//! CPU/memory usage (metrics-server or Prometheus) and history charts (Prometheus via the API server proxy).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::ClusterId;
use crate::settings::ClusterSettings;

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Usage {
    pub cpu_millicores: f64,
    pub memory_bytes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PodUsage {
    pub namespace: String,
    pub name: String,
    pub usage: Usage,
    /// `(container name, usage)`
    pub containers: Vec<(String, Usage)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NodeUsage {
    pub name: String,
    pub usage: Usage,
}

/// How Prometheus is found. Serialized with a `mode` tag.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(tag = "mode", rename_all = "camelCase")]
#[ts(export)]
pub enum PrometheusMode {
    #[default]
    Auto,
    Manual {
        target: PrometheusTarget,
    },
    Off,
}

/// Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum PrometheusTarget {
    /// Reached through the API server's service proxy.
    Service {
        namespace: String,
        service: String,
        port: u16,
        path_prefix: String,
    },
    Url {
        url: String,
    },
}

/// Where current CPU/memory values come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum UsageSource {
    /// metrics-server if `metrics.k8s.io` is served, otherwise the latest Prometheus point.
    #[default]
    Auto,
    MetricsServer,
    Prometheus,
    Off,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricsStatus {
    pub metrics_server: bool,
    pub prometheus: Option<PrometheusTarget>,
    pub mode: PrometheusMode,
    pub usage_source: UsageSource,
    /// `MetricsServer` or `Prometheus`; `None` when nothing is available.
    pub effective_usage_source: Option<UsageSource>,
}

/// What a chart is about. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ChartTarget {
    Cluster,
    Node {
        name: String,
    },
    Pod {
        namespace: String,
        name: String,
    },
    Workload {
        namespace: String,
        kind: String,
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Series {
    /// `"cpu" | "memory" | "pods" | "disk"`
    pub metric: String,
    /// `(unix seconds, value)`
    pub points: Vec<(i64, f64)>,
}

pub async fn pod_usage(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _settings: &ClusterSettings,
    _namespaces: Option<Vec<String>>,
) -> CoreResult<Vec<PodUsage>> {
    Err(CoreError::not_implemented())
}

pub async fn node_usage(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _settings: &ClusterSettings,
) -> CoreResult<Vec<NodeUsage>> {
    Err(CoreError::not_implemented())
}

pub async fn metrics_status(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    mode: &PrometheusMode,
    usage: &UsageSource,
) -> MetricsStatus {
    MetricsStatus {
        metrics_server: false,
        prometheus: None,
        mode: mode.clone(),
        usage_source: *usage,
        effective_usage_source: None,
    }
}

pub async fn query_charts(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _target: &PrometheusTarget,
    _chart: ChartTarget,
    _range_secs: i64,
) -> CoreResult<Vec<Series>> {
    Err(CoreError::not_implemented())
}
