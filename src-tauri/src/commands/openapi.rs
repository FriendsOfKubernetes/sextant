//! The cluster's OpenAPI v3 schema for the YAML editor (#151): one kind at a time, compact
//! (`sextant_core::openapi`). Only reads; a window command only: neither the MCP server nor the extension API offers
//! it.

use sextant_core::openapi::{self, KindSchema};
use sextant_core::{ClusterId, CoreResult};
use tauri::State;

use crate::state::AppState;

/// The schema of `group/version/kind`, `null` when the cluster publishes none for it.
#[tauri::command]
pub async fn openapi_kind_schema(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    group: String,
    version: String,
    kind: String,
) -> CoreResult<Option<KindSchema>> {
    openapi::kind_schema(&state.clusters, &cluster_id, &group, &version, &kind).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_the_schema() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools
                .iter()
                .any(|t| t.contains("openapi") || t.contains("schema")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| {
                let m = m.to_lowercase();
                m.contains("openapi") || m.contains("schema")
            }),
            "{methods:?}"
        );
    }
}
