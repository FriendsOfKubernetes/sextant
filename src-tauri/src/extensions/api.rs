//! The API extensions reach clusters through: the window's extension host forwards a frame's request as
//! `extension_call(extensionId, method, params, streamId?, onEvent?)`, and every call is checked here, in Rust, against
//! what the user granted at install — never against the manifest, never trusting the window.
//!
//! A call runs only when the extension is installed, enabled and within what was granted ([`ExtensionHost::active`],
//! read fresh on every call), the cluster is one it was granted (by kubeconfig context name), and
//! [`decide_extension`] allows every object it touches. A covering rule with `confirm` asks the user in the window
//! (the dialog names the extension, the same dialog and pending map as AI agents). Every cluster call is written to the
//! extensions' journal (`extensions-audit.jsonl`, event `ext-audit`).
//!
//! As for agents (ADR-0043, ADR-0045): Secrets come without their values from `resources.get/list/watch`; one value
//! needs `secret.value` and the "Secret values" action; secret material other kinds hold inline (a Route's key, a
//! node's k3s arguments, …: `sextant_core::resources::inline_secrets`) comes emptied from `resources.get/list/watch`
//! and `resources.patch`, whatever was granted (no method reads one such value); a JSON patch on a Secret that is not only add/replace/remove
//! needs "Secret values" too; node shell pods are never changed or deleted, whatever the rules, and a pod that cannot
//! be read to make sure is refused.
//!
//! `resources.watch` streams updates (`WatchUpdate`, as `watch_start` does) through the channel `onEvent` the window
//! created before the call, under the `streamId` it chose; the stream lives in [`ExtensionStreams`] (in `AppState`)
//! from before the watch starts, and ends with `extension_watch_stop`, the extension being disabled, removed or granted
//! other permissions, its cluster closed, the page reloaded or the window closed.
//!
//! `storage.*` keeps one JSON object per extension in `<data>/extensions-data/<id>.json`, at most [`MAX_STORAGE_BYTES`].

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use futures::{Stream, StreamExt};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use sextant_core::access::{
    self, AccessAction, AccessPreset, ClusterAccess, Decision, KindPattern, NamespaceScope,
};
use sextant_core::error::with_timeout;
use sextant_core::extensions::commands::{self, MAX_OUTPUT_BYTES};
use sextant_core::extensions::metric_queries::{MetricQueryRange, run_metric_query};
use sextant_core::extensions::services::{
    self, LoopbackRequest, ServiceContribution, ServiceMethod,
};
use sextant_core::extensions::{ExtensionPermissions, InstalledExtension, decide_extension};
use sextant_core::portforward::{ForwardInfo, ForwardSource, ForwardTarget, PodFilter};
use sextant_core::resources::{
    self, KindRef, PatchType, ResourceKind, WatchUpdate, inline_secrets,
};
use sextant_core::settings::custom_columns::{PathStep, parse_field_path};
use sextant_core::{
    ClusterId, ClusterManager, ConnectionState, CoreError, CoreResult, ErrorCode, ObjectRef,
    SettingsStore, WatchSpec, logs,
};
use tauri::ipc::JavaScriptChannelId;
use tauri::{Runtime, State, Webview};
use tokio::task::AbortHandle;

use super::forwards::{ExtensionForwards, MAX_FORWARDS_PER_EXTENSION};
use super::sessions::{RememberedSignIn, ServiceSessions, session_key, sign_in_credential};
use super::watch_hub::WatchHub;
use super::{ExtensionHost, HostEvent, WeakExtensionHost};
use crate::access_guard::audit::{AuditDecision, AuditEntry, AuditLog, clip};
use crate::access_guard::confirm::{
    CONFIRM_TIMEOUT, ConfirmOutcome, ConfirmRequest, ConfirmSource, Confirmations,
    MAX_PENDING_PER_EXTENSION, first_lines,
};
use crate::access_guard::{
    CallSummary, ClusterKinds, KindLookup, Requirement, action_name, effective_namespace, now_ms,
    refused_object, stronger,
};
use crate::commands::actions::CHANGE_TIMEOUT;
use crate::mcp::guard::narrowed_target;
use crate::mcp::tools_write::{check_json_patch, reads_secret_values};
use crate::state::{AppState, check_stream_id};

/// Event of a new entry in the extensions' journal, payload an `AuditEntry`.
pub const EXT_AUDIT: &str = "ext-audit";
/// Reads of the cluster (lists, objects, logs, kinds) are limited to this.
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// `resources.list` without `limit`.
pub const DEFAULT_LIST_LIMIT: u32 = 500;
/// `resources.list` gives at most this many objects.
pub const MAX_LIST_LIMIT: u32 = 5_000;
/// `logs.tail` without `lines`.
pub const DEFAULT_LOG_LINES: u32 = 200;
/// An extension's `storage`, serialized, at most.
pub const MAX_STORAGE_BYTES: usize = 1024 * 1024;
/// Longest `storage` key.
pub const MAX_STORAGE_KEY_CHARS: usize = 256;
/// Objects one `resources.getMany` reads at most.
pub const MAX_GET_MANY: usize = 50;
/// Reads of one `resources.getMany` running at once.
pub const GET_MANY_AT_ONCE: usize = 4;

/// The methods `extension_call` serves (`ui.*` and the context are the window's).
pub const METHODS: [&str; 23] = [
    "clusters.list",
    "kinds",
    "resources.list",
    "resources.get",
    "resources.getMany",
    "resources.watch",
    "resources.apply",
    "resources.patch",
    "resources.patchMany",
    "resources.delete",
    "logs.tail",
    "secret.value",
    "storage.get",
    "storage.set",
    "storage.remove",
    "backend.call",
    "exec.run",
    "logs.open",
    "portForward.start",
    "portForward.list",
    "portForward.stop",
    "service.request",
    "service.forget",
];

const NODE_SHELL_REFUSAL: &str = "Sextant does not let extensions change or delete node shell pods";

/// An AI agent on whose behalf an extension's backend runs (an agent tool, ADR-0159): every call is decided against
/// the extension's grant and the agent's own access rules in that cluster both, and the user is asked when either
/// asks. The agent never gets more through an extension than its own rules give it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentLimit {
    /// The MCP client's name, as the agent's activity log shows it.
    pub client: String,
}

/// Something the API tells the window.
#[derive(Debug, Clone, PartialEq)]
pub enum ApiEvent {
    /// `mcp-confirm` (the one confirmation dialog), with `source: "extension"`.
    Confirm(ConfirmRequest),
    /// `ext-audit`
    Audit(AuditEntry),
}

/// Delivers an event to the window; `false` when there is no window to deliver it to.
pub type ApiEmitter = Arc<dyn Fn(ApiEvent) -> bool + Send + Sync>;

/// Sends one watch update to the window; `false` when nobody receives it any more.
pub type UpdateSink = Arc<dyn Fn(WatchUpdate) -> bool + Send + Sync>;

// ---------------------------------------------------------------------------------------------------------------
// Streams

/// A running `resources.watch` of an extension.
pub struct ExtensionStream {
    pub extension: String,
    pub cluster: ClusterId,
    /// What was granted when the stream was opened: any change (or the extension no longer active) stops it.
    pub granted: ExtensionPermissions,
    pub task: AbortHandle,
}

/// The extensions' watch streams, by the id the window chose.
#[derive(Default)]
pub struct ExtensionStreams {
    map: Mutex<HashMap<String, ExtensionStream>>,
    /// Grows with every [`ExtensionStreams::stop_all`]: a start that began before it does not stay.
    generation: AtomicU64,
    /// A look of [`ExtensionStreams::stop_changed`] is queued and has not begun: a later change needs no other.
    look_queued: AtomicBool,
    /// One look at a time: a look queued behind a running one begins after it.
    look_turn: Mutex<()>,
}

impl ExtensionStreams {
    /// Registers a stream; a taken or malformed id is `invalid` and the stream's task is aborted.
    pub fn insert(&self, id: String, stream: ExtensionStream) -> CoreResult<()> {
        if let Err(err) = check_stream_id(&id) {
            stream.task.abort();
            return Err(err);
        }
        match lock(&self.map).entry(id) {
            Entry::Occupied(taken) => {
                stream.task.abort();
                Err(CoreError::new(
                    ErrorCode::Invalid,
                    format!("stream id {} is already in use", taken.key()),
                ))
            }
            Entry::Vacant(free) => {
                free.insert(stream);
                Ok(())
            }
        }
    }

    /// Stops a stream; `false` when there was none.
    pub fn stop(&self, id: &str) -> bool {
        match lock(&self.map).remove(id) {
            Some(stream) => {
                stream.task.abort();
                true
            }
            None => false,
        }
    }

    /// Forgets a stream that ended by itself: only if `id` is still that stream (its extension and its task), not one
    /// registered under the same id after it was stopped.
    fn remove_ended(&self, extension: &str, id: &str, task: tokio::task::Id) {
        let mut map = lock(&self.map);
        if map
            .get(id)
            .is_some_and(|s| s.extension == extension && s.task.id() == task)
        {
            map.remove(id);
        }
    }

    /// Stops the streams for which `stop` says so.
    fn stop_where(&self, stop: impl Fn(&ExtensionStream) -> bool) {
        lock(&self.map).retain(|_, stream| {
            let gone = stop(stream);
            if gone {
                stream.task.abort();
            }
            !gone
        });
    }

    /// The cluster was closed (disconnected).
    pub fn stop_cluster(&self, cluster: &ClusterId) {
        self.stop_where(|s| &s.cluster == cluster);
    }

    /// Every stream of one extension.
    pub fn stop_extension(&self, extension: &str) {
        self.stop_where(|s| s.extension == extension);
    }

    /// Streams whose extension is no longer active (disabled, removed, waiting for consent) or was granted anything
    /// else since the stream was opened (reinstalled with other permissions). What the installed list says — removed,
    /// disabled, granted anything else — stops them at once, so a disable stops them even when the extension is
    /// enabled again right after. Whether the rest are still active (a manifest that fails or asks for more) is looked
    /// at on the blocking pool, and this returns at once: after a `forget` a look reads the manifest again — walking a
    /// development folder whole — which must not hold up the thread that emits the host's events (#109). Looks run one
    /// at a time, and changes while one waits share it. A stream opened while a look runs is caught by the check after
    /// its start (`start_stream`).
    pub fn stop_changed(self: &Arc<Self>, host: &ExtensionHost) {
        let installed: HashMap<String, InstalledExtension> = host
            .installed()
            .into_iter()
            .map(|e| (e.id.clone(), e))
            .collect();
        self.stop_where(|s| {
            !installed
                .get(&s.extension)
                .is_some_and(|e| e.enabled && e.granted == s.granted)
        });
        if self.look_queued.swap(true, Ordering::SeqCst) {
            return;
        }
        let (streams, host) = (Arc::clone(self), host.clone());
        // Tauri's runtime: the host emits from threads outside any runtime as well (the folder watcher, commands).
        tauri::async_runtime::spawn_blocking(move || {
            let _turn = lock(&streams.look_turn);
            // From here a change queues a look of its own, which begins after this one.
            streams.look_queued.store(false, Ordering::SeqCst);
            streams.stop_changed_now(&host);
        });
    }

    fn stop_changed_now(&self, host: &ExtensionHost) {
        let opened: Vec<(String, String, ExtensionPermissions)> = lock(&self.map)
            .iter()
            .map(|(id, s)| (id.clone(), s.extension.clone(), s.granted.clone()))
            .collect();
        let mut now: HashMap<String, Option<ExtensionPermissions>> = HashMap::new();
        for (id, extension, granted) in opened {
            let current = now
                .entry(extension.clone())
                .or_insert_with(|| host.active(&extension).map(|e| e.granted));
            if current.as_ref() != Some(&granted) {
                self.stop_if(&id, |s| s.granted == granted);
            }
        }
    }

    /// Stops the stream `id` of `extension`; a stream of another extension is not touched. `false` when there was
    /// none.
    pub fn stop_of(&self, extension: &str, id: &str) -> bool {
        self.stop_if(id, |s| s.extension == extension)
    }

    fn stop_if(&self, id: &str, is_it: impl FnOnce(&ExtensionStream) -> bool) -> bool {
        let mut map = lock(&self.map);
        if !map.get(id).is_some_and(is_it) {
            return false;
        }
        if let Some(stream) = map.remove(id) {
            stream.task.abort();
        }
        true
    }

