//! Actions on workloads, nodes and CronJobs: thin wrappers over `sextant_core::resources`.
//!
//! Every change in the cluster is limited to [`CHANGE_TIMEOUT`]: an API server that does not answer (or keeps
//! answering "try later") gives a `timeout` error instead of an action that hangs. A drain is the exception: it is
//! one request per pod, so each request is limited instead (see [`node_drain`]).

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

/// What draining the node would do with its pods (lists only, changes nothing).
#[tauri::command]
pub async fn node_drain_preview(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    name: String,
) -> Result<DrainPreview, CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "listing the pods of the node",
        resources::drain_preview(&state.clusters, &cluster_id, &name),
    )
    .await
}

/// Cordons the node and evicts its pods like `kubectl drain`: DaemonSet and mirror pods stay; pods without a
/// controller go only with `options.force`, pods with `emptyDir` data only with `options.deleteEmptyDirData`.
///
/// Not limited as a whole: a drain sends one request per pod, so the core limits each request
/// (`resources::STEP_TIMEOUT`, as long as [`CHANGE_TIMEOUT`]) and a `timeout` error names the pods already evicted
/// and the ones not sent.
#[tauri::command]
pub async fn node_drain(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    name: String,
    options: DrainOptions,
) -> Result<(), CoreError> {
    resources::drain(&state.clusters, &cluster_id, &name, options).await
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
