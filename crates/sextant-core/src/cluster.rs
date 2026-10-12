//! Connections to clusters: one `kube::Client` per connected cluster, connection states, discovery cache.
//!
//! `connect` builds a client from the cluster's kubeconfig context and proves it with an authenticated request
//! (`GET /api`), so a wrong token, a missing exec plugin or an unreachable server shows up as the connection
//! error, not later in a table. Credentials are only handed to kube-rs; they are never logged or returned.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use kube::config::KubeConfigOptions;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode, kube_error};
use crate::kubeconfig::{ClusterId, KubeconfigRegistry, kubeconfig_error};
use crate::resources::{KindRef, PrinterColumn, ResourceKind};

/// How long a TCP/TLS connect may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
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
}

/// Everything known about one cluster. `generation` grows with every connect/disconnect, so a slow connect
/// that was overtaken by a disconnect (or a newer connect) does not overwrite the newer state.
#[derive(Default)]
struct Entry {
    state: ConnectionState,
    generation: u64,
    client: Option<kube::Client>,
    kinds: Option<Vec<ResourceKind>>,
}

impl ClusterManager {
    pub fn new(registry: Arc<RwLock<KubeconfigRegistry>>) -> Self {
        let (state_tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(Inner {
                registry,
                clusters: Mutex::new(HashMap::new()),
                state_tx,
            }),
        }
    }

    /// The kubeconfig registry this manager reads contexts from.
    pub fn registry(&self) -> Arc<RwLock<KubeconfigRegistry>> {
        Arc::clone(&self.inner.registry)
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
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    format!("cluster {id} is not connected"),
                )
            })
    }

    /// Discovery: every resource kind the cluster serves (in the preferred version of its group when that version
    /// serves it), with the printer columns of CRDs. Cached until the cluster reconnects.
    pub async fn kinds(&self, id: &ClusterId) -> CoreResult<Vec<ResourceKind>> {
        let (client, generation) = {
            let clusters = self.lock();
            let entry = clusters.get(id);
            if let Some(kinds) = entry.and_then(|e| e.kinds.clone()) {
                return Ok(kinds);
            }
            (
                self.client_locked(entry, id)?,
                entry.map_or(0, |e| e.generation),
            )
        };
        let kinds = discover(&client).await?;
        self.update(id, |entry| {
            if entry.generation == generation && entry.client.is_some() {
                entry.kinds = Some(kinds.clone());
            }
        });
        Ok(kinds)
    }

    fn client_locked(&self, entry: Option<&Entry>, id: &ClusterId) -> CoreResult<kube::Client> {
        entry.and_then(|e| e.client.clone()).ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("cluster {id} is not connected"),
            )
        })
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
/// the first other served version that has it. A group version that fails (e.g. an aggregated API whose backend is
/// down) is skipped; only a failing core group fails the discovery.
async fn discover(client: &kube::Client) -> CoreResult<Vec<ResourceKind>> {
    use futures::future::join_all;
    use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;

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

    // Printer columns come from the CRDs; without the right to list CRDs the columns stay empty.
    let crds = kube::Api::<CustomResourceDefinition>::all(client.clone())
        .list(&Default::default())
        .await
        .map(|list| list.items)
        .unwrap_or_default();
    let mut columns: HashMap<(String, String, String), Vec<PrinterColumn>> = HashMap::new();
    for crd in crds {
        for version in &crd.spec.versions {
            let cols = version
                .additional_printer_columns
                .iter()
                .flatten()
                .map(|c| PrinterColumn {
                    name: c.name.clone(),
                    json_path: c.json_path.clone(),
                    type_: c.type_.clone(),
                    priority: c.priority.unwrap_or(0),
                })
                .collect();
            columns.insert(
                (
                    crd.spec.group.clone(),
                    version.name.clone(),
                    crd.spec.names.kind.clone(),
                ),
                cols,
            );
        }
    }

    let mut kinds = Vec::new();
    let mut core_ok = false;
    for list in core_lists {
        let list = list.map_err(CoreError::from)?;
        core_ok = true;
        push_kinds(&mut kinds, list, &columns);
    }
    if !core_ok {
        return Err(CoreError::other("the cluster serves no core API version"));
    }
    for list in group_lists.into_iter().flatten() {
        push_kinds(&mut kinds, list, &columns);
    }
    let mut seen = std::collections::HashSet::new();
    kinds.retain(|k| seen.insert((k.kind_ref.group.clone(), k.kind_ref.kind.clone())));
    kinds.sort_by(|a, b| {
        (&a.kind_ref.group, &a.kind_ref.kind).cmp(&(&b.kind_ref.group, &b.kind_ref.kind))
    });
    Ok(kinds)
}

fn push_kinds(
    out: &mut Vec<ResourceKind>,
    list: k8s_openapi::apimachinery::pkg::apis::meta::v1::APIResourceList,
    columns: &HashMap<(String, String, String), Vec<PrinterColumn>>,
) {
    let (group, version) = match list.group_version.split_once('/') {
        Some((g, v)) => (g.to_owned(), v.to_owned()),
        None => (String::new(), list.group_version.clone()),
    };
    for res in list.resources {
        if res.name.contains('/') {
            continue; // subresources: pods/log, deployments/scale, …
        }
        let key = (group.clone(), version.clone(), res.kind.clone());
        out.push(ResourceKind {
            printer_columns: columns.get(&key).cloned().unwrap_or_default(),
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

    /// A plain-HTTP API server on 127.0.0.1 that answers every request with `status` (and `Retry-After`, if given).
    /// Returns its URL and the number of requests it got.
    async fn always_answering(
        status: u16,
        retry_after: Option<&'static str>,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&requests);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let counter = Arc::clone(&counter);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        // One response per request head (GET requests have no body).
                        while let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            buf.drain(..end + 4);
                            counter.fetch_add(1, Ordering::SeqCst);
                            let body = format!(
                                r#"{{"kind":"Status","apiVersion":"v1","status":"Failure","message":"try later","code":{status}}}"#
                            );
                            let extra = retry_after
                                .map(|v| format!("Retry-After: {v}\r\n"))
                                .unwrap_or_default();
                            let response = format!(
                                "HTTP/1.1 {status} Try Later\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}\r\n{body}",
                                body.len()
                            );
                            if socket.write_all(response.as_bytes()).await.is_err() {
                                return;
                            }
                        }
                        match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                });
            }
        });
        (url, requests)
    }

    #[tokio::test]
    async fn the_client_repeats_429_503_504_at_most_3_times_within_about_5_seconds() {
        use std::sync::atomic::Ordering;
        for status in [429, 503, 504] {
            let (url, requests) = always_answering(status, None).await;
            let (_dir, mgr, id) = manager(&kubeconfig(&url, "      token: abc\n"));
            let started = std::time::Instant::now();
            let err = mgr.connect(&id).await.unwrap_err();
            let elapsed = started.elapsed();
            let sent = requests.load(Ordering::SeqCst);
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
        use std::sync::atomic::Ordering;
        let (url, requests) = always_answering(503, Some("30")).await;
        let (_dir, mgr, id) = manager(&kubeconfig(&url, "      token: abc\n"));
        let started = std::time::Instant::now();
        let err = mgr.connect(&id).await.unwrap_err();
        assert_eq!(requests.load(Ordering::SeqCst), 1, "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "took {:?}",
            started.elapsed()
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
