//! Terminal sessions: shell in a container (`exec_start`) and a local shell (`terminal_start`).
//! Output arrives as `term:<sessionId>` events; input, resize and stop are shared by both kinds.

use sextant_core::{ClusterId, CoreError, ObjectRef};
use tauri::{AppHandle, Runtime, State};

use crate::state::AppState;

#[tauri::command]
pub async fn exec_start<R: Runtime>(
    _app: AppHandle<R>,
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _pod: ObjectRef,
    _container: String,
    _cols: u16,
    _rows: u16,
) -> Result<String, CoreError> {
    Err(CoreError::not_implemented())
}

/// Local shell with `KUBECONFIG` pointing at a temporary kubeconfig of the cluster.
#[tauri::command]
pub async fn terminal_start<R: Runtime>(
    _app: AppHandle<R>,
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _cols: u16,
    _rows: u16,
) -> Result<String, CoreError> {
    Err(CoreError::not_implemented())
}

/// `data` is the text typed into the terminal.
#[tauri::command]
pub async fn term_input(
    _state: State<'_, AppState>,
    _session_id: String,
    _data: String,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn term_resize(
    _state: State<'_, AppState>,
    _session_id: String,
    _cols: u16,
    _rows: u16,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn term_stop(_state: State<'_, AppState>, _session_id: String) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}
