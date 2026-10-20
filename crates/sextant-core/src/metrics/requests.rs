//! Request metrics of a workload (#212): request rate, error share and latency (p50/p95/p99) from whichever source of
//! request-level metrics the cluster's Prometheus has — Istio, Linkerd (also through linkerd-viz's own Prometheus),
//! ingress-nginx, Grafana Beyla, Cilium Hubble — and CPU throttling per container from cAdvisor.
//!
//! Which sources there are is asked of Prometheus once per connection (a fixed list of metric names, at most
//! [`REQUEST_SOURCES_TTL`] old) by [`request_sources`]; the live traffic graph (#211) reuses it. Every query is fixed
//! and built in `metrics/prometheus/requests.rs`, never taken from the caller: the target names a namespace, a
//! workload kind and a name, each checked against the Kubernetes naming rules before it goes into a query (and escaped
//! as well). Read-only. Decision: ADR-0095.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::history::{HISTORY_WORKLOAD_KINDS, HistoryScope, is_dns_label, is_dns_subdomain};
use super::prometheus::{self, Prometheus};
use super::{PrometheusMode, PrometheusTarget, prometheus_target};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

mod services;
#[cfg(test)]
mod tests;

/// How long the sources found for a connection are reused.
pub const REQUEST_SOURCES_TTL: Duration = Duration::from_secs(5 * 60);
/// The series cover the last hour…
pub const SERIES_RANGE_SECS: i64 = 3600;
/// …one point a minute (61 points per series at most).
pub const SERIES_STEP_SECS: i64 = 60;
/// At most this many containers come back with their throttling.
pub const MAX_THROTTLED_CONTAINERS: usize = 50;
/// At most this many Services selecting the workload are named in an ingress query.
pub const MAX_SELECTING_SERVICES: usize = 20;
/// Where linkerd-viz installs its own Prometheus (`prometheus:9090`), read when the cluster's Prometheus has no Linkerd
/// metrics.
pub const LINKERD_VIZ_NAMESPACE: &str = "linkerd-viz";

/// A source of request-level metrics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RequestSourceKind {
    /// Istio's standard metrics (`istio_requests_total`, `istio_request_duration_milliseconds`).
    Istio,
    /// The Linkerd proxy's inbound metrics (`response_total`, `response_latency_ms`).
    Linkerd,
    /// ingress-nginx (`nginx_ingress_controller_requests`, `…_request_duration_seconds`): requests through the ingress.
    IngressNginx,
    /// Grafana Beyla, or anything exporting the OpenTelemetry HTTP/RPC server metrics with Beyla's Kubernetes labels.
    Beyla,
    /// Cilium Hubble's HTTP metrics (`hubble_http_requests_total`, `hubble_http_request_duration_seconds`).
    Hubble,
}

impl RequestSourceKind {
    /// In the order the sources are listed.
    pub const ALL: [RequestSourceKind; 5] = [
        RequestSourceKind::Istio,
        RequestSourceKind::Linkerd,
        RequestSourceKind::IngressNginx,
        RequestSourceKind::Beyla,
        RequestSourceKind::Hubble,
    ];

    /// The source is there when every metric of one of these groups exists.
    pub fn required_metrics(self) -> &'static [&'static [&'static str]] {
        match self {
            RequestSourceKind::Istio => &[&["istio_requests_total"]],
            // `response_total` alone is too common a name; the pair is Linkerd's.
            RequestSourceKind::Linkerd => &[&["response_total", "response_latency_ms_bucket"]],
            RequestSourceKind::IngressNginx => &[&["nginx_ingress_controller_requests"]],
            RequestSourceKind::Beyla => &[
                &["http_server_request_duration_seconds_count"],
                &["rpc_server_duration_seconds_count"],
            ],
            RequestSourceKind::Hubble => &[&["hubble_http_requests_total"]],
        }
    }

