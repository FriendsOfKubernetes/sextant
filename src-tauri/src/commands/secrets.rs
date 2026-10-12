//! Values of Kubernetes Secrets, read only on an explicit request: the watch and `resource_get` send Secrets
//! without their values.

use sextant_core::resources;
use sextant_core::{ClusterId, CoreError, ObjectRef};
use tauri::State;

use crate::state::AppState;

/// The value of one key of a Secret, decoded from base64 as UTF-8 text; a binary value is `invalid` with its size.
#[tauri::command]
pub async fn secret_value(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    key: String,
) -> Result<String, CoreError> {
    resources::secret_value(&state.clusters, &cluster_id, &namespace, &name, &key).await
}

/// The whole object, values included — only for editing a Secret.
#[tauri::command]
pub async fn resource_get_full(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<serde_json::Value, CoreError> {
    resources::get_full(&state.clusters, &cluster_id, &_ref).await
}
