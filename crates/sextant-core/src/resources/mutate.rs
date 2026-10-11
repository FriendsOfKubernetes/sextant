//! Changes to objects: replace, server-side apply, delete, scale, restart, node and CronJob actions.

use super::ObjectRef;
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::ClusterId;

/// PUT of an edited object; a stale `resourceVersion` gives `Conflict`.
pub async fn replace_yaml(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _yaml: &str,
) -> CoreResult<serde_json::Value> {
    Err(CoreError::not_implemented())
}

/// Multi-document server-side apply with field manager `sextant`.
pub async fn apply_yaml(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _yaml: &str,
) -> CoreResult<Vec<ObjectRef>> {
    Err(CoreError::not_implemented())
}

pub async fn delete(_mgr: &ClusterManager, _cluster: &ClusterId, _r: &ObjectRef) -> CoreResult<()> {
    Err(CoreError::not_implemented())
}

pub async fn scale(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _r: &ObjectRef,
    _replicas: i32,
) -> CoreResult<()> {
    Err(CoreError::not_implemented())
}

/// Rollout restart: patches `kubectl.kubernetes.io/restartedAt` on the pod template.
pub async fn restart(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _r: &ObjectRef,
) -> CoreResult<()> {
    Err(CoreError::not_implemented())
}

pub async fn cordon(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _node: &str,
    _unschedulable: bool,
) -> CoreResult<()> {
    Err(CoreError::not_implemented())
}

/// Cordon + eviction of every pod except DaemonSet-owned and mirror pods.
pub async fn drain(_mgr: &ClusterManager, _cluster: &ClusterId, _node: &str) -> CoreResult<()> {
    Err(CoreError::not_implemented())
}

/// Creates a Job from the CronJob's template.
pub async fn trigger_cronjob(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _r: &ObjectRef,
) -> CoreResult<ObjectRef> {
    Err(CoreError::not_implemented())
}

pub async fn suspend_cronjob(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _r: &ObjectRef,
    _suspend: bool,
) -> CoreResult<()> {
    Err(CoreError::not_implemented())
}