    /// The histogram that gives the latency; without it the source has rates only.
    pub fn latency_metrics(self) -> &'static [&'static str] {
        match self {
            RequestSourceKind::Istio => &["istio_request_duration_milliseconds_bucket"],
            RequestSourceKind::Linkerd => &["response_latency_ms_bucket"],
            RequestSourceKind::IngressNginx => {
                &["nginx_ingress_controller_request_duration_seconds_bucket"]
            }
            RequestSourceKind::Beyla => &[
                "http_server_request_duration_seconds_bucket",
                "rpc_server_duration_seconds_bucket",
            ],
            RequestSourceKind::Hubble => &["hubble_http_request_duration_seconds_bucket"],
        }
    }

    /// The traffic graph (#211, ADR-0096) has edges of this source when every metric of one of these groups exists:
    /// metrics that name both the caller and the callee. ingress-nginx names no caller and has none.
    pub fn edge_metrics(self) -> &'static [&'static [&'static str]] {
        match self {
            RequestSourceKind::Istio => &[
                &["istio_requests_total"],
                &["istio_tcp_connections_opened_total"],
            ],
            // The outbound side of the same pair (`direction="outbound"`, `dst_*` labels).
            RequestSourceKind::Linkerd => &[&["response_total", "response_latency_ms_bucket"]],
            RequestSourceKind::IngressNginx => &[],
            // Beyla's service graph metrics (`application_service_graph`), which name both ends with namespaces.
            RequestSourceKind::Beyla => &[&["traces_service_graph_request_total"]],
            RequestSourceKind::Hubble => &[&["hubble_http_requests_total"]],
        }
    }

    /// The histogram that gives an edge's latency; without it the edges have rates only.
    pub fn edge_latency_metrics(self) -> &'static [&'static str] {
        match self {
            RequestSourceKind::Beyla => &["traces_service_graph_request_server_seconds_bucket"],
            RequestSourceKind::IngressNginx => &[],
            other => other.latency_metrics(),
        }
    }

    /// Every metric name detection asks about (and the only names it keeps from the answer).
    pub fn known_metrics() -> Vec<&'static str> {
        let mut names: Vec<&'static str> = Self::ALL
            .iter()
            .flat_map(|k| {
                let required = k.required_metrics().iter().flat_map(|g| g.iter().copied());
                let edges = k.edge_metrics().iter().flat_map(|g| g.iter().copied());
                required
                    .chain(k.latency_metrics().iter().copied())
                    .chain(edges)
                    .chain(k.edge_latency_metrics().iter().copied())
            })
            .collect();
        names.sort_unstable();
        names.dedup();
        names
    }
}

/// Which Prometheus a source is read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RequestVia {
    /// The Prometheus of the cluster settings (manual, or auto-detected).
    Cluster,
    /// linkerd-viz's own Prometheus (`linkerd-viz/prometheus:9090`), for Linkerd only.
    LinkerdViz,
}

/// A source whose metrics exist in a Prometheus (whether or not they cover a given workload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DetectedSource {
    pub kind: RequestSourceKind,
    pub via: RequestVia,
    /// Its latency histogram exists too.
    pub latency: bool,
}

/// What [`request_sources`] found for a connection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RequestSources {
    /// The Prometheus of the cluster settings; `None` when off or not found.
    pub prometheus: Option<PrometheusTarget>,
    /// linkerd-viz's Prometheus, when it answered and has the Linkerd metrics.
    pub linkerd_viz: Option<PrometheusTarget>,
    /// In [`RequestSourceKind::ALL`] order.
    pub sources: Vec<DetectedSource>,
    /// The sources with edge metrics (the traffic graph, #211); `latency` tells whether the edge histogram exists.
    pub edges: Vec<DetectedSource>,
}

impl RequestSources {
    /// The Prometheus `via` names.
    pub fn target(&self, via: RequestVia) -> Option<&PrometheusTarget> {
        match via {
            RequestVia::Cluster => self.prometheus.as_ref(),
            RequestVia::LinkerdViz => self.linkerd_viz.as_ref(),
        }
    }
}

