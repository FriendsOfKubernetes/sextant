//! PromQL of the request metrics (#212); see `metrics::requests` for the contract and ADR-0095 for what each source's
//! labels mean. Every query is built here from a validated target (and Service names read from the cluster); names are
//! escaped anyway. Nothing the caller writes becomes PromQL, a metric name or a label matcher.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::rightsizing::{SERVER_TIMEOUT, Samples, pod_name_pattern, scope_selector};
use super::{Prometheus, encode, labels, literal, number, results};
use crate::error::CoreResult;
use crate::metrics::history::HistoryScope;
use crate::metrics::requests::{
    ContainerThrottling, DetectedSource, GoldenMetrics, LatencyMs, MAX_THROTTLED_CONTAINERS,
    RequestSourceKind, RequestTarget, RequestVia, SERIES_RANGE_SECS, SERIES_STEP_SECS,
};

/// `rate()` window of the current values.
pub(crate) const RATE_WINDOW: &str = "5m";
/// Window of the throttled share.
pub(crate) const THROTTLE_WINDOW: &str = "1h";
/// How far back detection looks for series of the known metrics.
const DETECT_LOOKBACK_SECS: i64 = 3600;

// ---------------------------------------------------------------------------------------------------------------
// Detection

/// Which of [`RequestSourceKind::known_metrics`] have series in the last hour: one label-values request restricted by
/// `match[]` to those names; whatever else an older Prometheus sends back is dropped.
pub(crate) async fn request_metric_names(
    prometheus: &Prometheus,
    now: i64,
) -> CoreResult<BTreeSet<String>> {
    let known = RequestSourceKind::known_metrics();
    let matcher = format!(r#"{{__name__=~"{}"}}"#, known.join("|"));
    let data = prometheus
        .get(&format!(
            "api/v1/label/__name__/values?{}={}&start={}&end={now}",
            encode("match[]"),
            encode(&matcher),
            now - DETECT_LOOKBACK_SECS
        ))
        .await?;
    Ok(data
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| known.contains(name))
        .map(str::to_owned)
        .collect())
}

/// The sources these metric names make up, in [`RequestSourceKind::ALL`] order.
pub(crate) fn sources_in(names: &BTreeSet<String>, via: RequestVia) -> Vec<DetectedSource> {
    let has = |name: &&str| names.contains(*name);
    RequestSourceKind::ALL
        .iter()
        .filter(|kind| {
            kind.required_metrics()
                .iter()
                .any(|group| group.iter().all(has))
        })
        .map(|&kind| DetectedSource {
            kind,
            via,
            latency: kind.latency_metrics().iter().any(has),
        })
        .collect()
}