    /// Every stream (the page was reloaded, the window closed); a start under way does not stay either.
    pub fn stop_all(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        for (_, stream) in lock(&self.map).drain() {
            stream.task.abort();
        }
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn len(&self) -> usize {
        lock(&self.map).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Wires the host's events as the app does (`start_extensions`): on every event `forward` gets the event at once, and
/// the streams of `api` whose extension was disabled, removed, paused for consent or granted anything else stop as
/// soon as the blocking pool has looked ([`ExtensionStreams::stop_changed`]).
pub fn wire_host_events(
    host: &ExtensionHost,
    api: &ExtensionApi,
    forward: impl Fn(HostEvent) + Send + Sync + 'static,
) {
    host.set_emitter(host_emitter(
        Arc::clone(&api.streams),
        Arc::clone(&api.forwards),
        host.downgrade(),
        forward,
    ));
}

/// The extension host's emitter: on every event of the host (`extensions-changed` above all) the look for streams of
/// extensions that were disabled, removed or granted anything else goes to the blocking pool, and `forward` gets the
/// event at once, on the emitting thread. Holds the host weakly (the host keeps its emitter).
fn host_emitter(
    streams: Arc<ExtensionStreams>,
    forwards: Arc<ExtensionForwards>,
    host: WeakExtensionHost,
    forward: impl Fn(HostEvent) + Send + Sync + 'static,
) -> Arc<dyn Fn(HostEvent) + Send + Sync> {
    Arc::new(move |event| {
        if let Some(host) = host.upgrade() {
            streams.stop_changed(&host);
            // The installed list is held in memory: the look is cheap; stopping goes to the runtime.
            forwards.stop_changed(&host);
        }
        forward(event);
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The API

/// The extensions' API: kept in `AppState::ext_api`.
pub struct ExtensionApi {
    clusters: ClusterManager,
    pub(super) settings: Arc<SettingsStore>,
    kinds: Arc<dyn KindLookup>,
    /// Shared with the MCP server: one pending map, one answer command.
    confirmations: Arc<Confirmations>,
    /// `extensions-audit.jsonl`
    pub audit: AuditLog,
    pub streams: Arc<ExtensionStreams>,
    /// One core watch per list for every extension frame that watches it (#334, ADR-0145).
    watches: Arc<WatchHub>,
    emitter: RwLock<Option<ApiEmitter>>,
    /// One `storage` change at a time.
    storage: Arc<Mutex<()>>,
    /// The port forwards extensions started (ADR-0156), and Sextant's own for their service requests (ADR-0158).
    pub forwards: Arc<ExtensionForwards>,
    /// Session tokens of service requests (ADR-0158), in memory only.
    pub sessions: Arc<ServiceSessions>,
}

impl ExtensionApi {
    /// The journal goes to `<data_dir>/extensions-audit.jsonl`.
    pub fn new(
        clusters: ClusterManager,
        settings: Arc<SettingsStore>,
        confirmations: Arc<Confirmations>,
        data_dir: &std::path::Path,
    ) -> Self {
        let kinds = Arc::new(ClusterKinds(clusters.clone()));
        Self::with_kinds(clusters, settings, confirmations, data_dir, kinds)
    }

    /// [`ExtensionApi::new`] with another kind lookup (tests).
    pub fn with_kinds(
        clusters: ClusterManager,
        settings: Arc<SettingsStore>,
        confirmations: Arc<Confirmations>,
        data_dir: &std::path::Path,
        kinds: Arc<dyn KindLookup>,
    ) -> Self {
        Self {
            clusters,
            settings,
            kinds,
            confirmations,
            audit: AuditLog::open(AuditLog::extensions_path_in(data_dir)),
            streams: Arc::new(ExtensionStreams::default()),
            watches: Arc::new(WatchHub::default()),
            emitter: RwLock::new(None),
            storage: Arc::new(Mutex::new(())),
            forwards: Arc::new(ExtensionForwards::default()),
            sessions: Arc::new(ServiceSessions::default()),
        }
    }

    /// Where `mcp-confirm` (for extensions) and `ext-audit` go.
    pub fn set_emitter(&self, emitter: ApiEmitter) {
        *self.emitter.write().unwrap_or_else(|e| e.into_inner()) = Some(emitter);
    }

    /// Writes an entry of the activity log and tells the window.
    pub(super) fn journal(&self, entry: AuditEntry) {
        self.audit.record(entry.clone());
        self.emit(ApiEvent::Audit(entry));
    }

    fn emit(&self, event: ApiEvent) -> bool {
        let emitter = self
            .emitter
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        emitter.is_some_and(|emit| emit(event))
    }

    /// The page was reloaded: its streams go and the confirmations it was showing are declined.
    pub fn reset(&self) {
        self.streams.stop_all();
        self.confirmations.decline(ConfirmSource::Extension);
    }

    /// The window closed: nothing of extensions runs or asks any more.
    pub fn close(&self) {
        self.streams.stop_all();
        self.confirmations.close(ConfirmSource::Extension);
    }

    /// The journal, newest first; one extension's calls when `extension` is given.
    pub fn audit_list(&self, extension: Option<&str>) -> Vec<AuditEntry> {
        self.audit
            .list_matching(|e| extension.is_none_or(|id| e.client == id))
    }

    /// Runs one method for `extension_id`. `watch` is where `resources.watch` sends its updates (its stream id and the
    /// sink); other methods ignore it. Cluster calls are journaled; `storage.*` is not.
    pub async fn call(
        self: &Arc<Self>,
        host: &ExtensionHost,
        extension_id: &str,
        method: &str,
        params: Value,
        watch: Option<(String, UpdateSink)>,
    ) -> CoreResult<Value> {
        self.call_as(host, extension_id, method, params, watch, None)
            .await
    }

    /// [`ExtensionApi::call`] made by the extension's backend while it answers an AI agent (`agent`).
    pub async fn call_as(
        self: &Arc<Self>,
        host: &ExtensionHost,
        extension_id: &str,
        method: &str,
        params: Value,
        watch: Option<(String, UpdateSink)>,
        agent: Option<AgentLimit>,
    ) -> CoreResult<Value> {
        let params = if params.is_null() { json!({}) } else { params };
        // Files are read and written off the async runtime: `storage` syncs to disk, and the manifest of a
        // development folder is read by walking the folder. It is kept afterwards, but a `forget` (the folder changed)
        // can drop it at any moment, so every later look at the extension (`ExtCall::granted`, `start_stream`) goes
        // through the blocking pool too.
        let (blocking_host, id) = (host.clone(), extension_id.to_owned());
        match method {
            // The extension's own backend (ADR-0131): journaled there, with the calls it makes.
            "backend.call" => return self.backend_call(host, extension_id, params).await,
            "storage.get" | "storage.set" | "storage.remove" => {
                let (storage, method) = (Arc::clone(&self.storage), method.to_owned());
                return blocking(move || {
                    storage_call(&blocking_host, &storage, &id, &method, params)
                })
                .await;
            }
            _ => {}
        }
        let name = blocking(move || Ok(blocking_host.info(&id).map(|i| i.name))).await?;
        let at = now_ms();
        let started = Instant::now();
        let mut call = ExtCall::new(self, host, extension_id, method, name);
        call.agent = agent;
        let result = match method {
            "clusters.list" => call.clusters_list(params).await,
            "kinds" => call.kinds(params).await,
            "resources.list" => call.list(params).await,
            "resources.get" => call.get(params).await,
            "resources.getMany" => call.get_many(params).await,
            "resources.watch" => call.watch(params, watch).await,
            "resources.apply" => call.apply(params).await,
            "resources.patch" => call.patch(params).await,
            "resources.patchMany" => call.patch_many(params).await,
            "resources.delete" => call.delete(params).await,
            "logs.tail" => call.logs(params).await,
            "secret.value" => call.secret_value(params).await,
            "metrics.query" => call.metric_query(params).await,
            "exec.run" => call.exec_run(params).await,
            "logs.open" => call.logs_open(params).await,
            "portForward.start" => call.port_forward_start(params).await,
            "portForward.list" => call.port_forward_list(params).await,
            "portForward.stop" => call.port_forward_stop(params).await,
            "service.request" => call.service_request(params).await,
            "service.forget" => call.service_forget(params).await,
            _ => Err(invalid(format!("unknown method {method}"))),
        };
        let record = call.record();
        let entry = AuditEntry {
            at,
            source: ConfirmSource::Extension,
            principal: call.principal(),
            client: clip(extension_id),
            cluster_id: record.cluster.as_ref().map(|c| c.id.clone()),
            cluster_name: record.cluster.as_ref().map(|c| c.name.clone()),
            tool: clip(method),
            target: record.target.clone(),
            // No decision: the call ended before any check (malformed, unknown method or cluster, unreachable), and
            // is journaled as such — never as allowed, which would keep a malformed write or secret read (#98).
            decision: record.decision.unwrap_or(AuditDecision::NotChecked),
            result: match &result {
                Ok(_) => "ok".to_owned(),
                Err(e) => code_name(e.code),
            },
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        };
        self.audit.record(entry.clone());
        self.emit(ApiEvent::Audit(entry));
        result
    }

    /// The display name of a cluster: its display name in the settings, else its context.
    fn cluster_name(&self, id: &ClusterId, context: &str) -> String {
        self.settings
            .get()
            .clusters
            .get(&id.0)
            .and_then(|c| c.display_name.clone())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| context.to_owned())
    }

    fn cluster_list(&self) -> Vec<sextant_core::ClusterInfo> {
        self.clusters
            .registry()
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clusters()
            .unwrap_or_default()
    }

    /// Registers the stream `id` and runs it: `open` (the core starting the watch) and then each update to `sink`.
    /// Answers once `open` is done; a stream stopped before that (its cluster closed, the page reloaded) fails the
    /// start.
    #[allow(clippy::too_many_arguments)]
    async fn start_stream<S>(
        &self,
        host: &ExtensionHost,
        id: String,
        extension: &str,
        granted: ExtensionPermissions,
        cluster: ClusterId,
        open: impl Future<Output = CoreResult<S>> + Send + 'static,
        sink: UpdateSink,
    ) -> CoreResult<()>
    where
        S: Stream<Item = WatchUpdate> + Send + 'static,
    {
        check_stream_id(&id)?;
        let generation = self.streams.generation();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<CoreResult<()>>();
        let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
        let streams = Arc::clone(&self.streams);
        let (own_id, own_extension) = (id.clone(), extension.to_owned());
        let task = tokio::spawn(async move {
            if registered_rx.await.is_err() {
                return;
            }
            match open.await {
                Ok(updates) => {
                    let _ = started_tx.send(Ok(()));
                    let mut updates = std::pin::pin!(updates);
                    while let Some(update) = updates.next().await {
                        if !sink(update) {
                            break;
                        }
                    }
                }
                Err(err) => {
                    let _ = started_tx.send(Err(err));
                }
            }
            streams.remove_ended(&own_extension, &own_id, tokio::task::id());
        });
        self.streams.insert(
            id.clone(),
            ExtensionStream {
                extension: extension.to_owned(),
                cluster,
                granted: granted.clone(),
                task: task.abort_handle(),
            },
        )?;
        // Disabled, removed or granted anything else since the checks: a change from now on stops the stream
        // (`stop_changed` on `extensions-changed`), one before this is caught here. Read on the blocking pool
        // ([`active_off_runtime`]); a failed read counts as a change.
        let now = active_off_runtime(host, extension).await.ok().flatten();
        if now.map(|e| e.granted) != Some(granted) {
            self.streams.stop_of(extension, &id);
            return Err(CoreError::new(
                ErrorCode::Denied,
                format!(
                    "Extension {extension} was disabled, removed or given other permissions while its watch was \
                     starting; nothing is watched."
                ),
            ));
        }
        let _ = registered_tx.send(());
        started_rx
            .await
            .unwrap_or_else(|_| Err(CoreError::other("the watch was stopped before it started")))?;
        if self.streams.generation() != generation {
            self.streams.stop_of(extension, &id);
            return Err(CoreError::other(
                "the streams were reset while this one was starting",
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// storage

/// [`ExtensionHost::active`] on the blocking pool: after a `forget` (a development folder changed, an install, a
/// removal) it reads the manifest again — walking a development folder whole — which must not hold up a runtime
/// worker and with it every other extension's calls (#99).
async fn active_off_runtime(
    host: &ExtensionHost,
    id: &str,
) -> CoreResult<Option<InstalledExtension>> {
    let (host, id) = (host.clone(), id.to_owned());
    blocking(move || Ok(host.active(&id))).await
}

/// Runs `task` on the blocking pool.
async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> CoreResult<T> + Send + 'static,
) -> CoreResult<T> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|e| CoreError::other(e.to_string()))?
}

/// `storage.*` (blocking: reads, writes and syncs the file; `storage` is held for the whole change).
fn storage_call(
    host: &ExtensionHost,
    storage: &Mutex<()>,
    extension_id: &str,
    method: &str,
    params: Value,
) -> CoreResult<Value> {
    if host.active(extension_id).is_none() {
        return Err(inactive(extension_id));
    }
    let path = host.storage_dir().join(format!("{extension_id}.json"));
    let _one_at_a_time = lock(storage);
    let mut data = read_storage(&path, extension_id)?;
    match method {
        "storage.get" => {
            let args: KeyArgs = parse(method, params)?;
            Ok(data
                .get(storage_key(&args.key)?)
                .cloned()
                .unwrap_or(Value::Null))
        }
        "storage.set" => {
            let args: SetArgs = parse(method, params)?;
            data.insert(storage_key(&args.key)?.to_owned(), args.value);
            write_storage(&path, &data)?;
            forget_if_removed(host, extension_id, &path);
            Ok(Value::Null)
        }
        _ => {
            let args: KeyArgs = parse(method, params)?;
            if data.remove(storage_key(&args.key)?).is_some() {
                write_storage(&path, &data)?;
                forget_if_removed(host, extension_id, &path);
            }
            Ok(Value::Null)
        }
    }
}

/// The extension's storage; none yet is empty. A file that cannot be read or is not a JSON object is an error and
/// stays as it is (the next `set` does not overwrite it).
fn read_storage(path: &std::path::Path, extension_id: &str) -> CoreResult<Map<String, Value>> {
    let unreadable = |why: String| {
        CoreError::other(format!(
            "the storage of extension {extension_id} cannot be read ({why}); it is kept as it is"
        ))
    };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(unreadable(e.to_string())),
    };
    serde_json::from_slice::<Map<String, Value>>(&bytes).map_err(|e| unreadable(e.to_string()))
}

/// Writes the whole object at once: a temporary file next to it, then a rename.
fn write_storage(path: &std::path::Path, data: &Map<String, Value>) -> CoreResult<()> {
    let bytes = serde_json::to_vec(data).map_err(|e| CoreError::other(e.to_string()))?;
    if bytes.len() > MAX_STORAGE_BYTES {
        return Err(invalid(format!(
            "an extension's storage holds at most {} KB; this would make it {} KB",
            MAX_STORAGE_BYTES / 1024,
            bytes.len().div_ceil(1024)
        )));
    }
    let dir = path
        .parent()
        .ok_or_else(|| CoreError::other("the storage file has no directory"))?;
    std::fs::create_dir_all(dir)?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "json.tmp-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(err) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

/// The extension was removed while its write ran: the data goes with it.
fn forget_if_removed(host: &ExtensionHost, extension_id: &str, path: &std::path::Path) {
    if host.info(extension_id).is_none() {
        let _ = std::fs::remove_file(path);
    }
}

fn storage_key(key: &str) -> CoreResult<&str> {
    let count = key.chars().count();
    if count == 0 || count > MAX_STORAGE_KEY_CHARS {
        return Err(invalid(format!(
            "a storage key has 1 to {MAX_STORAGE_KEY_CHARS} characters"
        )));
    }
    Ok(key)
}

// ---------------------------------------------------------------------------------------------------------------
// One call

/// A cluster a call works with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtCluster {
    pub id: ClusterId,
    /// The name the user sees.
    pub name: String,
    /// The kubeconfig context: what the permissions name.
    pub context: String,
}

/// What the journal learns about a call while it runs.
#[derive(Debug, Clone, Default)]
struct CallRecord {
    cluster: Option<ExtCluster>,
    target: String,
    decision: Option<AuditDecision>,
}

/// One call of an extension: checks it and remembers what the journal should say.
struct ExtCall<'a> {
    api: &'a ExtensionApi,
    host: &'a ExtensionHost,
    id: String,
    /// The extension's name as the user knows it (the manifest's), read when the call came; else its id.
    name: String,
    method: String,
    record: Mutex<CallRecord>,
    /// The AI agent the backend answers, when it does (ADR-0159).
    agent: Option<AgentLimit>,
}

impl<'a> ExtCall<'a> {
    fn new(
        api: &'a ExtensionApi,
        host: &'a ExtensionHost,
        id: &str,
        method: &str,
        name: Option<String>,
    ) -> Self {
        Self {
            api,
            host,
            id: id.to_owned(),
            name: name.unwrap_or_else(|| id.to_owned()),
            method: method.to_owned(),
            record: Mutex::new(CallRecord::default()),
            agent: None,
        }
    }

    fn record(&self) -> CallRecord {
        lock(&self.record).clone()
    }

    fn decide(&self, decision: AuditDecision) {
        let mut record = lock(&self.record);
        record.decision = Some(stronger(record.decision, decision));
    }

    /// The extension's name as the user knows it (the manifest's), else its id.
    fn name(&self) -> String {
        self.name.clone()
    }

    /// `Extension <name>` (or `AI agent <client> through extension <name>`): who asks, in the dialog and the journal.
    fn principal(&self) -> String {
        match &self.agent {
            Some(agent) => clip(&format!(
                "AI agent {} through extension {}",
                agent.client,
                self.name()
            )),
            None => clip(&format!("Extension {}", self.name())),
        }
    }

    /// The agent's own rules in the cluster (its "AI agent access"), when the call is made for an agent.
    fn agent_access(&self, cluster: &ExtCluster) -> Option<ClusterAccess> {
        self.agent.as_ref().map(|_| {
            self.api
                .settings
                .get()
                .clusters
                .get(&cluster.id.0)
                .map(|c| c.agent_access.clone())
                .unwrap_or_default()
        })
    }

    /// What the agent needs for `action` on `kind`: running a command in a pod is the agent's Exec, not Read.
    fn agent_action(&self, kind: &KindPattern, action: AccessAction) -> AccessAction {
        if self.method == "exec.run"
            && action == AccessAction::Read
            && kind.group.is_empty()
            && kind.kind.eq_ignore_ascii_case("Pod")
        {
            AccessAction::Exec
        } else {
            action
        }
    }

    /// What was granted, read fresh (on the blocking pool): refused unless the extension is active now.
    async fn granted(&self) -> CoreResult<ExtensionPermissions> {
        match active_off_runtime(self.host, &self.id).await? {
            Some(entry) => Ok(entry.granted),
            None => {
                self.decide(AuditDecision::Denied);
                Err(inactive(&self.id))
            }
        }
    }

    fn denied(&self, message: String) -> CoreError {
        self.decide(AuditDecision::Denied);
        CoreError::new(ErrorCode::Denied, message)
    }

    fn where_to_allow(&self) -> String {
        let name = self.name();
        format!(
            "Allow it in Settings → Extensions → {name} → Permissions (reinstall with wider permissions)."
        )
    }

    /// The cluster the extension named (id, or context), if it was granted; nothing is connected. A granted cluster is
    /// not yet a decision: the call is allowed only by the check of what it does ([`ExtCall::check`],
    /// [`ExtCall::allowed_namespaces`]).
    async fn target(&self, cluster: &str) -> CoreResult<ExtCluster> {
        let granted = self.granted().await?;
        let wanted = cluster.trim();
        let clusters = self.api.cluster_list();
        let found = clusters
            .iter()
            .find(|c| c.id.0 == wanted)
            .or_else(|| {
                let mut by_context = clusters.iter().filter(|c| c.context == wanted);
                match (by_context.next(), by_context.next()) {
                    (Some(one), None) => Some(one),
                    _ => None,
                }
            })
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    format!("no cluster {wanted:?}; clusters.list gives the ids"),
                )
            })?;
        let target = ExtCluster {
            id: found.id.clone(),
            name: self.api.cluster_name(&found.id, &found.context),
            context: found.context.clone(),
        };
        lock(&self.record).cluster = Some(target.clone());
        if !granted.clusters.covers(&target.context) {
            return Err(self.denied(format!(
                "Sextant denied access to cluster {} for extension {}. {}",
                target.name,
                self.name(),
                self.where_to_allow()
            )));
        }
        Ok(target)
    }

    /// [`ExtCall::target`], connected (like the Connect button) when it is not.
    async fn open(&self, cluster: &str) -> CoreResult<ExtCluster> {
        let target = self.target(cluster).await?;
        let connected = matches!(
            self.api.clusters.state(&target.id),
            ConnectionState::Connected
        );
        if !connected {
            // What a failed exec plugin printed is for the window only (#256).
            self.api
                .clusters
                .connect(&target.id)
                .await
                .map_err(CoreError::without_plugin_output)?;
        }
        Ok(target)
    }

    /// Checks every requirement (all must be allowed) and, when a covering rule asks for it, waits for the user's
    /// answer in the window. After the answer the extension and its permissions are read again.
    async fn check(
        &self,
        cluster: &ExtCluster,
        requirements: &[Requirement],
        summary: &CallSummary,
    ) -> CoreResult<()> {
        self.check_asking(cluster, requirements, summary, false)
            .await
    }

    /// [`ExtCall::check`], asking the user even where the rules would not (`always`): a command that changes
    /// something (ADR-0147).
    async fn check_asking(
        &self,
        cluster: &ExtCluster,
        requirements: &[Requirement],
        summary: &CallSummary,
        always: bool,
    ) -> CoreResult<()> {
        let target = clip(&summary.target);
        lock(&self.record).target = target.clone();
        let mut seen = Vec::with_capacity(requirements.len());
        for (namespace, kind, action) in requirements {
            let namespace =
                effective_namespace(&*self.api.kinds, &cluster.id, namespace.as_deref(), kind)
                    .await;
            seen.push((namespace, kind.clone(), *action));
        }
        let confirm = self.decide_all(cluster, &seen, summary).await? || always;
        if !confirm {
            return Ok(());
        }
        let request = ConfirmRequest {
            id: String::new(),
            source: ConfirmSource::Extension,
            principal: self.principal(),
            client: self.id.clone(),
            cluster_id: cluster.id.clone(),
            cluster_name: cluster.name.clone(),
            tool: self.method.clone(),
            target: target.clone(),
            details: summary.details.clone(),
        };
        let api = self.api;
        let outcome = self
            .api
            .confirmations
            .ask_at_most(request, MAX_PENDING_PER_EXTENSION, |r| {
                api.emit(ApiEvent::Confirm(r.clone()))
            })
            .await;
        let what = if target.is_empty() {
            "the cluster"
        } else {
            &target
        };
        let Some(outcome) = outcome else {
            self.decide(AuditDecision::Denied);
            return Err(CoreError::new(
                ErrorCode::Denied,
                format!(
                    "Extension {} already has {MAX_PENDING_PER_EXTENSION} requests waiting for the user: {} on \
                     {what} in cluster {} was not asked and not run.",
                    self.id, self.method, cluster.name
                ),
            ));
        };
        match outcome {
            ConfirmOutcome::Approved => {
                // Disabled, removed or granted less while the dialog was open: the answer no longer counts.
                self.decide_all(cluster, &seen, summary).await?;
                self.decide(AuditDecision::Approved);
                Ok(())
            }
            ConfirmOutcome::Declined => {
                self.decide(AuditDecision::Declined);
                Err(CoreError::new(
                    ErrorCode::Denied,
                    format!(
                        "The user declined {} on {what} in cluster {}.",
                        self.method, cluster.name
                    ),
                ))
            }
            ConfirmOutcome::TimedOut => {
                self.decide(AuditDecision::TimedOut);
                Err(CoreError::new(
                    ErrorCode::Denied,
                    format!(
                        "No answer from the user in {} s: {} on {what} in cluster {} was not run.",
                        CONFIRM_TIMEOUT.as_secs(),
                        self.method,
                        cluster.name
                    ),
                ))
            }
        }
    }

    /// Decides every requirement against what is granted now; `Ok(true)` when the user must be asked. All allowed is
    /// journaled as allowed (an answer of the user, or a refusal, outranks it).
    async fn decide_all(
        &self,
        cluster: &ExtCluster,
        requirements: &[(Option<String>, KindPattern, AccessAction)],
        summary: &CallSummary,
    ) -> CoreResult<bool> {
        let granted = self.granted().await?;
        let agent_access = self.agent_access(cluster);
        let mut confirm = false;
        for (namespace, kind, action) in requirements {
            match decide_extension(
                &granted,
                &cluster.context,
                namespace.as_deref(),
                kind,
                *action,
            ) {
                Decision::Allowed { confirm: ask } => confirm |= ask,
                Decision::Denied => {
                    return Err(self.denied(format!(
                        "Sextant denied {} on {} in cluster {} for extension {}. {}",
                        action_name(*action),
                        refused_object(&summary.target, namespace.as_deref(), kind),
                        cluster.name,
                        self.name(),
                        self.where_to_allow()
                    )));
                }
            }
            if let (Some(access), Some(agent)) = (&agent_access, &self.agent) {
                let action = self.agent_action(kind, *action);
                match access::decide(access, namespace.as_deref(), kind, action) {
                    Decision::Allowed { confirm: ask } => confirm |= ask,
                    Decision::Denied => {
                        return Err(self.denied(format!(
                            "Sextant denied {} on {} in cluster {} for AI agent {} (through extension {}): the \
                             agent's own access does not allow it. Allow it in the cluster's settings → AI agent \
                             access.",
                            action_name(action),
                            refused_object(&summary.target, namespace.as_deref(), kind),
                            cluster.name,
                            agent.client,
                            self.name()
                        )));
                    }
                }
            }
        }
        self.decide(AuditDecision::Allowed);
        Ok(confirm)
    }

    /// Namespaces where `action` on `kind` is granted, for a call over all namespaces: `All`, or the namespaces of
    /// the covering rules. Nowhere is a refusal. A call narrowed to some namespaces is journaled with them.
    async fn allowed_namespaces(
        &self,
        cluster: &ExtCluster,
        kind: &KindPattern,
        action: AccessAction,
        summary: &CallSummary,
    ) -> CoreResult<NamespaceScope> {
        lock(&self.record).target = clip(&summary.target);
        let granted = self.granted().await?;
        let mut scope = if granted.clusters.covers(&cluster.context) {
            access::allowed_namespaces(&rules_of(&granted), kind, action)
        } else {
            NamespaceScope::Only {
                namespaces: Vec::new(),
            }
        };
        // For an agent: only where its own rules allow it too.
        if let Some(agent_access) = self.agent_access(cluster) {
            let theirs =
                access::allowed_namespaces(&agent_access, kind, self.agent_action(kind, action));
            scope = intersect(scope, theirs);
        }
        if matches!(&scope, NamespaceScope::Only { namespaces } if namespaces.is_empty()) {
            return Err(self.denied(format!(
                "Sextant denied {} on {} in cluster {} for extension {}. {}",
                action_name(action),
                refused_object(&summary.target, None, kind),
                cluster.name,
                self.name(),
                self.where_to_allow()
            )));
        }
        if let NamespaceScope::Only { namespaces } = &scope {
            lock(&self.record).target = clip(&narrowed_target(&summary.target, kind, namespaces));
        }
        self.decide(AuditDecision::Allowed);
        Ok(scope)
    }

    // -----------------------------------------------------------------------------------------------------------
    // Methods

    async fn clusters_list(&self, params: Value) -> CoreResult<Value> {
        let _: NoArgs = parse(&self.method, params)?;
        let granted = self.granted().await?;
        // Only the granted clusters are listed: that is the whole decision.
        self.decide(AuditDecision::Allowed);
        let clusters: Vec<Value> = self
            .api
            .cluster_list()
            .into_iter()
            .filter(|c| granted.clusters.covers(&c.context))
            .map(|c| {
                json!({
                    "id": c.id,
                    "name": self.api.cluster_name(&c.id, &c.context),
                    "context": c.context,
                    "server": c.server,
                    // What a failed exec plugin printed is for the window only (#256).
                    "state": self.api.clusters.state(&c.id).without_plugin_output(),
                })
            })
            .collect();
        Ok(Value::Array(clusters))
    }

    async fn kinds(&self, params: Value) -> CoreResult<Value> {
        let args: ClusterArgs = parse(&self.method, params)?;
        let cluster = self.open(&args.cluster_id).await?;
        let kinds = read("reading the kinds", self.api.clusters.kinds(&cluster.id)).await?;
        let granted = self.granted().await?;
        // Only the kinds the rules cover are given: that is the whole decision.
        self.decide(AuditDecision::Allowed);
        let rules = rules_of(&granted);
        let visible: Vec<&ResourceKind> = kinds
            .iter()
            .filter(|k| access::has_any_permission(&rules, &pattern_of(&k.kind_ref)))
            .collect();
        to_value(&visible)
    }

    async fn list(&self, params: Value) -> CoreResult<Value> {
        let args: ListArgs = parse(&self.method, params)?;
        let limit = args
            .limit
            .unwrap_or(DEFAULT_LIST_LIMIT)
            .clamp(1, MAX_LIST_LIMIT);
        let cluster = self.open(&args.cluster_id).await?;
        let kind = self.find_kind(&cluster, &args.kind).await?;
        let pattern = pattern_of(&kind.kind_ref);
        let name = &kind.kind_ref.kind;
        let namespace = non_empty(args.namespace.as_deref()).filter(|_| kind.namespaced);
        let scope = match (namespace, kind.namespaced) {
            (Some(ns), _) => {
                let summary = summary(format!("{name} in namespace {ns}"));
                let need = (Some(ns.to_owned()), pattern.clone(), AccessAction::Read);
                self.check(&cluster, &[need], &summary).await?;
                NamespaceScope::Only {
                    namespaces: vec![ns.to_owned()],
                }
            }
            (None, false) => {
                let need = (None, pattern.clone(), AccessAction::Read);
                self.check(&cluster, &[need], &summary(name.clone()))
                    .await?;
                NamespaceScope::All
            }
            (None, true) => {
                let summary = summary(format!("{name} in all namespaces"));
                self.allowed_namespaces(&cluster, &pattern, AccessAction::Read, &summary)
                    .await?
            }
        };
        let mgr = &self.api.clusters;
        let list_in = |ns: Option<String>, limit: u32| {
            let kind_ref = kind.kind_ref.clone();
            let (labels, fields) = (args.label_selector.clone(), args.field_selector.clone());
            let cluster = cluster.id.clone();
            async move {
                read(
                    "listing objects",
                    resources::list(
                        mgr,
                        &cluster,
                        &kind_ref,
                        ns.as_deref(),
                        labels.as_deref(),
                        fields.as_deref(),
                        limit,
                    ),
                )
                .await
            }
        };
        let (items, truncated, namespaces) = match scope {
            NamespaceScope::All => {
                let page = list_in(None, limit).await?;
                (page.items, page.truncated, None)
            }
            NamespaceScope::Only { namespaces } => {
                let mut items = Vec::new();
                let mut truncated = false;
                for (i, ns) in namespaces.iter().enumerate() {
                    let left = limit - u32::try_from(items.len()).unwrap_or(limit);
                    if left == 0 {
                        truncated = i < namespaces.len();
                        break;
                    }
                    let page = list_in(Some(ns.clone()), left).await?;
                    truncated |= page.truncated;
                    items.extend(page.items);
                }
                (items, truncated, Some(namespaces))
            }
        };
        let items: Vec<Value> = items.into_iter().map(without_inline_secrets).collect();
        let mut out = json!({ "items": items, "truncated": truncated });
        if let Some(namespaces) = namespaces.filter(|_| namespace.is_none()) {
            out["namespaces"] = json!(namespaces);
        }
        Ok(out)
    }

    async fn get(&self, params: Value) -> CoreResult<Value> {
        let args: ObjectArgs = parse(&self.method, params)?;
        let cluster = self.open(&args.cluster_id).await?;
        let object = self.object(&cluster, &args.object).await?;
        let need = requirement(&object, AccessAction::Read);
        self.check(&cluster, &[need], &summary(describe(&object)))
            .await?;
        // Always without Secret values (`resources::get`) and inline secret material; one Secret value is
        // `secret.value`.
        read(
            "reading the object",
            resources::get(&self.api.clusters, &cluster.id, &object),
        )
        .await
        .map(without_inline_secrets)
    }

    /// Named reads in one call (#334, ADR-0145): at most [`MAX_GET_MANY`], [`GET_MANY_AT_ONCE`] at a time, each answered
    /// in its place as `{object}` or `{error}`. Every object is checked for Read in one decision before any is read: a
    /// batch the extension may not read in full is refused as a whole, as one `resources.get` would be.
    async fn get_many(&self, params: Value) -> CoreResult<Value> {
        let args: GetManyArgs = parse(&self.method, params)?;
        if args.refs.is_empty() || args.refs.len() > MAX_GET_MANY {
            return Err(invalid(format!(
                "resources.getMany reads 1 to {MAX_GET_MANY} objects"
            )));
        }
        let cluster = self.open(&args.cluster_id).await?;
        let mut resolved = Vec::with_capacity(args.refs.len());
        for r in &args.refs {
            resolved.push(self.object(&cluster, r).await);
        }
        let objects: Vec<ObjectRef> = resolved
            .iter()
            .filter_map(|r| r.as_ref().ok().cloned())
            .collect();
        if !objects.is_empty() {
            let needs: Vec<Requirement> = objects
                .iter()
                .map(|o| requirement(o, AccessAction::Read))
                .collect();
            self.check(&cluster, &needs, &summary(targets_text(&objects)))
                .await?;
        }
        let mgr = &self.api.clusters;
        let cluster_id = &cluster.id;
        let items: Vec<Value> = futures::stream::iter(resolved)
            .map(|object| async move {
                let answer = match object {
                    Ok(object) => read(
                        "reading the object",
                        resources::get(mgr, cluster_id, &object),
                    )
                    .await
                    .map(without_inline_secrets),
                    Err(err) => Err(err),
                };
                match answer {
                    Ok(object) => serde_json::json!({ "object": object }),
                    Err(err) => {
                        serde_json::json!({ "error": { "code": err.code, "message": err.message } })
                    }
                }
            })
            .buffered(GET_MANY_AT_ONCE)
            .collect()
            .await;
        Ok(serde_json::json!({ "items": items }))
    }

    async fn watch(&self, params: Value, sink: Option<(String, UpdateSink)>) -> CoreResult<Value> {
        let args: WatchArgs = parse(&self.method, params)?;
        let Some((stream_id, sink)) = sink else {
            return Err(invalid(
                "resources.watch needs a stream id and a channel (onEvent)",
            ));
        };
        check_stream_id(&stream_id)?;
        // The grant every check below is made under (or a later one, which the stream then fails to match).
        let granted = self.granted().await?;
        let cluster = self.open(&args.cluster_id).await?;
        let kind = self.find_kind(&cluster, &args.kind).await?;
        let pattern = pattern_of(&kind.kind_ref);
        let name = &kind.kind_ref.kind;
        let mut asked: Vec<String> = args
            .namespaces
            .unwrap_or_default()
            .into_iter()
            .filter(|ns| !ns.trim().is_empty())
            .collect();
        asked.sort();
        asked.dedup();
        let namespaces = if !kind.namespaced {
            let need = (None, pattern.clone(), AccessAction::Read);
            self.check(&cluster, &[need], &summary(name.clone()))
                .await?;
            None
        } else if asked.is_empty() {
            let summary = summary(format!("{name} in all namespaces"));
            match self
                .allowed_namespaces(&cluster, &pattern, AccessAction::Read, &summary)
                .await?
            {
                NamespaceScope::All => None,
                NamespaceScope::Only { namespaces } => Some(namespaces),
            }
        } else {
            let needs: Vec<Requirement> = asked
                .iter()
                .map(|ns| (Some(ns.clone()), pattern.clone(), AccessAction::Read))
                .collect();
            let target = format!("{name} in namespaces {}", asked.join(", "));
            self.check(&cluster, &needs, &summary(target)).await?;
            Some(asked)
        };
        let spec = WatchSpec {
            kind: kind.kind_ref.clone(),
            namespaces,
            label_selector: args.label_selector,
            field_selector: args.field_selector,
            metadata_only: args.metadata_only,
        };
        let (mgr, cluster_id) = (self.api.clusters.clone(), cluster.id.clone());
        // Frames watching the same list share one core watch (ADR-0145): this call was checked against its own grant
        // above, and every extension's watch carries the same data. `resources::watch` gives Secrets without their
        // values, like `watch_start`; inline secret material is emptied here, object by object, before the hub.
        let hub = Arc::clone(&self.api.watches);
        let key = format!(
            "{}\u{0}{}",
            cluster_id,
            serde_json::to_string(&spec).map_err(|e| invalid(e.to_string()))?
        );
        let open = async move {
            hub.subscribe(key, async move {
                resources::watch(&mgr, &cluster_id, spec)
                    .await
                    .map(|updates| updates.map(inline_secrets::hide_in_watch_update))
            })
            .await
        };
        self.api
            .start_stream(
                self.host,
                stream_id,
                &self.id,
                granted,
                cluster.id.clone(),
                open,
                sink,
            )
            .await?;
        Ok(Value::Null)
    }

    async fn apply(&self, params: Value) -> CoreResult<Value> {
        let args: ApplyArgs = parse(&self.method, params)?;
        // The core's one reading of the text: what is checked is what is applied. A Secret loaded without its values
        // is refused here, before anyone is asked.
        let docs = resources::parse_documents(&args.yaml)?;
        if docs.is_empty() {
            return Err(invalid("the text has no objects to apply"));
        }
        let cluster = self.open(&args.cluster_id).await?;
        let mgr = &self.api.clusters;
        let targets = resources::plan_apply(mgr, &cluster.id, docs).await?;
        for target in &targets {
            refuse_named_node_shell(target.object(), Some(target.document().value()))?;
        }
        let objects: Vec<ObjectRef> = targets.iter().map(|t| t.object().clone()).collect();
        let needs: Vec<Requirement> = objects
            .iter()
            .map(|o| requirement(o, AccessAction::Modify))
            .collect();
        let summary = CallSummary {
            tool: self.method.clone(),
            target: targets_text(&objects),
            details: Some(apply_details(&objects, &args.yaml)),
        };
        self.check(&cluster, &needs, &summary).await?;
        for object in &objects {
            self.refuse_live_node_shell(&cluster, object, true).await?;
        }
        let applied = resources::apply_planned(mgr, &cluster.id, targets).await?;
        to_value(&applied)
    }

    async fn patch(&self, params: Value) -> CoreResult<Value> {
        let args: PatchArgs = parse(&self.method, params)?;
        let item = PatchItem {
            object: args.object,
            patch: args.patch,
            patch_type: args.patch_type,
            subresource: args.subresource,
        };
        patch_shape(&item)?;
        let cluster = self.open(&args.cluster_id).await?;
        let planned = self.plan_patch(&cluster, item).await?;
        let summary = CallSummary {
            tool: self.method.clone(),
            target: planned.target(),
            details: Some(first_lines(&planned.shown())),
        };
        self.check(&cluster, &planned.needs, &summary).await?;
        self.send_patch(&cluster, &planned).await
    }

    /// Several patches under one decision and one confirmation (#363, ADR-0161): every item is checked first, then
    /// they are sent in order; the first failure stops the rest. The answer has each sent item's object, the error of
    /// the one that failed, and `sent`.
    async fn patch_many(&self, params: Value) -> CoreResult<Value> {
        let args: PatchManyArgs = parse(&self.method, params)?;
        if args.items.is_empty() || args.items.len() > MAX_PATCH_MANY {
            return Err(invalid(format!("give 1 to {MAX_PATCH_MANY} items")));
        }
        for item in &args.items {
            patch_shape(item)?;
        }
        let cluster = self.open(&args.cluster_id).await?;
        let mut planned = Vec::with_capacity(args.items.len());
        for item in args.items {
            planned.push(self.plan_patch(&cluster, item).await?);
        }
        let needs: Vec<Requirement> = planned.iter().flat_map(|p| p.needs.clone()).collect();
        let targets: Vec<String> = planned.iter().map(PlannedPatch::target).collect();
        let shown: Vec<String> = planned
            .iter()
            .map(|p| format!("{}:\n{}", p.target(), p.shown()))
            .collect();
        let summary = CallSummary {
            tool: self.method.clone(),
            target: targets.join(", "),
            details: Some(first_lines(&shown.join("\n"))),
        };
        self.check(&cluster, &needs, &summary).await?;
        let mut results = Vec::with_capacity(planned.len());
        let mut sent = 0;
        for item in &planned {
            match self.send_patch(&cluster, item).await {
                Ok(object) => {
                    results.push(json!({ "object": object }));
                    sent += 1;
                }
                Err(err) => {
                    let err = err.without_plugin_output();
                    results.push(
                        json!({ "error": { "code": code_name(err.code), "message": err.message } }),
                    );
                    break;
                }
            }
        }
        Ok(json!({ "items": results, "sent": sent }))
    }

    /// One patch checked for its object, with what it needs (its shape was checked by [`patch_shape`]).
    async fn plan_patch(&self, cluster: &ExtCluster, item: PatchItem) -> CoreResult<PlannedPatch> {
        let status = patch_shape(&item)?;
        let object = self.object(cluster, &item.object).await?;
        refuse_named_node_shell(&object, None)?;
        if status
            && !self
                .granted()
                .await?
                .may_patch_status(&pattern_of(&object.kind))
        {
            return Err(self.denied(format!(
                "Sextant denied patching the status of {} for extension {}: the user did not grant it for this kind. {}",
                describe(&object),
                self.name(),
                self.where_to_allow()
            )));
        }
        let mut needs = vec![requirement(&object, AccessAction::Modify)];
        // On a Secret, a JSON patch other than add/replace/remove may read its values: only with "Secret values".
        if is_core_secret(&object.kind)
            && item.patch_type == PatchType::Json
            && reads_secret_values(&item.patch)
        {
            needs.push(requirement(&object, AccessAction::SecretValues));
        }
        Ok(PlannedPatch {
            object,
            patch: item.patch,
            patch_type: item.patch_type,
            status,
            needs,
        })
    }

    /// Sends a checked patch, right after the last look that the object is no node shell.
    async fn send_patch(&self, cluster: &ExtCluster, planned: &PlannedPatch) -> CoreResult<Value> {
        self.refuse_live_node_shell(cluster, &planned.object, false)
            .await?;
        if planned.status {
            return with_timeout(
                CHANGE_TIMEOUT,
                "patching the status",
                resources::patch_custom_status(
                    &self.api.clusters,
                    &cluster.id,
                    &planned.object,
                    &planned.patch,
                    planned.patch_type,
                ),
            )
            .await
            .map(without_inline_secrets);
        }
        with_timeout(
            CHANGE_TIMEOUT,
            "patching the object",
            resources::patch(
                &self.api.clusters,
                &cluster.id,
                &planned.object,
                &planned.patch,
                planned.patch_type,
            ),
        )
        .await
        .map(without_inline_secrets)
    }

    async fn delete(&self, params: Value) -> CoreResult<Value> {
        let args: ObjectArgs = parse(&self.method, params)?;
        let cluster = self.open(&args.cluster_id).await?;
        let object = self.object(&cluster, &args.object).await?;
        refuse_named_node_shell(&object, None)?;
        let need = requirement(&object, AccessAction::Delete);
        self.check(&cluster, &[need], &summary(describe(&object)))
            .await?;
        self.refuse_live_node_shell(&cluster, &object, false)
            .await?;
        with_timeout(
            CHANGE_TIMEOUT,
            "the deletion",
            resources::delete(&self.api.clusters, &cluster.id, &object),
        )
        .await?;
        Ok(Value::Null)
    }

    async fn logs(&self, params: Value) -> CoreResult<Value> {
        let args: LogArgs = parse(&self.method, params)?;
        let lines = args
            .lines
            .unwrap_or(DEFAULT_LOG_LINES)
            .clamp(1, logs::MAX_TAIL_LINES);
        let namespace = required("namespace", &args.namespace)?;
        let name = required("pod", &args.pod)?;
        let cluster = self.open(&args.cluster_id).await?;
        let pod = ObjectRef {
            kind: KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: "Pod".into(),
            },
            namespace: Some(namespace.to_owned()),
            name: name.to_owned(),
        };
        let need = requirement(&pod, AccessAction::Logs);
        self.check(&cluster, &[need], &summary(describe(&pod)))
            .await?;
        let text = read(
            "reading the log",
            logs::tail(
                &self.api.clusters,
                &cluster.id,
                &pod,
                non_empty(args.container.as_deref()),
                lines,
                args.previous,
            ),
        )
        .await?;
        Ok(Value::String(text))
    }

    /// Whether the window may open its logs tab for the extension (`ui.openLogs`, ADR-0156): Logs on the pod, or on
    /// pods of the namespace for a label selector; nothing is read here, the tab reads as the user's own.
    async fn logs_open(&self, params: Value) -> CoreResult<Value> {
        let args: LogsOpenArgs = parse(&self.method, params)?;
        let namespace = required("namespace", &args.namespace)?;
        let target = match (
            non_empty(args.pod.as_deref()),
            non_empty(args.label_selector.as_deref()),
        ) {
            (Some(pod), None) => format!("Pod {namespace}/{pod}"),
            (None, Some(selector)) => format!("pods {selector} in {namespace}"),
            _ => return Err(invalid("give `pod` or `labelSelector`")),
        };
        let target = match non_empty(args.container.as_deref()) {
            Some(container) => format!("{target} container {container}"),
            None => target,
        };
        let cluster = self.target(&args.cluster_id).await?;
        let need = (
            Some(namespace.to_owned()),
            KindPattern::new("", "Pod"),
            AccessAction::Logs,
        );
        self.check(&cluster, &[need], &summary(target)).await?;
        Ok(Value::Null)
    }

    /// Starts a forward to a Pod or Service (ADR-0156), listed on the port-forward page as the extension's: never to a
    /// node shell or a pod on the node's network.
    async fn port_forward_start(&self, params: Value) -> CoreResult<Value> {
        let args: ForwardStartArgs = parse(&self.method, params)?;
        if args.port == 0 {
            return Err(invalid("port must be 1–65535"));
        }
        let namespace = required("namespace", &args.namespace)?.to_owned();
        let name = required("name", &args.name)?.to_owned();
        let (kind, target) = match args.kind {
            ForwardKindArg::Pod => (
                "Pod",
                ForwardTarget::Pod {
                    namespace: namespace.clone(),
                    name: name.clone(),
                },
            ),
            ForwardKindArg::Service => (
                "Service",
                ForwardTarget::Service {
                    namespace: namespace.clone(),
                    name: name.clone(),
                },
            ),
        };
        let cluster = self.open(&args.cluster_id).await?;
        if args.kind == ForwardKindArg::Pod {
            let pod = ObjectRef {
                kind: KindRef {
                    group: String::new(),
                    version: "v1".into(),
                    kind: "Pod".into(),
                },
                namespace: Some(namespace.clone()),
                name: name.clone(),
            };
            refuse_named_node_shell(&pod, None)?;
        }
        let local = match args.local_port {
            Some(port) if port != 0 => format!("local port {port}"),
            _ => "a free local port".to_owned(),
        };
        let summary = CallSummary {
            tool: self.method.clone(),
            target: format!("{kind} {namespace}/{name}"),
            details: Some(format!(
                "{local} on 127.0.0.1 → port {} of the {}",
                args.port,
                kind.to_lowercase()
            )),
        };
        let need = (
            Some(namespace.clone()),
            KindPattern::new("", kind),
            AccessAction::PortForward,
        );
        self.check(&cluster, &[need], &summary).await?;
        let forwards = &self.api.forwards;
        if !forwards.room_for(&self.id) {
            return Err(self.denied(format!(
                "Extension {} already has {MAX_FORWARDS_PER_EXTENSION} port forwards; stop one first.",
                self.name()
            )));
        }
        let granted = self.granted().await?;
        let info = with_timeout(
            CHANGE_TIMEOUT,
            "starting the port forward",
            forwards.forwarder()?.start_with_source(
                &self.api.clusters,
                &cluster.id,
                target,
                args.port,
                args.local_port.filter(|p| *p != 0),
                PodFilter::NoNodeAccess,
                ForwardSource::Extension,
            ),
        )
        .await?;
        forwards.add(info.id.clone(), &self.id, granted);
        let mut out = to_value(&info)?;
        out["address"] = json!(format!("127.0.0.1:{}", info.local_port));
        Ok(out)
    }

    /// The extension's own running forwards (of one cluster when named).
    async fn port_forward_list(&self, params: Value) -> CoreResult<Value> {
        let args: ForwardListArgs = parse(&self.method, params)?;
        self.granted().await?;
        let cluster = match non_empty(args.cluster_id.as_deref()) {
            Some(cluster) => Some(self.target(cluster).await?),
            None => None,
        };
        lock(&self.record).target = "own port forwards".to_owned();
        self.decide(AuditDecision::Allowed);
        let forwards: Vec<Value> = self
            .api
            .forwards
            .of(&self.id)
            .into_iter()
            .filter(|f| cluster.as_ref().is_none_or(|c| c.id == f.cluster))
            .map(|f| to_value(&f))
            .collect::<CoreResult<_>>()?;
        Ok(json!({ "forwards": forwards }))
    }

    /// Stops one of the extension's own forwards.
    async fn port_forward_stop(&self, params: Value) -> CoreResult<Value> {
        let args: ForwardStopArgs = parse(&self.method, params)?;
        let id = args.id.trim();
        lock(&self.record).target = clip(&format!("port forward {id}"));
        if !self.api.forwards.is_of(id, &self.id) {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                format!("no port forward {id} of this extension; portForward.list lists them"),
            ));
        }
        self.decide(AuditDecision::Allowed);
        self.api.forwards.forwarder()?.stop(id).await?;
        self.api.forwards.forget(id);
        Ok(Value::Null)
    }

    /// One request to a Service the user agreed to (ADR-0158), through Sextant's own forward: Read and Port forward on
    /// the Service, "Secret values" on each Secret a `{{secret:<name>/<key>}}` body value names. Journaled with the
    /// method and path only; the session token never leaves the backend.
    async fn service_request(&self, params: Value) -> CoreResult<Value> {
        let args: ServiceRequestArgs = parse(&self.method, params)?;
        let namespace = required("namespace", &args.namespace)?.to_owned();
        services::check_path(&args.path)?;
        let query: Vec<(String, String)> = args.query.into_iter().collect();
        let encoded = services::encode_query(&query)?;
        // `session`: the token a `capture` kept; `signIn:<field>`: that sign-in field as the bearer token (ADR-0161).
        let auth = match args.auth.as_deref() {
            None => Auth::None,
            Some("session") => Auth::Session,
            Some(other) => match other.strip_prefix("signIn:") {
                Some(field) if !field.is_empty() => Auth::SignIn(field.to_owned()),
                _ => {
                    return Err(invalid(format!(
                        "auth {other:?}: \"session\" or \"signIn:<field>\""
                    )));
                }
            },
        };
        let session = matches!(auth, Auth::Session);
        let capture = match args.capture.as_deref().map(str::trim) {
            Some(path) => Some(
                parse_field_path(path)
                    .ok_or_else(|| invalid("capture must be a field path such as `.token`"))?,
            ),
            None => None,
        };
        let mut secrets = Vec::new();
        let mut sign_in_fields = Vec::new();
        if let Some(body) = &args.body {
            secret_placeholders(body, &mut secrets)?;
            sign_in_placeholders(body, &mut sign_in_fields)?;
        }
        let entry = active_off_runtime(self.host, &self.id)
            .await?
            .ok_or_else(|| {
                self.decide(AuditDecision::Denied);
                inactive(&self.id)
            })?;
        let service = entry
            .granted_services
            .iter()
            .flatten()
            .find(|s| s.id == args.service)
            .cloned()
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    format!("no service {:?} the user agreed to", args.service),
                )
            })?;
        let declared: Vec<&str> = service
            .sign_in
            .iter()
            .flat_map(|s| &s.fields)
            .map(|f| f.id.as_str())
            .collect();
        if let Auth::SignIn(field) = &auth
            && !sign_in_fields.contains(field)
        {
            sign_in_fields.push(field.clone());
        }
        if let Some(unknown) = sign_in_fields
            .iter()
            .find(|f| !declared.contains(&f.as_str()))
        {
            return Err(invalid(format!(
                "`{{{{signIn:{unknown}}}}}` is no sign-in field of service {}",
                service.id
            )));
        }
        let cluster = self.open(&args.cluster_id).await?;
        let mut needs = vec![
            (
                Some(namespace.clone()),
                KindPattern::new("", "Service"),
                AccessAction::Read,
            ),
            (
                Some(namespace.clone()),
                KindPattern::new("", "Service"),
                AccessAction::PortForward,
            ),
        ];
        // Keys the service declares were agreed to with it; any other needs "Secret values" there (ADR-0161).
        if secrets.iter().any(|(n, k)| !service.receives_secret(n, k)) {
            needs.push((
                Some(namespace.clone()),
                KindPattern::new("", "Secret"),
                AccessAction::SecretValues,
            ));
        }
        let summary = CallSummary {
            tool: self.method.clone(),
            target: format!(
                "Service {namespace}/{}: {} {}",
                service.shown_name(),
                args.method.as_str(),
                args.path
            ),
            details: {
                let mut lines = Vec::new();
                if !secrets.is_empty() {
                    let names: Vec<String> = secrets
                        .iter()
                        .map(|(n, k)| format!("{n} key {k}"))
                        .collect();
                    lines.push(format!("sends values of Secrets: {}", names.join(", ")));
                }
                if !sign_in_fields.is_empty() {
                    lines.push(format!("sends the sign-in: {}", sign_in_fields.join(", ")));
                }
                (!lines.is_empty()).then(|| lines.join("\n"))
            },
        };
        self.check(&cluster, &needs, &summary).await?;
        let mut body = args.body;
        if let Some(body) = body.as_mut() {
            for (name, key) in &secrets {
                let value = read(
                    "reading the Secret",
                    resources::secret_value(&self.api.clusters, &cluster.id, &namespace, name, key),
                )
                .await?;
                fill_secret(body, name, key, &value);
            }
        }
        let key = session_key(&self.id, &cluster.id.0, &namespace, &service.id);
        let mut signed_in = None;
        if !sign_in_fields.is_empty() {
            let values = self
                .sign_in_values(&cluster, &namespace, &service.id, &key)
                .await?;
            if let Some(body) = body.as_mut() {
                for field in &sign_in_fields {
                    let value = values.get(field).ok_or_else(|| {
                        CoreError::new(ErrorCode::Unauthorized, "sign in first (ui.signIn)")
                    })?;
                    fill_placeholder(body, &format!("{{{{signIn:{field}}}}}"), value);
                }
            }
            signed_in = Some(values);
        }
        let service_name = self.service_name(&cluster, &namespace, &service).await?;
        let forward = self
            .service_forward(
                &cluster,
                &namespace,
                &service,
                &service_name,
                &key,
                entry.granted,
            )
            .await?;
        let bearer = match &auth {
            Auth::None => None,
            Auth::Session => Some(self.api.sessions.token(&key, &forward.id).ok_or_else(|| {
                CoreError::new(
                    ErrorCode::Unauthorized,
                    "no session for this service: sign in first (a request with `capture`)",
                )
            })?),
            Auth::SignIn(field) => Some(
                signed_in
                    .as_ref()
                    .and_then(|values| values.get(field))
                    .cloned()
                    .ok_or_else(|| {
                        CoreError::new(ErrorCode::Unauthorized, "sign in first (ui.signIn)")
                    })?,
            ),
        };
        let path_and_query = if encoded.is_empty() {
            args.path.clone()
        } else {
            format!("{}?{encoded}", args.path)
        };
        let answer = services::send(LoopbackRequest {
            port: forward.local_port,
            scheme: service.scheme,
            host: format!("{service_name}.{namespace}.svc"),
            method: args.method,
            path_and_query,
            body,
            bearer,
        })
        .await?;
        let mut out = answer.body;
        let ok = (200..300).contains(&answer.status);
        if session && answer.status == 401 {
            self.api.sessions.forget(&key);
        }
        if let (true, Some(steps)) = (ok, capture.as_deref()) {
            let token = take_at(&mut out, steps).ok_or_else(|| {
                CoreError::new(
                    ErrorCode::Invalid,
                    "the answer has no token at the capture path",
                )
            })?;
            self.api.sessions.set(key, &forward.id, token);
        }
        Ok(json!({ "status": answer.status, "body": out }))
    }

    /// Forgets the session token of a service; nothing is sent.
    async fn service_forget(&self, params: Value) -> CoreResult<Value> {
        let args: ServiceForgetArgs = parse(&self.method, params)?;
        let cluster = self.target(&args.cluster_id).await?;
        lock(&self.record).target = clip(&format!(
            "session of service {} in {}",
            args.service, args.namespace
        ));
        self.decide(AuditDecision::Allowed);
        let key = session_key(&self.id, &cluster.id.0, &args.namespace, &args.service);
        self.api.sessions.forget(&key);
        self.api.sessions.forget_sign_in(&key);
        let (store, id) = (
            Arc::clone(&self.host.backends().credentials),
            self.id.clone(),
        );
        let name = sign_in_credential(&args.service, &cluster.id.0, &args.namespace);
        blocking(move || store.remove(&id, &name)).await?;
        Ok(Value::Null)
    }

    /// The sign-in typed for this service in this run, else one remembered for the same API server and CA.
    async fn sign_in_values(
        &self,
        cluster: &ExtCluster,
        namespace: &str,
        service: &str,
        key: &str,
    ) -> CoreResult<HashMap<String, String>> {
        if let Some(values) = self.api.sessions.sign_in(key) {
            return Ok(values);
        }
        let (store, id) = (
            Arc::clone(&self.host.backends().credentials),
            self.id.clone(),
        );
        let name = sign_in_credential(service, &cluster.id.0, namespace);
        let stored = blocking(move || store.get(&id, &name)).await?;
        let binding = self.api.clusters.server_binding(&cluster.id).ok().flatten();
        let remembered = stored
            .and_then(|text| serde_json::from_str::<RememberedSignIn>(&text).ok())
            .filter(|r| {
                binding
                    .as_ref()
                    .is_some_and(|b| b.server == r.server && b.ca_sha256 == r.ca_sha256)
            });
        match remembered {
            Some(r) => {
                self.api
                    .sessions
                    .set_sign_in(key.to_owned(), r.values.clone());
                Ok(r.values)
            }
            None => Err(CoreError::new(
                ErrorCode::Unauthorized,
                "sign in first (ui.signIn): nothing was typed or remembered for this cluster",
            )),
        }
    }

    /// Sextant's own forward to `service` for this extension, started when there is none (never listed to it).
    /// The name of the Service: the manifest's, or the one Service its label selector picks in `namespace`.
    async fn service_name(
        &self,
        cluster: &ExtCluster,
        namespace: &str,
        service: &ServiceContribution,
    ) -> CoreResult<String> {
        if let Some(name) = &service.name {
            return Ok(name.clone());
        }
        let selector = service.label_selector.as_deref().unwrap_or_default();
        let kind = KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Service".into(),
        };
        let page = read(
            "listing the Services",
            resources::list(
                &self.api.clusters,
                &cluster.id,
                &kind,
                Some(namespace),
                Some(selector),
                None,
                2,
            ),
        )
        .await?;
        let names: Vec<String> = page
            .items
            .iter()
            .filter_map(|s| s["metadata"]["name"].as_str().map(str::to_owned))
            .collect();
        match names.as_slice() {
            [one] => Ok(one.clone()),
            [] => Err(CoreError::new(
                ErrorCode::NotFound,
                format!("no Service {selector} in {namespace}"),
            )),
            _ => Err(CoreError::new(
                ErrorCode::Conflict,
                format!("more than one Service {selector} in {namespace}"),
            )),
        }
    }

    /// Sextant's own forward to `service` for this extension, started when there is none (never listed to it).
    async fn service_forward(
        &self,
        cluster: &ExtCluster,
        namespace: &str,
        service: &ServiceContribution,
        service_name: &str,
        key: &str,
        granted: ExtensionPermissions,
    ) -> CoreResult<ForwardInfo> {
        if let Some(info) = self.api.forwards.internal(&self.id, key) {
            return Ok(info);
        }
        let port = match &service.port {
            Value::Number(n) => n.as_u64().and_then(|p| u16::try_from(p).ok()).unwrap_or(0),
            Value::String(name) => {
                let object = ObjectRef {
                    kind: KindRef {
                        group: String::new(),
                        version: "v1".into(),
                        kind: "Service".into(),
                    },
                    namespace: Some(namespace.to_owned()),
                    name: service_name.to_owned(),
                };
                let found = read(
                    "reading the Service",
                    resources::get(&self.api.clusters, &cluster.id, &object),
                )
                .await?;
                found["spec"]["ports"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|p| p["name"].as_str() == Some(name.as_str()))
                    .and_then(|p| p["port"].as_u64())
                    .and_then(|p| u16::try_from(p).ok())
                    .ok_or_else(|| {
                        CoreError::new(
                            ErrorCode::NotFound,
                            format!("Service {namespace}/{service_name} has no port {name}"),
                        )
                    })?
            }
            _ => 0,
        };
        if port == 0 {
            return Err(invalid("the service's port is not a port"));
        }
        let info = with_timeout(
            CHANGE_TIMEOUT,
            "starting the port forward",
            self.api.forwards.forwarder()?.start_with_source(
                &self.api.clusters,
                &cluster.id,
                ForwardTarget::Service {
                    namespace: namespace.to_owned(),
                    name: service_name.to_owned(),
                },
                port,
                None,
                PodFilter::NoNodeAccess,
                ForwardSource::ExtensionInternal,
            ),
        )
        .await?;
        self.api
            .forwards
            .add_internal(info.id.clone(), &self.id, granted, key.to_owned());
        Ok(info)
    }

    async fn secret_value(&self, params: Value) -> CoreResult<Value> {
        let args: SecretArgs = parse(&self.method, params)?;
        let namespace = required("namespace", &args.namespace)?;
        let name = required("name", &args.name)?;
        let cluster = self.open(&args.cluster_id).await?;
        let need = (
            Some(namespace.to_owned()),
            KindPattern::new("", "Secret"),
            AccessAction::SecretValues,
        );
        let target = format!("Secret {namespace}/{name} key {}", args.key);
        self.check(&cluster, &[need], &summary(target)).await?;
        let value = read(
            "reading the Secret",
            resources::secret_value(&self.api.clusters, &cluster.id, namespace, name, &args.key),
        )
        .await?;
        Ok(Value::String(value))
    }

    // -----------------------------------------------------------------------------------------------------------
    // Helpers

    /// The kind as the cluster serves it; without a version, the version the cluster serves.
    /// One of the metric queries the user agreed to (ADR-0138), by id, with the extension's parameter values, in the
    /// cluster's Prometheus-compatible source. Only the query id and the parameters are journaled, never the answer.
    async fn metric_query(&self, params: Value) -> CoreResult<Value> {
        let args: MetricQueryArgs = parse(&self.method, params)?;
        lock(&self.record).target = clip(&metric_query_target(&args));
        let entry = match active_off_runtime(self.host, &self.id).await? {
            Some(entry) => entry,
            None => {
                self.decide(AuditDecision::Denied);
                return Err(inactive(&self.id));
            }
        };
        let Some(query) = entry
            .granted_metric_queries
            .iter()
            .flatten()
            .find(|q| q.id == args.id)
            .cloned()
        else {
            return Err(self.denied(format!(
                "Sextant denied metric query {:?} for extension {}: it is not a query of its manifest the user \
                 agreed to.",
                args.id,
                self.name()
            )));
        };
        let cluster = self.open(&args.cluster_id).await?;
        // The cluster is granted and the query agreed to: that is the whole decision.
        self.decide(AuditDecision::Allowed);
        let mode = self
            .api
            .settings
            .get()
            .clusters
            .get(&cluster.id.0)
            .map(|c| c.prometheus.clone())
            .unwrap_or_default();
        let now = i64::try_from(now_ms() / 1000).unwrap_or(i64::MAX);
        let answer = run_metric_query(
            &self.api.clusters,
            &cluster.id,
            &mode,
            &query,
            &args.params,
            args.range.as_ref(),
            now,
        )
        .await?;
        to_value(&answer)
    }

    /// One of the commands of its manifest the user agreed to (ADR-0147), with its values put in, in the newest ready
    /// pod of `namespace` its target's labels select (never a node shell or a debug copy). Read on Pods there is
    /// needed to find it; one that changes something asks the user, the filled words shown. Journaled without output.
    async fn exec_run(&self, params: Value) -> CoreResult<Value> {
        let args: ExecArgs = parse(&self.method, params)?;
        let namespace = required("namespace", &args.namespace)?.to_owned();
        lock(&self.record).target = clip(&format!("command {} in {namespace}", args.id));
        let entry = match active_off_runtime(self.host, &self.id).await? {
            Some(entry) => entry,
            None => {
                self.decide(AuditDecision::Denied);
                return Err(inactive(&self.id));
            }
        };
        let Some(command) = entry
            .granted_commands
            .iter()
            .flatten()
            .find(|c| c.id == args.id)
            .cloned()
        else {
            return Err(self.denied(format!(
                "Sextant denied command {:?} for extension {}: it is not a command of its manifest the user agreed \
                 to.",
                args.id,
                self.name()
            )));
        };
        let argv = commands::fill(&command, &args.params)?;
        let cluster = self.open(&args.cluster_id).await?;
        let pods = KindPattern {
            group: String::new(),
            kind: "Pod".to_owned(),
        };
        let summary = CallSummary {
            tool: self.method.clone(),
            target: format!("{} in namespace {namespace}", command.title),
            details: Some(argv.join(" ")),
        };
        self.check_asking(
            &cluster,
            &[(Some(namespace.clone()), pods, AccessAction::Read)],
            &summary,
            command.changes,
        )
        .await?;
        // The journal names the filled words too: which OSD was marked out, not only that one was.
        lock(&self.record).target = clip(&format!("{}: {}", summary.target, argv.join(" ")));
        let pod = self.command_pod(&cluster, &namespace, &command).await?;
        let output = sextant_core::exec::run_command(
            &self.api.clusters,
            &cluster.id,
            &pod,
            Some(&command.target.container),
            &argv,
            commands::timeout_of(&command),
            MAX_OUTPUT_BYTES,
        )
        .await?;
        Ok(json!({
            "pod": pod.name,
            "stdout": output.stdout,
            "stderr": output.stderr,
            "exitCode": output.exit_code,
            "truncated": output.truncated,
            "timedOut": output.timed_out,
        }))
    }

    /// The newest ready, running pod of `namespace` with the command's labels; never a node shell or a debug copy.
    async fn command_pod(
        &self,
        cluster: &ExtCluster,
        namespace: &str,
        command: &commands::CommandContribution,
    ) -> CoreResult<ObjectRef> {
        let kind = KindRef {
            group: String::new(),
            version: "v1".to_owned(),
            kind: "Pod".to_owned(),
        };
        let page = read(
            "listing the pods",
            resources::list(
                &self.api.clusters,
                &cluster.id,
                &kind,
                Some(namespace),
                Some(&command.target.label_selector),
                None,
                200,
            ),
        )
        .await?;
        let ready = |pod: &Value| {
            pod.pointer("/status/phase").and_then(Value::as_str) == Some("Running")
                && pod
                    .pointer("/status/conditions")
                    .and_then(Value::as_array)
                    .is_some_and(|c| {
                        c.iter()
                            .any(|c| c["type"] == "Ready" && c["status"] == "True")
                    })
                && pod.pointer("/metadata/deletionTimestamp").is_none()
        };
        let chosen = page
            .items
            .iter()
            .filter(|pod| {
                ready(pod)
                    && !sextant_core::node_shell::is_node_shell_object(pod)
                    && !sextant_core::debug::is_debug_copy_object(pod)
            })
            .max_by_key(|pod| {
                pod.pointer("/metadata/creationTimestamp")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            })
            .and_then(|pod| pod.pointer("/metadata/name").and_then(Value::as_str));
        let Some(name) = chosen else {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                format!(
                    "no ready pod with the labels {} in namespace {namespace}",
                    command.target.label_selector
                ),
            ));
        };
        Ok(ObjectRef {
            kind,
            namespace: Some(namespace.to_owned()),
            name: name.to_owned(),
        })
    }

    async fn find_kind(&self, cluster: &ExtCluster, kind: &KindArg) -> CoreResult<ResourceKind> {
        let name = kind.kind.trim();
        if name.is_empty() {
            return Err(invalid("the kind is empty"));
        }
        let mut wanted = KindRef {
            group: kind.group.trim().to_owned(),
            version: kind.version.trim().to_owned(),
            kind: name.to_owned(),
        };
        if wanted.version.is_empty() {
            let kinds = read("reading the kinds", self.api.clusters.kinds(&cluster.id)).await?;
            let served = kinds
                .iter()
                .find(|k| k.kind_ref.group == wanted.group && k.kind_ref.kind == wanted.kind)
                .ok_or_else(|| {
                    CoreError::new(
                        ErrorCode::NotFound,
                        format!(
                            "the cluster does not serve the kind {}",
                            pattern_text(&wanted)
                        ),
                    )
                })?;
            wanted.version = served.kind_ref.version.clone();
        }
        read(
            "reading the kind",
            resources::resolve(&self.api.clusters, &cluster.id, &wanted),
        )
        .await
    }

    /// The object the extension named; a namespace only for a kind that has them (required then).
    async fn object(&self, cluster: &ExtCluster, object: &RefArg) -> CoreResult<ObjectRef> {
        let name = required("name", &object.name)?;
        let kind = self.find_kind(cluster, &object.kind).await?;
        let namespace = if kind.namespaced {
            Some(
                non_empty(object.namespace.as_deref())
                    .ok_or_else(|| {
                        invalid(format!("{} {name} needs a namespace", kind.kind_ref.kind))
                    })?
                    .to_owned(),
            )
        } else {
            None
        };
        Ok(ObjectRef {
            kind: kind.kind_ref,
            namespace,
            name: name.to_owned(),
        })
    }

    /// After the check, right before acting on a pod: the shared check that it is not a node shell (failing closed).
    /// A refusal is journaled as denied, not as the allowed it was a moment before.
    async fn refuse_live_node_shell(
        &self,
        cluster: &ExtCluster,
        object: &ObjectRef,
        creates: bool,
    ) -> CoreResult<()> {
        crate::access_guard::refuse_live_node_shell(
            &self.api.clusters,
            &cluster.id,
            object,
            creates,
            NODE_SHELL_REFUSAL,
        )
        .await
        .inspect_err(|err| {
            if err.code == ErrorCode::Denied {
                self.decide(AuditDecision::Denied);
            }
        })
    }
}

