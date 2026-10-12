//! Values of Kubernetes Secrets, read only on an explicit request: the watch and `resource_get` send Secrets
//! without their values.

use sextant_core::{ClusterId, CoreError, ObjectRef};
use tauri::State;

use crate::state::AppState;

/// The value of one key of a Secret, decoded from base64 as UTF-8 text.
#[tauri::command]
pub async fn secret_value(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _namespace: String,
    _name: String,
    _key: String,
) -> Result<String, CoreError> {
    Err(CoreError::not_implemented())
}

/// The whole object, values included — only for editing a Secret.
#[tauri::command]
pub async fn resource_get_full(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<serde_json::Value, CoreError> {
    Err(CoreError::not_implemented())
}
