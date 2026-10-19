//! Storage insights (#152): the fill level of every mounted PersistentVolumeClaim, from the kubelets' stats summaries
//! or, when `nodes/proxy` is forbidden, from the Prometheus of the cluster settings. Read-only; the window polls it
//! (once a minute, shared per cluster) only while a view needs it. Snapshots and Velero objects are created by
//! `resource_create` — one POST after the window's own confirmation, so an object of the same name is never touched
//! (the API server answers AlreadyExists) — limited to [`CHANGE_TIMEOUT`] and never repeated.

use sextant_core::error::with_timeout;
use sextant_core::metrics::{self, VolumeUsageReport};
use sextant_core::{ClusterId, CoreError, ObjectRef, resources};
use tauri::State;

use crate::commands::actions::CHANGE_TIMEOUT;
use crate::state::AppState;

/// Creates the one object of `yaml` (a POST): `conflict` when an object of that name exists, `invalid` for a Secret
/// loaded without its values. Only the window's storage actions call it; agents and extensions do not get it.
#[tauri::command]
pub async fn resource_create(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    yaml: String,
) -> Result<ObjectRef, CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "creating the object",
        resources::create_yaml(&state.clusters, &cluster_id, &yaml),
    )
    .await
}

#[tauri::command]
pub async fn storage_volume_usage(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<VolumeUsageReport, CoreError> {
    let prometheus = state
        .settings
        .get()
        .clusters
        .get(&cluster_id.0)
        .map(|c| c.prometheus.clone())
        .unwrap_or_default();
    metrics::volume_usage(&state.clusters, &cluster_id, &prometheus).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_the_volume_usage() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        // (The extensions' own `storage.*` methods are their key-value store, not this.)
        let new = ["volume", "snapshot", "velero", "backup", "create"];
        assert!(
            !tools.iter().any(|t| new.iter().any(|n| t.contains(n))),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| new.iter().any(|n| m.contains(n))),
            "{methods:?}"
        );
    }
}
