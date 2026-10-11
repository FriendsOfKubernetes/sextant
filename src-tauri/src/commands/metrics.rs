//! CPU/memory usage and charts.

use sextant_core::metrics::{ChartTarget, MetricsStatus, NodeUsage, PodUsage, Series};
use sextant_core::{ClusterId, CoreError};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn metrics_pods(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _namespaces: Option<Vec<String>>,
) -> Result<Vec<PodUsage>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn metrics_nodes(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
) -> Result<Vec<NodeUsage>, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn metrics_status(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
) -> Result<MetricsStatus, CoreError> {
    Err(CoreError::not_implemented())
}

#[tauri::command]
pub async fn metrics_charts(
    _state: State<'_, AppState>,
    _cluster_id: ClusterId,
    _chart: ChartTarget,
    _range_secs: i64,
) -> Result<Vec<Series>, CoreError> {
    Err(CoreError::not_implemented())
}
