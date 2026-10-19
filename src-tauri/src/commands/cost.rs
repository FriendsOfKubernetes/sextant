//! Costs from OpenCost or Kubecost (#153), read through the API server's service proxy with the user's own
//! credentials; nothing is installed, stored or changed. Window only — neither MCP agents nor extensions have it.

use sextant_core::cost::{self, CostQuery, CostReport};
use sextant_core::{ClusterId, CoreError};
use tauri::State;

use crate::state::AppState;

/// Costs of `query` from the cluster's OpenCost or Kubecost; `source: null` when neither is found. A malformed
/// query is `invalid` before the cluster is looked up.
#[tauri::command]
pub async fn cost_allocation(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    query: CostQuery,
) -> Result<CostReport, CoreError> {
    cost::validate(&query)?;
    cost::allocation(&state.clusters, &cluster_id, &query).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_costs() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(!tools.iter().any(|t| t.contains("cost")), "{tools:?}");
        let methods = crate::extensions::api::METHODS;
        assert!(!methods.iter().any(|m| m.contains("cost")), "{methods:?}");
    }
}
