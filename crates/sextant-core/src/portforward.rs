//! Port forwarding from a local port to a pod or service.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::ClusterId;

/// Serialized with a `type` tag: `{ "type": "pod", "namespace": "…", "name": "…" }`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ForwardTarget {
    Pod { namespace: String, name: String },
    Service { namespace: String, name: String },
}

/// Serialized with a `state` tag: `{ "state": "active" }`, `{ "state": "error", "code": …, "message": … }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum ForwardStatus {
    Active,
    Error(CoreError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForwardInfo {
    pub id: String,
    pub cluster: ClusterId,
    pub target: ForwardTarget,
    pub remote_port: u16,
    pub local_port: u16,
    pub status: ForwardStatus,
}

/// All active forwards of the application.
pub struct PortForwarder {
    forwards: Mutex<Vec<ForwardInfo>>,
    tx: broadcast::Sender<Vec<ForwardInfo>>,
}

impl Default for PortForwarder {
    fn default() -> Self {
        Self::new()
    }
}

impl PortForwarder {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            forwards: Mutex::new(Vec::new()),
            tx,
        }
    }

    /// Starts forwarding; `local_port: None` picks a free port. A taken port gives `PortInUse`.
    pub async fn start(
        &self,
        _mgr: &ClusterManager,
        _cluster: &ClusterId,
        _target: ForwardTarget,
        _remote_port: u16,
        _local_port: Option<u16>,
    ) -> CoreResult<ForwardInfo> {
        Err(CoreError::not_implemented())
    }

    pub fn list(&self) -> Vec<ForwardInfo> {
        self.forwards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub async fn stop(&self, _id: &str) -> CoreResult<()> {
        Err(CoreError::not_implemented())
    }

    /// Receives the full list after every change.
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<ForwardInfo>> {
        self.tx.subscribe()
    }
}
