//! The API extensions reach clusters through: the window's extension host forwards a frame's request as
//! `extension_call(extensionId, method, params, streamId?)`, and every call is checked here, in Rust, against what the
//! user granted at install — never against the manifest, never trusting the window.
//!
//! A call runs only when the extension is installed, enabled and within what was granted ([`ExtensionHost::active`],
//! read fresh on every call), the cluster is one it was granted (by kubeconfig context name), and
//! [`decide_extension`] allows every object it touches. A covering rule with `confirm` asks the user in the window
//! (the dialog names the extension, the same dialog and pending map as AI agents). Every cluster call is written to the
//! extensions' journal (`extensions-audit.jsonl`, event `ext-audit`).
//!
//! As for agents (ADR-0043, ADR-0045): Secrets come without their values from `resources.get/list/watch`; one value
//! needs `secret.value` and the "Secret values" action; a JSON patch on a Secret that is not only add/replace/remove
//! needs "Secret values" too; node shell pods are never changed or deleted, whatever the rules, and a pod that cannot
//! be read to make sure is refused.
//!
//! `resources.watch` streams updates as `ext-watch:<streamId>` events (the payload of `watch:<id>`); the stream lives
//! in [`ExtensionStreams`] (in `AppState`) from before the watch starts, and ends with `extension_watch_stop`, the
//! extension being disabled, removed or granted other permissions, its cluster closed, the page reloaded or the window closed.
//!
//! `storage.*` keeps one JSON object per extension in `<data>/extensions-data/<id>.json`, at most [`MAX_STORAGE_BYTES`].

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
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
use sextant_core::extensions::{ExtensionPermissions, decide_extension};
use sextant_core::resources::{self, KindRef, PatchType, ResourceKind, WatchUpdate};
use sextant_core::{
    ClusterId, ClusterManager, ConnectionState, CoreError, CoreResult, ErrorCode, ObjectRef,
    SettingsStore, WatchSpec, logs,
};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::task::AbortHandle;

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

/// Prefix of the events of a `resources.watch` stream: `ext-watch:<streamId>`, payload a `WatchUpdate`.
pub const EXT_WATCH_PREFIX: &str = "ext-watch:";
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

/// The methods `extension_call` serves (`ui.*` and the context are the window's).
pub const METHODS: [&str; 13] = [
    "clusters.list",
    "kinds",
    "resources.list",
    "resources.get",
    "resources.watch",
    "resources.apply",
    "resources.patch",
    "resources.delete",
    "logs.tail",
    "secret.value",
    "storage.get",
    "storage.set",
    "storage.remove",
];

const NODE_SHELL_REFUSAL: &str = "Sextant does not let extensions change or delete node shell pods";

