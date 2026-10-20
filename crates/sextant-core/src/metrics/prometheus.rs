//! Prometheus: auto-detection through the API server's service proxy, PromQL for current usage and charts.
//!
//! Queries use what a plain kubelet/cAdvisor scrape provides (`container_cpu_usage_seconds_total`,
//! `container_memory_working_set_bytes`, `container_fs_usage_bytes`, `kubelet_running_pods`) and prefer
//! node-exporter / kube-state-metrics series (`node_filesystem_*`, `kube_pod_info`) when they exist. Node series are
//! matched by a `node` label, falling back to `instance` (`<node>` or `<node>:<port>`).

use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use k8s_openapi::api::core::v1::Service;
use kube::Api;
use kube::api::{GetParams, ListParams};
use serde_json::Value;

use super::{ChartTarget, NodeUsage, PodUsage, PrometheusTarget, Series, Usage};

mod requests;
mod rightsizing;
mod traffic;
mod volumes;
use crate::error::{CoreError, CoreResult, ErrorCode, kube_error};
use crate::kubeconfig::ClusterId;
pub(crate) use requests::{
    edge_sources_in, golden, golden_query, request_metric_names, request_selectors, series_query,
    sources_in, throttling,
};
pub(crate) use rightsizing::usage_history;
pub(crate) use traffic::{edge_queries, traffic_edges};
pub(crate) use volumes::volume_stats;

/// Namespaces searched by auto-detection, in order.
pub const CANDIDATE_NAMESPACES: [&str; 5] = [
    "monitoring",
    "prometheus",
    "kube-prometheus-stack",
    "lens-metrics",
    "observability",
];

/// How long one Prometheus request may take.
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);
/// How long an auto-detection result is reused.
const DETECT_TTL: Duration = Duration::from_secs(60);
/// `rate()` window; four scrapes at the usual 15 s interval.
const RATE_WINDOW: &str = "2m";
const CONTAINERS: &str = r#"container!="",container!="POD""#;

/// A Prometheus HTTP API reached through the cluster's API server (service proxy) or directly by URL.
pub(crate) struct Prometheus {
    client: kube::Client,
    /// Path in front of `api/v1/...`, without a trailing slash.
    base: String,
    /// Reached by its own URL (not through the API server's service proxy): a query refused as too long is sent again
    /// as a form POST, which the service proxy would need the `create` verb on `services/proxy` for.
    direct: bool,
}

/// The start of the error of a query refused as too long (HTTP 414 or 431) by something in front of Prometheus.
pub(crate) const QUERY_TOO_LONG: &str = "the query was too long for a proxy in front of Prometheus";

/// Whether `err` is a query refused as too long ([`QUERY_TOO_LONG`]).
pub(crate) fn is_query_too_long(err: &CoreError) -> bool {
    err.message.starts_with(QUERY_TOO_LONG)
}

impl Prometheus {
    pub(crate) fn new(cluster: &kube::Client, target: &PrometheusTarget) -> CoreResult<Self> {
        match target {
            PrometheusTarget::Service {
                namespace,
                service,
                port,
                path_prefix,
            } => {
                let prefix = path_prefix.trim().trim_end_matches('/');
                let prefix = match prefix {
                    "" => String::new(),
                    p if p.starts_with('/') => p.to_owned(),
                    p => format!("/{p}"),
                };
                Ok(Self {
                    client: cluster.clone(),
                    base: format!(
                        "/api/v1/namespaces/{namespace}/services/{service}:{port}/proxy{prefix}"
                    ),
                    direct: false,
                })
            }
            PrometheusTarget::Url { url } => {
                let uri = url.trim().parse().map_err(|e| {
                    CoreError::new(
                        ErrorCode::Invalid,
                        format!("bad Prometheus URL {url:?}: {e}"),
                    )
                })?;
                let mut config = kube::Config::new(uri);
                config.connect_timeout = Some(Duration::from_secs(10));
                config.read_timeout = Some(QUERY_TIMEOUT);
                let client = kube::Client::try_from(config).map_err(|e| kube_error(e, None))?;
                Ok(Self {
                    client,
                    base: String::new(),
                    direct: true,
                })
            }
        }
    }

