//! Tauri-managed application state.

use std::any::Any;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use sextant_core::portforward::PortForwarder;
use sextant_core::{
    ClusterId, ClusterManager, CoreError, ErrorCode, KubeconfigRegistry, SettingsStore,
};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use crate::commands::argocd::{ArgoSessions, KeyringStore};
use crate::extensions::api::ExtensionApi;
use crate::gitops_install::GitopsInstalls;
use crate::mcp::{McpContext, McpServer};

/// How long closing the window (or quitting) waits for the node shell pods to be deleted.
pub const NODE_SHELL_DELETE_WAIT: Duration = Duration::from_secs(5);

/// Everything the commands share. Registered with `app.manage(AppState::new(..))`.
pub struct AppState {
    pub registry: Arc<RwLock<KubeconfigRegistry>>,
    pub clusters: ClusterManager,
    pub forwarder: Arc<PortForwarder>,
    pub settings: Arc<SettingsStore>,
    /// Watch subscriptions and log streams (`watch_start`, `logs_start`).
    pub subscriptions: Subscriptions,
    /// Terminal sessions: container exec, node shells (their guard is the node's pod; while one starts, a placeholder
    /// whose guard calls the start off) and local shells.
    pub sessions: Sessions,
    /// Argo CD sessions (tokens in memory only) and their port forwards to `argocd-server`.
    pub argocd: ArgoSessions,
    /// The MCP server for AI agents (off unless `settings.mcp.enabled`); its token is `<config_dir>/mcp-token`, its
    /// journal `<data_dir>/mcp-audit.jsonl`.
    pub mcp: McpServer,
    /// The extensions' API (`extension_call`): its watch streams, its journal `<data_dir>/extensions-audit.jsonl`;
    /// confirmations shared with `mcp`.
    pub ext_api: ExtensionApi,
    /// Flux / Argo CD installs: plans prepared for the user's "Install" and the installs running
    /// (`gitops_install_*`); stopped with their cluster, on a reload and on exit.
    pub gitops: GitopsInstalls,
    /// Grows with every [`AppState::reset_streams`]; a start that began before a reset does not register.
    streams_generation: AtomicU64,
}

impl AppState {
    /// `config_dir` holds `settings.json`; pasted kubeconfigs go to `<data_dir>/kubeconfigs`.
    pub fn new(config_dir: &Path, data_dir: &Path) -> Self {
        let settings = Arc::new(SettingsStore::open(config_dir.join("settings.json")));
        let registry = Arc::new(RwLock::new(KubeconfigRegistry::new(
            settings.get().kubeconfig_sources,
            data_dir.join("kubeconfigs"),
        )));
        let clusters = ClusterManager::new(Arc::clone(&registry));
        // Node shell pods left by an earlier run go when their cluster connects.
        clusters.sweep_node_shells_on_connect();
        let forwarder = Arc::new(PortForwarder::new());
        let mcp = McpServer::new(McpContext::new(
            Arc::clone(&registry),
            clusters.clone(),
            Arc::clone(&forwarder),
            Arc::clone(&settings),
            config_dir,
            data_dir,
        ));
        let ext_api = ExtensionApi::new(
            clusters.clone(),
            Arc::clone(&settings),
            Arc::clone(&mcp.context().confirmations),
            data_dir,
        );
        Self {
            clusters,
            registry,
            forwarder,
            settings,
            subscriptions: Subscriptions::default(),
            sessions: Sessions::default(),
            argocd: ArgoSessions::new(Arc::new(KeyringStore::os())),
            mcp,
            ext_api,
            gitops: GitopsInstalls::default(),
            streams_generation: AtomicU64::new(0),
        }
    }

    /// Stops every subscription (extensions' streams too), session, Flux / Argo CD install and port forward of a
    /// cluster (on disconnect), and forgets its Argo CD session.
    pub fn close_cluster(&self, cluster: &ClusterId) {
        self.subscriptions.stop_cluster(cluster);
        self.gitops.stop_cluster(cluster);
        self.ext_api.streams.stop_cluster(cluster);
        self.sessions.stop_cluster(cluster);
        self.forwarder.stop_cluster(cluster);
        self.argocd.close_cluster(cluster);
    }

    /// Stops everything (window closed, application exiting): the MCP server first (no agent starts anything new,
    /// waiting confirmations are refused), then everything it or the window started. Terminal sessions drop their
    /// temporary kubeconfig before this returns; node shells start deleting their pods, and this waits up to
    /// [`NODE_SHELL_DELETE_WAIT`] for those deletions, so the process does not end before them.
    pub fn close_all(&self) {
        self.mcp.stop();
        self.ext_api.close();
        self.reset_streams();
        self.forwarder.stop_all();
        self.argocd.close_all();
        sextant_core::node_shell::wait_for_deletions(NODE_SHELL_DELETE_WAIT);
    }

