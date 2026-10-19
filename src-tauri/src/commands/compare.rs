//! Comparing objects across clusters and namespaces (#156), read-only: bounded namespace lists, Secrets compared by
//! key names and value hashes inside the core (`compare_secrets`, `compare_secret_namespaces`: no value and no hash
//! leaves the core), and a Helm release's manifest against the live objects (`compare_helm_drift`). Window commands
//! only: neither the MCP server nor the extension API offers them. A cluster that is not connected is an error;
//! nothing here connects one.

use sextant_core::compare::{
    self, CompareKindList, HelmDrift, NamespaceSide, SecretComparison, SecretNamespaceComparison,
    SecretSide,
};
use sextant_core::resources::KindRef;
use sextant_core::{ClusterId, CoreResult};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn compare_list(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    kinds: Vec<KindRef>,
    limit: u32,
) -> CoreResult<Vec<CompareKindList>> {
    compare::list_namespace(&state.clusters, &cluster_id, &namespace, &kinds, limit).await
}

#[tauri::command]
pub async fn compare_secrets(
    state: State<'_, AppState>,
    left: SecretSide,
    right: SecretSide,
) -> CoreResult<SecretComparison> {
    compare::compare_secrets(&state.clusters, &left, &right).await
}

#[tauri::command]
pub async fn compare_secret_namespaces(
    state: State<'_, AppState>,
    left: NamespaceSide,
    right: NamespaceSide,
) -> CoreResult<SecretNamespaceComparison> {
    compare::compare_secret_namespaces(&state.clusters, &left, &right).await
}

#[tauri::command]
pub async fn compare_helm_drift(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
) -> CoreResult<HelmDrift> {
    compare::helm_drift(&state.clusters, &cluster_id, &namespace, &name).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_the_comparison() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools
                .iter()
                .any(|t| t.contains("compare") || t.contains("drift") || t.contains("hash")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| {
                let m = m.to_lowercase();
                m.contains("compare") || m.contains("drift") || m.contains("hash")
            }),
            "{methods:?}"
        );
    }
}
