//! Change timeline (#145). The window records changes from its own watches; these commands read what the watches
//! cannot carry (field managers, the cluster's own history: `sextant_core::timeline`) and keep a recorded timeline
//! between runs when the user turned that on (`settings.timeline.persist`, off by default). Only reads: nothing in the
//! cluster changes. A window command only: neither the MCP server nor the extension API offers any of it.

use std::path::PathBuf;

use sextant_core::timeline::{self, ObjectManagers, PartialHistory};
use sextant_core::{ClusterId, CoreError, CoreResult, KindRef, ObjectRef};
use tauri::State;

use crate::state::AppState;

/// Where saved timelines go (`<app data>/timeline/`), managed beside `AppState`.
pub struct TimelineDir(pub PathBuf);

/// The field managers of up to `timeline::MAX_REFS` objects (metadata reads).
#[tauri::command]
pub async fn timeline_managers(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    refs: Vec<ObjectRef>,
) -> CoreResult<Vec<ObjectManagers>> {
    timeline::managers(&state.clusters, &cluster_id, refs).await
}

/// The partial history of up to `timeline::MAX_NAMESPACES` namespaces.
#[tauri::command]
pub async fn timeline_history(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespaces: Vec<String>,
    kinds: Vec<KindRef>,
    helm: bool,
) -> CoreResult<PartialHistory> {
    timeline::history(&state.clusters, &cluster_id, namespaces, kinds, helm).await
}

/// The partial history of one object.
#[tauri::command]
pub async fn timeline_object_history(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    object: ObjectRef,
) -> CoreResult<PartialHistory> {
    timeline::object_history(&state.clusters, &cluster_id, object).await
}

/// Saves the recorded timeline of a cluster (`text`), or removes it (`null`). The frontend calls it only while
/// persistence is on, and with `null` when it is turned off.
#[tauri::command]
pub async fn timeline_save(
    dir: State<'_, TimelineDir>,
    cluster_id: ClusterId,
    text: Option<String>,
) -> CoreResult<()> {
    let dir = dir.0.clone();
    tauri::async_runtime::spawn_blocking(move || timeline::save(&dir, &cluster_id, text.as_deref()))
        .await
        .map_err(|e| CoreError::other(e.to_string()))?
}

/// Removes the saved timelines of every cluster (persistence turned off).
#[tauri::command]
pub async fn timeline_remove_all(dir: State<'_, TimelineDir>) -> CoreResult<()> {
    let dir = dir.0.clone();
    tauri::async_runtime::spawn_blocking(move || timeline::remove_all(&dir))
        .await
        .map_err(|e| CoreError::other(e.to_string()))?
}

/// The saved timeline of a cluster, `null` when there is none.
#[tauri::command]
pub async fn timeline_load(
    dir: State<'_, TimelineDir>,
    cluster_id: ClusterId,
) -> CoreResult<Option<String>> {
    let dir = dir.0.clone();
    tauri::async_runtime::spawn_blocking(move || timeline::load(&dir, &cluster_id))
        .await
        .map_err(|e| CoreError::other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_the_timeline() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools
                .iter()
                .any(|t| t.contains("timeline") || t.contains("managers")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods
                .iter()
                .any(|m| m.to_lowercase().contains("timeline")),
            "{methods:?}"
        );
    }
}
