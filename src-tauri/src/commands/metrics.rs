//! CPU/memory usage and charts. Each command reads the cluster's metrics settings (`prometheus`, `usageSource`)
//! from the settings store, so a change in the cluster settings applies to the next call.

use sextant_core::metrics::{
    self, ChartTarget, HistoryScope, HistoryWindow, MetricsStatus, NodeUsage, PodUsage,
    PrometheusMode, RequestHealth, RequestTarget, Series, UsageHistory,
};
use sextant_core::{ClusterId, ClusterSettings, CoreError, ErrorCode};
use tauri::State;

use crate::state::AppState;

fn cluster_settings(state: &AppState, cluster: &ClusterId) -> ClusterSettings {
    state
        .settings
        .get()
        .clusters
        .get(&cluster.0)
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn metrics_pods(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespaces: Option<Vec<String>>,
) -> Result<Vec<PodUsage>, CoreError> {
    let settings = cluster_settings(&state, &cluster_id);
    metrics::pod_usage(&state.clusters, &cluster_id, &settings, namespaces).await
}

#[tauri::command]
pub async fn metrics_nodes(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<Vec<NodeUsage>, CoreError> {
    let settings = cluster_settings(&state, &cluster_id);
    metrics::node_usage(&state.clusters, &cluster_id, &settings).await
}

#[tauri::command]
pub async fn metrics_status(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<MetricsStatus, CoreError> {
    let settings = cluster_settings(&state, &cluster_id);
    Ok(metrics::metrics_status(
        &state.clusters,
        &cluster_id,
        &settings.prometheus,
        &settings.usage_source,
    )
    .await)
}

/// Charts from the Prometheus of the cluster settings (manual, or auto-detected); `notFound` when there is none.
#[tauri::command]
pub async fn metrics_charts(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    chart: ChartTarget,
    range_secs: i64,
) -> Result<Vec<Series>, CoreError> {
    let settings = cluster_settings(&state, &cluster_id);
    let target = metrics::prometheus_target(&state.clusters, &cluster_id, &settings.prometheus)
        .await?
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                match settings.prometheus {
                    PrometheusMode::Off => "Prometheus is turned off in the cluster settings",
                    _ => "Prometheus was not found",
                },
            )
        })?;
    metrics::query_charts(&state.clusters, &cluster_id, &target, chart, range_secs).await
}

/// Usage history for right-sizing (#137) from the Prometheus of the cluster settings; `notFound` when there is none.
/// Read-only; the PromQL is fixed in the core and the scope's names are validated there.
#[tauri::command]
pub async fn metrics_usage_history(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    scope: HistoryScope,
    window: HistoryWindow,
) -> Result<UsageHistory, CoreError> {
    let settings = cluster_settings(&state, &cluster_id);
    let target = metrics::prometheus_target(&state.clusters, &cluster_id, &settings.prometheus)
        .await?
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                match settings.prometheus {
                    PrometheusMode::Off => "Prometheus is turned off in the cluster settings",
                    _ => "Prometheus was not found",
                },
            )
        })?;
    metrics::usage_history(&state.clusters, &cluster_id, &target, scope, window).await
}

/// Request rate, errors and latency of a workload or pod from the request-metric sources its Prometheus has, and CPU
/// throttling per container (#212). Read-only; every query is fixed in the core (`metrics::requests`), the target's
/// names are validated there, and no Prometheus is not an error (the answer says so). Window only.
#[tauri::command]
pub async fn metrics_request_health(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    target: RequestTarget,
) -> Result<RequestHealth, CoreError> {
    let settings = cluster_settings(&state, &cluster_id);
    metrics::request_health(&state.clusters, &cluster_id, &settings.prometheus, target).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_the_usage_history() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools
                .iter()
                .any(|t| t.contains("history") || t.contains("rightsizing")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods
                .iter()
                .any(|m| m.contains("history") || m.contains("rightsizing")),
            "{methods:?}"
        );
    }

    #[test]
    fn neither_agents_nor_extensions_get_the_request_metrics() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        let forbidden = ["request_health", "golden", "throttl", "latency"];
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
                .any(|m| forbidden.iter().any(|f| m.contains(f)) || m.contains("metrics")),
            "{methods:?}"
        );
    }
}
