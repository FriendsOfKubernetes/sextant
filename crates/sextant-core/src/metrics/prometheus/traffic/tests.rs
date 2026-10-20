use std::collections::BTreeSet;

use serde_json::json;

use super::*;
use crate::metrics::prometheus::edge_sources_in;
use crate::metrics::requests::RequestVia;

fn ns(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

/// The metric names a query reads (identifiers right before `{`).
fn metric_names(promql: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (i, _) in promql.match_indices('{') {
        let head = &promql[..i];
        let start = head
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == ':'))
            .map_or(0, |p| p + 1);
        if start < i {
            out.insert(head[start..].to_owned());
        }
    }
    out
}

/// A source's answers from `metrics/traffic/testdata/<file>.json` (real Prometheus answers to the queries, evaluated
/// by promtool over synthetic series of the source).
pub(crate) fn fixture_answers(file: &str) -> Vec<Value> {
    let path = format!(
        "{}/src/metrics/traffic/testdata/{file}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let all: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    all["answers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["data"].clone())
        .collect()
}

fn detected(kind: RequestSourceKind) -> DetectedSource {
    DetectedSource {
        kind,
        via: RequestVia::Cluster,
        latency: true,
    }
}

fn peer_of(namespace: Option<&str>, name: Option<&str>, kind: TrafficPeerKind) -> TrafficPeer {
    TrafficPeer {
        kind,
        namespace: namespace.map(str::to_owned),
        name: name.map(str::to_owned),
    }
}

fn workload(namespace: &str, name: &str) -> TrafficPeer {
    peer_of(Some(namespace), Some(name), TrafficPeerKind::Workload)
}

#[test]
fn each_source_reads_only_its_own_edge_metrics() {
    for kind in RequestSourceKind::ALL {
        let queries = edge_queries(kind, &ns(&["shop"]), TrafficWindow::Minutes5, true);
        let Some(shape) = edge_shape(kind) else {
            assert!(queries.is_empty(), "{kind:?}");
            continue;
        };
        let mut allowed = BTreeSet::new();
        for part in shape.parts {
            allowed.insert(part.count.to_owned());
            allowed.extend(part.bucket.map(str::to_owned));
            if let Errors::Counter(c) = part.errors {
                allowed.insert(c.to_owned());
            }
        }
        let read: BTreeSet<String> = queries.iter().flat_map(|q| metric_names(q)).collect();
        assert_eq!(read, allowed, "{kind:?}");
        // What makes a source an edge source is among the names detection asks about.
        let known = RequestSourceKind::known_metrics();
        for group in kind.edge_metrics() {
            assert!(group.iter().all(|n| known.contains(n)), "{kind:?}");
        }
    }
}

#[test]
fn ingress_nginx_names_no_caller_and_has_no_edges() {
    assert!(edge_shape(RequestSourceKind::IngressNginx).is_none());
    assert!(RequestSourceKind::IngressNginx.edge_metrics().is_empty());
    let names: BTreeSet<String> = ["nginx_ingress_controller_requests".to_owned()].into();
    assert!(edge_sources_in(&names, RequestVia::Cluster).is_empty());
}