/// What the request metrics are about. Serialized with a `type` tag; read strictly (see the `Deserialize` impl).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum RequestTarget {
    /// A Deployment, StatefulSet or DaemonSet: every pod it created.
    Workload {
        namespace: String,
        kind: String,
        name: String,
    },
    Pod {
        namespace: String,
        name: String,
    },
}

/// Same shape as [`RequestTarget`], with unknown fields refused: a target carries names only, and anything else the
/// window sends (a query, a selector) is an error rather than silently dropped.
#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum TargetRepr {
    Workload {
        namespace: String,
        kind: String,
        name: String,
    },
    Pod {
        namespace: String,
        name: String,
    },
}

impl<'de> Deserialize<'de> for RequestTarget {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match TargetRepr::deserialize(deserializer)? {
            TargetRepr::Workload {
                namespace,
                kind,
                name,
            } => RequestTarget::Workload {
                namespace,
                kind,
                name,
            },
            TargetRepr::Pod { namespace, name } => RequestTarget::Pod { namespace, name },
        })
    }
}

impl RequestTarget {
    pub fn namespace(&self) -> &str {
        match self {
            RequestTarget::Workload { namespace, .. } | RequestTarget::Pod { namespace, .. } => {
                namespace
            }
        }
    }

    /// The same containers as the right-sizing history scope (for cAdvisor's series).
    pub(crate) fn scope(&self) -> HistoryScope {
        match self.clone() {
            RequestTarget::Workload {
                namespace,
                kind,
                name,
            } => HistoryScope::Workload {
                namespace,
                kind,
                name,
            },
            RequestTarget::Pod { namespace, name } => HistoryScope::Pod { namespace, name },
        }
    }
}

/// Latency quantiles in milliseconds; `None` without the histogram or without requests.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LatencyMs {
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
}

/// The golden metrics of a target from one source, over the last 5 minutes, and the last hour as series.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GoldenMetrics {
    pub source: RequestSourceKind,
    pub via: RequestVia,
    /// Requests per second; `None` when the source has no series of the target now.
    pub request_rate: Option<f64>,
    /// Share (0–1) of requests that failed (see ADR-0095 per source); `None` without requests.
    pub error_ratio: Option<f64>,
    pub latency_ms: LatencyMs,
    /// `(unix seconds, requests per second)`, one point a minute over the last hour.
    pub rate_series: Vec<(i64, f64)>,
    /// `(unix seconds, failed requests per second)`, like `rate_series`.
    pub error_series: Vec<(i64, f64)>,
}

/// The share of CPU periods a container was throttled in over the last hour (summed over the target's pods).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContainerThrottling {
    pub container: String,
    /// 0–1.
    pub throttled_ratio: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RequestHealth {
    /// Unix seconds the queries were evaluated at.
    pub evaluated_at: i64,
    /// The cluster settings name a Prometheus (or one was found); throttling needs it.
    pub prometheus: bool,
    /// Every source whose metrics exist, whether or not they cover this target.
    pub sources: Vec<DetectedSource>,
    /// The sources that have series of this target, in [`RequestSourceKind::ALL`] order.
    pub golden: Vec<GoldenMetrics>,
    /// Sources whose queries failed (their metrics are unknown, not absent).
    pub failed: Vec<RequestSourceKind>,
    /// By container name, at most [`MAX_THROTTLED_CONTAINERS`].
    pub throttling: Vec<ContainerThrottling>,
    /// `false` when throttling could not be read (no Prometheus, or the query failed).
    pub throttling_known: bool,
    pub series_step_secs: i64,
}

