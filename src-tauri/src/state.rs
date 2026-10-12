//! Tauri-managed application state.

use std::any::Any;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use sextant_core::portforward::PortForwarder;
use sextant_core::{
    ClusterId, ClusterManager, CoreError, ErrorCode, KubeconfigRegistry, SettingsStore,
};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

/// Everything the commands share. Registered with `app.manage(AppState::new(..))`.
pub struct AppState {
    pub registry: Arc<RwLock<KubeconfigRegistry>>,
    pub clusters: ClusterManager,
    pub forwarder: Arc<PortForwarder>,
    pub settings: Arc<SettingsStore>,
    /// Watch subscriptions and log streams (`watch_start`, `logs_start`).
    pub subscriptions: Subscriptions,
    /// Terminal sessions: container exec and local shells.
    pub sessions: Sessions,
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
        Self {
            clusters: ClusterManager::new(Arc::clone(&registry)),
            registry,
            forwarder: Arc::new(PortForwarder::new()),
            settings,
            subscriptions: Subscriptions::default(),
            sessions: Sessions::default(),
            streams_generation: AtomicU64::new(0),
        }
    }

    /// Stops every subscription, session and port forward of a cluster (on disconnect).
    pub fn close_cluster(&self, cluster: &ClusterId) {
        self.subscriptions.stop_cluster(cluster);
        self.sessions.stop_cluster(cluster);
        self.forwarder.stop_cluster(cluster);
    }

    /// Stops everything (window closed, application exiting). Terminal sessions drop their temporary kubeconfig
    /// before this returns.
    pub fn close_all(&self) {
        self.reset_streams();
        self.forwarder.stop_all();
    }

    /// Stops every watch subscription, log stream and terminal session, but keeps connections and port forwards
    /// (`streams_reset`: the window was reloaded and nobody listens to the old streams any more).
    pub fn reset_streams(&self) {
        // First: a start that registers from now on sees the reset and undoes itself.
        self.streams_generation.fetch_add(1, Ordering::SeqCst);
        self.subscriptions.stop_all();
        self.sessions.stop_all();
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
    fn end(self) {
        self.task.abort();
        drop(self.guard);
    }
}

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, TermSession>>,
}

impl Sessions {
    /// Registers a session under the id the frontend chose; a taken or malformed id is `invalid` and the session
    /// (with its guard) is dropped.
    pub fn insert(&self, id: String, session: TermSession) -> Result<(), CoreError> {
        check_stream_id(&id)?;
        match lock(&self.map).entry(id) {
            Entry::Occupied(taken) => Err(busy(taken.key())),
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
            .start(&state.clusters, id, target, 80, None)
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
