//! Connections to clusters: one `kube::Client` per connected cluster, connection states, discovery cache.
//!
//! Discovery runs once per connection (and again after `refresh_kinds`, when CRDs change): callers that ask while it runs wait for the same answer, and it stops when
//! the last of them gives up. It lists kinds only (two requests on servers with aggregated discovery); printer
//! columns of custom resources are read from their one CRD when that kind is opened, never from the whole list.
//!
//! `connect` builds a client from the cluster's kubeconfig context and proves it with an authenticated request
//! (`GET /api`), so a wrong token, a missing exec plugin or an unreachable server shows up as the connection
//! error, not later in a table. Credentials are only handed to kube-rs; they are never logged or returned.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use kube::config::KubeConfigOptions;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode, kube_error};
use crate::kubeconfig::{ClusterId, KubeconfigRegistry, kubeconfig_error};
use crate::resources::{KindRef, ResourceKind};

/// How long a TCP/TLS connect may take.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the whole connection check (exec plugin + first request) may take.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// When the connection's client repeats a request the server asked to repeat (429 Too Many Requests, 503 Service
/// Unavailable, 504 Gateway Timeout): at most [`RetryPolicy::MAX_RETRIES`] times, pausing 0.5 s, 1 s, 2 s, and never
/// more than [`RetryPolicy::MAX_WAIT`] in total. A `Retry-After` (in seconds) longer than the pause is waited for, if
/// it fits into what is left of the budget; otherwise the server's answer is returned at once. One value per request:
/// a copy starts from zero.
///
/// It replaces kube's `server_retry` (15 repeats, pauses up to 1000 s, any `Retry-After`), with which an action could
/// hang for minutes.
#[derive(Debug, Clone, Default)]
pub struct RetryPolicy {
    retries: u32,
    waited: Duration,
}

impl RetryPolicy {
    pub const MAX_RETRIES: u32 = 3;
    pub const MAX_WAIT: Duration = Duration::from_secs(5);
    const FIRST_PAUSE: Duration = Duration::from_millis(500);

    /// The pause before repeating a request answered with `status` (and the `Retry-After` header, if any), or `None`
    /// when the answer is final.
    pub fn next_delay(&mut self, status: u16, retry_after: Option<&str>) -> Option<Duration> {
        if !matches!(status, 429 | 503 | 504) || self.retries >= Self::MAX_RETRIES {
            return None;
        }
        let backoff = Self::FIRST_PAUSE * 2u32.pow(self.retries);
        let asked = retry_after
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let pause = asked.map_or(backoff, |asked| asked.max(backoff));
        if self.waited + pause > Self::MAX_WAIT {
            return None;
        }
        self.retries += 1;
        self.waited += pause;
        Some(pause)
    }
}

/// Connection state of one cluster. Serialized with a `state` tag:
/// `{ "state": "connected" }`, `{ "state": "error", "code": "unreachable", "message": "…" }`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum ConnectionState {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Error(CoreError),
}

/// Shared handle to all cluster connections. Cheap to clone.
#[derive(Clone)]
pub struct ClusterManager {
    inner: Arc<Inner>,
}

struct Inner {
    registry: Arc<RwLock<KubeconfigRegistry>>,
    clusters: Mutex<HashMap<ClusterId, Entry>>,
    state_tx: broadcast::Sender<(ClusterId, ConnectionState)>,
    /// See [`ClusterManager::sweep_node_shells_on_connect`].
    sweep_node_shells: AtomicBool,
}

/// Everything known about one cluster. `generation` grows with every connect/disconnect, so a slow connect
/// that was overtaken by a disconnect (or a newer connect) does not overwrite the newer state.
#[derive(Default)]
struct Entry {
    state: ConnectionState,
    generation: u64,
    client: Option<kube::Client>,
    kinds: Option<Vec<ResourceKind>>,
    /// The discovery that is running; every caller of `kinds` awaits this one.
    discovery: Option<Discovery>,
}

/// A running discovery, shared by everyone waiting for it.
type Discovery = Shared<BoxFuture<'static, CoreResult<Vec<ResourceKind>>>>;

