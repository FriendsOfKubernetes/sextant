//! Connections to clusters: one `kube::Client` per connected cluster, connection states, discovery cache.
//!
//! Stage 01 skeleton: states and the broadcast channel work; connecting is filled in by the clusters stage.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::{ClusterId, KubeconfigRegistry};
use crate::resources::ResourceKind;

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
    states: Mutex<HashMap<ClusterId, ConnectionState>>,
    state_tx: broadcast::Sender<(ClusterId, ConnectionState)>,
}

impl ClusterManager {
    pub fn new(registry: Arc<RwLock<KubeconfigRegistry>>) -> Self {
        let (state_tx, _) = broadcast::channel(64);
        Self {
            inner: Arc::new(Inner {
                registry,
                states: Mutex::new(HashMap::new()),
                state_tx,
            }),
        }
    }

    /// The kubeconfig registry this manager reads contexts from.
    pub fn registry(&self) -> Arc<RwLock<KubeconfigRegistry>> {
        Arc::clone(&self.inner.registry)
    }

    pub async fn connect(&self, _id: &ClusterId) -> CoreResult<()> {
        Err(CoreError::not_implemented())
    }

    pub async fn disconnect(&self, _id: &ClusterId) {}

    pub fn state(&self, id: &ClusterId) -> ConnectionState {
        let states = self.inner.states.lock().unwrap_or_else(|e| e.into_inner());
        states.get(id).cloned().unwrap_or_default()
    }

    pub fn subscribe_states(&self) -> broadcast::Receiver<(ClusterId, ConnectionState)> {
        self.inner.state_tx.subscribe()
    }

    /// Client of a connected cluster; an error if the cluster is not connected.
    pub fn client(&self, _id: &ClusterId) -> CoreResult<kube::Client> {
        Err(CoreError::not_implemented())
    }

    /// Discovery: every resource kind the cluster serves, cached until reconnect.
    pub async fn kinds(&self, _id: &ClusterId) -> CoreResult<Vec<ResourceKind>> {
        Err(CoreError::not_implemented())
    }
}
