//! Alerts (#264, ADR-0119): the firing and pending alerts of the cluster's Prometheus-compatible source and the alerts
//! and silences of its Alertmanager, read through the API server's service proxy with the user's own credentials and
//! fixed requests built in the core; nothing is changed. The window sends only the cluster: how the sources are found
//! comes from the cluster settings (`prometheus`, `alertmanager`). Window only — neither MCP agents nor extensions have
//! it.

use sextant_core::alerts::{self, AlertsReport};
use sextant_core::{ClusterId, CoreError};
use tauri::State;

use crate::state::AppState;

/// Both sources' alerts and the Alertmanager's silences; a source that is off, missing or failing is said in the
/// report, not as an error.
#[tauri::command]
pub async fn alerts_list(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<AlertsReport, CoreError> {
    let settings = state
        .settings
        .get()
        .clusters
        .get(&cluster_id.0)
        .cloned()
        .unwrap_or_default();
    alerts::report(
        &state.clusters,
        &cluster_id,
        &settings.prometheus,
        &settings.alertmanager.unwrap_or_default(),
    )
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_alerts_or_silences() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        let forbidden = ["alert", "silence"];
        assert!(
            !tools
                .iter()
                .any(|t| forbidden.iter().any(|f| t.contains(f))),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods
                .iter()
                .any(|m| forbidden.iter().any(|f| m.contains(f))),
            "{methods:?}"
        );
    }
}
