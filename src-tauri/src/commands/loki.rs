//! Logs of gone pods from Loki (#265), read through the API server's service proxy with the user's own credentials;
//! nothing is installed, stored or changed. Every request is built in the core from validated names; the window sends
//! names, a time range and a line limit, never LogQL, a label, a path or a URL. Window only — neither MCP agents nor
//! extensions have it.

use sextant_core::loki::{
    self, LokiLogsQuery, LokiNames, LokiNamesQuery, LokiRange, LokiSettings, LokiStatus, LokiUpdate,
};
use sextant_core::{ClusterId, CoreError};
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

use crate::commands::logs::start_logs;
use crate::state::AppState;

/// The cluster's Loki settings (`ClusterSettings.loki`), read fresh on every call.
fn loki_settings(state: &AppState, cluster: &ClusterId) -> LokiSettings {
    state
        .settings
        .get()
        .clusters
        .get(&cluster.0)
        .and_then(|c| c.loki.clone())
        .unwrap_or_default()
}

/// Whether the cluster has a Loki (found, or named in the settings), where, and which labels it has.
#[tauri::command]
pub async fn loki_status(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<LokiStatus, CoreError> {
    let settings = loki_settings(&state, &cluster_id);
    loki::status(&state.clusters, &cluster_id, &settings).await
}

/// Pod names of a workload, or container names of a pod, seen in Loki in `range`. A malformed query is `invalid`
/// before the cluster is looked up.
#[tauri::command]
pub async fn loki_names(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    query: LokiNamesQuery,
    range: LokiRange,
) -> Result<LokiNames, CoreError> {
    loki::validate_names_query(&query)?;
    let settings = loki_settings(&state, &cluster_id);
    loki::names(&state.clusters, &cluster_id, &settings, &query, &range).await
}

/// Reads lines from Loki under `stream_id` (chosen by the window), page by page through `on_event`. The read belongs
/// to the cluster like a log stream: `loki_logs_stop`, disconnecting, `streams_reset` and closing the window stop it.
#[tauri::command]
pub async fn loki_logs_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    query: LokiLogsQuery,
    stream_id: String,
    on_event: Channel<LokiUpdate>,
) -> Result<(), CoreError> {
    let settings = loki_settings(&state, &cluster_id);
    let open = loki::read_logs(&state.clusters, &cluster_id, &settings, query);
    start_logs(&app, &state, stream_id, cluster_id.clone(), open, on_event).await
}

/// Stops a read. Stopping one that already ended (or never existed) is not an error.
#[tauri::command]
pub async fn loki_logs_stop(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), CoreError> {
    state.subscriptions.stop(&stream_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_loki() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(!tools.iter().any(|t| t.contains("loki")), "{tools:?}");
        let methods = crate::extensions::api::METHODS;
        assert!(!methods.iter().any(|m| m.contains("loki")), "{methods:?}");
    }
}
