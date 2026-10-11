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

    /// Discovery: every resource kind the cluster serves (preferred version of each group), with the printer
    /// columns of CRDs. Cached until the cluster reconnects.
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

        let client = kube::Client::try_from(config).map_err(|err| {
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

/// Lists the preferred version of every API group (core `v1` included). A group that fails (e.g. an
/// aggregated API whose backend is down) is skipped; only a failing core group fails the discovery.
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
    let group_versions: Vec<String> = groups
        .groups
        .iter()
        .filter_map(|g| {
            g.preferred_version
                .as_ref()
                .map(|p| p.group_version.clone())
                .or_else(|| g.versions.first().map(|v| v.group_version.clone()))
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