    /// `GET <base>/<path>`; the `data` of a successful answer.
    async fn get(&self, path: &str) -> CoreResult<Value> {
        let request = kube::core::Request::new(self.base.clone())
            .get(path, &GetParams::default())
            .map_err(|e| CoreError::new(ErrorCode::Invalid, e.to_string()))?;
        let text = tokio::time::timeout(QUERY_TIMEOUT, self.client.request_text(request))
            .await
            .map_err(|_| {
                CoreError::new(
                    ErrorCode::Unreachable,
                    format!(
                        "Prometheus did not answer in {} seconds",
                        QUERY_TIMEOUT.as_secs()
                    ),
                )
            })?
            .map_err(|e| prometheus_error(kube_error(e, None)))?;
        let body: Value = serde_json::from_str(&text).map_err(|_| {
            CoreError::new(
                ErrorCode::Invalid,
                "the answer is not from the Prometheus HTTP API",
            )
        })?;
        if body.get("status").and_then(Value::as_str) != Some("success") {
            let message = body
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(CoreError::other(format!("Prometheus: {message}")));
        }
        Ok(body.get("data").cloned().unwrap_or(Value::Null))
    }

    /// Sends `request` and reads at most `limit` bytes of the answer (a bigger one is an error, not cut).
    async fn send_limited(
        &self,
        request: http::Request<Vec<u8>>,
        limit: usize,
    ) -> CoreResult<(http::StatusCode, Vec<u8>)> {
        use http_body_util::{BodyExt, LengthLimitError, Limited};
        let request = request.map(kube::client::Body::from);
        let exchange = async {
            let response = self
                .client
                .send(request)
                .await
                .map_err(|e| prometheus_error(kube_error(e, None)))?;
            let status = response.status();
            let body = Limited::new(response.into_body(), limit)
                .collect()
                .await
                .map_err(|err| {
                    if err.downcast_ref::<LengthLimitError>().is_some() {
                        CoreError::new(
                            ErrorCode::Invalid,
                            format!(
                                "the Prometheus answer is larger than {} MiB",
                                limit / (1024 * 1024)
                            ),
                        )
                    } else {
                        CoreError::new(ErrorCode::Unreachable, format!("Prometheus: {err}"))
                    }
                })?
                .to_bytes()
                .to_vec();
            Ok::<_, CoreError>((status, body))
        };
        tokio::time::timeout(QUERY_TIMEOUT, exchange)
            .await
            .map_err(|_| {
                CoreError::new(
                    ErrorCode::Unreachable,
                    format!(
                        "Prometheus did not answer in {} seconds",
                        QUERY_TIMEOUT.as_secs()
                    ),
                )
            })?
    }

    /// Instant query at `time` (with the server-side timeout), the answer read up to `limit` bytes; the `data` of a
    /// successful answer, Prometheus' own error message kept for a refused query. A GET refused as too long (HTTP 414
    /// or 431, a proxy's URL or header limit) is sent again as a form POST when Prometheus is reached by its own URL;
    /// through the API server's service proxy it is an error that says so ([`QUERY_TOO_LONG`]).
    pub(crate) async fn query_limited(
        &self,
        promql: &str,
        time: i64,
        limit: usize,
    ) -> CoreResult<Value> {
        let form = format!(
            "query={}&time={time}&timeout={}",
            encode(promql),
            rightsizing::SERVER_TIMEOUT
        );
        let get = http::Request::get(format!("{}/api/v1/query?{form}", self.base))
            .body(Vec::new())
            .map_err(|e| CoreError::new(ErrorCode::Invalid, e.to_string()))?;
        let (mut status, mut body) = self.send_limited(get, limit).await?;
        if too_long(status) && self.direct {
            let post = http::Request::post(format!("{}/api/v1/query", self.base))
                .header(
                    http::header::CONTENT_TYPE,
                    "application/x-www-form-urlencoded",
                )
                .body(form.into_bytes())
                .map_err(|e| CoreError::new(ErrorCode::Invalid, e.to_string()))?;
            (status, body) = self.send_limited(post, limit).await?;
        }
        answer_data(status, &body)
    }