impl ClusterManager {
    pub fn new(registry: Arc<RwLock<KubeconfigRegistry>>) -> Self {
        let (state_tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(Inner {
                registry,
                clusters: Mutex::new(HashMap::new()),
                state_tx,
                sweep_node_shells: AtomicBool::new(false),
            }),
        }
    }

    /// The kubeconfig registry this manager reads contexts from.
    pub fn registry(&self) -> Arc<RwLock<KubeconfigRegistry>> {
        Arc::clone(&self.inner.registry)
    }

    /// From now on every successful [`ClusterManager::connect`] starts [`crate::node_shell::sweep`] in the background:
    /// node shell pods left by an earlier run (or older than 8 hours) are deleted. The application turns it on; a
    /// manager in tests does not sweep unless asked to. Errors (no right to list or delete pods in `kube-system`) are
    /// ignored.
    pub fn sweep_node_shells_on_connect(&self) {
        self.inner.sweep_node_shells.store(true, Ordering::SeqCst);
    }

    /// Connects (or reconnects) a cluster: `connecting`, then `connected` or `error`. The discovery cache is
    /// dropped. Subscriptions made with the previous client keep running.
    pub async fn connect(&self, id: &ClusterId) -> CoreResult<()> {
        let generation = self.update(id, |entry| {
            entry.generation += 1;
            entry.state = ConnectionState::Connecting;
            entry.generation
        });
        self.broadcast(id, ConnectionState::Connecting);

        let result = self.open_client(id).await;

        let applied = self.update(id, |entry| {
            if entry.generation != generation {
                return None;
            }
            entry.kinds = None;
            entry.discovery = None;
            Some(match &result {
                Ok(client) => {
                    entry.client = Some(client.clone());
                    entry.state = ConnectionState::Connected;
                    entry.state.clone()
                }
                Err(err) => {
                    entry.client = None;
                    entry.state = ConnectionState::Error(err.clone());
                    entry.state.clone()
                }
            })
        });
        if let (Some(ConnectionState::Connected), Ok(client)) = (&applied, &result)
            && self.inner.sweep_node_shells.load(Ordering::SeqCst)
        {
            let client = client.clone();
            tokio::spawn(async move {
                let _ = crate::node_shell::sweep(client).await;
            });
        }
        match applied {
            Some(state) => self.broadcast(id, state),
            None => {
                return Err(CoreError::other(
                    "the connection was cancelled by a newer request",
                ));
            }
        }
        result.map(|_| ())
    }

    /// Drops the client and the discovery cache; the state becomes `disconnected`.
    pub async fn disconnect(&self, id: &ClusterId) {
        self.update(id, |entry| {
            entry.generation += 1;
            entry.client = None;
            entry.kinds = None;
            entry.discovery = None;
            entry.state = ConnectionState::Disconnected;
        });
        self.broadcast(id, ConnectionState::Disconnected);
    }

    pub fn state(&self, id: &ClusterId) -> ConnectionState {
        self.lock()
            .get(id)
            .map(|e| e.state.clone())
            .unwrap_or_default()
    }

    pub fn subscribe_states(&self) -> broadcast::Receiver<(ClusterId, ConnectionState)> {
        self.inner.state_tx.subscribe()
    }

    /// Client of a connected cluster; a `notFound` error if the cluster is not connected.
    pub fn client(&self, id: &ClusterId) -> CoreResult<kube::Client> {
        self.lock()
            .get(id)
            .and_then(|e| e.client.clone())
            .ok_or_else(|| not_connected(id))
    }

    /// Discovery: every resource kind the cluster serves (in the preferred version of its group when that version
    /// serves it). Printer columns stay empty: they come from the kind's CRD. Cached until the cluster reconnects or
    /// [`ClusterManager::refresh_kinds`] drops it; callers that ask while it runs share one discovery, which stops
    /// when all of them are dropped.
    pub async fn kinds(&self, id: &ClusterId) -> CoreResult<Vec<ResourceKind>> {
        let (discovery, generation) = {
            let mut clusters = self.lock();
            let entry = clusters.entry(id.clone()).or_default();
            if let Some(kinds) = &entry.kinds {
                return Ok(kinds.clone());
            }
            let client = entry.client.clone().ok_or_else(|| not_connected(id))?;
            let discovery = entry
                .discovery
                .get_or_insert_with(|| discover(client).boxed().shared())
                .clone();
            (discovery, entry.generation)
        };
        let mut waiter = DiscoveryWaiter {
            mgr: self,
            id,
            discovery: Some(discovery),
        };
        let result = match waiter.discovery.as_mut() {
            Some(running) => running.await,
            None => Err(CoreError::other("discovery was not started")),
        };
        let discovery = waiter.discovery.take();
        self.update(id, |entry| {
            let current = match (&entry.discovery, &discovery) {
                (Some(running), Some(ours)) => running.ptr_eq(ours),
                _ => false,
            };
            if entry.generation == generation && current {
                entry.discovery = None;
                if entry.client.is_some() {
                    entry.kinds = result.as_ref().ok().cloned();
                }
            }
        });
        result
    }