fn invalid(message: String) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// Names that are not Kubernetes names never reach a query; only the workload kinds whose pod names are known.
pub fn validate_target(target: &RequestTarget) -> CoreResult<()> {
    let namespace = target.namespace();
    if !is_dns_label(namespace) {
        return Err(invalid(format!("{namespace:?} is not a namespace name")));
    }
    let name = match target {
        RequestTarget::Workload { kind, name, .. } => {
            if !HISTORY_WORKLOAD_KINDS.contains(&kind.as_str()) {
                return Err(invalid(format!("no request metrics for the kind {kind:?}")));
            }
            name
        }
        RequestTarget::Pod { name, .. } => name,
    };
    if !is_dns_subdomain(name) {
        return Err(invalid(format!("{name:?} is not an object name")));
    }
    Ok(())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

// ---------------------------------------------------------------------------------------------------------------
// Sources, cached per connection

struct Cached {
    connection: u64,
    mode: PrometheusMode,
    at: Instant,
    found: RequestSources,
}

/// One entry per cluster: a reconnect or a settings change replaces it, so the map never outgrows the clusters.
static SOURCES: LazyLock<Mutex<HashMap<ClusterId, Cached>>> = LazyLock::new(Default::default);

fn lock_sources() -> std::sync::MutexGuard<'static, HashMap<ClusterId, Cached>> {
    SOURCES.lock().unwrap_or_else(|e| e.into_inner())
}

/// linkerd-viz's Prometheus, reached through the API server's service proxy.
pub fn linkerd_viz_target() -> PrometheusTarget {
    PrometheusTarget::Service {
        namespace: LINKERD_VIZ_NAMESPACE.to_owned(),
        service: "prometheus".to_owned(),
        port: 9090,
        path_prefix: String::new(),
    }
}

/// The sources of request metrics in the Prometheus of `mode` (and, when it has no Linkerd metrics, in linkerd-viz's
/// Prometheus), by asking which of [`RequestSourceKind::known_metrics`] exist. Reused for [`REQUEST_SOURCES_TTL`]
/// within one connection; a failed lookup is not kept. `mode` off: nothing is asked.
pub async fn request_sources(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &PrometheusMode,
) -> CoreResult<RequestSources> {
    let connection = mgr.connection(cluster)?;
    if let Some(c) = lock_sources().get(cluster)
        && c.connection == connection
        && c.mode == *mode
        && c.at.elapsed() < REQUEST_SOURCES_TTL
    {
        return Ok(c.found.clone());
    }
    let found = detect_sources(mgr, cluster, mode).await?;
    lock_sources().insert(
        cluster.clone(),
        Cached {
            connection,
            mode: mode.clone(),
            at: Instant::now(),
            found: found.clone(),
        },
    );
    Ok(found)
}

/// Forgets every cached lookup (tests).
#[cfg(test)]
pub(crate) fn forget_sources() {
    lock_sources().clear();
}

/// Held by the tests that look up sources: every fake cluster has the same id, so two of them at once would share
/// (or clear) each other's cached sources.
#[cfg(test)]
pub(crate) static SOURCES_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn detect_sources(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &PrometheusMode,
) -> CoreResult<RequestSources> {
    let mut found = RequestSources::default();
    if *mode == PrometheusMode::Off {
        return Ok(found);
    }
    let client = mgr.client(cluster)?;
    let now = now_secs();
    found.prometheus = prometheus_target(mgr, cluster, mode).await?;
    if let Some(target) = &found.prometheus {
        // The Prometheus the user relies on failing is an error, not "no source".
        let names =
            prometheus::request_metric_names(&Prometheus::new(&client, target)?, now).await?;
        found.sources = prometheus::sources_in(&names, RequestVia::Cluster);
        found.edges = prometheus::edge_sources_in(&names, RequestVia::Cluster);
    }
    if !found
        .sources
        .iter()
        .any(|s| s.kind == RequestSourceKind::Linkerd)
    {
        let viz = linkerd_viz_target();
        let prometheus = Prometheus::new(&client, &viz)?;
        // Usually not installed: any failure here only means "not from linkerd-viz".
        if prometheus.probe().await.is_ok()
            && let Ok(names) = prometheus::request_metric_names(&prometheus, now).await
        {
            let linkerd: Vec<DetectedSource> =
                prometheus::sources_in(&names, RequestVia::LinkerdViz)
                    .into_iter()
                    .filter(|s| s.kind == RequestSourceKind::Linkerd)
                    .collect();
            if !linkerd.is_empty() {
                found.linkerd_viz = Some(viz);
                found.sources.extend(linkerd);
                found.sources.sort_by_key(|s| s.kind);
                found.edges.extend(
                    prometheus::edge_sources_in(&names, RequestVia::LinkerdViz)
                        .into_iter()
                        .filter(|s| s.kind == RequestSourceKind::Linkerd),
                );
                found.edges.sort_by_key(|s| s.kind);
            }
        }
    }
    Ok(found)
}

