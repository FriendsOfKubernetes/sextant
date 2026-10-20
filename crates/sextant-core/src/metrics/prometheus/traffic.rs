//! PromQL of the traffic graph (#211); see `metrics::traffic` for the contract and ADR-0096 for what each source's
//! labels mean. Every query is built here from fixed tables and validated namespace names (escaped anyway); nothing the
//! caller writes becomes PromQL, a metric name or a label matcher.
//!
//! Each source's series are first summed by the source's own labels, then renamed into one set of labels (`sx_*`, by
//! `label_replace`), so every source answers in the same shape: caller namespace and name, callee namespace, name and
//! kind, protocol. One instant query per source returns every value tagged by `m`: the busiest edges (`topk`), how
//! many there are, and — only for those edges (`and on(...)`) — errors, status classes and p50/p95.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::rightsizing::SERVER_TIMEOUT;
use super::{Prometheus, encode, labels, literal, number, regex_literal, results};
use crate::error::CoreResult;
use crate::metrics::requests::{DetectedSource, RequestSourceKind};
use crate::metrics::traffic::{
    MAX_TRAFFIC_BODY, MAX_TRAFFIC_EDGES, MAX_TRAFFIC_SERIES, SourceEdges, StatusClassRate,
    TrafficEdge, TrafficPeer, TrafficPeerKind, TrafficProtocol, TrafficWindow,
};

// The labels every source's series are renamed into.
const SRC_NS: &str = "sx_sn";
const SRC: &str = "sx_s";
const DST_NS: &str = "sx_dn";
const DST: &str = "sx_d";
const DST_KIND: &str = "sx_dk";
const PROTO: &str = "sx_p";
const CLASS: &str = "sx_c";
/// Keeps the parts (and the error alternatives) of a source apart until they are summed.
const PART: &str = "sx_part";
const ALT: &str = "sx_alt";
/// What an edge is.
const EDGE: &str = "sx_sn, sx_s, sx_dn, sx_d, sx_dk, sx_p";

/// One `label_replace` step: (target label, replacement, source label, regex). The regex is anchored, so `(.+)` sets
/// the target only from a non-empty source label, and an empty source label with regex `""` sets a constant.
type Step = (&'static str, &'static str, &'static str, &'static str);

/// What a failed request is in a part.
pub(crate) enum Errors {
    /// TCP: no verdict.
    None,
    /// Matchers on the request counter; each picks other series, so their rates add up.
    Matchers(&'static [&'static str]),
    /// A counter of failed requests with the same labels.
    Counter(&'static str),
}

/// One family of series of a source that names both ends of a call.
pub(crate) struct Part {
    /// The request (or connection) counter.
    pub count: &'static str,
    /// Fixed matchers of the series that make edges.
    pub matchers: &'static str,
    /// Labels holding a namespace of an end: an edge is in scope when one of them names a chosen namespace.
    pub namespaces: &'static [&'static str],
    /// The source's labels the series are summed by before renaming.
    pub by: &'static [&'static str],
    pub steps: &'static [Step],
    pub errors: Errors,
    /// The latency histogram's buckets.
    pub bucket: Option<&'static str>,
    /// The label with the HTTP status code.
    pub class: Option<&'static str>,
}

pub(crate) struct EdgeShape {
    pub parts: &'static [Part],
    /// The histogram's unit in milliseconds.
    pub to_ms: f64,
    /// A name or namespace of this value means the source cannot tell (Istio writes `unknown`).
    pub unknown: &'static str,
}

const ISTIO_ERRORS: Errors = Errors::Matchers(&[
    r#"response_code=~"5..""#,
    r#"response_code!~"5..",grpc_response_status!~"|0""#,
]);
const ISTIO_SOURCE: [Step; 2] = [
    (SRC_NS, "$1", "source_workload_namespace", "(.*)"),
    (SRC, "$1", "source_workload", "(.*)"),
];
const ISTIO_TO_WORKLOAD: [Step; 3] = [
    (DST_NS, "$1", "destination_workload_namespace", "(.*)"),
    (DST, "$1", "destination_workload", "(.*)"),
    (DST_KIND, "workload", "", ""),
];
const ISTIO_TO_SERVICE: [Step; 3] = [
    (DST_NS, "$1", "destination_service_namespace", "(.*)"),
    (DST, "$1", "destination_service_name", "(.*)"),
    (DST_KIND, "service", "", ""),
];