    /// Stops every watch subscription (extensions' too), log stream, terminal session and Flux / Argo CD install, but
    /// keeps connections and port forwards (`streams_reset`: the window was reloaded and nobody listens to the old
    /// streams any more).
    pub fn reset_streams(&self) {
        // First: a start that registers from now on sees the reset and undoes itself.
        self.streams_generation.fetch_add(1, Ordering::SeqCst);
        self.subscriptions.stop_all();
        self.sessions.stop_all();
        self.gitops.stop_all();
        // Extensions' streams; the confirmations the old page was showing are declined.
        self.ext_api.reset();
    }

    /// Taken by a `*_start` before it waits for the core; passed to [`AppState::undo_if_reset`] after registering.
    pub fn streams_generation(&self) -> u64 {
        self.streams_generation.load(Ordering::SeqCst)
    }

    /// Called right after a stream that a start began at `generation` was registered: if `streams_reset` ran in
    /// between (the page that asked for the stream is gone), `stop` removes it again and the start fails. A reset
    /// after the registration stops the stream itself, so either way nothing is left behind.
    pub fn undo_if_reset(&self, generation: u64, stop: impl FnOnce()) -> Result<(), CoreError> {
        if self.streams_generation() == generation {
            return Ok(());
        }
        stop();
        Err(CoreError::other(
            "the streams were reset while this one was starting",
        ))
    }
}

/// Checks a stream id chosen by the frontend (`crypto.randomUUID()`). It becomes part of an event name
/// (`watch:<id>`), so only ASCII letters, digits, `-` and `_` are allowed.
pub fn check_stream_id(id: &str) -> Result<(), CoreError> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if valid {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Invalid,
            format!("invalid stream id {id:?}"),
        ))
    }
}

fn busy(id: &str) -> CoreError {
    CoreError::new(
        ErrorCode::Invalid,
        format!("stream id {id} is already in use"),
    )
}

/// A background task that pushes events to the window until it is stopped.
pub struct Subscription {
    pub cluster: ClusterId,
    pub task: AbortHandle,
}

#[derive(Default)]
pub struct Subscriptions {
    map: Mutex<HashMap<String, Subscription>>,
}

impl Subscriptions {
    /// Registers a subscription under the id the frontend chose; a taken or malformed id is `invalid` and the
    /// subscription is dropped (the caller then lets its task end).
    pub fn insert(&self, id: String, subscription: Subscription) -> Result<(), CoreError> {
        check_stream_id(&id)?;
        match lock(&self.map).entry(id) {
            Entry::Occupied(taken) => Err(busy(taken.key())),
            Entry::Vacant(free) => {
                free.insert(subscription);
                Ok(())
            }
        }
    }

    /// Aborts the task; `false` if there was no such subscription.
    pub fn stop(&self, id: &str) -> bool {
        match lock(&self.map).remove(id) {
            Some(sub) => {
                sub.task.abort();
                true
            }
            None => false,
        }
    }

    /// Forgets a subscription whose task ended by itself.
    pub fn remove(&self, id: &str) {
        lock(&self.map).remove(id);
    }

    pub fn stop_cluster(&self, cluster: &ClusterId) {
        lock(&self.map).retain(|_, sub| {
            let keep = &sub.cluster != cluster;
            if !keep {
                sub.task.abort();
            }
            keep
        });
    }

    pub fn stop_all(&self) {
        for (_, sub) in lock(&self.map).drain() {
            sub.task.abort();
        }
    }

    pub fn len(&self) -> usize {
        lock(&self.map).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Senders of a terminal session: keystrokes and `(cols, rows)` resizes.
pub type TermChannels = (mpsc::Sender<Vec<u8>>, mpsc::Sender<(u16, u16)>);

/// Something that must live exactly as long as a terminal session, e.g. its temporary kubeconfig
/// (`tempfile::TempPath`, which removes the file when dropped).
pub type SessionGuard = Box<dyn Any + Send>;

/// A running terminal: container exec (`cluster` set) or local shell.
pub struct TermSession {
    pub cluster: Option<ClusterId>,
    pub input: mpsc::Sender<Vec<u8>>,
    pub resize: mpsc::Sender<(u16, u16)>,
    /// The task that pumps output to the window; aborting it ends the session.
    pub task: AbortHandle,
    /// Dropped together with the session, synchronously: by `stop`, `stop_cluster`, `stop_all` before they return,
    /// or when the session ends by itself.
    pub guard: Option<SessionGuard>,
}

impl TermSession {
    /// Ends the session: aborts its task and drops its guard now.
    pub fn end(self) {
        self.task.abort();
        drop(self.guard);
    }
}

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, TermSession>>,
}

impl Sessions {
    /// Registers a session under the id the frontend chose; a taken or malformed id is `invalid` and the session is
    /// ended (its task aborted, its guard dropped) before this returns — the session holding the id is not touched.
    pub fn insert(&self, id: String, session: TermSession) -> Result<(), CoreError> {
        if let Err(err) = check_stream_id(&id) {
            session.end();
            return Err(err);
        }
        let mut map = lock(&self.map);
        match map.entry(id) {
            Entry::Occupied(taken) => {
                let err = busy(taken.key());
                drop(map);
                session.end();
                Err(err)
            }
            Entry::Vacant(free) => {
                free.insert(session);
                Ok(())
            }
        }
    }

