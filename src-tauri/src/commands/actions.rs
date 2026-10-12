//! Actions on workloads, nodes and CronJobs: thin wrappers over `sextant_core::resources`.
//!
//! Every change in the cluster is limited to [`CHANGE_TIMEOUT`]: an API server that does not answer (or keeps
//! answering "try later") gives a `timeout` error instead of an action that hangs.

use std::time::Duration;

use sextant_core::error::with_timeout;
use sextant_core::resources;
use sextant_core::{ClusterId, CoreError, DrainOptions, DrainPreview, ObjectRef};
use tauri::State;

use crate::state::AppState;

/// How long one action may take.
pub const CHANGE_TIMEOUT: Duration = Duration::from_secs(30);

/// Sets the replica count of a Deployment, StatefulSet or ReplicaSet.
#[tauri::command]
pub async fn workload_scale(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
    replicas: i32,
) -> Result<(), CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "scaling",
        resources::scale(&state.clusters, &cluster_id, &_ref, replicas),
    )
    .await
}

/// Rollout restart of a Deployment, StatefulSet or DaemonSet.
#[tauri::command]
pub async fn workload_restart(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<(), CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "the restart",
        resources::restart(&state.clusters, &cluster_id, &_ref),
    )
    .await
}

/// Cordon (`unschedulable: true`) or uncordon a node.
#[tauri::command]
pub async fn node_cordon(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    name: String,
    unschedulable: bool,
) -> Result<(), CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "changing the node",
        resources::cordon(&state.clusters, &cluster_id, &name, unschedulable),
    )
    .await
}

/// What draining the node would do with its pods.
#[tauri::command]
pub async fn node_drain_preview(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _name: String,
) -> Result<DrainPreview, CoreError> {
    Err(CoreError::not_implemented())
}

/// Cordons the node and evicts its pods (DaemonSet and mirror pods stay). `options` is not applied yet and may be
/// left out until the drain dialog sends it.
#[tauri::command]
pub async fn node_drain(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    name: String,
    options: Option<DrainOptions>,
) -> Result<(), CoreError> {
    let _ = options;
    with_timeout(
        CHANGE_TIMEOUT,
        "the drain",
        resources::drain(&state.clusters, &cluster_id, &name),
    )
    .await
}

/// Starts a Job from the CronJob's template now; returns the Job.
#[tauri::command]
pub async fn cronjob_trigger(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<ObjectRef, CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "starting the Job",
        resources::trigger_cronjob(&state.clusters, &cluster_id, &_ref),
    )
    .await
}

/// Suspends (`suspend: true`) or resumes a CronJob.
#[tauri::command]
pub async fn cronjob_suspend(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
    suspend: bool,
) -> Result<(), CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "changing the CronJob",
        resources::suspend_cronjob(&state.clusters, &cluster_id, &_ref, suspend),
    )
    .await
}
