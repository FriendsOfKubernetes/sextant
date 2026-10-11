//! Port forwards. The full list is pushed as the `portforwards` event after every change.

use sextant_core::portforward::{ForwardInfo, ForwardTarget};
use sextant_core::{ClusterId, CoreError};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn portforward_start(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _target: ForwardTarget,
    _remote_port: u16,
    _local_port: Option<u16>,
) -> Result<ForwardInfo, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn portforward_list(_state: State<'_, AppState>) -> Result<Vec<ForwardInfo>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn portforward_stop(_state: State<'_, AppState>, _id: String) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}
