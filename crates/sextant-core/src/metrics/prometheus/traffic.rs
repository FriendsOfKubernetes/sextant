//! PromQL of the traffic graph (#211); see `metrics::traffic` for the contract and ADR-0096 for what each source's
//! labels mean. Every query is built here from fixed tables and validated namespace names (escaped anyway); nothing the
//! caller writes becomes PromQL, a metric name or a label matcher.
//!
//! A source is made of parts: families of series that name both ends of a call in their own labels. Each part is asked
//! on its own, so that no URL repeats much (a proxy in front of Prometheus refuses long URLs, 8 KiB is common):
//! first its busiest edges (`topk`, the only query that may fail the source), and only when there are any, one query
//! per detail — errors, status classes, p50, p95 — each best-effort. A detail query covers every edge of the part
//! when the part has fewer than [`MAX_TRAFFIC_EDGES`] edges (filtered to non-zero values, so it returns no more than
//! the edges); only a capped part restricts it to its busiest edges (`and on(...) topk(...)`), which repeats the edge
//! expression once. The answers keep the source's own labels; which label names which end is in the tables below and
//! read back by [`assemble`].

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::{Prometheus, labels, literal, number, regex_literal, results};
use crate::error::CoreResult;
use crate::metrics::requests::{DetectedSource, RequestSourceKind};
use crate::metrics::traffic::{
    MAX_TRAFFIC_BODY, MAX_TRAFFIC_EDGES, MAX_TRAFFIC_SERIES, SourceEdges, StatusClassRate,
    TrafficDetail, TrafficEdge, TrafficPeer, TrafficPeerKind, TrafficProtocol, TrafficWindow,
};

/// Set by `label_replace` where the protocol is told by another label's presence (Linkerd's `grpc_status`).
const PROTO: &str = "sx_p";
/// The status class (`2xx`…`5xx`) of the HTTP code label.
const CLASS: &str = "sx_c";
/// Tells the caller's series from the callee's where both are kept before summing.
const SIDE: &str = "sx_side";

/// One end of a call in a part's labels.
pub(crate) struct End {
    /// The label with the end's namespace; empty when the part does not tell.
    pub namespace: &'static str,
    /// A label whose value tells what the end is (Caretta's `client_kind`/`server_kind`, see [`kind_of`]); empty: the
    /// `names` table says.
    pub kind: &'static str,
    /// Labels naming the end, with what they name; the first one set wins.
    pub names: &'static [(&'static str, TrafficPeerKind)],
}

/// Nobody the part can name (a caller without a mesh identity).
const NOBODY: End = End {
    namespace: "",
    kind: "",
    names: &[],
};

