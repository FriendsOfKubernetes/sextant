//! Actions on workloads, nodes and CronJobs.

use sextant_core::{ClusterId, CoreError, ObjectRef};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn workload_scale(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _ref: ObjectRef,
    _replicas: i32,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn workload_restart(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn node_cordon(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _name: String,
    _unschedulable: bool,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn node_drain(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _name: String,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn cronjob_trigger(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<ObjectRef, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn cronjob_suspend(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _ref: ObjectRef,
    _suspend: bool,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}
