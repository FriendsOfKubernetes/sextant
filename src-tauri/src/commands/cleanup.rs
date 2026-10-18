//! The "Cleanup" page (#147): which kinds a namespace holds objects of (`resources::sample_namespace`: metadata-only
//! lists of at most a few objects, names only). The page offers an empty namespace, or a ConfigMap, Secret or claim
//! of a namespace, only when nothing it cannot judge is there; and `cleanup_cluster_check` (API groups that do not
//! answer, ConfigMaps and Secrets that cluster-scoped objects name). Read-only; a window command only: neither the MCP
//! server nor the extension API offers it.

use sextant_core::resources::{self, ClusterCheck, KindRef, KindSample, NamedObject};
use sextant_core::{ClusterId, CoreResult};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn cleanup_sample(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    kinds: Vec<KindRef>,
    limit: u32,
) -> CoreResult<Vec<KindSample>> {
    resources::sample_namespace(&state.clusters, &cluster_id, &namespace, &kinds, limit).await
}

/// The cluster-wide check: API group versions that do not answer, and which of `targets` (ConfigMaps and Secrets) an
/// object of the cluster-scoped `kinds` names (`resources::cluster_check`; only targets come back, never a value).
#[tauri::command]
pub async fn cleanup_cluster_check(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    kinds: Vec<KindRef>,
    targets: Vec<NamedObject>,
) -> CoreResult<ClusterCheck> {
    resources::cluster_check(&state.clusters, &cluster_id, &kinds, &targets).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_the_cleanup_sample() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools
                .iter()
                .any(|t| t.contains("cleanup") || t.contains("sample")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| {
                let m = m.to_lowercase();
                m.contains("cleanup") || m.contains("sample")
            }),
            "{methods:?}"
        );
    }
}