/// The sources whose edge metrics these names make up (the traffic graph, #211), in [`RequestSourceKind::ALL`] order.
pub(crate) fn edge_sources_in(names: &BTreeSet<String>, via: RequestVia) -> Vec<DetectedSource> {
    let has = |name: &&str| names.contains(*name);
    RequestSourceKind::ALL
        .iter()
        .filter(|kind| {
            kind.edge_metrics()
                .iter()
                .any(|group| group.iter().all(has))
        })
        .map(|&kind| DetectedSource {
            kind,
            via,
            latency: kind.edge_latency_metrics().iter().any(has),
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// Selectors

/// The label matchers (without braces) of the target's requests in the source's series; several are alternatives
/// (asked with `or`), none means the source cannot name the target. `services`: the Services selecting the target's
/// pods (ingress-nginx only).
pub(crate) fn request_selectors(
    kind: RequestSourceKind,
    target: &RequestTarget,
    services: &[String],
) -> Vec<String> {
    let q = |text: &str| literal(text);
    match (kind, target) {
        // Set by the receiving proxy from its own workload: no pod names involved.
        (
            RequestSourceKind::Istio,
            RequestTarget::Workload {
                namespace, name, ..
            },
        ) => vec![format!(
            r#"reporter="destination",destination_workload_namespace="{}",destination_workload="{}""#,
            q(namespace),
            q(name)
        )],
        // The receiving proxy is the pod itself; `pod` is the scrape target's label.
        (RequestSourceKind::Istio, RequestTarget::Pod { namespace, name }) => vec![format!(
            r#"reporter="destination",destination_workload_namespace="{}",pod="{}""#,
            q(namespace),
            q(name)
        )],
        (RequestSourceKind::Linkerd, _) => vec![format!(
            r#"direction="inbound",namespace="{}",{}"#,
            q(target.namespace()),
            pod_matcher("pod", target)
        )],
        (RequestSourceKind::Beyla, _) => vec![format!(
            r#"k8s_namespace_name="{}",{}"#,
            q(target.namespace()),
            pod_matcher("k8s_pod_name", target)
        )],
        // Either side's report ([`Shape::sides`] picks): the callee's, or the caller's where the callee has none.
        (
            RequestSourceKind::Hubble,
            RequestTarget::Workload {
                namespace, name, ..
            },
        ) => vec![format!(
            r#"destination_namespace="{}",destination_workload="{}""#,
            q(namespace),
            q(name)
        )],
        (RequestSourceKind::Hubble, RequestTarget::Pod { namespace, name }) => vec![format!(
            r#"destination_namespace="{}",destination_pod="{}""#,
            q(namespace),
            q(name)
        )],
        // Connections, not requests: nothing to ask about a workload's requests.
        (RequestSourceKind::Caretta, _) => Vec::new(),
        (RequestSourceKind::IngressNginx, _) if services.is_empty() => Vec::new(),
        (RequestSourceKind::IngressNginx, _) => {
            let alternatives: Vec<String> =
                services.iter().map(|s| super::regex_literal(s)).collect();
            let names = q(&alternatives.join("|"));
            let namespace = q(target.namespace());
            // The metric's own `namespace` and `service`; or — when the scrape kept the target's labels (a
            // ServiceMonitor without `honorLabels`) — the same values renamed `exported_namespace`/`exported_service`;
            // or, through a PodMonitor (whose targets have a `namespace` but no `service`), only the namespace renamed.
            vec![
                format!(r#"namespace="{namespace}",service=~"{names}""#),
                format!(r#"exported_namespace="{namespace}",exported_service=~"{names}""#),
                format!(r#"exported_namespace="{namespace}",service=~"{names}""#),
            ]
        }
    }
}

/// `label="pod"` for a pod, `label=~"<the controller's pod names>"` for a workload.
fn pod_matcher(label: &str, target: &RequestTarget) -> String {
    match target {
        RequestTarget::Pod { name, .. } => format!(r#"{label}="{}""#, literal(name)),
        RequestTarget::Workload { kind, name, .. } => {
            format!(r#"{label}=~"{}""#, literal(&pod_name_pattern(kind, name)))
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

/// What a source's series look like.
pub(crate) struct Shape {
    /// The request counter; several names are matched by `__name__`.
    pub count: &'static [&'static str],
    /// The latency histogram's buckets, likewise.
    pub bucket: &'static [&'static str],
    /// Matchers of failed requests; each picks other series, so their rates add up.
    pub errors: &'static [&'static str],
    /// The histogram's unit in milliseconds.
    pub to_ms: f64,
    /// A source that reports a call at both ends (selectors then name only the callee).
    pub sides: Option<Sides>,
}

/// Matchers of the two reports of one call, and the labels that make a pair of ends.
pub(crate) struct Sides {
    /// The callee's report: every call it sees counts.
    pub callee: &'static str,
    /// The caller's report: counted only for the pairs the callee does not report (`unless on(<pair>)`).
    pub caller: &'static str,
    pub pair: &'static str,
}

/// Hubble reports a call at the callee with ingress L7 visibility and at the caller with egress visibility; with only
/// egress visibility (or a callee outside the cluster) the caller's report is the only one.
const HUBBLE_SIDES: Sides = Sides {
    callee: r#"reporter!="client""#,
    caller: r#"reporter="client""#,
    pair: "source_namespace,source_workload,source_pod,destination_namespace,destination_workload,destination_pod",
};

pub(crate) fn shape(kind: RequestSourceKind) -> Shape {
    match kind {
        RequestSourceKind::Istio => Shape {
            count: &["istio_requests_total"],
            bucket: &["istio_request_duration_milliseconds_bucket"],
            // HTTP 5xx; a gRPC call answers HTTP 200 with a non-OK `grpc-status`.
            errors: &[
                r#"response_code=~"5..""#,
                r#"response_code!~"5..",grpc_response_status!~"|0""#,
            ],
            to_ms: 1.0,
            sides: None,
        },
        RequestSourceKind::Linkerd => Shape {
            count: &["response_total"],
            bucket: &["response_latency_ms_bucket"],
            // The proxy's own verdict: 5xx, a non-OK gRPC status, or no response.
            errors: &[r#"classification="failure""#],
            to_ms: 1.0,
            sides: None,
        },
        RequestSourceKind::IngressNginx => Shape {
            count: &["nginx_ingress_controller_requests"],
            bucket: &["nginx_ingress_controller_request_duration_seconds_bucket"],
            errors: &[r#"status=~"5..""#],
            to_ms: 1000.0,
            sides: None,
        },
        RequestSourceKind::Beyla => Shape {
            count: &[
                "http_server_request_duration_seconds_count",
                "rpc_server_duration_seconds_count",
            ],
            bucket: &[
                "http_server_request_duration_seconds_bucket",
                "rpc_server_duration_seconds_bucket",
            ],
            // HTTP series have no gRPC status and RPC series no HTTP status, so the two never overlap.
            errors: &[
                r#"http_response_status_code=~"5..""#,
                r#"rpc_grpc_status_code!~"|0""#,
            ],
            to_ms: 1000.0,
            sides: None,
        },
        RequestSourceKind::Hubble => Shape {
            count: &["hubble_http_requests_total"],
            bucket: &["hubble_http_request_duration_seconds_bucket"],
            errors: &[r#"status=~"5..""#],
            to_ms: 1000.0,
            sides: Some(HUBBLE_SIDES),
        },
        // Never asked: Caretta has no request metrics, so `request_selectors` names nothing for it.
        RequestSourceKind::Caretta => Shape {
            count: &[],
            bucket: &[],
            errors: &[],
            to_ms: 1.0,
            sides: None,
        },
    }
}

/// `name{matchers}`, or `{__name__=~"a|b",matchers}` for several names.
fn series(names: &[&str], matchers: &[&str]) -> String {
    let matchers: Vec<&str> = matchers.iter().copied().filter(|m| !m.is_empty()).collect();
    match names {
        [one] => format!("{one}{{{}}}", matchers.join(",")),
        _ => {
            let name = format!(r#"__name__=~"{}""#, names.join("|"));
            let all: Vec<&str> = std::iter::once(name.as_str()).chain(matchers).collect();
            format!("{{{}}}", all.join(","))
        }
    }
}

/// The series of `names` matching `selector` and `extra`, per second. With two [`Sides`]: the callee's report, and the
/// caller's for the pairs of ends the callee does not report, each summed by the pair (and `by`).
fn per_second(shape: &Shape, names: &[&str], selector: &str, extra: &str, by: &str) -> String {
    let rate = |names: &[&str], matchers: &[&str]| {
        format!("rate({}[{RATE_WINDOW}])", series(names, matchers))
    };
    let Some(sides) = &shape.sides else {
        return rate(names, &[selector, extra]);
    };
    let pair = sides.pair;
    let by = match by {
        "" => pair.to_owned(),
        more => format!("{more},{pair}"),
    };
    format!(
        "sum by ({by}) ({}) or (sum by ({by}) ({}) unless on({pair}) sum by ({pair}) ({}))",
        rate(names, &[selector, sides.callee, extra]),
        rate(names, &[selector, sides.caller, extra]),
        rate(shape.count, &[selector, sides.callee]),
    )
}

/// Requests per second matching `extra`, the first alternative selector that has series.
fn rate_expr(shape: &Shape, selectors: &[String], extra: &str) -> String {
    let alternatives: Vec<String> = selectors
        .iter()
        .map(|s| format!("sum({})", per_second(shape, shape.count, s, extra, "")))
        .collect();
    format!("({})", alternatives.join(" or "))
}

/// Failed requests per second (0 when there are none).
fn errors_expr(shape: &Shape, selectors: &[String]) -> String {
    let terms: Vec<String> = shape
        .errors
        .iter()
        .map(|e| format!("({} or vector(0))", rate_expr(shape, selectors, e)))
        .collect();
    format!("({})", terms.join(" + "))
}

fn quantile_expr(shape: &Shape, selectors: &[String], q: &str) -> String {
    let buckets: Vec<String> = selectors
        .iter()
        .map(|s| {
            format!(
                "sum by (le) ({})",
                per_second(shape, shape.bucket, s, "", "le")
            )
        })
        .collect();
    format!("histogram_quantile({q}, {})", buckets.join(" or "))
}

fn tagged(expr: &str, tag: &str) -> String {
    format!(r#"label_replace({expr}, "m", "{tag}", "", "")"#)
}

/// The quantiles asked, by their tag.
const QUANTILES: [(&str, &str); 3] = [("p50", "0.5"), ("p95", "0.95"), ("p99", "0.99")];

/// One instant query for every current value, each series tagged by `m`: `rate`, `errors`, and with the histogram
/// `p50`, `p95`, `p99` (in the histogram's unit).
pub(crate) fn golden_query(kind: RequestSourceKind, selectors: &[String], latency: bool) -> String {
    let shape = shape(kind);
    let mut parts = vec![
        tagged(&rate_expr(&shape, selectors, ""), "rate"),
        tagged(&errors_expr(&shape, selectors), "errors"),
    ];
    if latency {
        parts.extend(
            QUANTILES
                .iter()
                .map(|(tag, q)| tagged(&quantile_expr(&shape, selectors, q), tag)),
        );
    }
    parts.join(" or ")
}

/// The range query of the last hour: `rate` and `errors`, tagged by `m`.
pub(crate) fn series_query(kind: RequestSourceKind, selectors: &[String]) -> String {
    let shape = shape(kind);
    format!(
        "{} or {}",
        tagged(&rate_expr(&shape, selectors, ""), "rate"),
        tagged(&errors_expr(&shape, selectors), "errors")
    )
}

/// The throttled share of CFS periods per container over [`THROTTLE_WINDOW`]; `None` when the scope matches nothing.
pub(crate) fn throttling_query(scope: &HistoryScope) -> Option<String> {
    let s = scope_selector(scope)?;
    Some(format!(
        "sum by (container) (increase(container_cpu_cfs_throttled_periods_total{{{s}}}[{THROTTLE_WINDOW}])) / sum by (container) (increase(container_cpu_cfs_periods_total{{{s}}}[{THROTTLE_WINDOW}]))"
    ))
}

// ---------------------------------------------------------------------------------------------------------------
// Running them

/// At most this many points are kept per series.
const MAX_POINTS: usize = (SERIES_RANGE_SECS / SERIES_STEP_SECS) as usize + 1;

impl Prometheus {
    /// Range query whose series are told apart by the `m` tag; only `tags` are kept, each at most [`MAX_POINTS`].
    async fn query_range_tagged(
        &self,
        promql: &str,
        (start, end, step): (i64, i64, i64),
        tags: &[&str],
    ) -> CoreResult<BTreeMap<String, Vec<(i64, f64)>>> {
        let data = self
            .get(&format!(
                "api/v1/query_range?query={}&start={start}&end={end}&step={step}&timeout={SERVER_TIMEOUT}",
                encode(promql)
            ))
            .await?;
        let mut out = BTreeMap::new();
        for result in results(&data) {
            let Some(tag) = labels(result)
                .remove("m")
                .filter(|t| tags.contains(&t.as_str()))
            else {
                continue;
            };
            let points: Vec<(i64, f64)> = result
                .get("values")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|p| Some((p.get(0)?.as_f64()? as i64, number(p.get(1)?)?)))
                .take(MAX_POINTS)
                .collect();
            out.entry(tag).or_insert(points);
        }
        Ok(out)
    }
}

/// The first value of each tag.
fn by_tag(samples: Samples) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for (mut labels, value) in samples {
        if let Some(tag) = labels.remove("m") {
            out.entry(tag).or_insert(value);
        }
    }
    out
}

/// The golden metrics of the target in `source` (the selectors of [`request_selectors`]); `None` when the source has
/// no series of it over the last hour.
pub(crate) async fn golden(
    prometheus: &Prometheus,
    source: DetectedSource,
    selectors: &[String],
    now: i64,
) -> CoreResult<Option<GoldenMetrics>> {
    let end = now - now % SERIES_STEP_SECS;
    let range = (end - SERIES_RANGE_SECS, end, SERIES_STEP_SECS);
    let instant = golden_query(source.kind, selectors, source.latency);
    let hour = series_query(source.kind, selectors);
    let (current, mut series) = futures::try_join!(
        prometheus.query_at(&instant, now),
        prometheus.query_range_tagged(&hour, range, &["rate", "errors"]),
    )?;
    Ok(assemble(source, by_tag(current), &mut series))
}

pub(crate) fn assemble(
    source: DetectedSource,
    current: BTreeMap<String, f64>,
    series: &mut BTreeMap<String, Vec<(i64, f64)>>,
) -> Option<GoldenMetrics> {
    let rate_series = series.remove("rate").unwrap_or_default();
    let request_rate = current.get("rate").copied().map(|r| r.max(0.0));
    if request_rate.is_none() && rate_series.is_empty() {
        return None;
    }
    let to_ms = shape(source.kind).to_ms;
    let quantile = |tag: &str| current.get(tag).map(|v| v * to_ms).filter(|v| *v >= 0.0);
    let error_ratio = match (request_rate, current.get("errors")) {
        (Some(rate), Some(errors)) if rate > 0.0 => Some((errors / rate).clamp(0.0, 1.0)),
        _ => None,
    };
    Some(GoldenMetrics {
        source: source.kind,
        via: source.via,
        request_rate,
        error_ratio,
        latency_ms: LatencyMs {
            p50: quantile("p50"),
            p95: quantile("p95"),
            p99: quantile("p99"),
        },
        rate_series,
        error_series: series.remove("errors").unwrap_or_default(),
    })
}

/// The throttled share per container of the scope, by name, at most [`MAX_THROTTLED_CONTAINERS`].
pub(crate) async fn throttling(
    prometheus: &Prometheus,
    scope: &HistoryScope,
    now: i64,
) -> CoreResult<Vec<ContainerThrottling>> {
    let Some(query) = throttling_query(scope) else {
        return Ok(Vec::new());
    };
    let mut by_container: BTreeMap<String, f64> = BTreeMap::new();
    for (mut labels, value) in prometheus.query_at(&query, now).await? {
        if let Some(container) = labels.remove("container") {
            by_container
                .entry(container)
                .or_insert(value.clamp(0.0, 1.0));
        }
    }
    Ok(by_container
        .into_iter()
        .take(MAX_THROTTLED_CONTAINERS)
        .map(|(container, throttled_ratio)| ContainerThrottling {
            container,
            throttled_ratio,
        })
        .collect())
}

#[cfg(test)]
mod tests;