/// The PromQL [`request_health`] sends for `kind` about `target` — the instant query, then the range query — or `None`
/// when the source cannot name the target (ingress-nginx without a Service selecting it). For review, tests and the
/// traffic graph (#211); `target` must have passed [`validate_target`].
pub fn request_queries(
    kind: RequestSourceKind,
    target: &RequestTarget,
    services: &[String],
    latency: bool,
) -> Option<(String, String)> {
    let selectors = prometheus::request_selectors(kind, target, services);
    if selectors.is_empty() {
        return None;
    }
    Some((
        prometheus::golden_query(kind, &selectors, latency),
        prometheus::series_query(kind, &selectors),
    ))
}

// ---------------------------------------------------------------------------------------------------------------
// One target's request health

/// The request health of `target` from the sources [`request_sources`] finds for `mode`. Fails when the target is
/// invalid, the cluster is not connected or the cluster's Prometheus fails the source lookup; a source whose own
/// queries fail is listed in `failed`, a failed throttling query leaves `throttling_known` false.
pub async fn request_health(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &PrometheusMode,
    target: RequestTarget,
) -> CoreResult<RequestHealth> {
    validate_target(&target)?;
    let found = request_sources(mgr, cluster, mode).await?;
    let client = mgr.client(cluster)?;
    let now = now_secs();
    // ingress-nginx names Services, not pods: the Services that select the target's pods, read from the cluster.
    let services = if found
        .sources
        .iter()
        .any(|s| s.kind == RequestSourceKind::IngressNginx)
    {
        services::selecting(&client, &target)
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let golden = futures::future::join_all(found.sources.iter().map(|source| {
        let (client, target, services) = (&client, &target, &services);
        let via_target = found.target(source.via).cloned();
        async move {
            let Some(via_target) = via_target else {
                return (source.kind, Ok(None));
            };
            let selectors = prometheus::request_selectors(source.kind, target, services);
            if selectors.is_empty() {
                return (source.kind, Ok(None));
            }
            let answer = match Prometheus::new(client, &via_target) {
                Ok(p) => prometheus::golden(&p, *source, &selectors, now).await,
                Err(err) => Err(err),
            };
            (source.kind, answer)
        }
    }));
    let throttling = async {
        let target_prometheus = found.prometheus.as_ref()?;
        let p = Prometheus::new(&client, target_prometheus).ok()?;
        prometheus::throttling(&p, &target.scope(), now).await.ok()
    };
    let (answers, throttling) = tokio::join!(golden, throttling);
    let mut health = RequestHealth {
        evaluated_at: now,
        prometheus: found.prometheus.is_some(),
        sources: found.sources.clone(),
        golden: Vec::new(),
        failed: Vec::new(),
        throttling_known: throttling.is_some(),
        throttling: throttling.unwrap_or_default(),
        series_step_secs: SERIES_STEP_SECS,
    };
    for (kind, answer) in answers {
        match answer {
            Ok(Some(metrics)) => health.golden.push(metrics),
            Ok(None) => {}
            Err(_) => health.failed.push(kind),
        }
    }
    Ok(health)
}