#[test]
fn queries_are_bounded_scoped_and_escaped() {
    for kind in [
        RequestSourceKind::Istio,
        RequestSourceKind::Linkerd,
        RequestSourceKind::Beyla,
        RequestSourceKind::Hubble,
    ] {
        let queries = edge_queries(kind, &ns(&["shop", "a.b"]), TrafficWindow::Hour1, true);
        let (first, rest) = queries.split_first().unwrap();
        assert!(
            first.contains(&format!("topk({MAX_TRAFFIC_EDGES}, ")),
            "{kind:?}"
        );
        assert!(first.contains(r#""m", "count""#));
        for q in rest {
            assert!(
                q.contains(&format!("and on({EDGE}) topk({MAX_TRAFFIC_EDGES}, ")),
                "{q}"
            );
        }
        for q in &queries {
            // The chosen namespaces only, matched literally, over the chosen window.
            assert!(q.contains(r#"=~"shop|a\\.b""#), "{q}");
            assert!(q.contains("[1h]") && !q.contains("[5m]"), "{q}");
        }
        let latency = edge_queries(kind, &ns(&["shop"]), TrafficWindow::Minutes5, false);
        assert!(latency.iter().all(|q| !q.contains("histogram_quantile")));
    }
}

#[test]
fn even_five_longest_namespace_names_keep_each_query_small() {
    let longest: Vec<String> = (0..crate::metrics::traffic::MAX_TRAFFIC_NAMESPACES)
        .map(|i| format!("{i}{}", "n".repeat(62)))
        .collect();
    for kind in RequestSourceKind::ALL {
        for q in edge_queries(kind, &longest, TrafficWindow::Minutes5, true) {
            assert!(
                encode(&q).len() <= 16 * 1024,
                "{kind:?}: {}",
                encode(&q).len()
            );
        }
    }
}

#[test]
fn istio_edges_name_both_ends_or_say_unknown() {
    let edges = assemble(
        detected(RequestSourceKind::Istio),
        &fixture_answers("istio"),
    );
    assert_eq!(edges.total, 5);
    assert_eq!(edges.edges.len(), 5);
    let find = |to: &str| {
        edges
            .edges
            .iter()
            .find(|e| e.to.name.as_deref() == Some(to) && e.from.name.is_some())
            .unwrap()
    };
    let web = find("web");
    assert_eq!(web.from, workload("shop", "frontend"));
    assert_eq!(web.to, workload("shop", "web"));
    assert_eq!(web.protocol, TrafficProtocol::Http);
    assert_eq!(web.rate, 1.0);
    assert_eq!(web.error_ratio, Some(0.1));
    assert_eq!((web.p50_ms, web.p95_ms), (Some(10.0), Some(50.0)));
    let classes: Vec<(&str, f64)> = web
        .status_classes
        .iter()
        .map(|c| (c.class.as_str(), c.rate))
        .collect();
    assert_eq!(classes, [("2xx", 0.9), ("5xx", 0.1)]);
    // gRPC: a non-OK status on HTTP 200 is an error.
    let db = find("db");
    assert_eq!(db.protocol, TrafficProtocol::Grpc);
    assert_eq!(db.error_ratio, Some(0.5));
    // A callee without a proxy is the Service (here a host) the caller named; Istio's `unknown` is no namespace.
    let host = find("api.example.com");
    assert_eq!(
        host.to,
        peer_of(None, Some("api.example.com"), TrafficPeerKind::Service)
    );
    let redis = find("redis");
    assert_eq!(redis.protocol, TrafficProtocol::Tcp);
    assert_eq!((redis.error_ratio, redis.p50_ms), (None, None));
    // A caller without a proxy is an unknown peer, not dropped.
    let unknown = edges
        .edges
        .iter()
        .find(|e| e.from.kind == TrafficPeerKind::Unknown)
        .unwrap();
    assert_eq!(unknown.from, peer_of(None, None, TrafficPeerKind::Unknown));
    assert_eq!(unknown.to, workload("shop", "web"));
    // Busiest first.
    assert!(edges.edges.windows(2).all(|w| w[0].rate >= w[1].rate));
}

#[test]
fn linkerd_tcp_beside_http_is_the_same_traffic_and_is_dropped() {
    let edges = assemble(
        detected(RequestSourceKind::Linkerd),
        &fixture_answers("linkerd"),
    );
    let tcp: Vec<&TrafficEdge> = edges
        .edges
        .iter()
        .filter(|e| e.protocol == TrafficProtocol::Tcp)
        .collect();
    assert_eq!(tcp.len(), 1);
    assert_eq!(tcp[0].to, workload("cache", "redis"));
    // 5 in Prometheus, one TCP edge dropped.
    assert_eq!((edges.edges.len(), edges.total), (4, 4));
    // A caller without a mesh identity, seen by the callee.
    let inbound = edges
        .edges
        .iter()
        .find(|e| e.from.kind == TrafficPeerKind::Unknown)
        .unwrap();
    assert_eq!(inbound.from, peer_of(None, None, TrafficPeerKind::Unknown));
    assert_eq!(inbound.to, workload("shop", "web"));
    assert_eq!(inbound.error_ratio, Some(0.0));
    // The destination controller named only the Service.
    let db = edges
        .edges
        .iter()
        .find(|e| e.to.name.as_deref() == Some("db"))
        .unwrap();
    assert_eq!(
        db.to,
        peer_of(Some("pay"), Some("db"), TrafficPeerKind::Service)
    );
    assert_eq!(
        (db.protocol, db.error_ratio),
        (TrafficProtocol::Grpc, Some(1.0))
    );
}

#[test]
fn hubble_and_beyla_edges() {
    let hubble = assemble(
        detected(RequestSourceKind::Hubble),
        &fixture_answers("hubble"),
    );
    assert_eq!(hubble.edges.len(), 2);
    let outside = &hubble.edges[1];
    assert_eq!(outside.from, workload("shop", "web"));
    assert_eq!(outside.to, peer_of(None, None, TrafficPeerKind::Unknown));
    assert_eq!(hubble.edges[0].p95_ms, Some(50.0));
    let beyla = assemble(
        detected(RequestSourceKind::Beyla),
        &fixture_answers("beyla"),
    );
    assert_eq!(beyla.edges.len(), 1);
    let edge = &beyla.edges[0];
    assert_eq!(edge.protocol, TrafficProtocol::Unknown);
    assert_eq!(edge.error_ratio, Some(0.1));
    assert!(edge.status_classes.is_empty());
    assert_eq!((edge.p50_ms, edge.p95_ms), (Some(10.0), Some(50.0)));
}

#[test]
fn only_so_many_series_are_read_and_values_of_other_edges_are_ignored() {
    let series: Vec<Value> = (0..MAX_TRAFFIC_SERIES + 50)
        .map(|i| {
            json!({ "metric": { "m": "rate", "sx_sn": "shop", "sx_s": format!("w{i}"), "sx_dn": "shop",
                                "sx_d": "web", "sx_dk": "workload", "sx_p": "http" },
                    "value": [1, "1"] })
        })
        .collect();
    let stray =
        json!({ "result": [{ "metric": { "m": "errors", "sx_s": "nobody" }, "value": [1, "5"] }] });
    let answers = [json!({ "result": series }), stray];
    let edges = assemble(detected(RequestSourceKind::Hubble), &answers);
    assert_eq!(edges.edges.len(), MAX_TRAFFIC_SERIES);
    assert!(edges.edges.iter().all(|e| e.error_ratio == Some(0.0)));
}

#[tokio::test]
async fn an_answer_over_the_size_cap_is_an_error_not_a_cut() {
    use crate::fake_api::{FakeApi, Reply, Request};
    use crate::metrics::PrometheusTarget;
    let big = format!(
        r#"{{"status":"success","data":{{"resultType":"vector","result":[],"pad":"{}"}}}}"#,
        "x".repeat(MAX_TRAFFIC_BODY)
    );
    let api = FakeApi::start(move |_: &Request| Reply::json(200, big.clone())).await;
    let client =
        kube::Client::try_from(kube::Config::new("http://127.0.0.1:1".parse().unwrap())).unwrap();
    let prometheus = Prometheus::new(
        &client,
        &PrometheusTarget::Url {
            url: api.url().to_owned(),
        },
    )
    .unwrap();
    let err = traffic_edges(
        &prometheus,
        detected(RequestSourceKind::Hubble),
        &ns(&["shop"]),
        TrafficWindow::Minutes5,
        1_760_000_000,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, crate::error::ErrorCode::Invalid);
    assert!(err.message.contains("larger than 8 MiB"), "{}", err.message);
}