/// The `{{secret:<name>/<key>}}` string values of a request body (Secrets of the request's namespace), each once.
fn secret_placeholders(body: &Value, out: &mut Vec<(String, String)>) -> CoreResult<()> {
    match body {
        Value::String(text) => {
            if let Some(inner) = text
                .strip_prefix("{{secret:")
                .and_then(|t| t.strip_suffix("}}"))
            {
                let (name, key) = inner
                    .split_once('/')
                    .filter(|(n, k)| services::is_dns_label(n) && !k.is_empty() && k.len() <= 253)
                    .ok_or_else(|| {
                        invalid("a body value `{{secret:<name>/<key>}}` names a Secret and a key")
                    })?;
                let pair = (name.to_owned(), key.to_owned());
                if !out.contains(&pair) {
                    out.push(pair);
                }
            } else if text.contains("{{secret:") {
                return Err(invalid(
                    "`{{secret:…}}` is a body value of its own, never inside other text",
                ));
            }
        }
        Value::Array(items) => {
            for item in items {
                secret_placeholders(item, out)?;
            }
        }
        Value::Object(map) => {
            for value in map.values() {
                secret_placeholders(value, out)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Puts `value` where the body says `{{secret:<name>/<key>}}`.
fn fill_secret(body: &mut Value, name: &str, key: &str, value: &str) {
    fill_placeholder(body, &format!("{{{{secret:{name}/{key}}}}}"), value);
}

/// Puts `value` where a body string is exactly `wanted`.
fn fill_placeholder(body: &mut Value, wanted: &str, value: &str) {
    match body {
        Value::String(text) if *text == wanted => *text = value.to_owned(),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| fill_placeholder(item, wanted, value)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| fill_placeholder(item, wanted, value)),
        _ => {}
    }
}

/// The `{{signIn:<field>}}` string values of a request body, each once.
fn sign_in_placeholders(body: &Value, out: &mut Vec<String>) -> CoreResult<()> {
    match body {
        Value::String(text) => {
            if let Some(field) = text
                .strip_prefix("{{signIn:")
                .and_then(|t| t.strip_suffix("}}"))
            {
                if !out.iter().any(|f| f == field) {
                    out.push(field.to_owned());
                }
            } else if text.contains("{{signIn:") {
                return Err(invalid(
                    "`{{signIn:…}}` is a body value of its own, never inside other text",
                ));
            }
        }
        Value::Array(items) => items
            .iter()
            .try_for_each(|item| sign_in_placeholders(item, out))?,
        Value::Object(map) => map
            .values()
            .try_for_each(|item| sign_in_placeholders(item, out))?,
        _ => {}
    }
    Ok(())
}

/// Takes the non-empty string at `steps` out of `value` (replaced by `<hidden>`).
fn take_at(value: &mut Value, steps: &[PathStep]) -> Option<String> {
    let mut at = value;
    for step in steps {
        at = match step {
            PathStep::Key(key) => at.get_mut(key.as_str())?,
            PathStep::Index(i) => at.get_mut(*i)?,
            PathStep::Match { field, value } => at.as_array_mut()?.iter_mut().find(|item| {
                item.get(field.as_str()).and_then(Value::as_str) == Some(value.as_str())
            })?,
        };
    }
    let token = at.as_str().filter(|t| !t.is_empty())?.to_owned();
    *at = Value::String("<hidden>".into());
    Some(token)
}

/// An object as an extension gets it: the secret material its kind holds inline emptied
/// ([`inline_secrets::hide_inline_secrets`]; a Secret's values are already gone in the core).
fn without_inline_secrets(mut value: Value) -> Value {
    inline_secrets::hide_inline_secrets(&mut value);
    value
}

/// The namespaces both scopes cover.
fn intersect(a: NamespaceScope, b: NamespaceScope) -> NamespaceScope {
    match (a, b) {
        (NamespaceScope::All, other) | (other, NamespaceScope::All) => other,
        (NamespaceScope::Only { namespaces }, NamespaceScope::Only { namespaces: other }) => {
            NamespaceScope::Only {
                namespaces: namespaces
                    .into_iter()
                    .filter(|n| other.contains(n))
                    .collect(),
            }
        }
    }
}

/// The rules an extension was granted, as the agent's access model reads them.
fn rules_of(granted: &ExtensionPermissions) -> ClusterAccess {
    // `..default()` keeps this building when the agent's access gains fields; the rules are all an extension has.
    #[allow(clippy::needless_update)]
    ClusterAccess {
        preset: AccessPreset::Custom,
        rules: granted.rules.clone(),
        ..ClusterAccess::default()
    }
}

fn inactive(id: &str) -> CoreError {
    CoreError::new(
        ErrorCode::Denied,
        format!(
            "Extension {id} is not installed, is disabled or waits for the user's consent; Sextant runs none of its \
             calls."
        ),
    )
}

fn is_core_secret(kind: &KindRef) -> bool {
    kind.group.is_empty() && kind.kind == "Secret"
}

/// Before the check: a pod named like a node shell, or a pod document that is one (the shared check, with the
/// extensions' text). Refused without asking and without reading the cluster.
fn refuse_named_node_shell(object: &ObjectRef, document: Option<&Value>) -> CoreResult<()> {
    crate::access_guard::refuse_named_node_shell(object, document, NODE_SHELL_REFUSAL)
}

fn requirement(object: &ObjectRef, action: AccessAction) -> Requirement {
    (object.namespace.clone(), pattern_of(&object.kind), action)
}

fn pattern_of(kind: &KindRef) -> KindPattern {
    KindPattern::new(kind.group.clone(), kind.kind.clone())
}

fn pattern_text(kind: &KindRef) -> String {
    if kind.group.is_empty() {
        kind.kind.clone()
    } else {
        format!("{}/{}", kind.group, kind.kind)
    }
}

fn summary(target: String) -> CallSummary {
    CallSummary {
        tool: String::new(),
        target,
        details: None,
    }
}

/// `Pod team-a/web-1`, `Node worker-1`.
fn describe(object: &ObjectRef) -> String {
    match object.namespace.as_deref().filter(|ns| !ns.is_empty()) {
        Some(ns) => format!("{} {ns}/{}", object.kind.kind, object.name),
        None => format!("{} {}", object.kind.kind, object.name),
    }
}

fn targets_text(objects: &[ObjectRef]) -> String {
    match objects {
        [one] => describe(one),
        many => format!(
            "{} objects: {}",
            many.len(),
            many.iter().map(describe).collect::<Vec<_>>().join(", ")
        ),
    }
}

fn apply_details(objects: &[ObjectRef], yaml: &str) -> String {
    let count = match objects.len() {
        1 => "1 object".to_owned(),
        n => format!("{n} objects"),
    };
    let list: Vec<String> = objects.iter().map(describe).collect();
    format!("{count}:\n{}\n\n{}", list.join("\n"), first_lines(yaml))
}

fn non_empty(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|t| !t.is_empty())
}

fn required<'a>(field: &str, value: &'a str) -> CoreResult<&'a str> {
    non_empty(Some(value)).ok_or_else(|| invalid(format!("{field} is required")))
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

pub(super) fn code_name(code: ErrorCode) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "other".to_owned())
}

