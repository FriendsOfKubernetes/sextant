//! CPU/memory usage (metrics-server or Prometheus) and history charts (Prometheus via the API server proxy).
//!
//! Current values come from the source chosen by [`ClusterSettings::usage_source`]: `auto` uses metrics-server when
//! `metrics.k8s.io` answers and the latest Prometheus point otherwise. Prometheus is found by [`PrometheusMode`]:
//! `auto` tries the known services in [`CANDIDATE_NAMESPACES`] through the API server's service proxy (no direct
//! network access to the cluster is needed), `manual` uses the configured service or URL, `off` disables it.
//! "Prometheus" here is any Prometheus-compatible HTTP API: Prometheus itself or VictoriaMetrics (single-node, or a
//! cluster's vmselect under `/select/<tenant>/prometheus`), which answer the same fixed queries (ADR-0102).

mod history;
mod prometheus;
mod quantity;
mod requests;
mod server;
mod traffic;
mod volumes;

pub use history::{
    ContainerHistory, HISTORY_WORKLOAD_KINDS, HistoryScope, HistoryWindow, MAX_HISTORY_CONTAINERS,
    MAX_HISTORY_NAMESPACES, UsageHistory, usage_history,
};
pub use requests::{
    ContainerThrottling, DetectedSource, GoldenMetrics, LINKERD_VIZ_NAMESPACE, LatencyMs,
    MAX_SELECTING_SERVICES, MAX_THROTTLED_CONTAINERS, REQUEST_SOURCES_TTL, RequestHealth,
    RequestSourceKind, RequestSources, RequestTarget, RequestVia, SERIES_RANGE_SECS,
    SERIES_STEP_SECS, linkerd_viz_target, request_health, request_queries, request_sources,
    validate_target,
};
pub use traffic::{
    MAX_TRAFFIC_BODY, MAX_TRAFFIC_EDGES, MAX_TRAFFIC_NAMESPACES, MAX_TRAFFIC_SERIES,
    StatusClassRate, TrafficDetail, TrafficEdge, TrafficGraph, TrafficPeer, TrafficPeerKind,
    TrafficProtocol, TrafficWindow, traffic_graph, traffic_queries, validate_namespaces,
};
pub use volumes::{
    MAX_NODES, MAX_SUMMARY_BYTES, MAX_VOLUMES, VolumeUsage, VolumeUsageReport, VolumeUsageSource,
    volume_usage,
};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;
use crate::settings::ClusterSettings;

use prometheus::Prometheus;
pub use prometheus::{CANDIDATE_NAMESPACES, VMSELECT_PATH_PREFIX, source_kind};

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