    /// Input and resize senders of a session.
    pub fn channels(&self, id: &str) -> Option<TermChannels> {
        lock(&self.map)
            .get(id)
            .map(|s| (s.input.clone(), s.resize.clone()))
    }

    /// Ends a session; its guard is dropped before this returns. `false` if there was no such session.
    pub fn stop(&self, id: &str) -> bool {
        let session = lock(&self.map).remove(id);
        match session {
            Some(session) => {
                session.end();
                true
            }
            None => false,
        }
    }

    /// Takes the session `id` out if `is_it` says it is the expected one, without ending it: its task keeps running and
    /// its guard stays alive in the returned session (a starting node shell swaps its placeholder for the real session).
    pub fn take_if(
        &self,
        id: &str,
        is_it: impl FnOnce(&TermSession) -> bool,
    ) -> Option<TermSession> {
        let mut map = lock(&self.map);
        if map.get(id).is_some_and(is_it) {
            map.remove(id)
        } else {
            None
        }
    }

    /// Puts `session` in place of the session `id` if `is_it` says that one is the expected one, in one step, so the
    /// id is never free in between (a starting node shell swaps its placeholder for the running shell): `term_stop`,
    /// `close_cluster` or a reset find either the old session or the new one. Returns the old session, not ended (its
    /// task keeps running, its guard stays alive in it). When it is not there any more (it was stopped), `session` is
    /// ended — its task aborted and its guard dropped before this returns — and `None` is returned.
    pub fn replace_if(
        &self,
        id: &str,
        is_it: impl FnOnce(&TermSession) -> bool,
        session: TermSession,
    ) -> Option<TermSession> {
        let mut map = lock(&self.map);
        match map.get_mut(id) {
            Some(current) if is_it(current) => Some(std::mem::replace(current, session)),
            _ => {
                drop(map);
                session.end();
                None
            }
        }
    }

    /// Forgets a session whose task ended by itself (dropping its guard).
    pub fn remove(&self, id: &str) {
        let session = lock(&self.map).remove(id);
        drop(session);
    }

    /// Ends every session of `cluster`; their guards are dropped before this returns.
    pub fn stop_cluster(&self, cluster: &ClusterId) {
        let ended: Vec<TermSession> = {
            let mut map = lock(&self.map);
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, s)| s.cluster.as_ref() == Some(cluster))
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        ended.into_iter().for_each(TermSession::end);
    }

    /// Ends every session; their guards are dropped before this returns.
    pub fn stop_all(&self) {
        let ended: Vec<TermSession> = lock(&self.map).drain().map(|(_, s)| s).collect();
        ended.into_iter().for_each(TermSession::end);
    }