    /// Forgets the cluster's discovery without reconnecting, so the next [`ClusterManager::kinds`] asks the server
    /// again (a CRD was created or deleted). A discovery that is running keeps answering the callers that wait for
    /// it, but its result is not cached: it may predate the change.
    pub fn refresh_kinds(&self, id: &ClusterId) {
        let mut clusters = self.lock();
        if let Some(entry) = clusters.get_mut(id) {
            entry.kinds = None;
            // Its waiters keep their clones; `kinds` caches a result only while its discovery is the current one.
            entry.discovery = None;
        }
    }

    /// Builds a client for the cluster's context and checks it with an authenticated request.
    async fn open_client(&self, id: &ClusterId) -> CoreResult<kube::Client> {
        let kubeconfig = {
            let registry = self
                .inner
                .registry
                .read()
                .unwrap_or_else(|e| e.into_inner());
            registry.kubeconfig_for(id)?
        };
        // Only the file name of the exec plugin goes into error messages.
        let plugin: Option<String> = kubeconfig
            .auth_infos
            .iter()
            .filter_map(|u| u.auth_info.as_ref()?.exec.as_ref()?.command.as_deref())
            .map(|cmd| {
                std::path::Path::new(cmd)
                    .file_name()
                    .map_or_else(|| cmd.to_owned(), |n| n.to_string_lossy().into_owned())
            })
            .next();
        let options = KubeConfigOptions {
            context: kubeconfig.current_context.clone(),
            ..Default::default()
        };
        let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(kubeconfig_error)?;
        config.connect_timeout = Some(CONNECT_TIMEOUT);
        // kube's own retry (`server_retry`: 15 repeats, any `Retry-After`) is replaced by [`RetryPolicy`].
        config.default_retry = false;

        let client = retrying_client(config).map_err(|err| {
            let core = kube_error(err, plugin.as_deref());
            if core.code == ErrorCode::AuthPlugin {
                core
            } else {
                // The client is built from the kubeconfig alone: a bad certificate or key is a kubeconfig problem.
                CoreError::new(ErrorCode::Kubeconfig, core.message)
            }
        })?;

        // `/api` needs an authenticated user (unlike `/version`), so a rejected token fails here with 401.
        match tokio::time::timeout(CHECK_TIMEOUT, client.list_core_api_versions()).await {
            Ok(Ok(_)) => Ok(client),
            Ok(Err(err)) => Err(kube_error(err, plugin.as_deref())),
            Err(_) => Err(CoreError::new(
                ErrorCode::Unreachable,
                format!(
                    "no answer from the API server in {} seconds",
                    CHECK_TIMEOUT.as_secs()
                ),
            )),
        }
    }

    fn update<T>(&self, id: &ClusterId, f: impl FnOnce(&mut Entry) -> T) -> T {
        f(self.lock().entry(id.clone()).or_default())
    }

    fn broadcast(&self, id: &ClusterId, state: ConnectionState) {
        // No receivers is fine: nobody listens in tests and before the window starts.
        let _ = self.inner.state_tx.send((id.clone(), state));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ClusterId, Entry>> {
        self.inner
            .clusters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }
}

fn not_connected(id: &ClusterId) -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        format!("cluster {id} is not connected"),
    )
}

/// One caller of `kinds` waiting for the shared discovery. Dropped before the answer (the caller gave up), it stops
/// the discovery if nobody else waits for it. Clones of the discovery are made and dropped only under the
/// manager's lock, so the count of waiters is exact.
struct DiscoveryWaiter<'a> {
    mgr: &'a ClusterManager,
    id: &'a ClusterId,
    discovery: Option<Discovery>,
}

