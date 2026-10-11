//! Helm: releases are read natively, changes go through the `helm` binary.

use sextant_core::helm::cli::{ChartHit, HelmRepo, HelmStatus};
use sextant_core::helm::{HelmRelease, HelmReleaseDetail};
use sextant_core::{ClusterId, CoreError};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn helm_status() -> Result<HelmStatus, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_releases(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _namespaces: Option<Vec<String>>,
) -> Result<Vec<HelmRelease>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_release_detail(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _namespace: String,
    _name: String,
    _revision: Option<i32>,
) -> Result<HelmReleaseDetail, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_release_history(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _namespace: String,
    _name: String,
) -> Result<Vec<HelmRelease>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_upgrade(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _namespace: String,
    _release: String,
    _chart_ref: String,
    _values_yaml: String,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_rollback(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _namespace: String,
    _release: String,
    _revision: i32,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_uninstall(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _namespace: String,
    _release: String,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn helm_install(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _namespace: String,
    _release: String,
    _chart: String,
    _version: Option<String>,
    _values_yaml: String,
) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_repos() -> Result<Vec<HelmRepo>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_repo_add(_name: String, _url: String) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_repo_remove(_name: String) -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_repo_update() -> Result<(), CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_search(_query: String) -> Result<Vec<ChartHit>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn helm_show_values(
    _chart: String,
    _version: Option<String>,
) -> Result<String, CoreError> {
    Err(CoreError::not_implemented())
}