/// What answers at a [`PrometheusTarget`], as far as its name or path tells ([`source_kind`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MetricsSourceKind {
    Prometheus,
    /// Single-node VictoriaMetrics (`vmsingle`).
    VictoriaMetricsSingle,
    /// A VictoriaMetrics cluster's vmselect, under `/select/<tenant>/prometheus`.
    VictoriaMetricsCluster,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricsStatus {
    pub metrics_server: bool,
    pub prometheus: Option<PrometheusTarget>,
    /// What `prometheus` is, when its name or path tells; absent for an unknown Prometheus-compatible API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub prometheus_kind: Option<MetricsSourceKind>,
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

/// Current usage of the pods in `namespaces` (`None` = all), from the source chosen by `settings.usage_source`.
/// No source available → `notFound` ("metrics are unavailable").
pub async fn pod_usage(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    settings: &ClusterSettings,
    namespaces: Option<Vec<String>>,
) -> CoreResult<Vec<PodUsage>> {
    let client = mgr.client(cluster)?;
    let namespaces = namespaces.as_deref();
    match settings.usage_source {
        UsageSource::Off => Err(off()),
        UsageSource::MetricsServer => server::pod_usage(&client, namespaces).await,
        UsageSource::Prometheus => {
            let prometheus = required_prometheus(mgr, cluster, &settings.prometheus).await?;
            prometheus::pod_usage(&prometheus, namespaces).await
        }
        UsageSource::Auto => match server::pod_usage(&client, namespaces).await {
            Ok(pods) => Ok(pods),
            Err(server_error) => {
                let prometheus = fallback_prometheus(mgr, cluster, settings, server_error).await?;
                prometheus::pod_usage(&prometheus, namespaces).await
            }
        },
    }
}

/// Current usage of every node, from the source chosen by `settings.usage_source`.
pub async fn node_usage(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    settings: &ClusterSettings,
) -> CoreResult<Vec<NodeUsage>> {
    let client = mgr.client(cluster)?;
    match settings.usage_source {
        UsageSource::Off => Err(off()),
        UsageSource::MetricsServer => server::node_usage(&client).await,
        UsageSource::Prometheus => {
            let prometheus = required_prometheus(mgr, cluster, &settings.prometheus).await?;
            prometheus::node_usage(&prometheus).await
        }
        UsageSource::Auto => match server::node_usage(&client).await {
            Ok(nodes) => Ok(nodes),
            Err(server_error) => {
                let prometheus = fallback_prometheus(mgr, cluster, settings, server_error).await?;
                prometheus::node_usage(&prometheus).await
            }
        },
    }
}

/// What is available: metrics-server, the Prometheus in use (manual or found, only if it answers) and the source
/// current values come from. A cluster that is not connected has nothing.
pub async fn metrics_status(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &PrometheusMode,
    usage: &UsageSource,
) -> MetricsStatus {
    let (metrics_server, prometheus) = match mgr.client(cluster) {
        Err(_) => (false, None),
        Ok(client) => {
            let answering = async {
                let target = prometheus_target(mgr, cluster, mode).await.ok()??;
                match mode {
                    // A found one has just answered.
                    PrometheusMode::Auto => Some(target),
                    _ => {
                        let prometheus = Prometheus::new(&client, &target).ok()?;
                        prometheus.probe().await.ok().map(|_| target)
                    }
                }
            };
            tokio::join!(server::available(&client), answering)
        }
    };
    let effective_usage_source = match usage {
        UsageSource::Auto if metrics_server => Some(UsageSource::MetricsServer),
        UsageSource::Auto if prometheus.is_some() => Some(UsageSource::Prometheus),
        UsageSource::MetricsServer if metrics_server => Some(UsageSource::MetricsServer),
        UsageSource::Prometheus if prometheus.is_some() => Some(UsageSource::Prometheus),
        _ => None,
    };
    MetricsStatus {
        metrics_server,
        prometheus_kind: prometheus.as_ref().and_then(source_kind),
        prometheus,
        mode: mode.clone(),
        usage_source: *usage,
        effective_usage_source,
    }
}

/// The Prometheus to use for `mode`: the manual target as configured, the auto-detected one (cached for a
/// minute), or `None` (off, or nothing found).
pub async fn prometheus_target(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &PrometheusMode,
) -> CoreResult<Option<PrometheusTarget>> {
    match mode {
        PrometheusMode::Off => Ok(None),
        PrometheusMode::Manual { target } => Ok(Some(target.clone())),
        PrometheusMode::Auto => {
            let client = mgr.client(cluster)?;
            Ok(prometheus::detect(&client, cluster).await)
        }
    }
}

/// History of `chart` over the last `range_secs` seconds (about 60 points): `cpu` (millicores), `memory` (bytes),
/// and for nodes and the cluster `pods` and `disk` (bytes used) when Prometheus has them. Metrics without data are
/// left out.
pub async fn query_charts(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    target: &PrometheusTarget,
    chart: ChartTarget,
    range_secs: i64,
) -> CoreResult<Vec<Series>> {
    let client = mgr.client(cluster)?;
    let prometheus = Prometheus::new(&client, target)?;
    prometheus::charts(&prometheus, &chart, range_secs).await
}

fn off() -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        "metrics are unavailable: turned off in the cluster settings",
    )
}

async fn required_prometheus(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &PrometheusMode,
) -> CoreResult<Prometheus> {
    let target = prometheus_target(mgr, cluster, mode)
        .await?
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                match mode {
                    PrometheusMode::Off => "metrics are unavailable: Prometheus is turned off",
                    _ => "metrics are unavailable: Prometheus was not found",
                },
            )
        })?;
    Prometheus::new(&mgr.client(cluster)?, &target)
}

/// `auto` without metrics-server: Prometheus, or an error naming both sources.
async fn fallback_prometheus(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    settings: &ClusterSettings,
    server_error: CoreError,
) -> CoreResult<Prometheus> {
    required_prometheus(mgr, cluster, &settings.prometheus)
        .await
        .map_err(|prometheus_error| {
            CoreError::new(
                ErrorCode::NotFound,
                format!(
                    "metrics are unavailable ({}; {})",
                    server_error.message, prometheus_error.message
                ),
            )
        })
}
