//! Kubeconfig sources and cluster connections.

use std::path::PathBuf;

use sextant_core::resources::ResourceKind;
use sextant_core::{ClusterId, ClusterInfo, ConnectionState, CoreError, KubeconfigSource};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn clusters_list(_state: State<'_, AppState>) -> Result<Vec<ClusterInfo>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn kubeconfig_sources(
    _state: State<'_, AppState>,
) -> Result<Vec<KubeconfigSource>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn kubeconfig_add_file(
    _state: State<'_, AppState>,
    _path: PathBuf,
) -> Result<KubeconfigSource, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn kubeconfig_add_pasted(
    _state: State<'_, AppState>,
    _text: String,
) -> Result<KubeconfigSource, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn kubeconfig_remove(
    _state: State<'_, AppState>,
    _source_id: String,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn cluster_connect(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn cluster_disconnect(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn cluster_state(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
) -> Result<ConnectionState, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn cluster_kinds(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
) -> Result<Vec<ResourceKind>, CoreError> {
    Err(CoreError::not_implemented())
}