const ISTIO: EdgeShape = EdgeShape {
    to_ms: 1.0,
    unknown: "unknown",
    parts: &[
        // Reported by the callee's proxy: counted once, with the caller as the callee saw it (`unknown` without a proxy).
        Part {
            count: "istio_requests_total",
            matchers: r#"reporter="destination""#,
            namespaces: &[
                "destination_workload_namespace",
                "source_workload_namespace",
            ],
            by: &[
                "source_workload_namespace",
                "source_workload",
                "destination_workload_namespace",
                "destination_workload",
                "request_protocol",
            ],
            steps: &[
                ISTIO_SOURCE[0],
                ISTIO_SOURCE[1],
                ISTIO_TO_WORKLOAD[0],
                ISTIO_TO_WORKLOAD[1],
                ISTIO_TO_WORKLOAD[2],
                (PROTO, "$1", "request_protocol", "(.*)"),
            ],
            errors: ISTIO_ERRORS,
            bucket: Some("istio_request_duration_milliseconds_bucket"),
            class: Some("response_code"),
        },
        // Reported by the caller's proxy when the callee has none (no callee report exists): the Service it called.
        Part {
            count: "istio_requests_total",
            matchers: r#"reporter="source",destination_workload="unknown""#,
            namespaces: &["destination_service_namespace", "source_workload_namespace"],
            by: &[
                "source_workload_namespace",
                "source_workload",
                "destination_service_namespace",
                "destination_service_name",
                "request_protocol",
            ],
            steps: &[
                ISTIO_SOURCE[0],
                ISTIO_SOURCE[1],
                ISTIO_TO_SERVICE[0],
                ISTIO_TO_SERVICE[1],
                ISTIO_TO_SERVICE[2],
                (PROTO, "$1", "request_protocol", "(.*)"),
            ],
            errors: ISTIO_ERRORS,
            bucket: Some("istio_request_duration_milliseconds_bucket"),
            class: Some("response_code"),
        },
        // Plain TCP services, the same two ways.
        Part {
            count: "istio_tcp_connections_opened_total",
            matchers: r#"reporter="destination""#,
            namespaces: &[
                "destination_workload_namespace",
                "source_workload_namespace",
            ],
            by: &[
                "source_workload_namespace",
                "source_workload",
                "destination_workload_namespace",
                "destination_workload",
            ],
            steps: &[
                ISTIO_SOURCE[0],
                ISTIO_SOURCE[1],
                ISTIO_TO_WORKLOAD[0],
                ISTIO_TO_WORKLOAD[1],
                ISTIO_TO_WORKLOAD[2],
                (PROTO, "tcp", "", ""),
            ],
            errors: Errors::None,
            bucket: None,
            class: None,
        },
        Part {
            count: "istio_tcp_connections_opened_total",
            matchers: r#"reporter="source",destination_workload="unknown""#,
            namespaces: &["destination_service_namespace", "source_workload_namespace"],
            by: &[
                "source_workload_namespace",
                "source_workload",
                "destination_service_namespace",
                "destination_service_name",
            ],
            steps: &[
                ISTIO_SOURCE[0],
                ISTIO_SOURCE[1],
                ISTIO_TO_SERVICE[0],
                ISTIO_TO_SERVICE[1],
                ISTIO_TO_SERVICE[2],
                (PROTO, "tcp", "", ""),
            ],
            errors: Errors::None,
            bucket: None,
            class: None,
        },
    ],
};