impl Drop for DiscoveryWaiter<'_> {
    fn drop(&mut self) {
        let Some(ours) = self.discovery.take() else {
            return;
        };
        let mut clusters = self.mgr.lock();
        if let Some(entry) = clusters.get_mut(self.id) {
            let alone = entry
                .discovery
                .as_ref()
                .is_some_and(|running| running.ptr_eq(&ours) && ours.strong_count() == Some(2));
            if alone {
                // The last clone goes with `ours` below: the requests in flight are dropped.
                entry.discovery = None;
            }
        }
        drop(ours);
    }
}

/// A client for `config` that repeats requests as [`RetryPolicy`] says. The retry layer needs a cloneable inner
/// service, hence the buffer in front of kube's own stack.
fn retrying_client(config: kube::Config) -> Result<kube::Client, kube::Error> {
    let builder = kube::client::ClientBuilder::try_from(config)?
        .with_layer(&tower::buffer::BufferLayer::new(1024))
        .with_layer(&tower::retry::RetryLayer::new(RetryPolicy::default()));
    Ok(builder.build())
}

impl<Res>
    tower::retry::Policy<http::Request<kube::client::Body>, http::Response<Res>, tower::BoxError>
    for RetryPolicy
{
    type Future = tokio::time::Sleep;

    fn retry(
        &mut self,
        _request: &mut http::Request<kube::client::Body>,
        result: &mut Result<http::Response<Res>, tower::BoxError>,
    ) -> Option<Self::Future> {
        let response = result.as_ref().ok()?;
        let retry_after = response
            .headers()
            .get(http::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok());
        self.next_delay(response.status().as_u16(), retry_after)
            .map(tokio::time::sleep)
    }

    /// Requests whose body cannot be cloned (a stream) are sent once.
    fn clone_request(
        &mut self,
        request: &http::Request<kube::client::Body>,
    ) -> Option<http::Request<kube::client::Body>> {
        let body = request.body().try_clone()?;
        let mut clone = http::Request::builder()
            .method(request.method().clone())
            .uri(request.uri().clone())
            .version(request.version())
            .body(body)
            .ok()?;
        *clone.headers_mut() = request.headers().clone();
        *clone.extensions_mut() = request.extensions().clone();
        Some(clone)
    }
}

/// Lists every kind the cluster serves (core `v1` included), each once: in the preferred version of its group, or in
/// the first other served version that has it. Aggregated discovery (Kubernetes 1.26+) answers in two requests; an
/// older server is asked per group version.
async fn discover(client: kube::Client) -> CoreResult<Vec<ResourceKind>> {
    let kinds = match discover_aggregated(&client).await {
        Some(kinds) => kinds,
        None => discover_by_group_version(&client).await?,
    };
    Ok(unique_sorted(kinds))
}

/// Aggregated discovery: `/api` and `/apis` with every version and resource. `None` when the server does not serve
/// it (it answers with the plain lists, which carry no items) or a request fails; the caller then asks per group.
async fn discover_aggregated(client: &kube::Client) -> Option<Vec<ResourceKind>> {
    let (core, groups) = futures::join!(
        client.list_core_api_versions_aggregated(),
        client.list_api_groups_aggregated()
    );
    let (core, groups) = (core.ok()?, groups.ok()?);
    if !core.items.iter().any(|g| !g.versions.is_empty()) {
        return None;
    }
    let mut kinds = Vec::new();
    for (is_core, group) in core
        .items
        .into_iter()
        .map(|g| (true, g))
        .chain(groups.items.into_iter().map(|g| (false, g)))
    {
        let name = if is_core {
            String::new()
        } else {
            match group.metadata.and_then(|m| m.name) {
                Some(name) => name,
                None => continue,
            }
        };
        // Versions come in the group's order of preference.
        for version in group.versions {
            let Some(version_name) = version.version else {
                continue;
            };
            for res in version.resources {
                let (Some(plural), Some(kind)) =
                    (res.resource, res.response_kind.and_then(|k| k.kind))
                else {
                    continue;
                };
                kinds.push(ResourceKind {
                    kind_ref: KindRef {
                        group: name.clone(),
                        version: version_name.clone(),
                        kind,
                    },
                    plural,
                    namespaced: res.scope.as_deref() == Some("Namespaced"),
                    verbs: res.verbs,
                    printer_columns: Vec::new(),
                });
            }
        }
    }
    Some(kinds)
}