pub(crate) enum Protocol {
    Fixed(TrafficProtocol),
    /// A label whose value is `http` or `grpc`.
    Label(&'static str),
    /// gRPC where this label is set, else HTTP.
    GrpcWhen(&'static str),
}

/// What a failed request is in a part.
pub(crate) enum Errors {
    /// TCP: no verdict.
    None,
    /// A matcher of the failed requests.
    Matcher(&'static str),
    /// A matcher of the successful requests (one selector, where the failed ones would need two): errors = requests −
    /// those.
    Ok(&'static str),
    /// The failed requests are the `5xx` class: read from the classes, no query of its own.
    Class5xx,
    /// The share of failed spans: a counter of failed spans of both sides over the spans of both sides (Beyla, whose
    /// failed counter has no side).
    Share { failed: &'static str },
}

/// One side's series of a part.
pub(crate) struct Side {
    /// The request (or connection) counter.
    pub count: &'static str,
    /// Fixed matchers of the side's series (may be empty).
    pub matchers: &'static str,
    /// The latency histogram's buckets.
    pub bucket: Option<&'static str>,
}

/// One family of series of a source that names both ends of a call.
pub(crate) struct Part {
    /// The series every call is counted from: the callee's report where the source has two.
    pub series: Side,
    /// The caller's report, counted only for the pairs of ends `series` has no series of (`or on(<the pair>)`, which
    /// is `caller unless on(<the pair>) callee` added to the callee's).
    pub caller: Option<Side>,
    /// Labels holding a namespace of an end: an edge is in scope when one of them names a chosen namespace.
    pub namespaces: &'static [&'static str],
    /// The source's labels that make an edge (the series are summed by them).
    pub by: &'static [&'static str],
    pub from: End,
    pub to: End,
    pub protocol: Protocol,
    pub errors: Errors,
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

use TrafficPeerKind::{Service, Workload};

const ISTIO_FROM: End = End {
    namespace: "source_workload_namespace",
    kind: "",
    names: &[("source_workload", Workload)],
};
const ISTIO_TO_WORKLOAD: End = End {
    namespace: "destination_workload_namespace",
    kind: "",
    names: &[("destination_workload", Workload)],
};
const ISTIO_TO_SERVICE: End = End {
    namespace: "destination_service_namespace",
    kind: "",
    names: &[("destination_service_name", Service)],
};
/// Not 5xx and no gRPC error: the complement of ADR-0095's Istio errors in one selector.
const ISTIO_OK: &str = r#"response_code!~"5..",grpc_response_status=~"|0""#;
const ISTIO_REQUESTS_BUCKET: Option<&str> = Some("istio_request_duration_milliseconds_bucket");

const ISTIO: EdgeShape = EdgeShape {
    to_ms: 1.0,
    unknown: "unknown",
    parts: &[
        // Reported by the callee's proxy: counted once, with the caller as the callee saw it (`unknown` without a proxy).
        Part {
            series: Side {
                count: "istio_requests_total",
                matchers: r#"reporter="destination""#,
                bucket: ISTIO_REQUESTS_BUCKET,
            },
            caller: None,
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
            from: ISTIO_FROM,
            to: ISTIO_TO_WORKLOAD,
            protocol: Protocol::Label("request_protocol"),
            errors: Errors::Ok(ISTIO_OK),
            class: Some("response_code"),
        },
        // Reported by the caller's proxy when the callee has none (no callee report exists): the Service it called.
        Part {
            series: Side {
                count: "istio_requests_total",
                matchers: r#"reporter="source",destination_workload="unknown""#,
                bucket: ISTIO_REQUESTS_BUCKET,
            },
            caller: None,
            namespaces: &["destination_service_namespace", "source_workload_namespace"],
            by: &[
                "source_workload_namespace",
                "source_workload",
                "destination_service_namespace",
                "destination_service_name",
                "request_protocol",
            ],
            from: ISTIO_FROM,
            to: ISTIO_TO_SERVICE,
            protocol: Protocol::Label("request_protocol"),
            errors: Errors::Ok(ISTIO_OK),
            class: Some("response_code"),
        },
        // Plain TCP services, the same two ways.
        Part {
            series: Side {
                count: "istio_tcp_connections_opened_total",
                matchers: r#"reporter="destination""#,
                bucket: None,
            },
            caller: None,
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
            from: ISTIO_FROM,
            to: ISTIO_TO_WORKLOAD,
            protocol: Protocol::Fixed(TrafficProtocol::Tcp),
            errors: Errors::None,
            class: None,
        },
        Part {
            series: Side {
                count: "istio_tcp_connections_opened_total",
                matchers: r#"reporter="source",destination_workload="unknown""#,
                bucket: None,
            },
            caller: None,
            namespaces: &["destination_service_namespace", "source_workload_namespace"],
            by: &[
                "source_workload_namespace",
                "source_workload",
                "destination_service_namespace",
                "destination_service_name",
            ],
            from: ISTIO_FROM,
            to: ISTIO_TO_SERVICE,
            protocol: Protocol::Fixed(TrafficProtocol::Tcp),
            errors: Errors::None,
            class: None,
        },
    ],
};

/// The workload labels Linkerd's proxy puts on its own series (one of them is set).
const LINKERD_FROM: End = End {
    namespace: "namespace",
    kind: "",
    names: &[
        ("deployment", Workload),
        ("statefulset", Workload),
        ("daemonset", Workload),
    ],
};
/// The callee as the destination controller told the caller's proxy: a workload when it knows one, else the Service.
const LINKERD_TO: End = End {
    namespace: "dst_namespace",
    kind: "",
    names: &[
        ("dst_deployment", Workload),
        ("dst_statefulset", Workload),
        ("dst_daemonset", Workload),
        ("dst_service", Service),
    ],
};
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
const LINKERD_FAILED: Errors = Errors::Matcher(r#"classification="failure""#);

const LINKERD: EdgeShape = EdgeShape {
    to_ms: 1.0,
    unknown: "",
    parts: &[
        // The caller's proxy, outbound: both ends named.
        Part {
            series: Side {
                count: "response_total",
                matchers: r#"direction="outbound""#,
                bucket: Some("response_latency_ms_bucket"),
            },
            caller: None,
            namespaces: &["namespace", "dst_namespace"],
            by: LINKERD_OUT_BY,
            from: LINKERD_FROM,
            to: LINKERD_TO,
            protocol: Protocol::GrpcWhen("grpc_status"),
            errors: LINKERD_FAILED,
            class: Some("status_code"),
        },
        // The callee's proxy, inbound, from callers without a mesh identity (no outbound report of theirs exists).
        Part {
            series: Side {
                count: "response_total",
                matchers: r#"direction="inbound",tls!="true""#,
                bucket: Some("response_latency_ms_bucket"),
            },
            caller: None,
            namespaces: &["namespace"],
            by: &["namespace", "deployment", "statefulset", "daemonset"],
            from: NOBODY,
            to: LINKERD_FROM,
            protocol: Protocol::GrpcWhen("grpc_status"),
            errors: LINKERD_FAILED,
            class: Some("status_code"),
        },
        // Connections the caller's proxy opened (dropped where the same ends have HTTP or gRPC edges).
        Part {
            series: Side {
                count: "tcp_open_total",
                matchers: r#"direction="outbound",peer="dst""#,
                bucket: None,
            },
            caller: None,
            namespaces: &["namespace", "dst_namespace"],
            by: LINKERD_OUT_BY,
            from: LINKERD_FROM,
            to: LINKERD_TO,
            protocol: Protocol::Fixed(TrafficProtocol::Tcp),
            errors: Errors::None,
            class: None,
        },
    ],
};

/// Beyla's service graph (`application_service_graph`): `client` and `server` are the services (by default the
/// workloads) with their namespaces. `traces_service_graph_request_total` is not read: Beyla up to 2.x adds every
/// client and every server span to it (a call between two instrumented services counts twice), and OBI, which Beyla
/// builds on now, adds a client span only when the server is not instrumented — so the server histogram's count, plus
/// the client's only for pairs without a server report, is the same number of calls under both (ADR-0096).
const BEYLA: EdgeShape = EdgeShape {
    to_ms: 1000.0,
    unknown: "",
    parts: &[Part {
        series: Side {
            count: "traces_service_graph_request_server_seconds_count",
            matchers: "",
            bucket: Some("traces_service_graph_request_server_seconds_bucket"),
        },
        caller: Some(Side {
            count: "traces_service_graph_request_client_seconds_count",
            matchers: "",
            bucket: Some("traces_service_graph_request_client_seconds_bucket"),
        }),
        namespaces: &["server_service_namespace", "client_service_namespace"],
        by: &[
            "client_service_namespace",
            "client",
            "server_service_namespace",
            "server",
        ],
        from: End {
            namespace: "client_service_namespace",
            kind: "",
            names: &[("client", Workload)],
        },
        to: End {
            namespace: "server_service_namespace",
            kind: "",
            names: &[("server", Workload)],
        },
        protocol: Protocol::Fixed(TrafficProtocol::Unknown),
        errors: Errors::Share {
            failed: "traces_service_graph_request_failed_total",
        },
        class: None,
    }],
};

/// Hubble's HTTP metrics (`labelsContext` must name the workloads, as for the Requests section). A call between two
/// pods is seen at the callee with ingress L7 visibility (`reporter="server"`) and at the caller with egress
/// visibility (`reporter="client"`), so the callee's report counts and the caller's only where the callee has none —
/// egress-only visibility and callees outside the cluster.
const HUBBLE: EdgeShape = EdgeShape {
    to_ms: 1000.0,
    unknown: "",
    parts: &[Part {
        series: Side {
            count: "hubble_http_requests_total",
            matchers: r#"reporter!="client""#,
            bucket: Some("hubble_http_request_duration_seconds_bucket"),
        },
        caller: Some(Side {
            count: "hubble_http_requests_total",
            matchers: r#"reporter="client""#,
            bucket: Some("hubble_http_request_duration_seconds_bucket"),
        }),
        namespaces: &["destination_namespace", "source_namespace"],
        by: &[
            "source_namespace",
            "source_workload",
            "destination_namespace",
            "destination_workload",
        ],
        from: End {
            namespace: "source_namespace",
            kind: "",
            names: &[("source_workload", Workload)],
        },
        to: End {
            namespace: "destination_namespace",
            kind: "",
            names: &[("destination_workload", Workload)],
        },
        protocol: Protocol::Fixed(TrafficProtocol::Http),
        errors: Errors::Class5xx,
        class: Some("status"),
    }],
};

/// Caretta (groundcover, #236): `caretta_links_observed` is a gauge of the bytes sent on the TCP links Caretta's eBPF
/// probes saw since it started (`pkg/caretta/caretta.go`: labels `link_id`, `client_id`, `client_name`,
/// `client_namespace`, `client_kind`, `client_owner`, `server_id`, `server_name`, `server_namespace`, `server_kind`,
/// `server_port`, `role`; `role` 1 is the client's socket — the bytes it sent — and 2 the server's, the bytes it
/// answered). Its rate summed over roles and ports is the link's throughput both ways, as Caretta's own dashboard sums
/// it. TCP only: no requests, errors, status or latency.
const CARETTA: EdgeShape = EdgeShape {
    to_ms: 1.0,
    unknown: "",
    parts: &[Part {
        series: Side {
            count: "caretta_links_observed",
            matchers: "",
            bucket: None,
        },
        caller: None,
        namespaces: &["client_namespace", "server_namespace"],
        by: &[
            "client_namespace",
            "client_name",
            "client_kind",
            "server_namespace",
            "server_name",
            "server_kind",
        ],
        from: End {
            namespace: "client_namespace",
            kind: "client_kind",
            names: &[("client_name", Workload)],
        },
        to: End {
            namespace: "server_namespace",
            kind: "server_kind",
            names: &[("server_name", Workload)],
        },
        protocol: Protocol::Fixed(TrafficProtocol::TcpBytes),
        errors: Errors::None,
        class: None,
    }],
};

/// What Caretta's kind label says an end is (`pkg/k8s/ipresolver.go`): the top owner of a pod (Deployment,
/// StatefulSet, DaemonSet, Job, CronJob…) or a bare `pod` is a workload, `Service` a Service; `node` (a node's
/// address, with the namespace `node`) and `external` (an address outside the cluster, the namespace `external`) are
/// no object of a namespace: unknown, without a namespace.
fn kind_of(value: &str) -> Option<TrafficPeerKind> {
    match value {
        "Service" => Some(Service),
        "node" | "external" | "" => None,
        _ => Some(Workload),
    }
}

/// The edge series of a source; `None` for ingress-nginx, which names no caller.
pub(crate) fn edge_shape(kind: RequestSourceKind) -> Option<&'static EdgeShape> {
    match kind {
        RequestSourceKind::Istio => Some(&ISTIO),
        RequestSourceKind::Linkerd => Some(&LINKERD),
        RequestSourceKind::Beyla => Some(&BEYLA),
        RequestSourceKind::Hubble => Some(&HUBBLE),
        RequestSourceKind::Caretta => Some(&CARETTA),
        RequestSourceKind::IngressNginx => None,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

/// What one query of a part asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ask {
    /// The busiest edges with requests in the window.
    Rate,
    /// How many edges have requests (asked only when the busiest fill the cap).
    Count,
    Errors,
    /// Successful requests ([`Errors::Ok`]).
    Ok,
    /// Share of failed spans ([`Errors::Share`]).
    Share,
    Classes,
    P50,
    P95,
}

impl Ask {
    /// The detail an answer of this query gives; `None` for the edges themselves.
    fn detail(self) -> Option<TrafficDetail> {
        match self {
            Ask::Rate | Ask::Count => None,
            Ask::Errors | Ask::Ok | Ask::Share => Some(TrafficDetail::Errors),
            Ask::Classes => Some(TrafficDetail::Classes),
            Ask::P50 | Ask::P95 => Some(TrafficDetail::Latency),
        }
    }
}

fn label_replace(expr: &str, target: &str, replacement: &str, source: &str, regex: &str) -> String {
    format!(r#"label_replace({expr},"{target}","{replacement}","{source}","{regex}")"#)
}

/// `namespaces` as the body of a regular expression literal (each name matched literally).
fn namespace_regex(namespaces: &[String]) -> String {
    let alternatives: Vec<String> = namespaces.iter().map(|ns| regex_literal(ns)).collect();
    literal(&alternatives.join("|"))
}

/// The labels an edge of the part is told apart by.
fn edge_labels(part: &Part) -> String {
    let mut by = part.by.join(",");
    if matches!(part.protocol, Protocol::GrpcWhen(_)) {
        by.push(',');
        by.push_str(PROTO);
    }
    by
}

/// The rate of `metric` with `matchers` in scope: one selector per namespace label, joined by
/// `or` (the same series from two of them counted once).
fn scoped(part: &Part, metric: &str, matchers: &[&str], ns: &str, window: TrafficWindow) -> String {
    let w = window.promql();
    part.namespaces
        .iter()
        .map(|label| {
            let scope = format!(r#"{label}=~"{ns}""#);
            let all: Vec<&str> = matchers
                .iter()
                .copied()
                .filter(|m| !m.is_empty())
                .chain([scope.as_str()])
                .collect();
            format!("rate({metric}{{{}}}[{w}])", all.join(","))
        })
        .collect::<Vec<_>>()
        .join(" or ")
}

/// A side's series of `metric` (with `extra` matchers) summed by the edge labels and `by_extra`; with `class`, by
/// status class as well.
#[allow(clippy::too_many_arguments)]
fn side_sum(
    part: &Part,
    side: &Side,
    metric: &str,
    extra: &str,
    by_extra: &str,
    class: bool,
    ns: &str,
    window: TrafficWindow,
) -> String {
    let mut inner = scoped(part, metric, &[side.matchers, extra], ns, window);
    if let Protocol::GrpcWhen(label) = part.protocol {
        inner = label_replace(&inner, PROTO, "grpc", label, ".+");
    }
    if let (true, Some(label)) = (class, part.class) {
        inner = label_replace(&inner, CLASS, "${1}xx", label, "([1-5])..");
    }
    let by = match by_extra {
        "" => edge_labels(part),
        more => format!("{more},{}", edge_labels(part)),
    };
    format!("sum by({by})({inner})")
}

/// `each` of the callee's series, and of the caller's for the pairs the callee has none of.
fn sides(part: &Part, each: impl Fn(&Side) -> Option<String>) -> Option<String> {
    let callee = each(&part.series)?;
    Some(match part.caller.as_ref().and_then(each) {
        Some(caller) => format!("{callee} or on({}) {caller}", edge_labels(part)),
        None => callee,
    })
}

/// Requests (or connections) per second of every edge of the part in scope.
fn rate_expr(part: &Part, ns: &str, window: TrafficWindow) -> String {
    sides(part, |s| {
        Some(side_sum(part, s, s.count, "", "", false, ns, window))
    })
    .unwrap_or_default()
}

/// The part's [`MAX_TRAFFIC_EDGES`] busiest edges with requests in the window.
fn top(part: &Part, ns: &str, window: TrafficWindow) -> String {
    format!(
        "topk({MAX_TRAFFIC_EDGES},({})>0)",
        rate_expr(part, ns, window)
    )
}

/// The queries of a part's details: errors, classes and latency, as the part has them.
fn detail_asks(part: &Part, latency: bool) -> Vec<Ask> {
    let mut asks = match part.errors {
        Errors::None | Errors::Class5xx => Vec::new(),
        Errors::Matcher(_) => vec![Ask::Errors],
        Errors::Ok(_) => vec![Ask::Ok],
        Errors::Share { .. } => vec![Ask::Share],
    };
    if part.class.is_some() {
        asks.push(Ask::Classes);
    }
    if latency && part.series.bucket.is_some() {
        asks.extend([Ask::P50, Ask::P95]);
    }
    asks
}

/// The query of `ask` about the part; `capped`: the part has more edges than the busiest ones, so a detail is asked
/// only for those.
fn part_query(part: &Part, ask: Ask, ns: &str, window: TrafficWindow, capped: bool) -> String {
    let count = |extra: &str, class: bool| {
        sides(part, |s| {
            let by = if class { CLASS } else { "" };
            Some(side_sum(part, s, s.count, extra, by, class, ns, window))
        })
        .unwrap_or_default()
    };
    let quantile = |q: &str| {
        let buckets = sides(part, |s| {
            s.bucket
                .map(|b| side_sum(part, s, b, "", "le", false, ns, window))
        })
        .unwrap_or_default();
        format!("histogram_quantile({q},{buckets})")
    };
    let (expr, keep) = match ask {
        Ask::Rate => return top(part, ns, window),
        Ask::Count => return format!("count(({})>0)", rate_expr(part, ns, window)),
        Ask::Errors | Ask::Ok => {
            let matcher = match part.errors {
                Errors::Matcher(m) | Errors::Ok(m) => m,
                _ => "",
            };
            (count(matcher, false), ">0")
        }
        Ask::Share => {
            let Errors::Share { failed } = part.errors else {
                return String::new();
            };
            // Both sides' spans; the caller's tagged, so that `or` keeps them beside the callee's of the same pair.
            let mut spans = scoped(part, part.series.count, &[part.series.matchers], ns, window);
            if let Some(caller) = &part.caller {
                let theirs = scoped(part, caller.count, &[caller.matchers], ns, window);
                spans = format!(
                    "{spans} or {}",
                    label_replace(&theirs, SIDE, "caller", "", "")
                );
            }
            let by = edge_labels(part);
            (
                format!(
                    "sum by({by})({})/sum by({by})({spans})",
                    scoped(part, failed, &[], ns, window),
                ),
                ">0",
            )
        }
        Ask::Classes => (count("", true), ">0"),
        Ask::P50 => (quantile("0.5"), ">=0"),
        Ask::P95 => (quantile("0.95"), ">=0"),
    };
    let filtered = format!("({expr}){keep}");
    if capped {
        format!(
            "{filtered} and on({}) {}",
            edge_labels(part),
            top(part, ns, window)
        )
    } else {
        filtered
    }
}

/// Every instant query the traffic graph may send for `kind` about `namespaces` (validated): per part its busiest
/// edges, their count, and each detail both for every edge and for the busiest only. Empty for a source without
/// edges. For review, tests and the kind-cluster check.
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
    let mut out = Vec::new();
    for part in shape.parts {
        out.push(part_query(part, Ask::Rate, &ns, window, false));
        out.push(part_query(part, Ask::Count, &ns, window, false));
        for ask in detail_asks(part, latency) {
            out.push(part_query(part, ask, &ns, window, false));
            out.push(part_query(part, ask, &ns, window, true));
        }
    }
    out
}

/// The queries of every part of `kind` as `(part, ask, promql)` (fixtures and tests): rate, then the details for every
/// edge.
#[cfg(test)]
pub(crate) fn part_queries(
    kind: RequestSourceKind,
    namespaces: &[String],
    window: TrafficWindow,
    latency: bool,
) -> Vec<(usize, Ask, String)> {
    let Some(shape) = edge_shape(kind) else {
        return Vec::new();
    };
    let ns = namespace_regex(namespaces);
    let mut out = Vec::new();
    for (index, part) in shape.parts.iter().enumerate() {
        out.push((
            index,
            Ask::Rate,
            part_query(part, Ask::Rate, &ns, window, false),
        ));
        for ask in detail_asks(part, latency) {
            out.push((index, ask, part_query(part, ask, &ns, window, false)));
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// Answers

/// What a part's queries answered: the busiest edges, their count when asked, and each detail (`None`: the query
/// failed).
#[derive(Debug, Clone, Default)]
pub(crate) struct PartAnswers {
    pub rate: Value,
    pub count: Option<Value>,
    pub details: Vec<(Ask, Option<Value>)>,
}

type EdgeKey = (TrafficPeer, TrafficPeer, TrafficProtocol);

#[derive(Default)]
struct Values {
    rate: f64,
    errors: Option<f64>,
    ok: Option<f64>,
    share: Option<f64>,
    p50: Option<f64>,
    p95: Option<f64>,
    classes: BTreeMap<String, f64>,
    missing: BTreeSet<TrafficDetail>,
}

fn peer(shape: &EdgeShape, end: &End, labels: &BTreeMap<String, String>) -> TrafficPeer {
    let known = |v: &&String| !v.is_empty() && v.as_str() != shape.unknown;
    if !end.kind.is_empty() {
        let name = end
            .names
            .first()
            .and_then(|(label, _)| labels.get(*label))
            .filter(known);
        return match (
            kind_of(labels.get(end.kind).map_or("", String::as_str)),
            name,
        ) {
            (Some(kind), Some(name)) => TrafficPeer {
                kind,
                namespace: labels.get(end.namespace).filter(known).cloned(),
                name: Some(name.clone()),
            },
            _ => TrafficPeer {
                kind: TrafficPeerKind::Unknown,
                namespace: None,
                name: None,
            },
        };
    }
    let namespace = labels.get(end.namespace).filter(known).cloned();
    let named = end
        .names
        .iter()
        .find_map(|(label, kind)| labels.get(*label).filter(known).map(|n| (n, *kind)));
    match named {
        Some((name, kind)) => TrafficPeer {
            kind,
            namespace,
            name: Some(name.clone()),
        },
        None => TrafficPeer {
            kind: TrafficPeerKind::Unknown,
            namespace,
            name: None,
        },
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

fn edge_key(shape: &EdgeShape, part: &Part, labels: &BTreeMap<String, String>) -> EdgeKey {
    let protocol = match part.protocol {
        Protocol::Fixed(p) => p,
        Protocol::Label(label) => protocol(labels.get(label).map_or("", String::as_str)),
        Protocol::GrpcWhen(_) => match labels.get(PROTO).map(String::as_str) {
            Some("grpc") => TrafficProtocol::Grpc,
            _ => TrafficProtocol::Http,
        },
    };
    (
        peer(shape, &part.from, labels),
        peer(shape, &part.to, labels),
        protocol,
    )
}

/// `(labels, value)` of at most [`MAX_TRAFFIC_SERIES`] series of an answer.
fn samples(data: &Value) -> impl Iterator<Item = (BTreeMap<String, String>, f64)> {
    results(data).take(MAX_TRAFFIC_SERIES).filter_map(|r| {
        let value = r.get("value").and_then(|v| v.get(1)).and_then(number)?;
        Some((labels(r), value))
    })
}

/// The edges of one part's answers, with how many edges the part has.
fn part_edges(
    shape: &EdgeShape,
    part: &Part,
    answers: &PartAnswers,
) -> (BTreeMap<EdgeKey, Values>, usize) {
    let mut values: BTreeMap<EdgeKey, Values> = BTreeMap::new();
    for (labels, value) in samples(&answers.rate) {
        values
            .entry(edge_key(shape, part, &labels))
            .or_default()
            .rate += value.max(0.0);
    }
    let total = answers
        .count
        .as_ref()
        .and_then(|data| samples(data).next())
        .map_or(values.len(), |(_, n)| n.max(0.0) as usize);
    for (ask, answer) in &answers.details {
        let Some(data) = answer else {
            let detail = ask.detail();
            for v in values.values_mut() {
                v.missing.extend(detail);
                if *ask == Ask::Classes && matches!(part.errors, Errors::Class5xx) {
                    v.missing.insert(TrafficDetail::Errors);
                }
            }
            continue;
        };
        for (labels, value) in samples(data) {
            // Only the edges of the rate answer are kept; the details come for those (or fewer) anyway.
            let Some(v) = values.get_mut(&edge_key(shape, part, &labels)) else {
                continue;
            };
            let add = |slot: &mut Option<f64>| *slot = Some(slot.unwrap_or(0.0) + value.max(0.0));
            match ask {
                Ask::Errors => add(&mut v.errors),
                Ask::Ok => add(&mut v.ok),
                Ask::Share => v.share = Some(value.clamp(0.0, 1.0)),
                Ask::P50 if value >= 0.0 => v.p50 = Some(value * shape.to_ms),
                Ask::P95 if value >= 0.0 => v.p95 = Some(value * shape.to_ms),
                Ask::Classes => {
                    if let Some(class) = labels.get(CLASS).filter(|c| !c.is_empty()) {
                        *v.classes.entry(class.clone()).or_default() += value.max(0.0);
                    }
                }
                _ => {}
            }
        }
    }
    // Failed requests per second, by the part's rule; `None` when the query that tells failed.
    for ((_, _, protocol), v) in values.iter_mut() {
        let missing = v.missing.contains(&TrafficDetail::Errors);
        v.errors = match (&part.errors, missing) {
            _ if is_tcp(*protocol) => None,
            (Errors::None, _) | (_, true) => None,
            (Errors::Matcher(_), false) => Some(v.errors.unwrap_or(0.0)),
            (Errors::Ok(_), false) => Some((v.rate - v.ok.unwrap_or(0.0)).max(0.0)),
            (Errors::Share { .. }, false) => Some(v.share.unwrap_or(0.0) * v.rate),
            (Errors::Class5xx, false) => Some(v.classes.get("5xx").copied().unwrap_or(0.0)),
        };
    }
    (values, total)
}

/// Traffic seen as connections (their count or their bytes), never as requests.
fn is_tcp(protocol: TrafficProtocol) -> bool {
    matches!(protocol, TrafficProtocol::Tcp | TrafficProtocol::TcpBytes)
}

/// The edges of one source's answers (one entry per part, in the shape's order): busiest first, a TCP edge dropped
/// where the same ends have an HTTP or gRPC edge (the same traffic seen as connections).
pub(crate) fn assemble(source: DetectedSource, answers: &[PartAnswers]) -> SourceEdges {
    let Some(shape) = edge_shape(source.kind) else {
        return SourceEdges::default();
    };
    let mut merged: BTreeMap<EdgeKey, Values> = BTreeMap::new();
    let mut total = 0usize;
    for (part, answers) in shape.parts.iter().zip(answers) {
        let (values, part_total) = part_edges(shape, part, answers);
        total += part_total;
        for (key, v) in values {
            // Parts pick other series, so an edge comes from one part; should two give one, they add up.
            let Some(m) = merged.get_mut(&key) else {
                merged.insert(key, v);
                continue;
            };
            if v.rate > m.rate {
                (m.p50, m.p95) = (v.p50, v.p95);
            }
            m.rate += v.rate;
            m.errors = m.errors.zip(v.errors).map(|(a, b)| a + b);
            for (class, rate) in v.classes {
                *m.classes.entry(class).or_default() += rate;
            }
            m.missing.extend(v.missing);
        }
    }
    let mut edges: Vec<TrafficEdge> = merged
        .into_iter()
        .map(|((from, to, protocol), v)| TrafficEdge {
            source: source.kind,
            via: source.via,
            from,
            to,
            protocol,
            rate: v.rate,
            error_ratio: v
                .errors
                .filter(|_| v.rate > 0.0)
                .map(|e| (e / v.rate).clamp(0.0, 1.0)),
            p50_ms: v.p50,
            p95_ms: v.p95,
            status_classes: v
                .classes
                .into_iter()
                .map(|(class, rate)| StatusClassRate { class, rate })
                .collect(),
            missing: v.missing.into_iter().collect(),
        })
        .collect();
    let requests: BTreeSet<(TrafficPeer, TrafficPeer)> = edges
        .iter()
        .filter(|e| !is_tcp(e.protocol))
        .map(|e| (e.from.clone(), e.to.clone()))
        .collect();
    let before = edges.len();
    edges.retain(|e| !is_tcp(e.protocol) || !requests.contains(&(e.from.clone(), e.to.clone())));
    let dropped = before - edges.len();
    let edges = crate::metrics::traffic::busiest_first(edges);
    let total = total.saturating_sub(dropped).max(edges.len());
    SourceEdges { edges, total }
}

/// The edges of `source` about `namespaces` (validated) over `window`, evaluated at `now`. Fails only when a part's
/// edge query fails; the count and the details are best-effort (a failed one leaves its fields unknown and is named
/// in each edge's `missing`).
pub(crate) async fn traffic_edges(
    prometheus: &Prometheus,
    source: DetectedSource,
    namespaces: &[String],
    window: TrafficWindow,
    now: i64,
) -> CoreResult<SourceEdges> {
    let Some(shape) = edge_shape(source.kind) else {
        return Ok(SourceEdges::default());
    };
    let ns = namespace_regex(namespaces);
    let ask = |query: String| async move {
        prometheus
            .query_limited(&query, now, MAX_TRAFFIC_BODY)
            .await
    };
    let rates = futures::future::try_join_all(
        shape
            .parts
            .iter()
            .map(|part| ask(part_query(part, Ask::Rate, &ns, window, false))),
    )
    .await?;
    let answers = futures::future::join_all(shape.parts.iter().zip(rates).map(|(part, rate)| {
        let ns = &ns;
        async move {
            let edges = results(&rate).count();
            if edges == 0 {
                return PartAnswers {
                    rate,
                    ..PartAnswers::default()
                };
            }
            let capped = edges >= MAX_TRAFFIC_EDGES;
            let count = async {
                match capped {
                    true => ask(part_query(part, Ask::Count, ns, window, false))
                        .await
                        .ok(),
                    false => None,
                }
            };
            let details =
                futures::future::join_all(detail_asks(part, source.latency).into_iter().map(
                    |a| async move { (a, ask(part_query(part, a, ns, window, capped)).await.ok()) },
                ));
            let (count, details) = tokio::join!(count, details);
            PartAnswers {
                rate,
                count,
                details,
            }
        }
    }))
    .await;
    Ok(assemble(source, &answers))
}

#[cfg(test)]
mod tests;
