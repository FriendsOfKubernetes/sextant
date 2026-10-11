//! Pod log streams; lines arrive as `logs:<streamId>` events.

use sextant_core::logs::LogOptions;
use sextant_core::{ClusterId, CoreError, ObjectRef};
use tauri::{AppHandle, Runtime, State};

use crate::state::AppState;

#[tauri::command]
pub async fn logs_start<R: Runtime>(
    _app: AppHandle<R>,
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _pod: ObjectRef,
    _opts: LogOptions,
) -> Result<String, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn logs_stop(_state: State<'_, AppState>, _stream_id: String) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}