    pub fn len(&self) -> usize {
        lock(&self.map).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    //! Port forwards end with their cluster. Needs the kind test cluster (`scripts/test-cluster.sh`):
    //! `SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant state::tests`.
    use std::net::Ipv4Addr;
    use std::time::{Duration, Instant};

    use sextant_core::kubeconfig::KubeconfigEnv;
    use sextant_core::portforward::ForwardTarget;

    use super::*;

    async fn connected_state(dirs: &Path) -> Option<(AppState, ClusterId)> {
        let Some(kubeconfig) =
            std::env::var_os("SEXTANT_TEST_KUBECONFIG").filter(|v| !v.is_empty())
        else {
            eprintln!("skipped: SEXTANT_TEST_KUBECONFIG is not set (see scripts/test-cluster.sh)");
            return None;
        };
        let state = AppState::new(&dirs.join("config"), &dirs.join("data"));
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig),
            home: Some(dirs.join("home")),
        });
        let id = state.registry.read().unwrap().clusters().unwrap()[0]
            .id
            .clone();
        state.clusters.connect(&id).await.unwrap();
        Some((state, id))
    }

    async fn forward_nginx(state: &AppState, id: &ClusterId) -> u16 {
        let target = ForwardTarget::Service {
            namespace: "sextant-demo".into(),
            name: "nginx".into(),
        };
        let info = state
            .forwarder
            .start(
                &state.clusters,
                id,
                target,
                80,
                None,
                sextant_core::portforward::PodFilter::Any,
            )
            .await
            .unwrap();
        info.local_port
    }

    async fn wait_until_closed(state: &AppState, port: u16) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let free = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
                .await
                .is_ok();
            if state.forwarder.list().is_empty() && free {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "port forward still open: {:?}",
                state.forwarder.list()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// A session whose task runs until aborted and whose guard reports being dropped.
    fn pending_session() -> (
        TermSession,
        tokio::task::JoinHandle<()>,
        std::sync::mpsc::Receiver<()>,
    ) {
        struct Dropped(std::sync::mpsc::Sender<()>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let task = tokio::spawn(std::future::pending::<()>());
        let (dropped_tx, dropped) = std::sync::mpsc::channel();
        let (input, _) = mpsc::channel(1);
        let (resize, _) = mpsc::channel(1);
        let session = TermSession {
            cluster: None,
            input,
            resize,
            task: task.abort_handle(),
            guard: Some(Box::new(Dropped(dropped_tx))),
        };
        (session, task, dropped)
    }

    async fn aborted(task: tokio::task::JoinHandle<()>) -> bool {
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .is_ok_and(|end| end.is_err_and(|e| e.is_cancelled()))
    }

    #[tokio::test]
    async fn a_session_refused_for_a_taken_id_is_ended_not_left_running() {
        let sessions = Sessions::default();
        let (first, first_task, _first_dropped) = pending_session();
        sessions.insert("t-1".into(), first).unwrap();
        let (second, second_task, second_dropped) = pending_session();

        let err = sessions.insert("t-1".into(), second).unwrap_err();

        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(
            aborted(second_task).await,
            "the refused session's task ends"
        );
        assert!(second_dropped.try_recv().is_ok(), "its guard is dropped");
        assert!(
            !first_task.is_finished(),
            "the session holding the id runs on"
        );
        assert_eq!(sessions.len(), 1);
    }

    #[tokio::test]
    async fn a_placeholder_is_swapped_for_its_session_at_once_or_the_session_is_ended() {
        let sessions = Sessions::default();
        let (placeholder, placeholder_task, placeholder_dropped) = pending_session();
        sessions.insert("t-1".into(), placeholder).unwrap();
        let (session, session_task, session_dropped) = pending_session();

        let old = sessions
            .replace_if("t-1", |s| s.cluster.is_none(), session)
            .expect("the placeholder is still there");
        // The id never was free: the running session is registered in the same step.
        assert_eq!(sessions.len(), 1);
        assert!(
            placeholder_dropped.try_recv().is_err(),
            "the caller decides about the old one"
        );
        old.end();
        assert!(aborted(placeholder_task).await);
        assert!(sessions.channels("t-1").is_some());

        // Stopped before the swap: the new session is ended, nothing is registered.
        sessions.stop("t-1");
        assert!(aborted(session_task).await);
        assert!(session_dropped.try_recv().is_ok());
        let (late, late_task, late_dropped) = pending_session();
        assert!(sessions.replace_if("t-1", |_| true, late).is_none());
        assert!(aborted(late_task).await, "a session nobody waits for ends");
        assert!(late_dropped.try_recv().is_ok());
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn closing_a_cluster_stops_its_port_forwards() {
        let dirs = tempfile::tempdir().unwrap();
        let Some((state, id)) = connected_state(dirs.path()).await else {
            return;
        };
        let port = forward_nginx(&state, &id).await;
        let other = ClusterId::from("another-cluster");

        state.close_cluster(&other);
        assert_eq!(
            state.forwarder.list().len(),
            1,
            "another cluster's close keeps it"
        );

        state.close_cluster(&id);
        wait_until_closed(&state, port).await;
    }

    #[tokio::test]
    async fn resetting_streams_keeps_the_connection_and_port_forwards() {
        let dirs = tempfile::tempdir().unwrap();
        let Some((state, id)) = connected_state(dirs.path()).await else {
            return;
        };
        forward_nginx(&state, &id).await;

        state.reset_streams();
        assert_eq!(state.forwarder.list().len(), 1, "the port forward stays");
        assert!(
            state.clusters.client(&id).is_ok(),
            "the cluster stays connected"
        );
        state.close_all();
    }

    #[tokio::test]
    async fn closing_everything_stops_every_port_forward() {
        let dirs = tempfile::tempdir().unwrap();
        let Some((state, id)) = connected_state(dirs.path()).await else {
            return;
        };
        let port = forward_nginx(&state, &id).await;

        state.close_all();
        wait_until_closed(&state, port).await;
    }
}
