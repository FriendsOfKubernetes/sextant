//! "Can I …" for the current user (#140): SelfSubjectAccessReview and SelfSubjectRulesReview through the core
//! (`sextant_core::rbac`). Both only ask the API server and change nothing. They are window commands only: neither the
//! MCP server nor the extension API offers them (an agent or extension gets nothing new without a decision to grant it,
//! and the answers describe the app user's own credentials, which are not theirs to probe).

use sextant_core::rbac::{self, AccessAnswer, AccessQuery, RulesReview};
use sextant_core::{ClusterId, CoreResult};
use tauri::State;

use crate::state::AppState;

/// The API server's answer to each question, in order (at most `rbac::MAX_QUERIES`).
#[tauri::command]
pub async fn rbac_can_i(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    queries: Vec<AccessQuery>,
) -> CoreResult<Vec<AccessAnswer>> {
    rbac::can_i(&state.clusters, &cluster_id, queries).await
}

/// What the current user may do in `namespace`, as the API server lists it.
#[tauri::command]
pub async fn rbac_rules_review(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
) -> CoreResult<RulesReview> {
    rbac::rules_review(&state.clusters, &cluster_id, &namespace).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_can_ask_access_reviews() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools
                .iter()
                .any(|t| t.contains("rbac") || t.contains("can_i") || t.contains("review")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| m.contains("rbac")
                || m.contains("canI")
                || m.contains("can_i")
                || m.contains("review")),
            "{methods:?}"
        );
    }
}