/// Discovery of a server without aggregated discovery: one request per group version. A group version that fails
/// (e.g. an aggregated API whose backend is down) is skipped; only a failing core group fails the discovery.
async fn discover_by_group_version(client: &kube::Client) -> CoreResult<Vec<ResourceKind>> {
    use futures::future::join_all;

    let core_versions = client
        .list_core_api_versions()
        .await
        .map_err(CoreError::from)?;
    let core_lists = join_all(
        core_versions
            .versions
            .iter()
            .map(|v| client.list_core_api_resources(v)),
    )
    .await;

    let groups = client.list_api_groups().await.map_err(CoreError::from)?;
    // Every served version of every group, the preferred one first: a kind is taken from the first version that
    // serves it, so a kind that only an older version serves (a CRD not yet moved to the group's newest version)
    // is listed too.
    let group_versions: Vec<String> = groups
        .groups
        .iter()
        .flat_map(|g| {
            let preferred = g
                .preferred_version
                .as_ref()
                .map(|p| p.group_version.clone());
            let others = g
                .versions
                .iter()
                .map(|v| v.group_version.clone())
                .filter(|gv| Some(gv) != preferred.as_ref())
                .collect::<Vec<_>>();
            preferred.into_iter().chain(others)
        })
        .collect();
    let group_lists = join_all(
        group_versions
            .iter()
            .map(|gv| client.list_api_group_resources(gv)),
    )
    .await;

    let mut kinds = Vec::new();
    let mut core_ok = false;
    for list in core_lists {
        let list = list.map_err(CoreError::from)?;
        core_ok = true;
        push_kinds(&mut kinds, list);
    }
    if !core_ok {
        return Err(CoreError::other("the cluster serves no core API version"));
    }
    for list in group_lists.into_iter().flatten() {
        push_kinds(&mut kinds, list);
    }
    Ok(kinds)
}

/// Keeps the first entry of each (group, kind) — the most preferred version — sorted by group and kind.
fn unique_sorted(mut kinds: Vec<ResourceKind>) -> Vec<ResourceKind> {
    let mut seen = std::collections::HashSet::new();
    kinds.retain(|k| seen.insert((k.kind_ref.group.clone(), k.kind_ref.kind.clone())));
    kinds.sort_by(|a, b| {
        (&a.kind_ref.group, &a.kind_ref.kind).cmp(&(&b.kind_ref.group, &b.kind_ref.kind))
    });
    kinds
}