    /// Whether this is a Prometheus that answers.
    pub(crate) async fn probe(&self) -> CoreResult<()> {
        self.get("api/v1/status/buildinfo").await.map(|_| ())
    }

    /// Instant query: `(labels, value)` per series.
    async fn query(&self, promql: &str) -> CoreResult<Vec<(BTreeMap<String, String>, f64)>> {
        let data = self
            .get(&format!("api/v1/query?query={}", encode(promql)))
            .await?;
        Ok(results(&data)
            .filter_map(|r| {
                let value = number(r.get("value")?.get(1)?)?;
                Some((labels(r), value))
            })
            .collect())
    }

    /// Range query: the points of the first series (empty when there is no data).
    async fn query_range(
        &self,
        promql: &str,
        start: i64,
        end: i64,
        step: i64,
    ) -> CoreResult<Vec<(i64, f64)>> {
        let data = self
            .get(&format!(
                "api/v1/query_range?query={}&start={start}&end={end}&step={step}",
                encode(promql)
            ))
            .await?;
        let Some(first) = results(&data).next() else {
            return Ok(Vec::new());
        };
        Ok(first
            .get("values")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|p| {
                let ts = p.get(0)?.as_f64()? as i64;
                Some((ts, number(p.get(1)?)?))
            })
            .collect())
    }
}

/// HTTP 414 (URI too long) or 431 (headers too large): a proxy's limit, not Prometheus' answer.
fn too_long(status: http::StatusCode) -> bool {
    matches!(status.as_u16(), 414 | 431)
}

