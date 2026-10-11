//! Tauri-managed application state.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use sextant_core::portforward::PortForwarder;
use sextant_core::{ClusterId, ClusterManager, KubeconfigRegistry, SettingsStore};
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
        }
    }

    /// Stops every subscription and session of a cluster (on disconnect).
    pub fn close_cluster(&self, cluster: &ClusterId) {
        self.subscriptions.stop_cluster(cluster);
        self.sessions.stop_cluster(cluster);
    }

    /// Stops everything (window closed).
    pub fn close_all(&self) {
        self.subscriptions.stop_all();
        self.sessions.stop_all();
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// A new id for a subscription, stream or session, e.g. `watch-7`. Safe in event names.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed))
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
    pub fn insert(&self, id: String, subscription: Subscription) {
        lock(&self.map).insert(id, subscription);
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

/// A running terminal: container exec (`cluster` set) or local shell.
pub struct TermSession {
    pub cluster: Option<ClusterId>,
    pub input: mpsc::Sender<Vec<u8>>,
    pub resize: mpsc::Sender<(u16, u16)>,
    /// The task that pumps output to the window; aborting it ends the session.
    pub task: AbortHandle,
}

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, TermSession>>,
}

impl Sessions {
    pub fn insert(&self, id: String, session: TermSession) {
        lock(&self.map).insert(id, session);
    }

    /// Input and resize senders of a session.
    pub fn channels(&self, id: &str) -> Option<TermChannels> {
        lock(&self.map)
            .get(id)
            .map(|s| (s.input.clone(), s.resize.clone()))
    }

    pub fn stop(&self, id: &str) -> bool {
        match lock(&self.map).remove(id) {
            Some(session) => {
                session.task.abort();
                true
            }
            None => false,
        }
    }

    pub fn remove(&self, id: &str) {
        lock(&self.map).remove(id);
    }

    pub fn stop_cluster(&self, cluster: &ClusterId) {
        lock(&self.map).retain(|_, s| {
            let keep = s.cluster.as_ref() != Some(cluster);
            if !keep {
                s.task.abort();
            }
            keep
        });
    }

    pub fn stop_all(&self) {
        for (_, s) in lock(&self.map).drain() {
            s.task.abort();
        }
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
