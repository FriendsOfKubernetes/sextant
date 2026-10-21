use std::collections::BTreeSet;

use serde_json::json;

use super::super::encode;
use super::*;
use crate::fake_api::{FakeApi, Reply, Request};
use crate::metrics::PrometheusTarget;
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

fn ask_named(name: &str) -> Ask {
    match name {
        "Rate" => Ask::Rate,
        "Count" => Ask::Count,
        "Errors" => Ask::Errors,
        "Ok" => Ask::Ok,
        "Share" => Ask::Share,
        "Classes" => Ask::Classes,
        "P50" => Ask::P50,
        "P95" => Ask::P95,
        other => panic!("{other}"),
    }
}

/// `metrics/traffic/testdata/<file>.json`: what a real Prometheus answered to each query of a source.
pub(crate) fn fixture(file: &str) -> Value {
    let path = format!(
        "{}/src/metrics/traffic/testdata/{file}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A fixture's answers per part.
fn fixture_answers(kind: RequestSourceKind, file: &str) -> Vec<PartAnswers> {
    let parts = edge_shape(kind).unwrap().parts.len();
    let mut out = vec![PartAnswers::default(); parts];
    for q in fixture(file)["queries"].as_array().unwrap() {
        let part = q["part"].as_u64().unwrap() as usize;
        let ask = ask_named(q["ask"].as_str().unwrap());
        let data = q["data"].clone();
        match ask {
            Ask::Rate => out[part].rate = data,
            _ => out[part].details.push((ask, Some(data))),
        }
    }
    out
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

/// Rounded to six places (Prometheus' rates of the synthetic counters are 0.9999999999999999 and the like).
fn r6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

fn r6o(v: Option<f64>) -> Option<f64> {
    v.map(r6)
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
            for side in [Some(&part.series), part.caller.as_ref()]
                .into_iter()
                .flatten()
            {
                allowed.insert(side.count.to_owned());
                allowed.extend(side.bucket.map(str::to_owned));
            }
            if let Errors::Share { failed } = part.errors {
                allowed.insert(failed.to_owned());
            }
            // A matcher of failed requests would pick the caller's errors where the callee merely has none.
            if part.caller.is_some() {
                assert!(
                    !matches!(part.errors, Errors::Matcher(_) | Errors::Ok(_)),
                    "{kind:?}"
                );
            }
        }
        let read: BTreeSet<String> = queries.iter().flat_map(|q| metric_names(q)).collect();
        assert_eq!(read, allowed, "{kind:?}");
        // What makes a source an edge source is among the names detection asks about, and so is what it reads.
        let known = RequestSourceKind::known_metrics();
        for group in kind.edge_metrics() {
            assert!(group.iter().all(|n| known.contains(n)), "{kind:?}");
        }
        for name in &read {
            let bucket_or_count = name.ends_with("_bucket") || name.ends_with("_count");
            assert!(
                known.contains(&name.as_str()) || !bucket_or_count,
                "{kind:?}: {name}"
            );
        }
    }
}

#[test]
fn beyla_never_reads_the_total_that_counts_a_call_twice() {
    let queries = edge_queries(
        RequestSourceKind::Beyla,
        &ns(&["shop"]),
        TrafficWindow::Minutes5,
        true,
    );
    assert!(
        queries
            .iter()
            .all(|q| !q.contains("traces_service_graph_request_total"))
    );
    let rate = &queries[0];
    assert!(
        rate.contains("traces_service_graph_request_server_seconds_count")
            && rate.contains(
                " or on(client_service_namespace,client,server_service_namespace,server) sum by("
            )
            && rate.contains("traces_service_graph_request_client_seconds_count"),
        "{rate}"
    );
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
        RequestSourceKind::Caretta,
    ] {
        let shape = edge_shape(kind).unwrap();
        let ns_regex = namespace_regex(&ns(&["shop", "a.b"]));
        for part in shape.parts {
            let rate = part_query(part, Ask::Rate, &ns_regex, TrafficWindow::Hour1, false);
            assert!(
                rate.starts_with(&format!("topk({MAX_TRAFFIC_EDGES},(")),
                "{rate}"
            );
            for ask in detail_asks(part, true) {
                let every = part_query(part, ask, &ns_regex, TrafficWindow::Hour1, false);
                assert!(!every.contains("topk("), "{every}");
                let busiest = part_query(part, ask, &ns_regex, TrafficWindow::Hour1, true);
                assert!(
                    busiest.ends_with(&format!(" and on({}) {rate}", edge_labels(part))),
                    "{busiest}"
                );
            }
        }
        for q in edge_queries(kind, &ns(&["shop", "a.b"]), TrafficWindow::Hour1, true) {
            // The chosen namespaces only, matched literally, over the chosen window.
            assert!(q.contains(r#"=~"shop|a\\.b""#), "{q}");
            assert!(q.contains("[1h]") && !q.contains("[5m]"), "{q}");
        }
        let no_latency = edge_queries(kind, &ns(&["shop"]), TrafficWindow::Minutes5, false);
        assert!(no_latency.iter().all(|q| !q.contains("histogram_quantile")));
    }
}

/// The longest query of any source with five 63-character namespaces, percent-encoded as it goes into the URL. Two
/// reviews measured the first version at 7–15 KiB (a proxy with nginx's 8 KiB buffer answers 414).
const MAX_ENCODED_QUERY: usize = 5 * 1024;

#[test]
fn even_five_longest_namespace_names_keep_each_url_under_6_kib() {
    let longest: Vec<String> = (0..crate::metrics::traffic::MAX_TRAFFIC_NAMESPACES)
        .map(|i| format!("{i}{}", "n".repeat(62)))
        .collect();
    let mut max = 0;
    for kind in RequestSourceKind::ALL {
        for window in [TrafficWindow::Minutes5, TrafficWindow::Hour1] {
            for q in edge_queries(kind, &longest, window, true) {
                max = max.max(encode(&q).len());
            }
        }
    }
    eprintln!("the longest encoded query: {max} bytes");
    assert!(max <= MAX_ENCODED_QUERY, "{max}");
    // With a service proxy path of the longest names and the other parameters, the whole URL stays under 6 KiB.
    let base = format!(
        "/api/v1/namespaces/{0}/services/{0}:65535/proxy/api/v1/query?query=",
        "n".repeat(63)
    );
    let rest = "&time=1760000000&timeout=18s";
    assert!(base.len() + max + rest.len() < 6 * 1024);
}

#[test]
fn the_fixtures_answer_the_queries_sent_now() {
    for (kind, files) in [
        (RequestSourceKind::Istio, &["istio"][..]),
        (RequestSourceKind::Linkerd, &["linkerd"][..]),
        (RequestSourceKind::Beyla, &["beyla"][..]),
        (
            RequestSourceKind::Hubble,
            &["hubble-both", "hubble-egress", "hubble-ingress"][..],
        ),
        (RequestSourceKind::Caretta, &["caretta"][..]),
    ] {
        let now: Vec<(u64, String, String)> =
            part_queries(kind, &ns(&["shop", "pay"]), TrafficWindow::Minutes5, true)
                .into_iter()
                .map(|(part, ask, q)| (part as u64, format!("{ask:?}"), q))
                .collect();
        for file in files {
            let asked: Vec<(u64, String, String)> = fixture(file)["queries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|q| {
                    (
                        q["part"].as_u64().unwrap(),
                        q["ask"].as_str().unwrap().to_owned(),
                        q["promql"].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            assert_eq!(
                asked, now,
                "{file}: regenerate it (see write_fixture_queries)"
            );
        }
    }
}

#[test]
fn caretta_links_are_bytes_per_second_between_workloads_both_ways() {
    let edges = assemble(
        detected(RequestSourceKind::Caretta),
        &fixture_answers(RequestSourceKind::Caretta, "caretta"),
    );
    // Seven pairs in scope (the `other` namespace's link is not).
    assert_eq!(edges.total, 7);
    assert!(
        edges
            .edges
            .iter()
            .all(|e| e.protocol == TrafficProtocol::TcpBytes
                && e.error_ratio.is_none()
                && e.p50_ms.is_none()
                && e.status_classes.is_empty()
                && e.missing.is_empty())
    );
    let between = |from: &TrafficPeer, to: &TrafficPeer| {
        edges
            .edges
            .iter()
            .find(|e| &e.from == from && &e.to == to)
            .unwrap_or_else(|| panic!("{from:?} -> {to:?}"))
    };
    // The client's bytes (role 1) and the server's answer (role 2), from two nodes' Caretta, add up.
    let web = between(&workload("shop", "frontend"), &workload("shop", "web"));
    assert_eq!(r6(web.rate), 32000.0);
    // Ports of one pair are one edge.
    assert_eq!(
        r6(between(&workload("shop", "web"), &workload("pay", "db")).rate),
        2100.0
    );
    // A ClusterIP Caretta resolved is the Service.
    let cache = peer_of(Some("shop"), Some("cache"), TrafficPeerKind::Service);
    assert_eq!(r6(between(&workload("shop", "web"), &cache).rate), 400.0);
    // An address outside the cluster and a node's address are no object of a namespace: unknown ends.
    let unknown = peer_of(None, None, TrafficPeerKind::Unknown);
    assert_eq!(r6(between(&workload("shop", "web"), &unknown).rate), 300.0);
    assert_eq!(r6(between(&unknown, &workload("shop", "web")).rate), 50.0);
    // A pod without an owner keeps its own name.
    assert_eq!(
        r6(between(&workload("pay", "migrate-x7k2p"), &workload("pay", "db")).rate),
        20.0
    );
    assert!(edges.edges.windows(2).all(|w| w[0].rate >= w[1].rate));
    // The one query: no details to ask.
    let parts = part_queries(
        RequestSourceKind::Caretta,
        &ns(&["shop"]),
        TrafficWindow::Minutes5,
        true,
    );
    assert_eq!(parts.len(), 1);
    assert!(
        parts[0]
            .2
            .contains("rate(caretta_links_observed{client_namespace=~\"shop\"}[5m])")
    );
}

/// Through kube-proxy the client's socket (role 1) is connected to the ClusterIP and the server's (role 2) to the pod:
/// Caretta names the Service on one side and the workload on the other, so one connection is two one-way edges. They
/// are kept apart (ADR-0096): the Service edge carries the client's bytes only, the workload edge the answers only.
#[test]
fn caretta_through_a_cluster_ip_is_two_one_way_edges() {
    let edges = assemble(
        detected(RequestSourceKind::Caretta),
        &fixture_answers(RequestSourceKind::Caretta, "caretta"),
    );
    let web = workload("shop", "web");
    let to_service = peer_of(Some("shop"), Some("cache"), TrafficPeerKind::Service);
    let to_workload = workload("shop", "cache");
    let rate = |to: &TrafficPeer| {
        edges
            .edges
            .iter()
            .filter(|e| e.from == web && &e.to == to)
            .map(|e| r6(e.rate))
            .collect::<Vec<_>>()
    };
    // Role 1 alone: the 400 bytes/s web sent to the Service's ClusterIP.
    assert_eq!(rate(&to_service), [400.0]);
    // Role 2 alone: the 3 600 bytes/s the workload behind it answered; not folded into the Service's edge.
    assert_eq!(rate(&to_workload), [3600.0]);
}
#[test]
fn istio_edges_name_both_ends_or_say_unknown() {
    let edges = assemble(
        detected(RequestSourceKind::Istio),
        &fixture_answers(RequestSourceKind::Istio, "istio"),
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
    // The caller's copy of the same calls is not added.
    assert_eq!(r6(web.rate), 1.0);
    assert_eq!(r6o(web.error_ratio), Some(0.1));
    assert_eq!((r6o(web.p50_ms), r6o(web.p95_ms)), (Some(10.0), Some(50.0)));
    let classes: Vec<(&str, f64)> = web
        .status_classes
        .iter()
        .map(|c| (c.class.as_str(), r6(c.rate)))
        .collect();
    assert_eq!(classes, [("2xx", 0.9), ("5xx", 0.1)]);
    assert!(web.missing.is_empty());
    // gRPC: a non-OK status on HTTP 200 is an error.
    let db = find("db");
    assert_eq!(db.protocol, TrafficProtocol::Grpc);
    assert_eq!(r6o(db.error_ratio), Some(0.5));
    // A callee without a proxy is the Service (here a host) the caller named; Istio's `unknown` is no namespace.
    let host = find("api.example.com");
    assert_eq!(
        host.to,
        peer_of(None, Some("api.example.com"), TrafficPeerKind::Service)
    );
    assert_eq!(r6o(host.error_ratio), Some(0.0));
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
        &fixture_answers(RequestSourceKind::Linkerd, "linkerd"),
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
        (db.protocol, r6o(db.error_ratio)),
        (TrafficProtocol::Grpc, Some(1.0))
    );
    let web = edges
        .edges
        .iter()
        .find(|e| e.from == workload("shop", "frontend"))
        .unwrap();
    assert_eq!((web.protocol, r6(web.rate)), (TrafficProtocol::Http, 1.0));
    assert_eq!(r6o(web.p95_ms), Some(50.0));
}

#[test]
fn beyla_counts_a_call_seen_at_both_ends_once() {
    let edges = assemble(
        detected(RequestSourceKind::Beyla),
        &fixture_answers(RequestSourceKind::Beyla, "beyla"),
    );
    assert_eq!(edges.edges.len(), 2);
    // frontend → web: both ends instrumented; `request_total` says 2/s, the calls are 1/s.
    let web = &edges.edges[0];
    assert_eq!(web.to, workload("shop", "web"));
    assert_eq!(web.protocol, TrafficProtocol::Unknown);
    assert_eq!(r6(web.rate), 1.0);
    // 0.2 failed spans/s over 2 spans/s of both sides.
    assert_eq!(r6o(web.error_ratio), Some(0.1));
    assert!(web.status_classes.is_empty());
    assert_eq!((r6o(web.p50_ms), r6o(web.p95_ms)), (Some(10.0), Some(50.0)));
    // web → db: only the client is instrumented, so its spans count (and its histogram).
    let db = &edges.edges[1];
    assert_eq!(db.to, workload("pay", "db"));
    assert_eq!((r6(db.rate), db.error_ratio), (0.5, Some(0.0)));
    assert_eq!(r6o(db.p50_ms), Some(10.0));
}

#[test]
fn hubble_counts_a_call_once_whichever_end_sees_it() {
    for case in ["both", "egress", "ingress"] {
        let edges = assemble(
            detected(RequestSourceKind::Hubble),
            &fixture_answers(RequestSourceKind::Hubble, &format!("hubble-{case}")),
        );
        let web = edges
            .edges
            .iter()
            .find(|e| e.to == workload("shop", "web"))
            .unwrap_or_else(|| panic!("{case}: {edges:?}"));
        assert_eq!(web.from, workload("shop", "frontend"), "{case}");
        assert_eq!(r6(web.rate), 1.0, "{case}");
        // The 5xx class is Hubble's error.
        assert_eq!(r6o(web.error_ratio), Some(0.1), "{case}");
        // The callee's histogram where it has one (the caller's says twice as long in `both`).
        assert_eq!(r6o(web.p50_ms), Some(10.0), "{case}");
        // A callee outside the cluster is seen only by the caller: an unknown end.
        let outside = edges
            .edges
            .iter()
            .find(|e| e.to.kind == TrafficPeerKind::Unknown);
        match case {
            "ingress" => assert!(outside.is_none()),
            _ => {
                let outside = outside.unwrap();
                assert_eq!(outside.from, workload("shop", "web"));
                assert_eq!(outside.to, peer_of(None, None, TrafficPeerKind::Unknown));
            }
        }
    }
}

#[test]
fn a_failed_detail_leaves_the_edges_with_that_detail_unknown() {
    let mut answers = fixture_answers(RequestSourceKind::Istio, "istio");
    for (ask, data) in &mut answers[0].details {
        if matches!(ask, Ask::Ok | Ask::P95) {
            *data = None;
        }
    }
    let edges = assemble(detected(RequestSourceKind::Istio), &answers);
    // Every edge is still there.
    assert_eq!(edges.edges.len(), 5);
    let web = edges
        .edges
        .iter()
        .find(|e| e.from == workload("shop", "frontend"))
        .unwrap();
    assert_eq!(web.error_ratio, None);
    assert_eq!((r6o(web.p50_ms), web.p95_ms), (Some(10.0), None));
    assert_eq!(web.missing, [TrafficDetail::Errors, TrafficDetail::Latency]);
    assert_eq!(web.status_classes.len(), 2);
    // Other parts' details are not touched.
    let host = edges
        .edges
        .iter()
        .find(|e| e.to.name.as_deref() == Some("api.example.com"))
        .unwrap();
    assert!(host.missing.is_empty());
    // Hubble's errors are its 5xx class: no classes, no errors either.
    let mut hubble = fixture_answers(RequestSourceKind::Hubble, "hubble-both");
    for (ask, data) in &mut hubble[0].details {
        if *ask == Ask::Classes {
            *data = None;
        }
    }
    let edges = assemble(detected(RequestSourceKind::Hubble), &hubble);
    let web = &edges.edges[0];
    assert_eq!(
        (web.error_ratio, web.status_classes.is_empty()),
        (None, true)
    );
    assert_eq!(web.missing, [TrafficDetail::Errors, TrafficDetail::Classes]);
}

#[test]
fn only_so_many_series_are_read_and_values_of_other_edges_are_ignored() {
    let series: Vec<Value> = (0..MAX_TRAFFIC_SERIES + 50)
        .map(|i| {
            json!({ "metric": { "source_namespace": "shop", "source_workload": format!("w{i}"),
                                "destination_namespace": "shop", "destination_workload": "web" },
                    "value": [1, "1"] })
        })
        .collect();
    let stray = json!({ "result": [{ "metric": { "source_workload": "nobody", "sx_c": "5xx" }, "value": [1, "5"] }] });
    let answers = [PartAnswers {
        rate: json!({ "result": series }),
        count: None,
        details: vec![(Ask::Classes, Some(stray))],
    }];
    let edges = assemble(detected(RequestSourceKind::Hubble), &answers);
    assert_eq!(edges.edges.len(), MAX_TRAFFIC_SERIES);
    assert!(edges.edges.iter().all(|e| e.error_ratio == Some(0.0)));
}

fn url_prometheus(api: &FakeApi) -> Prometheus {
    let client =
        kube::Client::try_from(kube::Config::new("http://127.0.0.1:1".parse().unwrap())).unwrap();
    Prometheus::new(
        &client,
        &PrometheusTarget::Url {
            url: api.url().to_owned(),
        },
    )
    .unwrap()
}

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

/// The `query` parameter of a GET's query string or of a form body.
fn promql_of(req: &Request) -> String {
    let form = if req.method == "POST" {
        String::from_utf8(req.body.clone()).unwrap()
    } else {
        req.query.clone()
    };
    form.split('&')
        .find_map(|p| p.strip_prefix("query="))
        .map(decode)
        .unwrap_or_default()
}

fn vector(result: Value) -> String {
    json!({ "status": "success", "data": { "resultType": "vector", "result": result } }).to_string()
}

#[tokio::test]
async fn only_a_failed_edge_query_fails_the_source() {
    // Every detail query fails (a timeout, Prometheus' sample limit…): the edges stay, the details are unknown.
    let api = FakeApi::start(|req: &Request| {
        let promql = promql_of(req);
        if promql.starts_with("topk(") {
            let data = fixture("hubble-both")["queries"][0]["data"].clone();
            Reply::json(200, json!({ "status": "success", "data": data }).to_string())
        } else {
            Reply::json(
                422,
                r#"{"status":"error","errorType":"execution","error":"query processing would load too many samples into memory"}"#,
            )
        }
    })
    .await;
    let edges = traffic_edges(
        &url_prometheus(&api),
        detected(RequestSourceKind::Hubble),
        &ns(&["shop", "pay"]),
        TrafficWindow::Minutes5,
        1_760_000_000,
    )
    .await
    .unwrap();
    assert_eq!(edges.edges.len(), 2);
    for edge in &edges.edges {
        assert_eq!(
            edge.missing,
            [
                TrafficDetail::Errors,
                TrafficDetail::Classes,
                TrafficDetail::Latency
            ]
        );
        assert_eq!((edge.error_ratio, edge.p50_ms), (None, None));
    }
    // The edge query failing does fail it.
    let refused = FakeApi::start(|_: &Request| {
        Reply::json(
            422,
            r#"{"status":"error","errorType":"execution","error":"query timed out"}"#,
        )
    })
    .await;
    let err = traffic_edges(
        &url_prometheus(&refused),
        detected(RequestSourceKind::Hubble),
        &ns(&["shop"]),
        TrafficWindow::Minutes5,
        1_760_000_000,
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("query timed out"), "{}", err.message);
}

#[tokio::test]
async fn a_capped_part_counts_its_edges_and_asks_details_of_the_busiest_only() {
    let api = FakeApi::start(|req: &Request| {
        let promql = promql_of(req);
        if promql.starts_with("topk(") {
            let series: Vec<Value> = (0..MAX_TRAFFIC_EDGES)
                .map(|i| json!({ "metric": { "source_namespace": "shop", "source_workload": format!("w{i}"),
                                              "destination_namespace": "shop", "destination_workload": "web" },
                                 "value": [1, "1"] }))
                .collect();
            Reply::json(200, vector(Value::Array(series)))
        } else if promql.starts_with("count(") {
            Reply::json(200, vector(json!([{ "metric": {}, "value": [1, "1234"] }])))
        } else {
            Reply::json(200, vector(json!([])))
        }
    })
    .await;
    let edges = traffic_edges(
        &url_prometheus(&api),
        detected(RequestSourceKind::Hubble),
        &ns(&["shop"]),
        TrafficWindow::Minutes5,
        1_760_000_000,
    )
    .await
    .unwrap();
    assert_eq!((edges.edges.len(), edges.total), (MAX_TRAFFIC_EDGES, 1234));
    let asked: Vec<String> = api.requests().iter().map(promql_of).collect();
    assert_eq!(asked.len(), 1 + 1 + 3);
    for q in asked
        .iter()
        .filter(|q| !q.starts_with("topk(") && !q.starts_with("count("))
    {
        assert!(q.contains(" and on(") && q.contains("topk(200,"), "{q}");
    }
}

#[tokio::test]
async fn an_answer_over_the_size_cap_is_an_error_not_a_cut() {
    let big = format!(
        r#"{{"status":"success","data":{{"resultType":"vector","result":[],"pad":"{}"}}}}"#,
        "x".repeat(MAX_TRAFFIC_BODY)
    );
    let api = FakeApi::start(move |_: &Request| Reply::json(200, big.clone())).await;
    let err = traffic_edges(
        &url_prometheus(&api),
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

/// A proxy that refuses URLs longer than half a KiB (nginx answers 414 with HTML).
fn short_urls(req: &Request) -> Reply {
    if req.method == "GET" && req.query.len() > 512 {
        return Reply::json(
            414,
            "<html><body><h1>414 Request-URI Too Large</h1></body></html>",
        );
    }
    let promql = promql_of(req);
    if promql.starts_with("topk(") {
        let data = fixture("hubble-both")["queries"][0]["data"].clone();
        return Reply::json(
            200,
            json!({ "status": "success", "data": data }).to_string(),
        );
    }
    Reply::json(200, vector(json!([])))
}

#[tokio::test]
async fn a_query_too_long_for_a_proxy_is_posted_to_a_prometheus_reached_by_url() {
    let api = FakeApi::start(short_urls).await;
    let edges = traffic_edges(
        &url_prometheus(&api),
        detected(RequestSourceKind::Hubble),
        &ns(&["shop", "pay"]),
        TrafficWindow::Minutes5,
        1_760_000_000,
    )
    .await
    .unwrap();
    assert_eq!(edges.edges.len(), 2);
    let requests = api.requests();
    let posts: Vec<&Request> = requests.iter().filter(|r| r.method == "POST").collect();
    assert!(!posts.is_empty());
    for post in posts {
        assert_eq!(post.path, "/api/v1/query");
        assert_eq!(
            post.header("content-type"),
            "application/x-www-form-urlencoded"
        );
        let body = String::from_utf8(post.body.clone()).unwrap();
        assert!(body.contains("&time=1760000000&timeout=18s"), "{body}");
    }
}

#[tokio::test]
async fn through_the_service_proxy_a_query_too_long_says_so() {
    use crate::fake_api::connected_to;
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(
            200,
            r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
        ),
        _ => short_urls(req),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let prometheus = Prometheus::new(
        &mgr.client(&id).unwrap(),
        &PrometheusTarget::Service {
            namespace: "monitoring".into(),
            service: "prometheus".into(),
            port: 9090,
            path_prefix: String::new(),
        },
    )
    .unwrap();
    let err = traffic_edges(
        &prometheus,
        detected(RequestSourceKind::Hubble),
        &ns(&["shop", "pay"]),
        TrafficWindow::Minutes5,
        1_760_000_000,
    )
    .await
    .unwrap_err();
    assert!(
        crate::metrics::prometheus::is_query_too_long(&err),
        "{}",
        err.message
    );
    assert!(err.message.contains("HTTP 414"), "{}", err.message);
    // POST through the service proxy would need `create` on services/proxy: never sent.
    assert!(api.requests().iter().all(|r| r.method == "GET"));
}

/// Writes every query the fixtures answer (`SEXTANT_FIXTURE_QUERIES=<file>`): `metrics/traffic/testdata/*.json` and
/// `metrics/requests/testdata/hubble-*.json` are a real Prometheus' answers to these queries over the synthetic series
/// each file lists (`series`), loaded with `promtool tsdb create-blocks-from openmetrics`.
#[test]
#[ignore = "writes the queries the fixtures are made from"]
fn write_fixture_queries() {
    use crate::metrics::prometheus::{golden_query, request_selectors};
    use crate::metrics::requests::RequestTarget;
    let Ok(out) = std::env::var("SEXTANT_FIXTURE_QUERIES") else {
        return;
    };
    let namespaces = vec!["shop".to_owned(), "pay".to_owned()];
    let mut all = serde_json::Map::new();
    for kind in RequestSourceKind::ALL {
        let list: Vec<Value> = part_queries(kind, &namespaces, TrafficWindow::Minutes5, true)
            .into_iter()
            .map(|(part, ask, promql)| serde_json::json!({"part": part, "ask": format!("{ask:?}"), "promql": promql}))
            .collect();
        all.insert(format!("{kind:?}"), Value::Array(list));
    }
    let web = RequestTarget::Workload {
        namespace: "shop".into(),
        kind: "Deployment".into(),
        name: "web".into(),
    };
    let selectors = request_selectors(RequestSourceKind::Hubble, &web, &[]);
    all.insert(
        "golden".into(),
        Value::String(golden_query(RequestSourceKind::Hubble, &selectors, true)),
    );
    std::fs::write(out, serde_json::to_string_pretty(&all).unwrap()).unwrap();
}
