use serde_json::Value;

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};
use crate::metrics::PrometheusTarget;
use crate::metrics::requests::{SOURCES_TEST_LOCK, forget_sources};

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

/// The answer of `metrics/traffic/testdata/<file>.json` to `promql` (an empty vector for a query it has none of).
fn answer(file: &str, promql: &str) -> String {
    let path = format!(
        "{}/src/metrics/traffic/testdata/{file}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let all: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let data = all["queries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["promql"] == promql)
        .map_or_else(
            || serde_json::json!({ "resultType": "vector", "result": [] }),
            |q| q["data"].clone(),
        );
    serde_json::json!({ "status": "success", "data": data }).to_string()
}

/// The `query` parameter of a query string.
fn promql_of(query: &str) -> String {
    query
        .split('&')
        .find_map(|p| p.strip_prefix("query="))
        .map(decode)
        .unwrap_or_default()
}

fn ns(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn one_to_five_distinct_namespace_names_pass() {
    validate_namespaces(&ns(&["shop", "pay"])).unwrap();
    validate_namespaces(&ns(&["a", "b", "c", "d", "e"])).unwrap();
    let bad: [&[&str]; 5] = [
        &[],
        &["a", "b", "c", "d", "e", "f"],
        &["shop|pay"],
        &["shop\"} or vector(1) #"],
        &["shop", "shop"],
    ];
    for list in bad {
        assert_eq!(
            validate_namespaces(&ns(list)).unwrap_err().code,
            ErrorCode::Invalid,
            "{list:?}"
        );
    }
}

#[test]
fn the_window_names_only_two_ranges() {
    assert_eq!(TrafficWindow::Minutes5.promql(), "5m");
    assert_eq!(TrafficWindow::Hour1.promql(), "1h");
    let parsed: TrafficWindow = serde_json::from_str(r#""hour1""#).unwrap();
    assert_eq!(parsed, TrafficWindow::Hour1);
    assert!(serde_json::from_str::<TrafficWindow>(r#""2h""#).is_err());
}

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
const PROXY: &str = "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy";

fn manual() -> PrometheusMode {
    PrometheusMode::Manual {
        target: PrometheusTarget::Service {
            namespace: "monitoring".into(),
            service: "prometheus".into(),
            port: 9090,
            path_prefix: String::new(),
        },
    }
}

/// A cluster whose Prometheus has Istio, Linkerd, Hubble (whose queries a proxy refuses) and ingress-nginx metrics.
async fn cluster() -> FakeApi {
    FakeApi::start(|req: &Request| {
        let path = req.path.as_str();
        let Some(rest) = path.strip_prefix(PROXY) else {
            return match path {
                "/api" => Reply::json(200, API_VERSIONS),
                _ => Reply::not_found(),
            };
        };
        let promql = promql_of(&req.query);
        match rest {
            "/api/v1/label/__name__/values" => Reply::json(
                200,
                r#"{"status":"success","data":["istio_requests_total","istio_request_duration_milliseconds_bucket","response_total","response_latency_ms_bucket","hubble_http_requests_total","nginx_ingress_controller_requests"]}"#,
            ),
            // A proxy in front of Prometheus refuses Hubble's URL as too long.
            "/api/v1/query" if promql.contains("hubble_") => {
                Reply::json(414, "<html><body>414 Request-URI Too Large</body></html>")
            }
            "/api/v1/query" => {
                let file = if promql.contains("istio_") { "istio" } else { "linkerd" };
                Reply::json(200, answer(file, &promql))
            }
            _ => Reply::not_found(),
        }
    })
    .await
}

#[tokio::test]
async fn edges_of_every_source_merged_busiest_first() {
    let _serial = SOURCES_TEST_LOCK.lock().await;
    forget_sources();
    let api = cluster().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let graph = traffic_graph(
        &mgr,
        &id,
        &manual(),
        ns(&["shop", "pay"]),
        TrafficWindow::Minutes5,
    )
    .await
    .unwrap();
    assert!(graph.prometheus);
    assert_eq!(graph.namespaces, ns(&["shop", "pay"]));
    let kinds: Vec<RequestSourceKind> = graph.sources.iter().map(|s| s.kind).collect();
    assert_eq!(
        kinds,
        [
            RequestSourceKind::Istio,
            RequestSourceKind::Linkerd,
            RequestSourceKind::Hubble
        ]
    );
    assert_eq!(graph.request_only, [RequestSourceKind::IngressNginx]);
    // Hubble's query failed: its edges are unknown, not absent, and the reason is told.
    assert_eq!(graph.failed, [RequestSourceKind::Hubble]);
    assert_eq!(graph.query_too_long, [RequestSourceKind::Hubble]);
    assert_eq!(graph.edges.len(), 9);
    assert_eq!(graph.total_edges, 9);
    assert!(graph.edges.windows(2).all(|w| w[0].rate >= w[1].rate));
    assert!(
        graph
            .edges
            .iter()
            .any(|e| e.source == RequestSourceKind::Linkerd)
    );
    // Every query asked the chosen namespaces, through the cluster's Prometheus, with the server-side timeout.
    let queries: Vec<String> = api
        .requests()
        .iter()
        .filter(|r| r.path == format!("{PROXY}/api/v1/query"))
        .map(|r| decode(&r.query))
        .collect();
    // Istio: 4 parts' edges, 2 parts with HTTP edges × 4 details; Linkerd: 3 parts' edges, 2 × 4 details; Hubble 1.
    assert_eq!(queries.len(), 12 + 11 + 1);
    for q in &queries {
        assert!(
            q.contains(r#"=~"shop|pay""#) && q.contains("timeout=18s"),
            "{q}"
        );
    }
}

#[tokio::test]
async fn bad_names_and_prometheus_off_ask_nothing() {
    let _serial = SOURCES_TEST_LOCK.lock().await;
    forget_sources();
    let api = cluster().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let before = api.requests().len();
    let refused = traffic_graph(
        &mgr,
        &id,
        &manual(),
        ns(&["shop|pay"]),
        TrafficWindow::Hour1,
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Invalid);
    assert_eq!(api.requests().len(), before);
    let off = traffic_graph(
        &mgr,
        &id,
        &PrometheusMode::Off,
        ns(&["shop"]),
        TrafficWindow::Hour1,
    )
    .await
    .unwrap();
    assert!(!off.prometheus && off.sources.is_empty() && off.edges.is_empty());
    assert_eq!(api.requests().len(), before);
}

/// A cluster whose Prometheus has Istio's metrics and Caretta's (#236).
async fn cluster_with_caretta() -> FakeApi {
    FakeApi::start(|req: &Request| {
        let path = req.path.as_str();
        let Some(rest) = path.strip_prefix(PROXY) else {
            return match path {
                "/api" => Reply::json(200, API_VERSIONS),
                _ => Reply::not_found(),
            };
        };
        let promql = promql_of(&req.query);
        match rest {
            "/api/v1/label/__name__/values" => Reply::json(
                200,
                r#"{"status":"success","data":["istio_requests_total","istio_request_duration_milliseconds_bucket","caretta_links_observed","caretta_tcp_states"]}"#,
            ),
            "/api/v1/query" => {
                let file = if promql.contains("caretta_") { "caretta" } else { "istio" };
                Reply::json(200, answer(file, &promql))
            }
            _ => Reply::not_found(),
        }
    })
    .await
}

#[tokio::test]
async fn caretta_is_an_edge_source_whose_bytes_never_crowd_out_requests() {
    let _serial = SOURCES_TEST_LOCK.lock().await;
    forget_sources();
    let api = cluster_with_caretta().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let graph = traffic_graph(
        &mgr,
        &id,
        &manual(),
        ns(&["shop", "pay"]),
        TrafficWindow::Minutes5,
    )
    .await
    .unwrap();
    let kinds: Vec<RequestSourceKind> = graph.sources.iter().map(|s| s.kind).collect();
    assert_eq!(
        kinds,
        [RequestSourceKind::Istio, RequestSourceKind::Caretta]
    );
    // Not a source of request metrics, and not "request only" either.
    assert!(graph.request_only.is_empty());
    assert!(graph.failed.is_empty());
    assert_eq!(graph.edges.len(), 5 + 6);
    // Taken in turns: Istio's busiest (1 request/s) first, then Caretta's busiest (32 000 bytes/s), …
    let order: Vec<(RequestSourceKind, TrafficProtocol)> = graph
        .edges
        .iter()
        .take(4)
        .map(|e| (e.source, e.protocol))
        .collect();
    assert_eq!(order[0].0, RequestSourceKind::Istio);
    assert_eq!(
        order[1],
        (RequestSourceKind::Caretta, TrafficProtocol::TcpBytes)
    );
    assert_eq!(order[2].0, RequestSourceKind::Istio);
    assert_eq!(
        order[3],
        (RequestSourceKind::Caretta, TrafficProtocol::TcpBytes)
    );
    // Caretta was asked its one edge query only: no errors, classes or latency to ask.
    let caretta_queries = api
        .requests()
        .iter()
        .filter(|r| promql_of(&r.query).contains("caretta_"))
        .count();
    assert_eq!(caretta_queries, 1);
}

fn edge(source: RequestSourceKind, protocol: TrafficProtocol, rate: f64) -> TrafficEdge {
    let peer = TrafficPeer {
        kind: TrafficPeerKind::Workload,
        namespace: Some("shop".into()),
        name: Some(format!("{rate}")),
    };
    TrafficEdge {
        source,
        via: RequestVia::Cluster,
        from: peer.clone(),
        to: peer,
        protocol,
        rate,
        error_ratio: None,
        p50_ms: None,
        p95_ms: None,
        status_classes: Vec::new(),
        missing: Vec::new(),
    }
}

#[test]
fn bytes_and_calls_are_ranked_apart_and_taken_in_turns() {
    use RequestSourceKind::{Caretta, Istio};
    use TrafficProtocol::{Http, Tcp, TcpBytes};
    let edges = vec![
        edge(Caretta, TcpBytes, 9000.0),
        edge(Istio, Http, 1.0),
        edge(Caretta, TcpBytes, 50.0),
        edge(Istio, Tcp, 3.0),
        edge(Caretta, TcpBytes, 700.0),
    ];
    let rates: Vec<f64> = busiest_first(edges).iter().map(|e| e.rate).collect();
    assert_eq!(rates, [3.0, 9000.0, 1.0, 700.0, 50.0]);
}
