//! CPU/memory usage and charts. Each command reads the cluster's metrics settings (`prometheus`, `usageSource`)
//! from the settings store, so a change in the cluster settings applies to the next call.

use sextant_core::metrics::{
    self, ChartTarget, MetricsStatus, NodeUsage, PodUsage, PrometheusMode, Series,
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