fn to_value<T: serde::Serialize>(value: &T) -> CoreResult<Value> {
    serde_json::to_value(value).map_err(|e| CoreError::other(e.to_string()))
}

async fn read<T>(what: &str, call: impl Future<Output = CoreResult<T>>) -> CoreResult<T> {
    with_timeout(READ_TIMEOUT, what, call).await
}

fn parse<T: DeserializeOwned>(method: &str, params: Value) -> CoreResult<T> {
    serde_json::from_value(params)
        .map_err(|e| invalid(format!("invalid parameters of {method}: {e}")))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------------------------------------------
// Parameters

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

/// A kind: `{group, version?, kind}` (the core group is `""`; without a version, the one the cluster serves).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KindArg {
    #[serde(default)]
    group: String,
    #[serde(default)]
    version: String,
    kind: String,
}

/// An object: `{kind, namespace?, name}` (the shape of `ObjectRef`, the version optional).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RefArg {
    kind: KindArg,
    #[serde(default)]
    namespace: Option<String>,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecArgs {
    cluster_id: String,
    id: String,
    namespace: String,
    #[serde(default)]
    params: std::collections::BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetManyArgs {
    cluster_id: String,
    refs: Vec<RefArg>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClusterArgs {
    cluster_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MetricQueryArgs {
    cluster_id: String,
    id: String,
    #[serde(default)]
    params: BTreeMap<String, String>,
    #[serde(default)]
    range: Option<MetricQueryRange>,
}

/// `<id>(<name>=<value>, …)`, and the range when there is one: what the journal says of a metric query.
fn metric_query_target(args: &MetricQueryArgs) -> String {
    let params: Vec<String> = args
        .params
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect();
    let range = args
        .range
        .as_ref()
        .map(|r| format!(" over {} min every {}", r.minutes, r.step))
        .unwrap_or_default();
    format!("{}({}){range}", args.id, params.join(", "))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListArgs {
    cluster_id: String,
    kind: KindArg,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    label_selector: Option<String>,
    #[serde(default)]
    field_selector: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObjectArgs {
    cluster_id: String,
    #[serde(rename = "ref")]
    object: RefArg,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WatchArgs {
    cluster_id: String,
    kind: KindArg,
    #[serde(default)]
    namespaces: Option<Vec<String>>,
    #[serde(default)]
    label_selector: Option<String>,
    #[serde(default)]
    field_selector: Option<String>,
    #[serde(default)]
    metadata_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyArgs {
    cluster_id: String,
    yaml: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchArgs {
    cluster_id: String,
    #[serde(rename = "ref")]
    object: RefArg,
    patch: Value,
    patch_type: PatchType,
    /// `status`: the status subresource of a kind granted in `statusPatches` (ADR-0155).
    #[serde(default)]
    subresource: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogsOpenArgs {
    cluster_id: String,
    namespace: String,
    /// One pod, or the pods `label_selector` picks.
    #[serde(default)]
    pod: Option<String>,
    #[serde(default)]
    label_selector: Option<String>,
    #[serde(default)]
    container: Option<String>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
enum ForwardKindArg {
    Pod,
    Service,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForwardStartArgs {
    cluster_id: String,
    namespace: String,
    kind: ForwardKindArg,
    name: String,
    port: u16,
    #[serde(default)]
    local_port: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForwardListArgs {
    #[serde(default)]
    cluster_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForwardStopArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceRequestArgs {
    cluster_id: String,
    namespace: String,
    /// The id of one of the services the user agreed to.
    service: String,
    method: ServiceMethod,
    path: String,
    #[serde(default)]
    query: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<Value>,
    /// `session`: Sextant adds the session token it holds for this service.
    #[serde(default)]
    auth: Option<String>,
    /// A field path of the JSON answer holding a token: Sextant keeps it as the session and takes it out of the answer.
    #[serde(default)]
    capture: Option<String>,
}

/// A patch's shape, checked before any cluster is touched; whether it patches the status.
fn patch_shape(item: &PatchItem) -> CoreResult<bool> {
    match item.patch_type {
        PatchType::Merge if !item.patch.is_object() => {
            return Err(invalid("a merge patch is a JSON object"));
        }
        PatchType::Json => check_json_patch(&item.patch)?,
        PatchType::Merge => {}
    }
    match item.subresource.as_deref() {
        None => Ok(false),
        Some("status") => Ok(true),
        Some(other) => Err(invalid(format!(
            "subresource {other:?}: only \"status\" can be patched"
        ))),
    }
}

/// Items one `resources.patchMany` sends at most.
pub const MAX_PATCH_MANY: usize = 50;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchItem {
    #[serde(rename = "ref")]
    object: RefArg,
    patch: Value,
    patch_type: PatchType,
    #[serde(default)]
    subresource: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchManyArgs {
    cluster_id: String,
    items: Vec<PatchItem>,
}

/// A patch checked for its shape and object.
struct PlannedPatch {
    object: ObjectRef,
    patch: Value,
    patch_type: PatchType,
    status: bool,
    needs: Vec<Requirement>,
}

impl PlannedPatch {
    fn target(&self) -> String {
        if self.status {
            format!("status of {}", describe(&self.object))
        } else {
            describe(&self.object)
        }
    }

    fn shown(&self) -> String {
        serde_json::to_string_pretty(&self.patch).unwrap_or_default()
    }
}

/// How a service request is authenticated.
enum Auth {
    None,
    /// The token a `capture` kept.
    Session,
    /// A sign-in field as the bearer token.
    SignIn(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceForgetArgs {
    cluster_id: String,
    namespace: String,
    service: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogArgs {
    cluster_id: String,
    namespace: String,
    pod: String,
    #[serde(default)]
    container: Option<String>,
    #[serde(default)]
    lines: Option<u32>,
    #[serde(default)]
    previous: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SecretArgs {
    cluster_id: String,
    namespace: String,
    name: String,
    key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyArgs {
    key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetArgs {
    key: String,
    value: Value,
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

/// Runs one API method for an extension (see the module docs). `streamId` and `onEvent` (a channel, which other
/// methods do not take) are required by `resources.watch`: its updates go through the channel, and the stream is
/// stopped by its id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn extension_call<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, AppState>,
    host: State<'_, ExtensionHost>,
    extension_id: String,
    method: String,
    params: Option<Value>,
    stream_id: Option<String>,
    on_event: Option<JavaScriptChannelId>,
) -> CoreResult<Value> {
    let sink = stream_id.zip(on_event).map(|(id, channel)| {
        let channel = channel.channel_on::<R, WatchUpdate>(webview);
        let sink: UpdateSink = Arc::new(move |update| channel.send(update).is_ok());
        (id, sink)
    });
    state
        .ext_api
        .call(
            host.inner(),
            &extension_id,
            &method,
            params.unwrap_or(Value::Null),
            sink,
        )
        .await
}

/// Stops a watch stream of `extensionId`; a stream of another extension is not touched, and one that already ended
/// (or never existed) is not an error.
/// What the user typed in Sextant's own sign-in dialog for an extension's service (`ui.signIn`, ADR-0160): kept for
/// this run, and in the keyring bound to the cluster's API server when `remember` is set. The window's only: the frame
/// never sees the values, and the command is no extension method.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn extension_service_sign_in(
    state: State<'_, AppState>,
    host: State<'_, ExtensionHost>,
    extension_id: String,
    cluster_id: String,
    namespace: String,
    service: String,
    values: HashMap<String, String>,
    remember: bool,
) -> CoreResult<()> {
    state
        .ext_api
        .sign_in(
            host.inner(),
            &extension_id,
            &cluster_id,
            &namespace,
            &service,
            values,
            remember,
        )
        .await
}

/// Longest sign-in value.
pub const MAX_SIGN_IN_CHARS: usize = 4096;

impl ExtensionApi {
    /// See [`extension_service_sign_in`].
    #[allow(clippy::too_many_arguments)]
    pub async fn sign_in(
        &self,
        host: &ExtensionHost,
        extension_id: &str,
        cluster_id: &str,
        namespace: &str,
        service: &str,
        values: HashMap<String, String>,
        remember: bool,
    ) -> CoreResult<()> {
        let entry = active_off_runtime(host, extension_id)
            .await?
            .ok_or_else(|| inactive(extension_id))?;
        let fields: Vec<String> = entry
            .granted_services
            .iter()
            .flatten()
            .find(|s| s.id == service)
            .and_then(|s| s.sign_in.as_ref())
            .map(|s| s.fields.iter().map(|f| f.id.clone()).collect())
            .ok_or_else(|| {
                invalid(format!(
                    "service {service:?} of {extension_id} has no sign-in"
                ))
            })?;
        let mut given: Vec<&String> = values.keys().collect();
        given.sort();
        let mut wanted: Vec<&String> = fields.iter().collect();
        wanted.sort();
        if given != wanted
            || values
                .values()
                .any(|v| v.chars().count() > MAX_SIGN_IN_CHARS)
        {
            return Err(invalid(
                "the sign-in has other fields than the service declares",
            ));
        }
        let cluster = self
            .cluster_list()
            .into_iter()
            .find(|c| c.id.0 == cluster_id)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "no such cluster"))?;
        let key = session_key(extension_id, &cluster.id.0, namespace, service);
        // A new sign-in replaces the session it made.
        self.sessions.forget(&key);
        let store = Arc::clone(&host.backends().credentials);
        let (id, name) = (
            extension_id.to_owned(),
            sign_in_credential(service, &cluster.id.0, namespace),
        );
        if remember {
            let binding = self.clusters.server_binding(&cluster.id)?.ok_or_else(|| {
                CoreError::new(
                    ErrorCode::Unreachable,
                    "connect the cluster to remember a sign-in",
                )
            })?;
            let text = serde_json::to_string(&RememberedSignIn {
                values: values.clone(),
                server: binding.server,
                ca_sha256: binding.ca_sha256,
            })
            .map_err(|_| CoreError::other("the sign-in cannot be stored"))?;
            blocking(move || store.set(&id, &name, &text)).await?;
        } else {
            blocking(move || store.remove(&id, &name)).await?;
        }
        self.sessions.set_sign_in(key, values);
        self.journal(AuditEntry {
            at: now_ms(),
            source: ConfirmSource::Extension,
            principal: clip(&format!("Extension {extension_id}")),
            client: clip(extension_id),
            cluster_id: Some(cluster.id.clone()),
            cluster_name: Some(self.cluster_name(&cluster.id, &cluster.context)),
            tool: "ui.signIn".to_owned(),
            target: clip(&format!(
                "sign-in of service {service} in {namespace}{}",
                if remember { ", remembered" } else { "" }
            )),
            decision: AuditDecision::Allowed,
            result: "ok".to_owned(),
            duration_ms: 0,
        });
        Ok(())
    }
}

#[tauri::command]
pub async fn extension_watch_stop(
    state: State<'_, AppState>,
    extension_id: String,
    stream_id: String,
) -> CoreResult<()> {
    state.ext_api.streams.stop_of(&extension_id, &stream_id);
    Ok(())
}

/// The extensions' journal, newest first; one extension's calls when `extensionId` is given.
#[tauri::command]
pub async fn extension_audit_list(
    state: State<'_, AppState>,
    extension_id: Option<String>,
) -> CoreResult<Vec<AuditEntry>> {
    Ok(state.ext_api.audit_list(extension_id.as_deref()))
}

#[tauri::command]
pub async fn extension_audit_clear(state: State<'_, AppState>) -> CoreResult<()> {
    state.ext_api.audit.clear().map_err(CoreError::from)
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;
