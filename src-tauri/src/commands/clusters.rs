//! Kubeconfig sources and cluster connections.

use std::path::PathBuf;

use sextant_core::resources::ResourceKind;
use sextant_core::{ClusterId, ClusterInfo, ConnectionState, CoreError, KubeconfigSource};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn clusters_list(state: State<'_, AppState>) -> Result<Vec<ClusterInfo>, CoreError> {
    list_clusters(&state)
}

pub fn list_clusters(state: &AppState) -> Result<Vec<ClusterInfo>, CoreError> {
    read_registry(state).clusters()
}

#[tauri::command]
pub async fn kubeconfig_sources(
    state: State<'_, AppState>,
) -> Result<Vec<KubeconfigSource>, CoreError> {
    Ok(read_registry(&state).sources())
}

#[tauri::command]
pub async fn kubeconfig_add_file(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<KubeconfigSource, CoreError> {
    let source = write_registry(&state).add_file(path)?;
    save_sources(&state)?;
    Ok(source)
}

#[tauri::command]
pub async fn kubeconfig_add_pasted(
    state: State<'_, AppState>,
    text: String,
) -> Result<KubeconfigSource, CoreError> {
    let source = write_registry(&state).add_pasted(&text)?;
    save_sources(&state)?;
    Ok(source)
}

/// Removes an added or pasted source and disconnects its clusters (closing their subscriptions).
#[tauri::command]
pub async fn kubeconfig_remove(
    state: State<'_, AppState>,
    source_id: String,
) -> Result<(), CoreError> {
    let affected: Vec<ClusterId> = list_clusters(&state)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.source_id == source_id)
        .map(|c| c.id)
        .collect();
    write_registry(&state).remove_source(&source_id)?;
    save_sources(&state)?;
    for id in affected {
        disconnect_cluster(&state, &id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn cluster_connect(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<(), CoreError> {
    state.clusters.connect(&cluster_id).await
}

#[tauri::command]
pub async fn cluster_disconnect(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<(), CoreError> {
    disconnect_cluster(&state, &cluster_id).await;
    Ok(())
}

#[tauri::command]
pub async fn cluster_state(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<ConnectionState, CoreError> {
    Ok(state.clusters.state(&cluster_id))
}

#[tauri::command]
pub async fn cluster_kinds(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<Vec<ResourceKind>, CoreError> {
    state.clusters.kinds(&cluster_id).await
}

/// Forgets the cluster's discovery without reconnecting (a CRD was created or deleted); the next `cluster_kinds`
/// asks the server again.
#[tauri::command]
pub async fn cluster_kinds_refresh(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<(), CoreError> {
    state.clusters.refresh_kinds(&cluster_id);
    Ok(())
}

/// Disconnects a cluster and stops its watch subscriptions, log streams and exec sessions.
pub async fn disconnect_cluster(state: &AppState, id: &ClusterId) {
    state.clusters.disconnect(id).await;
    state.close_cluster(id);
}

/// Writes the added/pasted sources to the settings, so they survive a restart.
fn save_sources(state: &AppState) -> Result<(), CoreError> {
    let sources = read_registry(state).added_sources();
    state
        .settings
        .update(move |s| s.kubeconfig_sources = sources)
}

fn read_registry(
    state: &AppState,
) -> std::sync::RwLockReadGuard<'_, sextant_core::KubeconfigRegistry> {
    state.registry.read().unwrap_or_else(|e| e.into_inner())
}

fn write_registry(
    state: &AppState,
) -> std::sync::RwLockWriteGuard<'_, sextant_core::KubeconfigRegistry> {
    state.registry.write().unwrap_or_else(|e| e.into_inner())
}