/// The workload labels Linkerd's proxy puts on its own series (one of them is set).
const LINKERD_SOURCE: [Step; 4] = [
    (SRC_NS, "$1", "namespace", "(.*)"),
    (SRC, "$1", "deployment", "(.+)"),
    (SRC, "$1", "statefulset", "(.+)"),
    (SRC, "$1", "daemonset", "(.+)"),
];
/// The callee as the destination controller told the caller's proxy: a workload when it knows one, else the Service.
const LINKERD_DESTINATION: [Step; 9] = [
    (DST_NS, "$1", "dst_namespace", "(.*)"),
    (DST, "$1", "dst_service", "(.+)"),
    (DST_KIND, "service", "dst_service", "(.+)"),
    (DST, "$1", "dst_deployment", "(.+)"),
    (DST_KIND, "workload", "dst_deployment", "(.+)"),
    (DST, "$1", "dst_statefulset", "(.+)"),
    (DST_KIND, "workload", "dst_statefulset", "(.+)"),
    (DST, "$1", "dst_daemonset", "(.+)"),
    (DST_KIND, "workload", "dst_daemonset", "(.+)"),
];
const LINKERD_PROTOCOL: [Step; 2] = [
    (PROTO, "http", "", ""),
    (PROTO, "grpc", "grpc_status", "(.+)"),
];
const LINKERD_OUT_BY: &[&str] = &[
    "namespace",
    "deployment",
    "statefulset",
    "daemonset",
    "dst_namespace",
    "dst_service",
    "dst_deployment",
    "dst_statefulset",
    "dst_daemonset",
];