/// `ext-watch:<id>`.
pub fn ext_watch_event(stream_id: &str) -> String {
    format!("{EXT_WATCH_PREFIX}{stream_id}")
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
pub type UpdateSink = Arc<dyn Fn(&WatchUpdate) -> bool + Send + Sync>;

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
    /// else since the stream was opened (reinstalled with other permissions).
    pub fn stop_changed(&self, host: &ExtensionHost) {
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

/// Wires the host's events as the app does (`start_extensions`): on every event the streams of `api` whose extension
/// was disabled, removed, paused for consent or granted anything else stop, then `forward` gets the event.
pub fn wire_host_events(
    host: &ExtensionHost,
    api: &ExtensionApi,
    forward: impl Fn(HostEvent) + Send + Sync + 'static,
) {
    host.set_emitter(host_emitter(
        Arc::clone(&api.streams),
        host.downgrade(),
        forward,
    ));
}

/// The extension host's emitter: on every event of the host (`extensions-changed` above all) the streams of
/// extensions that were disabled, removed or granted anything else stop, then `forward` gets the event. Holds the host
/// weakly (the host keeps its emitter).
fn host_emitter(
    streams: Arc<ExtensionStreams>,
    host: WeakExtensionHost,
    forward: impl Fn(HostEvent) + Send + Sync + 'static,
) -> Arc<dyn Fn(HostEvent) + Send + Sync> {
    Arc::new(move |event| {
        if let Some(host) = host.upgrade() {
            streams.stop_changed(&host);
        }
        forward(event);
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The API

/// The extensions' API: kept in `AppState::ext_api`.
pub struct ExtensionApi {
    clusters: ClusterManager,
    settings: Arc<SettingsStore>,
    kinds: Arc<dyn KindLookup>,
    /// Shared with the MCP server: one pending map, one answer command.
    confirmations: Arc<Confirmations>,
    /// `extensions-audit.jsonl`
    pub audit: AuditLog,
    pub streams: Arc<ExtensionStreams>,
    emitter: RwLock<Option<ApiEmitter>>,
    /// One `storage` change at a time.
    storage: Arc<Mutex<()>>,
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
            emitter: RwLock::new(None),
            storage: Arc::new(Mutex::new(())),
        }
    }

    /// Where `mcp-confirm` (for extensions) and `ext-audit` go.
    pub fn set_emitter(&self, emitter: ApiEmitter) {
        *self.emitter.write().unwrap_or_else(|e| e.into_inner()) = Some(emitter);
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
        &self,
        host: &ExtensionHost,
        extension_id: &str,
        method: &str,
        params: Value,
        watch: Option<(String, UpdateSink)>,
    ) -> CoreResult<Value> {
        let params = if params.is_null() { json!({}) } else { params };
        // Files are read and written off the async runtime: `storage` syncs to disk, and the manifest of a
        // development folder is read by walking the folder (kept afterwards, so the checks below find it ready).
        let (blocking_host, id) = (host.clone(), extension_id.to_owned());
        match method {
            "storage.get" | "storage.set" | "storage.remove" => {
                let (storage, method) = (Arc::clone(&self.storage), method.to_owned());
                return blocking(move || {
                    storage_call(&blocking_host, &storage, &id, &method, params)
                })
                .await;
            }
            _ => {
                blocking(move || Ok(blocking_host.info(&id))).await?;
            }
        }
        let at = now_ms();
        let started = Instant::now();
        let call = ExtCall::new(self, host, extension_id, method);
        let result = match method {
            "clusters.list" => call.clusters_list(params),
            "kinds" => call.kinds(params).await,
            "resources.list" => call.list(params).await,
            "resources.get" => call.get(params).await,
            "resources.watch" => call.watch(params, watch).await,
            "resources.apply" => call.apply(params).await,
            "resources.patch" => call.patch(params).await,
            "resources.delete" => call.delete(params).await,
            "logs.tail" => call.logs(params).await,
            "secret.value" => call.secret_value(params).await,
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
            decision: record.decision.unwrap_or(AuditDecision::Allowed),
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
                        if !sink(&update) {
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
        // (`stop_changed` on `extensions-changed`), one before this is caught here.
        if host.active(extension).map(|e| e.granted) != Some(granted) {
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
    method: String,
    record: Mutex<CallRecord>,
}

impl<'a> ExtCall<'a> {
    fn new(api: &'a ExtensionApi, host: &'a ExtensionHost, id: &str, method: &str) -> Self {
        Self {
            api,
            host,
            id: id.to_owned(),
            method: method.to_owned(),
            record: Mutex::new(CallRecord::default()),
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
        self.host
            .info(&self.id)
            .map_or_else(|| self.id.clone(), |i| i.name)
    }

    /// `Extension <name>`: who asks, in the dialog and the journal.
    fn principal(&self) -> String {
        clip(&format!("Extension {}", self.name()))
    }

    /// What was granted, read fresh: refused unless the extension is active now.
    fn granted(&self) -> CoreResult<ExtensionPermissions> {
        match self.host.active(&self.id) {
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

    /// The cluster the extension named (id, or context), if it was granted; nothing is connected.
    fn target(&self, cluster: &str) -> CoreResult<ExtCluster> {
        let granted = self.granted()?;
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
        self.decide(AuditDecision::Allowed);
        Ok(target)
    }

    /// [`ExtCall::target`], connected (like the Connect button) when it is not.
    async fn open(&self, cluster: &str) -> CoreResult<ExtCluster> {
        let target = self.target(cluster)?;
        let connected = matches!(
            self.api.clusters.state(&target.id),
            ConnectionState::Connected
        );
        if !connected {
            self.api.clusters.connect(&target.id).await?;
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
        let target = clip(&summary.target);
        lock(&self.record).target = target.clone();
        let mut seen = Vec::with_capacity(requirements.len());
        for (namespace, kind, action) in requirements {
            let namespace =
                effective_namespace(&*self.api.kinds, &cluster.id, namespace.as_deref(), kind)
                    .await;
            seen.push((namespace, kind.clone(), *action));
        }
        let confirm = self.decide_all(cluster, &seen, summary)?;
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
                self.decide_all(cluster, &seen, summary)?;
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

    /// Decides every requirement against what is granted now; `Ok(true)` when the user must be asked.
    fn decide_all(
        &self,
        cluster: &ExtCluster,
        requirements: &[(Option<String>, KindPattern, AccessAction)],
        summary: &CallSummary,
    ) -> CoreResult<bool> {
        let granted = self.granted()?;
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
        }
        Ok(confirm)
    }

    /// Namespaces where `action` on `kind` is granted, for a call over all namespaces: `All`, or the namespaces of
    /// the covering rules. Nowhere is a refusal. A call narrowed to some namespaces is journaled with them.
    fn allowed_namespaces(
        &self,
        cluster: &ExtCluster,
        kind: &KindPattern,
        action: AccessAction,
        summary: &CallSummary,
    ) -> CoreResult<NamespaceScope> {
        lock(&self.record).target = clip(&summary.target);
        let granted = self.granted()?;
        let scope = if granted.clusters.covers(&cluster.context) {
            access::allowed_namespaces(&rules_of(&granted), kind, action)
        } else {
            NamespaceScope::Only {
                namespaces: Vec::new(),
            }
        };
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
        Ok(scope)
    }

    // -----------------------------------------------------------------------------------------------------------
    // Methods

    fn clusters_list(&self, params: Value) -> CoreResult<Value> {
        let _: NoArgs = parse(&self.method, params)?;
        let granted = self.granted()?;
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
                    "state": self.api.clusters.state(&c.id),
                })
            })
            .collect();
        Ok(Value::Array(clusters))
    }

    async fn kinds(&self, params: Value) -> CoreResult<Value> {
        let args: ClusterArgs = parse(&self.method, params)?;
        let cluster = self.open(&args.cluster_id).await?;
        let kinds = read("reading the kinds", self.api.clusters.kinds(&cluster.id)).await?;
        let granted = self.granted()?;
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
                self.allowed_namespaces(&cluster, &pattern, AccessAction::Read, &summary)?
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
        // Always without Secret values (`resources::get`); one value is `secret.value`.
        read(
            "reading the object",
            resources::get(&self.api.clusters, &cluster.id, &object),
        )
        .await
    }

    async fn watch(&self, params: Value, sink: Option<(String, UpdateSink)>) -> CoreResult<Value> {
        let args: WatchArgs = parse(&self.method, params)?;
        let Some((stream_id, sink)) = sink else {
            return Err(invalid("resources.watch needs a stream id"));
        };
        check_stream_id(&stream_id)?;
        // The grant every check below is made under (or a later one, which the stream then fails to match).
        let granted = self.granted()?;
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
            match self.allowed_namespaces(&cluster, &pattern, AccessAction::Read, &summary)? {
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
        // `resources::watch` gives Secrets without their values, like `watch_start`.
        let open = async move { resources::watch(&mgr, &cluster_id, spec).await };
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
        match args.patch_type {
            PatchType::Merge if !args.patch.is_object() => {
                return Err(invalid("a merge patch is a JSON object"));
            }
            PatchType::Json => check_json_patch(&args.patch)?,
            PatchType::Merge => {}
        }
        let cluster = self.open(&args.cluster_id).await?;
        let object = self.object(&cluster, &args.object).await?;
        refuse_named_node_shell(&object, None)?;
        let mut needs = vec![requirement(&object, AccessAction::Modify)];
        // On a Secret, a JSON patch other than add/replace/remove may read its values: only with "Secret values".
        if is_core_secret(&object.kind)
            && args.patch_type == PatchType::Json
            && reads_secret_values(&args.patch)
        {
            needs.push(requirement(&object, AccessAction::SecretValues));
        }
        let shown = serde_json::to_string_pretty(&args.patch).unwrap_or_default();
        let summary = CallSummary {
            tool: self.method.clone(),
            target: describe(&object),
            details: Some(first_lines(&shown)),
        };
        self.check(&cluster, &needs, &summary).await?;
        self.refuse_live_node_shell(&cluster, &object, false)
            .await?;
        with_timeout(
            CHANGE_TIMEOUT,
            "patching the object",
            resources::patch(
                &self.api.clusters,
                &cluster.id,
                &object,
                &args.patch,
                args.patch_type,
            ),
        )
        .await
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

fn code_name(code: ErrorCode) -> String {
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
struct ClusterArgs {
    cluster_id: String,
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

/// Runs one API method for an extension (see the module docs). `streamId` is required by `resources.watch`, whose
/// updates arrive as `ext-watch:<streamId>`.
#[tauri::command]
pub async fn extension_call<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    host: State<'_, ExtensionHost>,
    extension_id: String,
    method: String,
    params: Option<Value>,
    stream_id: Option<String>,
) -> CoreResult<Value> {
    let sink = stream_id.map(|id| {
        let event = ext_watch_event(&id);
        let handle = app.clone();
        let sink: UpdateSink = Arc::new(move |update| handle.emit(&event, update).is_ok());
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