/// The `data` of a Prometheus HTTP API answer with `status`; Prometheus' own error message kept for a refused query.
fn answer_data(status: http::StatusCode, body: &[u8]) -> CoreResult<Value> {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let Some(body) = parsed.filter(|b| b.get("status").is_some()) else {
        return Err(if status.is_success() {
            CoreError::new(
                ErrorCode::Invalid,
                "the answer is not from the Prometheus HTTP API",
            )
        } else if too_long(status) {
            CoreError::new(
                ErrorCode::Invalid,
                format!("{QUERY_TOO_LONG} (HTTP {})", status.as_u16()),
            )
        } else {
            CoreError::new(
                crate::error::code_for_http_status(status.as_u16()),
                format!("Prometheus: HTTP {status}"),
            )
        });
    };
    if body.get("status").and_then(Value::as_str) != Some("success") {
        let message = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(CoreError::other(format!("Prometheus: {message}")));
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

fn prometheus_error(err: CoreError) -> CoreError {
    CoreError::new(err.code, format!("Prometheus: {}", err.message))
}

fn results(data: &Value) -> impl Iterator<Item = &Value> {
    data.get("result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn labels(result: &Value) -> BTreeMap<String, String> {
    result
        .get("metric")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
        .collect()
}

/// Prometheus sends sample values as strings ("12.5", "NaN").
fn number(value: &Value) -> Option<f64> {
    value
        .as_str()?
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
}

/// Percent-encoding for a query parameter value.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A PromQL string literal body: backslashes and quotes escaped.
fn literal(text: &str) -> String {
    text.replace('\\', r"\\").replace('"', "\\\"")
}

/// A regular expression matching `text` literally.
fn regex_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if r"\.+*?()|[]{}^$".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// Auto-detection

/// Auto-detection results per cluster: when, and what was found.
type Detected = HashMap<ClusterId, (Instant, Option<PrometheusTarget>)>;

static DETECTED: LazyLock<Mutex<Detected>> = LazyLock::new(Default::default);

/// Rank of a service among the known Prometheus service names (lower is better) and the port to use.
fn candidate(service: &Service) -> Option<(u8, u16)> {
    let name = service.metadata.name.as_deref()?;
    let ports: Vec<u16> = service
        .spec
        .as_ref()?
        .ports
        .iter()
        .flatten()
        .filter_map(|p| u16::try_from(p.port).ok())
        .collect();
    let rank = if name == "prometheus-operated" {
        (0, 9090)
    } else if name == "prometheus-server" {
        (1, 80)
    } else if name.ends_with("-kube-prometheus-prometheus") {
        (2, 9090)
    } else if name == "prometheus" {
        (3, 9090)
    } else {
        return None;
    };
    ports.contains(&rank.1).then_some(rank)
}

/// The first known Prometheus service (see [`CANDIDATE_NAMESPACES`]) that answers through the API server proxy.
/// Results, including "not found", are cached per cluster for a minute.
pub(crate) async fn detect(client: &kube::Client, cluster: &ClusterId) -> Option<PrometheusTarget> {
    if let Some((at, found)) = lock_detected().get(cluster)
        && at.elapsed() < DETECT_TTL
    {
        return found.clone();
    }
    let found = detect_uncached(client).await;
    lock_detected().insert(cluster.clone(), (Instant::now(), found.clone()));
    found
}

fn lock_detected() -> std::sync::MutexGuard<'static, Detected> {
    DETECTED.lock().unwrap_or_else(|e| e.into_inner())
}

async fn detect_uncached(client: &kube::Client) -> Option<PrometheusTarget> {
    let lists = join_all(CANDIDATE_NAMESPACES.iter().map(|ns| async move {
        let api: Api<Service> = Api::namespaced(client.clone(), ns);
        // A missing namespace lists nothing; a forbidden one is skipped.
        api.list(&ListParams::default())
            .await
            .map(|l| l.items)
            .unwrap_or_default()
    }))
    .await;
    let mut candidates: Vec<(usize, u8, PrometheusTarget)> = Vec::new();
    for (index, services) in lists.into_iter().enumerate() {
        for service in services {
            if let Some((rank, port)) = candidate(&service) {
                candidates.push((
                    index,
                    rank,
                    PrometheusTarget::Service {
                        namespace: CANDIDATE_NAMESPACES[index].to_owned(),
                        service: service.metadata.name.clone().unwrap_or_default(),
                        port,
                        path_prefix: String::new(),
                    },
                ));
            }
        }
    }
    candidates.sort_by_key(|(index, rank, _)| (*index, *rank));
    for (_, _, target) in candidates {
        let Ok(prometheus) = Prometheus::new(client, &target) else {
            continue;
        };
        if prometheus.probe().await.is_ok() {
            return Some(target);
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------
// Current usage (the latest point)

fn namespace_filter(namespaces: Option<&[String]>) -> String {
    match namespaces {
        None => String::new(),
        Some(list) => {
            let alternatives: Vec<String> =
                list.iter().map(|ns| literal(&regex_literal(ns))).collect();
            format!(r#",namespace=~"{}""#, alternatives.join("|"))
        }
    }
}

pub(crate) async fn pod_usage(
    prometheus: &Prometheus,
    namespaces: Option<&[String]>,
) -> CoreResult<Vec<PodUsage>> {
    if namespaces.is_some_and(<[String]>::is_empty) {
        return Ok(Vec::new());
    }
    let filter = format!(r#"{CONTAINERS},pod!=""{}"#, namespace_filter(namespaces));
    let cpu = format!(
        "sum by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{{{filter}}}[{RATE_WINDOW}])) * 1000"
    );
    let memory = format!(
        "sum by (namespace, pod, container) (container_memory_working_set_bytes{{{filter}}})"
    );
    let (cpu, memory) = futures::try_join!(prometheus.query(&cpu), prometheus.query(&memory))?;

    type Containers = BTreeMap<String, Usage>;
    let mut pods: BTreeMap<(String, String), Containers> = BTreeMap::new();
    let mut add = |samples: Vec<(BTreeMap<String, String>, f64)>, is_cpu: bool| {
        for (labels, value) in samples {
            let (Some(ns), Some(pod), Some(container)) = (
                labels.get("namespace"),
                labels.get("pod"),
                labels.get("container"),
            ) else {
                continue;
            };
            let usage = pods
                .entry((ns.clone(), pod.clone()))
                .or_default()
                .entry(container.clone())
                .or_default();
            if is_cpu {
                usage.cpu_millicores = value;
            } else {
                usage.memory_bytes = value;
            }
        }
    };
    add(cpu, true);
    add(memory, false);
    Ok(pods
        .into_iter()
        .map(|((namespace, name), containers)| {
            let containers: Vec<(String, Usage)> = containers.into_iter().collect();
            let usage = containers
                .iter()
                .fold(Usage::default(), |acc, (_, u)| Usage {
                    cpu_millicores: acc.cpu_millicores + u.cpu_millicores,
                    memory_bytes: acc.memory_bytes + u.memory_bytes,
                });
            PodUsage {
                namespace,
                name,
                usage,
                containers,
            }
        })
        .collect())
}

/// Node name of a series: its `node` label, else `instance` without the port.
fn node_name(labels: &BTreeMap<String, String>) -> Option<String> {
    if let Some(node) = labels.get("node").filter(|n| !n.is_empty()) {
        return Some(node.clone());
    }
    let instance = labels.get("instance").filter(|i| !i.is_empty())?;
    Some(match instance.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host.to_owned(),
        _ => instance.clone(),
    })
}

pub(crate) async fn node_usage(prometheus: &Prometheus) -> CoreResult<Vec<NodeUsage>> {
    let cpu = format!(
        r#"sum by (node, instance) (rate(container_cpu_usage_seconds_total{{id="/"}}[{RATE_WINDOW}])) * 1000"#
    );
    let memory = r#"sum by (node, instance) (container_memory_working_set_bytes{id="/"})"#;
    let (cpu, memory) = futures::try_join!(prometheus.query(&cpu), prometheus.query(memory))?;
    let mut nodes: BTreeMap<String, Usage> = BTreeMap::new();
    for (labels, value) in cpu {
        if let Some(name) = node_name(&labels) {
            nodes.entry(name).or_default().cpu_millicores = value;
        }
    }
    for (labels, value) in memory {
        if let Some(name) = node_name(&labels) {
            nodes.entry(name).or_default().memory_bytes = value;
        }
    }
    Ok(nodes
        .into_iter()
        .map(|(name, usage)| NodeUsage { name, usage })
        .collect())
}

// ---------------------------------------------------------------------------------------------------------------
// Charts

/// PromQL per metric (`cpu` in millicores, `memory` and `disk` in bytes, `pods` as a count).
pub(crate) fn chart_queries(chart: &ChartTarget) -> Vec<(&'static str, String)> {
    let containers = |selector: &str| {
        vec![
            (
                "cpu",
                format!(
                    "sum(rate(container_cpu_usage_seconds_total{{{selector},{CONTAINERS}}}[{RATE_WINDOW}])) * 1000"
                ),
            ),
            (
                "memory",
                format!("sum(container_memory_working_set_bytes{{{selector},{CONTAINERS}}})"),
            ),
        ]
    };
    match chart {
        ChartTarget::Pod { namespace, name } => containers(&format!(
            r#"namespace="{}",pod="{}""#,
            literal(namespace),
            literal(name)
        )),
        ChartTarget::Workload {
            namespace,
            kind,
            name,
        } => {
            let name = regex_literal(name);
            // Pod names that the controller generates, so pods replaced during the hour still count.
            let pods = match kind.as_str() {
                "Deployment" => format!("{name}-[a-z0-9]+-[a-z0-9]+"),
                "StatefulSet" => format!("{name}-[0-9]+"),
                "DaemonSet" | "ReplicaSet" | "Job" => format!("{name}-[a-z0-9]+"),
                _ => format!("{name}-.+"),
            };
            containers(&format!(
                r#"namespace="{}",pod=~"{}""#,
                literal(namespace),
                literal(&pods)
            ))
        }
        ChartTarget::Node { name } => {
            let by_node = format!(r#"node="{}""#, literal(name));
            let by_instance = format!(
                r#"instance=~"{}(:[0-9]+)?""#,
                literal(&regex_literal(name))
            );
            // The same expression matched by `node`, else by `instance`.
            let either = |expr: &dyn Fn(&str) -> String| {
                format!("{} or {}", expr(&by_node), expr(&by_instance))
            };
            vec![
                (
                    "cpu",
                    either(&|s| {
                        format!(
                            r#"sum(rate(container_cpu_usage_seconds_total{{id="/",{s}}}[{RATE_WINDOW}])) * 1000"#
                        )
                    }),
                ),
                (
                    "memory",
                    either(&|s| format!(r#"sum(container_memory_working_set_bytes{{id="/",{s}}})"#)),
                ),
                (
                    "pods",
                    either(&|s| {
                        format!(
                            r#"sum(kubelet_running_pods{{{s}}}) or sum(kubelet_running_pod_count{{{s}}}) or count(kube_pod_info{{{s}}}) or count(count by (namespace, pod) (container_memory_working_set_bytes{{{s},pod!="",container!=""}}))"#
                        )
                    }),
                ),
                (
                    "disk",
                    either(&|s| {
                        format!(
                            r#"sum(node_filesystem_size_bytes{{mountpoint="/",{s}}} - node_filesystem_avail_bytes{{mountpoint="/",{s}}}) or max(container_fs_usage_bytes{{id="/",device=~"/dev/.+",{s}}})"#
                        )
                    }),
                ),
            ]
        }
        ChartTarget::Cluster => vec![
            (
                "cpu",
                format!(
                    r#"sum(rate(container_cpu_usage_seconds_total{{id="/"}}[{RATE_WINDOW}])) * 1000"#
                ),
            ),
            (
                "memory",
                r#"sum(container_memory_working_set_bytes{id="/"})"#.to_owned(),
            ),
            (
                "pods",
                r#"sum(kubelet_running_pods) or sum(kubelet_running_pod_count) or count(kube_pod_info) or count(count by (namespace, pod) (container_memory_working_set_bytes{pod!="",container!=""}))"#.to_owned(),
            ),
            (
                "disk",
                r#"sum(node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_avail_bytes{mountpoint="/"}) or sum(max by (node, instance) (container_fs_usage_bytes{id="/",device=~"/dev/.+"}))"#.to_owned(),
            ),
        ],
    }
}

/// One series per metric that has data in the last `range_secs` seconds (about 60 points). Fails only when every
/// query fails.
pub(crate) async fn charts(
    prometheus: &Prometheus,
    chart: &ChartTarget,
    range_secs: i64,
) -> CoreResult<Vec<Series>> {
    let range = range_secs.clamp(60, 7 * 24 * 3600);
    let step = (range / 60).max(15);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let end = now - now % step;
    let start = end - range;
    let queries = chart_queries(chart);
    let answers = join_all(
        queries
            .iter()
            .map(|(_, q)| prometheus.query_range(q, start, end, step)),
    )
    .await;
    let mut series = Vec::new();
    let mut first_error = None;
    let mut failed = 0;
    for ((metric, _), answer) in queries.iter().zip(answers) {
        match answer {
            Ok(points) if !points.is_empty() => series.push(Series {
                metric: (*metric).to_owned(),
                points,
            }),
            Ok(_) => {}
            Err(err) => {
                failed += 1;
                first_error.get_or_insert(err);
            }
        }
    }
    match first_error {
        Some(err) if failed == queries.len() => Err(err),
        _ => Ok(series),
    }
}