const LINKERD: EdgeShape = EdgeShape {
    to_ms: 1.0,
    unknown: "",
    parts: &[
        // The caller's proxy, outbound: both ends named.
        Part {
            count: "response_total",
            matchers: r#"direction="outbound""#,
            namespaces: &["namespace", "dst_namespace"],
            by: &[
                "namespace",
                "deployment",
                "statefulset",
                "daemonset",
                "dst_namespace",
                "dst_service",
                "dst_deployment",
                "dst_statefulset",
                "dst_daemonset",
                "grpc_status",
            ],
            steps: &[
                LINKERD_SOURCE[0],
                LINKERD_SOURCE[1],
                LINKERD_SOURCE[2],
                LINKERD_SOURCE[3],
                LINKERD_DESTINATION[0],
                LINKERD_DESTINATION[1],
                LINKERD_DESTINATION[2],
                LINKERD_DESTINATION[3],
                LINKERD_DESTINATION[4],
                LINKERD_DESTINATION[5],
                LINKERD_DESTINATION[6],
                LINKERD_DESTINATION[7],
                LINKERD_DESTINATION[8],
                LINKERD_PROTOCOL[0],
                LINKERD_PROTOCOL[1],
            ],
            errors: Errors::Matchers(&[r#"classification="failure""#]),
            bucket: Some("response_latency_ms_bucket"),
            class: Some("status_code"),
        },
        // The callee's proxy, inbound, from callers without a mesh identity (no outbound report of theirs exists).
        Part {
            count: "response_total",
            matchers: r#"direction="inbound",tls!="true""#,
            namespaces: &["namespace"],
            by: &[
                "namespace",
                "deployment",
                "statefulset",
                "daemonset",
                "grpc_status",
            ],
            steps: &[
                (DST_NS, "$1", "namespace", "(.*)"),
                (DST, "$1", "deployment", "(.+)"),
                (DST, "$1", "statefulset", "(.+)"),
                (DST, "$1", "daemonset", "(.+)"),
                (DST_KIND, "workload", "", ""),
                LINKERD_PROTOCOL[0],
                LINKERD_PROTOCOL[1],
            ],
            errors: Errors::Matchers(&[r#"classification="failure""#]),
            bucket: Some("response_latency_ms_bucket"),
            class: Some("status_code"),
        },
        // Connections the caller's proxy opened (dropped where the same ends have HTTP or gRPC edges).
        Part {
            count: "tcp_open_total",
            matchers: r#"direction="outbound",peer="dst""#,
            namespaces: &["namespace", "dst_namespace"],
            by: LINKERD_OUT_BY,
            steps: &[
                LINKERD_SOURCE[0],
                LINKERD_SOURCE[1],
                LINKERD_SOURCE[2],
                LINKERD_SOURCE[3],
                LINKERD_DESTINATION[0],
                LINKERD_DESTINATION[1],
                LINKERD_DESTINATION[2],
                LINKERD_DESTINATION[3],
                LINKERD_DESTINATION[4],
                LINKERD_DESTINATION[5],
                LINKERD_DESTINATION[6],
                LINKERD_DESTINATION[7],
                LINKERD_DESTINATION[8],
                (PROTO, "tcp", "", ""),
            ],
            errors: Errors::None,
            bucket: None,
            class: None,
        },
    ],
};

const BEYLA: EdgeShape = EdgeShape {
    to_ms: 1000.0,
    unknown: "",
    // The service graph: `client` and `server` are the services (by default the workloads) with their namespaces.
    parts: &[Part {
        count: "traces_service_graph_request_total",
        matchers: "",
        namespaces: &["server_service_namespace", "client_service_namespace"],
        by: &[
            "client_service_namespace",
            "client",
            "server_service_namespace",
            "server",
        ],
        steps: &[
            (SRC_NS, "$1", "client_service_namespace", "(.*)"),
            (SRC, "$1", "client", "(.*)"),
            (DST_NS, "$1", "server_service_namespace", "(.*)"),
            (DST, "$1", "server", "(.*)"),
            (DST_KIND, "workload", "", ""),
        ],
        errors: Errors::Counter("traces_service_graph_request_failed_total"),
        bucket: Some("traces_service_graph_request_server_seconds_bucket"),
        class: None,
    }],
};

const HUBBLE_STEPS: [Step; 6] = [
    (SRC_NS, "$1", "source_namespace", "(.*)"),
    (SRC, "$1", "source_workload", "(.*)"),
    (DST_NS, "$1", "destination_namespace", "(.*)"),
    (DST, "$1", "destination_workload", "(.*)"),
    (DST_KIND, "workload", "", ""),
    (PROTO, "http", "", ""),
];
const HUBBLE_BY: &[&str] = &[
    "source_namespace",
    "source_workload",
    "destination_namespace",
    "destination_workload",
];

const HUBBLE: EdgeShape = EdgeShape {
    to_ms: 1000.0,
    unknown: "",
    parts: &[
        // Seen at the callee (`labelsContext` must name the workloads, as for the Requests section).
        Part {
            count: "hubble_http_requests_total",
            matchers: r#"reporter!="client""#,
            namespaces: &["destination_namespace", "source_namespace"],
            by: HUBBLE_BY,
            steps: &HUBBLE_STEPS,
            errors: Errors::Matchers(&[r#"status=~"5..""#]),
            bucket: Some("hubble_http_request_duration_seconds_bucket"),
            class: Some("status"),
        },
        // Seen only at the caller: calls to no workload (outside the cluster).
        Part {
            count: "hubble_http_requests_total",
            matchers: r#"reporter="client",destination_workload="""#,
            namespaces: &["source_namespace"],
            by: HUBBLE_BY,
            steps: &HUBBLE_STEPS,
            errors: Errors::Matchers(&[r#"status=~"5..""#]),
            bucket: Some("hubble_http_request_duration_seconds_bucket"),
            class: Some("status"),
        },
    ],
};

/// The edge series of a source; `None` for ingress-nginx, which names no caller.
pub(crate) fn edge_shape(kind: RequestSourceKind) -> Option<&'static EdgeShape> {
    match kind {
        RequestSourceKind::Istio => Some(&ISTIO),
        RequestSourceKind::Linkerd => Some(&LINKERD),
        RequestSourceKind::Beyla => Some(&BEYLA),
        RequestSourceKind::Hubble => Some(&HUBBLE),
        RequestSourceKind::IngressNginx => None,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

/// What a part's series are asked for: which metric, an extra matcher, extra labels to keep and steps after the
/// part's own.
struct Ask<'a> {
    metric: &'a str,
    matcher: &'a str,
    by: &'a [&'a str],
    steps: &'a [Step],
}

fn label_replace(expr: &str, target: &str, replacement: &str, source: &str, regex: &str) -> String {
    format!(r#"label_replace({expr}, "{target}", "{replacement}", "{source}", "{regex}")"#)
}

fn relabel(expr: String, steps: &[Step]) -> String {
    steps
        .iter()
        .fold(expr, |acc, (target, replacement, source, regex)| {
            label_replace(&acc, target, replacement, source, regex)
        })
}

/// `namespaces` as the body of a regular expression literal (each name matched literally).
fn namespace_regex(namespaces: &[String]) -> String {
    let alternatives: Vec<String> = namespaces.iter().map(|ns| regex_literal(ns)).collect();
    literal(&alternatives.join("|"))
}

/// The part's series of `ask` in scope (either end in a chosen namespace: one alternative per namespace label, the
/// same series from two of them counted once by `or`), summed by the part's labels, renamed and tagged `sx_part`.
fn part_expr(
    index: usize,
    part: &Part,
    ask: &Ask,
    namespaces: &str,
    window: TrafficWindow,
) -> String {
    let w = window.promql();
    let alternatives: Vec<String> = part
        .namespaces
        .iter()
        .map(|label| {
            let mut matchers: Vec<String> = [part.matchers, ask.matcher]
                .into_iter()
                .filter(|m| !m.is_empty())
                .map(str::to_owned)
                .collect();
            matchers.push(format!(r#"{label}=~"{namespaces}""#));
            format!("rate({}{{{}}}[{w}])", ask.metric, matchers.join(","))
        })
        .collect();
    let by: Vec<&str> = part.by.iter().chain(ask.by).copied().collect();
    let summed = format!("sum by ({}) ({})", by.join(", "), alternatives.join(" or "));
    let renamed = relabel(relabel(summed, part.steps), ask.steps);
    label_replace(&renamed, PART, &index.to_string(), "", "")
}

/// The union of `each` over the parts that give something, or `None`.
fn union(shape: &EdgeShape, mut each: impl FnMut(usize, &Part) -> Vec<String>) -> Option<String> {
    let all: Vec<String> = shape
        .parts
        .iter()
        .enumerate()
        .flat_map(|(i, p)| each(i, p))
        .collect();
    (!all.is_empty()).then(|| all.join(" or "))
}

/// The status class of an HTTP code label: `2xx`…`5xx` (other codes keep no class).
fn class_steps(label: &'static str) -> [Step; 1] {
    [(CLASS, "${1}xx", label, "([1-5])..")]
}

fn tagged(expr: &str, tag: &str) -> String {
    label_replace(expr, "m", tag, "", "")
}

/// The instant queries of a source's edges about `namespaces` (validated), each value tagged by `m`: first `rate`
/// (the [`MAX_TRAFFIC_EDGES`] busiest edges with requests in the window) with `count` (how many there are); then, for
/// those edges only, `errors`, `class` (per `sx_c`) and with `latency` `p50` and `p95` (in the histogram's unit), one
/// query each so that no query repeats the edge expression more than twice (a few KiB of URL). Empty for a source
/// without edges.
pub(crate) fn edge_queries(
    kind: RequestSourceKind,
    namespaces: &[String],
    window: TrafficWindow,
    latency: bool,
) -> Vec<String> {
    let Some(shape) = edge_shape(kind) else {
        return Vec::new();
    };
    let ns = namespace_regex(namespaces);
    let plain = |metric: &'static str| Ask {
        metric,
        matcher: "",
        by: &[],
        steps: &[],
    };
    let Some(requests) = union(shape, |i, p| {
        vec![part_expr(i, p, &plain(p.count), &ns, window)]
    }) else {
        return Vec::new();
    };
    let rate = format!("(sum by ({EDGE}) ({requests}) > 0)");
    let top = format!("topk({MAX_TRAFFIC_EDGES}, {rate})");
    let only_top = |expr: String, tag: &str| tagged(&format!("({expr}) and on({EDGE}) {top}"), tag);
    let mut queries = vec![format!(
        "{} or {}",
        tagged(&top, "rate"),
        tagged(&format!("count({rate})"), "count")
    )];

    // Each error alternative is tagged too, so equal label sets of two alternatives are added, not merged by `or`.
    let errors = union(shape, |i, p| match p.errors {
        Errors::None => Vec::new(),
        Errors::Matchers(list) => list
            .iter()
            .enumerate()
            .map(|(alt, m)| {
                let ask = Ask {
                    metric: p.count,
                    matcher: m,
                    by: &[],
                    steps: &[],
                };
                label_replace(
                    &part_expr(i, p, &ask, &ns, window),
                    ALT,
                    &alt.to_string(),
                    "",
                    "",
                )
            })
            .collect(),
        Errors::Counter(metric) => vec![part_expr(i, p, &plain(metric), &ns, window)],
    });
    if let Some(errors) = errors {
        queries.push(only_top(format!("sum by ({EDGE}) ({errors})"), "errors"));
    }
    let classes = union(shape, |i, p| match p.class {
        None => Vec::new(),
        Some(label) => {
            let steps = class_steps(label);
            let ask = Ask {
                metric: p.count,
                matcher: "",
                by: &[label],
                steps: &steps,
            };
            vec![part_expr(i, p, &ask, &ns, window)]
        }
    });
    if let Some(classes) = classes {
        queries.push(only_top(
            format!("sum by ({EDGE}, {CLASS}) ({classes})"),
            "class",
        ));
    }
    let buckets = union(shape, |i, p| match p.bucket {
        Some(metric) if latency => {
            let ask = Ask {
                metric,
                matcher: "",
                by: &["le"],
                steps: &[],
            };
            vec![part_expr(i, p, &ask, &ns, window)]
        }
        _ => Vec::new(),
    });
    if let Some(buckets) = buckets {
        for (tag, q) in [("p50", "0.5"), ("p95", "0.95")] {
            let quantile = format!("histogram_quantile({q}, sum by (le, {EDGE}) ({buckets}))");
            queries.push(only_top(quantile, tag));
        }
    }
    queries
}

// ---------------------------------------------------------------------------------------------------------------
// Answers

/// The renamed labels of an edge: caller namespace and name, callee namespace, name and kind, protocol.
type EdgeKey = [String; 6];

#[derive(Default)]
struct Values {
    rate: Option<f64>,
    errors: Option<f64>,
    p50: Option<f64>,
    p95: Option<f64>,
    classes: BTreeMap<String, f64>,
}

fn peer(shape: &EdgeShape, namespace: &str, name: &str, kind: &str) -> TrafficPeer {
    let known = |v: &str| !v.is_empty() && v != shape.unknown;
    let namespace = known(namespace).then(|| namespace.to_owned());
    if !known(name) {
        return TrafficPeer {
            kind: TrafficPeerKind::Unknown,
            namespace,
            name: None,
        };
    }
    TrafficPeer {
        kind: if kind == "service" {
            TrafficPeerKind::Service
        } else {
            TrafficPeerKind::Workload
        },
        namespace,
        name: Some(name.to_owned()),
    }
}

fn protocol(value: &str) -> TrafficProtocol {
    match value {
        "http" => TrafficProtocol::Http,
        "grpc" => TrafficProtocol::Grpc,
        "tcp" => TrafficProtocol::Tcp,
        _ => TrafficProtocol::Unknown,
    }
}

/// The edges of one source's answers (at most [`MAX_TRAFFIC_SERIES`] series of each are read): busiest first, a TCP
/// edge dropped where the same ends have an HTTP or gRPC edge (the same traffic seen as connections).
pub(crate) fn assemble(source: DetectedSource, answers: &[Value]) -> SourceEdges {
    let Some(shape) = edge_shape(source.kind) else {
        return SourceEdges::default();
    };
    let mut values: BTreeMap<EdgeKey, Values> = BTreeMap::new();
    let mut total = 0usize;
    for result in answers
        .iter()
        .flat_map(|data| results(data).take(MAX_TRAFFIC_SERIES))
    {
        let Some(value) = result.get("value").and_then(|v| v.get(1)).and_then(number) else {
            continue;
        };
        let mut labels = labels(result);
        let Some(tag) = labels.remove("m") else {
            continue;
        };
        if tag == "count" {
            total = value.max(0.0) as usize;
            continue;
        }
        let mut take = |name: &str| labels.remove(name).unwrap_or_default();
        let key: EdgeKey = [
            take(SRC_NS),
            take(SRC),
            take(DST_NS),
            take(DST),
            take(DST_KIND),
            take(PROTO),
        ];
        let class = take(CLASS);
        // Only the edges of the `rate` answer are kept; the others come for those edges only anyway.
        let entry = match (tag.as_str(), values.get_mut(&key)) {
            ("rate", _) => values.entry(key).or_default(),
            (_, Some(entry)) => entry,
            (_, None) => continue,
        };
        match tag.as_str() {
            "rate" => entry.rate = Some(value.max(0.0)),
            "errors" => entry.errors = Some(value.max(0.0)),
            "p50" if value >= 0.0 => entry.p50 = Some(value * shape.to_ms),
            "p95" if value >= 0.0 => entry.p95 = Some(value * shape.to_ms),
            "class" if !class.is_empty() => {
                *entry.classes.entry(class).or_default() += value.max(0.0);
            }
            _ => {}
        }
    }
    let mut edges: Vec<TrafficEdge> = values
        .into_iter()
        .filter_map(|([sn, s, dn, d, dk, p], v)| {
            let rate = v.rate?;
            let protocol = protocol(&p);
            Some(TrafficEdge {
                source: source.kind,
                via: source.via,
                from: peer(shape, &sn, &s, "workload"),
                to: peer(shape, &dn, &d, &dk),
                protocol,
                rate,
                error_ratio: (protocol != TrafficProtocol::Tcp && rate > 0.0)
                    .then(|| (v.errors.unwrap_or(0.0) / rate).clamp(0.0, 1.0)),
                p50_ms: v.p50,
                p95_ms: v.p95,
                status_classes: v
                    .classes
                    .into_iter()
                    .map(|(class, rate)| StatusClassRate { class, rate })
                    .collect(),
            })
        })
        .collect();
    let requests: BTreeSet<(TrafficPeer, TrafficPeer)> = edges
        .iter()
        .filter(|e| e.protocol != TrafficProtocol::Tcp)
        .map(|e| (e.from.clone(), e.to.clone()))
        .collect();
    let before = edges.len();
    edges.retain(|e| {
        e.protocol != TrafficProtocol::Tcp || !requests.contains(&(e.from.clone(), e.to.clone()))
    });
    let dropped = before - edges.len();
    edges.sort_by(|a, b| b.rate.total_cmp(&a.rate));
    let total = total.saturating_sub(dropped).max(edges.len());
    SourceEdges { edges, total }
}

impl Prometheus {
    /// Instant query at `time`, the answer read up to [`MAX_TRAFFIC_BODY`].
    async fn query_limited(&self, promql: &str, time: i64) -> CoreResult<Value> {
        self.get_limited(
            &format!(
                "api/v1/query?query={}&time={time}&timeout={SERVER_TIMEOUT}",
                encode(promql)
            ),
            MAX_TRAFFIC_BODY,
        )
        .await
    }
}

/// The edges of `source` about `namespaces` (validated) over `window`, evaluated at `now`: the busiest edges first,
/// then — when there are any — their errors, classes and latency, those queries at once.
pub(crate) async fn traffic_edges(
    prometheus: &Prometheus,
    source: DetectedSource,
    namespaces: &[String],
    window: TrafficWindow,
    now: i64,
) -> CoreResult<SourceEdges> {
    let queries = edge_queries(source.kind, namespaces, window, source.latency);
    let Some((first, rest)) = queries.split_first() else {
        return Ok(SourceEdges::default());
    };
    let mut answers = vec![prometheus.query_limited(first, now).await?];
    if results(&answers[0]).next().is_some() {
        let more =
            futures::future::try_join_all(rest.iter().map(|q| prometheus.query_limited(q, now)));
        answers.extend(more.await?);
    }
    Ok(assemble(source, &answers))
}

#[cfg(test)]
mod tests;