fn push_kinds(
    out: &mut Vec<ResourceKind>,
    list: k8s_openapi::apimachinery::pkg::apis::meta::v1::APIResourceList,
) {
    let (group, version) = match list.group_version.split_once('/') {
        Some((g, v)) => (g.to_owned(), v.to_owned()),
        None => (String::new(), list.group_version.clone()),
    };
    for res in list.resources {
        if res.name.contains('/') {
            continue; // subresources: pods/log, deployments/scale, …
        }
        out.push(ResourceKind {
            printer_columns: Vec::new(),
            kind_ref: KindRef {
                group: group.clone(),
                version: version.clone(),
                kind: res.kind,
            },
            plural: res.name,
            namespaced: res.namespaced,
            verbs: res.verbs,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request};
    use crate::kubeconfig::KubeconfigEnv;

    /// A kubeconfig with one context `test` for `server`, user given as YAML lines under `user:`.
    fn kubeconfig(server: &str, user: &str) -> String {
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster:\n      server: {server}\nusers:\n  - name: u\n    user:\n{user}\ncontexts:\n  - name: test\n    context:\n      cluster: c\n      user: u\ncurrent-context: test\n"
        )
    }

    /// A manager whose only cluster comes from `text` as `~/.kube/config`.
    fn manager(text: &str) -> (tempfile::TempDir, ClusterManager, ClusterId) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".kube")).unwrap();
        std::fs::write(home.join(".kube").join("config"), text).unwrap();
        let registry = KubeconfigRegistry::new(Vec::new(), dir.path().join("pasted")).with_env(
            KubeconfigEnv {
                kubeconfig: None,
                home: Some(home),
            },
        );
        let id = registry.clusters().unwrap()[0].id.clone();
        let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
        (dir, mgr, id)
    }

    fn error_code(state: ConnectionState) -> ErrorCode {
        match state {
            ConnectionState::Error(err) => err.code,
            other => panic!("expected an error state, got {other:?}"),
        }
    }

    /// An exec plugin `sh -c <script> --password=ARG-SECRET` with `VAULT_TOKEN=ENV-SECRET-123` in its env.
    #[cfg(unix)]
    fn exec_user(script: &str) -> String {
        format!(
            "      exec:\n        apiVersion: client.authentication.k8s.io/v1\n        command: sh\n        args:\n          - -c\n          - \"{script}\"\n          - --password=ARG-SECRET\n        env:\n          - name: VAULT_TOKEN\n            value: ENV-SECRET-123\n        interactiveMode: Never\n"
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failing_exec_plugin_leaks_no_secrets_into_errors_states_or_events() {
        const SECRETS: [&str; 4] = [
            "ENV-SECRET-123",
            "ARG-SECRET",
            "OUT-SECRET-456",
            "ERR-SECRET-789",
        ];
        let cases = [
            // Non-zero exit with secrets on stdout and stderr.
            (
                "echo OUT-SECRET-456; echo ERR-SECRET-789 >&2; exit 3",
                Some("3"),
            ),
            // Exit 0 with output that is not an ExecCredential.
            ("echo token: OUT-SECRET-456", None),
        ];
        for (script, exit_code) in cases {
            let (_dir, mgr, id) = manager(&kubeconfig("https://127.0.0.1:1", &exec_user(script)));
            let mut events = mgr.subscribe_states();
            let err = mgr.connect(&id).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::AuthPlugin, "{script}: {err}");
            assert!(err.message.contains("'sh'"), "names the plugin: {err}");
            if let Some(code) = exit_code {
                assert!(err.message.contains(code), "gives the exit code: {err}");
            }

            let state = serde_json::to_string(&mgr.state(&id)).unwrap();
            let mut seen = vec![err.message.clone(), state];
            while let Ok(event) = events.try_recv() {
                seen.push(serde_json::to_string(&event.1).unwrap());
            }
            for text in &seen {
                for secret in SECRETS {
                    assert!(!text.contains(secret), "{secret} leaked in {text}");
                }
            }
        }
    }

    #[tokio::test]
    async fn missing_exec_plugin_gives_auth_plugin() {
        let user = "      exec:\n        apiVersion: client.authentication.k8s.io/v1\n        command: sextant-no-such-auth-plugin\n        interactiveMode: Never\n";
        let (_dir, mgr, id) = manager(&kubeconfig("https://127.0.0.1:1", user));
        let err = mgr.connect(&id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::AuthPlugin, "{err}");
        assert_eq!(error_code(mgr.state(&id)), ErrorCode::AuthPlugin);
    }

    #[tokio::test]
    async fn context_with_a_missing_cluster_gives_kubeconfig() {
        let text = "apiVersion: v1\nkind: Config\ncontexts:\n  - name: orphan\n    context:\n      cluster: nowhere\n      user: nobody\n";
        let (_dir, mgr, id) = manager(text);
        let err = mgr.connect(&id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Kubeconfig, "{err}");
    }

    #[tokio::test]
    async fn broken_client_certificate_gives_kubeconfig() {
        let user = "      client-certificate-data: bm90IGEgY2VydA==\n      client-key-data: bm90IGEga2V5\n";
        let (_dir, mgr, id) = manager(&kubeconfig("https://127.0.0.1:1", user));
        let err = mgr.connect(&id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Kubeconfig, "{err}");
    }

    #[tokio::test]
    async fn closed_port_gives_unreachable_and_states_are_broadcast() {
        let (_dir, mgr, id) = manager(&kubeconfig("https://127.0.0.1:1", "      token: abc\n"));
        let mut states = mgr.subscribe_states();
        let err = mgr.connect(&id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Unreachable, "{err}");

        let (first_id, first) = states.recv().await.unwrap();
        assert_eq!(first_id, id);
        assert_eq!(first, ConnectionState::Connecting);
        let (_, second) = states.recv().await.unwrap();
        assert_eq!(error_code(second), ErrorCode::Unreachable);
        assert!(mgr.client(&id).is_err());
    }

    /// Every pause the policy asks for until it gives up, for the same answer each time.
    fn pauses(status: u16, retry_after: Option<&str>) -> Vec<Duration> {
        let mut policy = RetryPolicy::default();
        std::iter::from_fn(|| policy.next_delay(status, retry_after))
            .take(100)
            .collect()
    }

    #[test]
    fn retry_policy_repeats_429_503_504_at_most_3_times_within_5_seconds() {
        for status in [429, 503, 504] {
            let waits = pauses(status, None);
            assert!(!waits.is_empty(), "{status} is retried");
            assert!(waits.len() <= 3, "{status}: {waits:?}");
            let total: Duration = waits.iter().sum();
            assert!(total <= Duration::from_secs(5), "{status}: {waits:?}");
        }
        for status in [200, 400, 401, 403, 404, 409, 500, 502] {
            assert!(pauses(status, None).is_empty(), "{status} is not retried");
        }
    }

    #[test]
    fn retry_after_within_the_budget_is_respected_and_beyond_it_fails_at_once() {
        assert_eq!(pauses(429, Some("2"))[0], Duration::from_secs(2));
        assert!(
            pauses(503, Some("2")).iter().sum::<Duration>() <= Duration::from_secs(5),
            "Retry-After never stretches the total past the budget"
        );
        assert!(
            pauses(429, Some("30")).is_empty(),
            "the server asks for more than 5 s"
        );
        assert!(pauses(503, Some("6")).is_empty());
        // A date or garbage is not a number of seconds: the policy's own pauses apply.
        assert!(!pauses(503, Some("Wed, 21 Oct 2026 07:28:00 GMT")).is_empty());
    }

    /// A fake API server that answers every request with `status` (and `Retry-After`, if given).
    async fn always_answering(status: u16, retry_after: Option<&'static str>) -> FakeApi {
        FakeApi::start(move |_: &Request| {
            let reply = Reply::json(
                status,
                format!(
                    r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"try later","code":{status}}}"#
                ),
            );
            match retry_after {
                Some(value) => reply.with_header("Retry-After", value),
                None => reply,
            }
        })
        .await
    }

    #[tokio::test]
    async fn the_client_repeats_429_503_504_at_most_3_times_within_about_5_seconds() {
        for status in [429, 503, 504] {
            let api = always_answering(status, None).await;
            let (_dir, mgr, id) = manager(&kubeconfig(api.url(), "      token: abc\n"));
            let started = std::time::Instant::now();
            let err = mgr.connect(&id).await.unwrap_err();
            let elapsed = started.elapsed();
            let sent = api.requests().len();
            assert!(
                (2..=4).contains(&sent),
                "{status}: {sent} requests (first + at most 3 repeats)"
            );
            assert!(
                elapsed < Duration::from_secs(6),
                "{status}: took {elapsed:?}"
            );
            assert_ne!(err.code, ErrorCode::Timeout, "{err}");
        }
    }

    #[tokio::test]
    async fn the_client_gives_up_at_once_when_retry_after_exceeds_the_budget() {
        let api = always_answering(503, Some("30")).await;
        let (_dir, mgr, id) = manager(&kubeconfig(api.url(), "      token: abc\n"));
        let started = std::time::Instant::now();
        let err = mgr.connect(&id).await.unwrap_err();
        assert_eq!(api.requests().len(), 1, "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "took {:?}",
            started.elapsed()
        );
    }

    /// A fake API server without aggregated discovery that serves the core kinds and, in group `demo.sextant.dev`,
    /// the kinds in `served` when the group is asked; the group's answer comes `delay` later.
    async fn serving(served: Arc<Mutex<Vec<&'static str>>>, delay: Duration) -> FakeApi {
        FakeApi::start(move |req: &Request| match req.path.as_str() {
            "/api" => Reply::json(
                200,
                r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
            ),
            "/api/v1" => Reply::json(
                200,
                r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["list","watch"]}]}"#,
            ),
            "/apis" => Reply::json(
                200,
                r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[{"name":"demo.sextant.dev","versions":[{"groupVersion":"demo.sextant.dev/v1","version":"v1"}],"preferredVersion":{"groupVersion":"demo.sextant.dev/v1","version":"v1"}}]}"#,
            ),
            "/apis/demo.sextant.dev/v1" => {
                let resources: Vec<String> = served
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|kind| {
                        let plural = format!("{}s", kind.to_lowercase());
                        format!(
                            r#"{{"name":"{plural}","singularName":"","namespaced":true,"kind":"{kind}","verbs":["list","watch"]}}"#
                        )
                    })
                    .collect();
                Reply::json(
                    200,
                    format!(
                        r#"{{"kind":"APIResourceList","groupVersion":"demo.sextant.dev/v1","resources":[{}]}}"#,
                        resources.join(",")
                    ),
                )
                .after(delay)
            }
            _ => Reply::not_found(),
        })
        .await
    }

    fn demo_kinds(kinds: &[ResourceKind]) -> Vec<String> {
        kinds
            .iter()
            .filter(|k| k.kind_ref.group == "demo.sextant.dev")
            .map(|k| k.kind_ref.kind.clone())
            .collect()
    }

    #[tokio::test]
    async fn refreshed_kinds_show_created_and_deleted_kinds_without_reconnecting() {
        let served = Arc::new(Mutex::new(vec!["Widget"]));
        let api = serving(Arc::clone(&served), Duration::ZERO).await;
        let (_tmp, mgr, id) = crate::fake_api::connected_to(api.url()).await;
        assert_eq!(demo_kinds(&mgr.kinds(&id).await.unwrap()), ["Widget"]);

        served.lock().unwrap().push("Gadget");
        // Cached until refreshed.
        assert_eq!(demo_kinds(&mgr.kinds(&id).await.unwrap()), ["Widget"]);
        mgr.refresh_kinds(&id);
        assert_eq!(
            demo_kinds(&mgr.kinds(&id).await.unwrap()),
            ["Gadget", "Widget"]
        );

        served.lock().unwrap().retain(|k| *k != "Widget");
        mgr.refresh_kinds(&id);
        assert_eq!(demo_kinds(&mgr.kinds(&id).await.unwrap()), ["Gadget"]);
        assert_eq!(mgr.state(&id), ConnectionState::Connected);
    }

    #[tokio::test]
    async fn a_discovery_running_during_a_refresh_does_not_cache_its_older_result() {
        let served = Arc::new(Mutex::new(vec!["Widget"]));
        let api = serving(Arc::clone(&served), Duration::from_millis(500)).await;
        let (_tmp, mgr, id) = crate::fake_api::connected_to(api.url()).await;

        let running = {
            let (mgr, id) = (mgr.clone(), id.clone());
            tokio::spawn(async move { mgr.kinds(&id).await })
        };
        // The group was asked before the change, so the running discovery answers with the old kinds.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while api.count("/apis/demo.sextant.dev/v1") == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "discovery did not start"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        served.lock().unwrap().push("Gadget");
        mgr.refresh_kinds(&id);
        let old = running.await.unwrap().unwrap();
        assert!(!demo_kinds(&old).contains(&"Gadget".to_owned()));

        assert_eq!(
            demo_kinds(&mgr.kinds(&id).await.unwrap()),
            ["Gadget", "Widget"]
        );
    }

    #[tokio::test]
    async fn unknown_or_disconnected_cluster_has_no_client() {
        let (_dir, mgr, id) = manager(&kubeconfig("https://127.0.0.1:1", "      token: abc\n"));
        assert_eq!(mgr.state(&id), ConnectionState::Disconnected);
        assert_eq!(
            mgr.client(&id).err().map(|e| e.code),
            Some(ErrorCode::NotFound)
        );
        assert_eq!(mgr.kinds(&id).await.unwrap_err().code, ErrorCode::NotFound);

        let mut states = mgr.subscribe_states();
        mgr.disconnect(&id).await;
        assert_eq!(
            states.recv().await.unwrap(),
            (id.clone(), ConnectionState::Disconnected)
        );
        let unknown = mgr.connect(&ClusterId::from("0000")).await.unwrap_err();
        assert_eq!(unknown.code, ErrorCode::NotFound);
    }
}
