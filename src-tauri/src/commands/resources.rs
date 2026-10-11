//! Watch subscriptions and reading/writing objects.
//!
//! Note: `resource_replace` / `resource_apply` / `resource_delete` stay here (they are listed with `resource_get`
//! in the command table); their core functions live in `sextant_core::resources::mutate`.

use sextant_core::{ClusterId, CoreError, ObjectRef, WatchSpec};
use tauri::{AppHandle, Runtime, State};

use crate::state::AppState;

/// Starts a watch; updates arrive as `watch:<subscriptionId>` events.
#[tauri::command]
pub async fn watch_start<R: Runtime>(
    _app: AppHandle<R>,
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _spec: WatchSpec,
) -> Result<String, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn watch_stop(
    _state: State<'_, AppState>,
    _subscription_id: String,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn resource_get(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<serde_json::Value, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn resource_replace(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _yaml: String,
) -> Result<serde_json::Value, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn resource_apply(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _yaml: String,
) -> Result<Vec<ObjectRef>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn resource_delete(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}
