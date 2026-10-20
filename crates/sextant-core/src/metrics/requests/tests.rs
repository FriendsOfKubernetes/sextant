use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

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

/// A Prometheus answer of `testdata/<source>.json`: `names`, `instant` or `range`.
fn fixture(source: &str, part: &str) -> String {
    let path = format!(
        "{}/src/metrics/requests/testdata/{source}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let all: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    all[part].to_string()
}

/// Answers a Prometheus request (path relative to the Prometheus root) from the source's fixtures.
fn prometheus_reply(source: &str, path: &str) -> Reply {
    match path {
        "/api/v1/status/buildinfo" => Reply::json(200, r#"{"status":"success","data":{}}"#),
        "/api/v1/label/__name__/values" => Reply::json(200, fixture(source, "names")),
        "/api/v1/query" => Reply::json(200, fixture(source, "instant")),
        "/api/v1/query_range" => Reply::json(200, fixture(source, "range")),
        _ => Reply::not_found(),
    }
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

#[test]
fn only_kubernetes_names_and_known_kinds_pass() {
    let ok = RequestTarget::Workload {
        namespace: "shop".into(),
        kind: "StatefulSet".into(),
        name: "db".into(),
    };
    validate_target(&ok).unwrap();
    let bad = [
        RequestTarget::Pod {
            namespace: "shop".into(),
            name: "p\"} or vector(1) #".into(),
        },
        RequestTarget::Pod {
            namespace: "a|b".into(),
            name: "p".into(),
        },
        RequestTarget::Workload {
            namespace: "shop".into(),
            kind: "CronJob".into(),
            name: "nightly".into(),
        },
        RequestTarget::Workload {
            namespace: "shop".into(),
            kind: "Deployment".into(),
            name: "web.*".into(),
        },
    ];
    for target in bad {
        assert_eq!(
            validate_target(&target).unwrap_err().code,
            ErrorCode::Invalid,
            "{target:?}"
        );
    }
}

#[test]
fn a_target_carries_names_only_never_a_query() {
    let parsed: RequestTarget =
        serde_json::from_value(json!({ "type": "pod", "namespace": "a", "name": "b" })).unwrap();
    assert_eq!(parsed.namespace(), "a");
    for extra in ["query", "promql", "selector", "metric"] {
        let mut value = json!({ "type": "pod", "namespace": "a", "name": "b" });
        value[extra] = json!("up");
        assert!(
            serde_json::from_value::<RequestTarget>(value).is_err(),
            "{extra}"
        );
    }
}

#[test]
fn detection_asks_for_the_known_names_only() {
    let known = RequestSourceKind::known_metrics();
    assert_eq!(known.len(), known.iter().collect::<BTreeSet<_>>().len());
    assert!(known.contains(&"istio_requests_total"));
    assert!(known.contains(&"hubble_http_request_duration_seconds_bucket"));
    assert_eq!(known.len(), 12);
}

/// What the fixtures of each source must give: (source file, kind, rate, error ratio, p50, p95, p99 in ms).
#[allow(clippy::type_complexity)]
const EXPECTED: [(&str, RequestSourceKind, f64, f64, f64, f64, Option<f64>); 5] = [
    (
        "istio",
        RequestSourceKind::Istio,
        12.5,
        0.02,
        8.2,
        45.0,
        Some(120.0),
    ),
    (
        "linkerd",
        RequestSourceKind::Linkerd,
        4.0,
        0.1,
        3.0,
        10.0,
        Some(25.0),
    ),
    (
        "ingress-nginx",
        RequestSourceKind::IngressNginx,
        20.0,
        0.05,
        12.0,
        80.0,
        Some(250.0),
    ),
    (
        "beyla",
        RequestSourceKind::Beyla,
        2.0,
        0.0,
        4.0,
        20.0,
        Some(50.0),
    ),
    // A NaN quantile (no requests in that bucket range) is unknown, not 0.
    (
        "hubble",
        RequestSourceKind::Hubble,
        1.0,
        0.5,
        100.0,
        400.0,
        None,
    ),
];

fn close(a: Option<f64>, b: f64) -> bool {
    a.is_some_and(|a| (a - b).abs() < 1e-9)
}

#[tokio::test]
async fn each_sources_answers_become_golden_metrics() {
    for (file, kind, rate, errors, p50, p95, p99) in EXPECTED {
        let api = FakeApi::start(move |req: &Request| prometheus_reply(file, &req.path)).await;
        let prometheus = url_prometheus(&api);
        let names = prometheus::request_metric_names(&prometheus, 1_760_000_000)
            .await
            .unwrap();
        // Names of other metrics in the answer are dropped.
        assert!(
            names
                .iter()
                .all(|n| RequestSourceKind::known_metrics().contains(&n.as_str()))
        );
        let sources = prometheus::sources_in(&names, RequestVia::Cluster);
        assert_eq!(sources.len(), 1, "{file}: {sources:?}");
        assert_eq!(sources[0].kind, kind);
        assert!(sources[0].latency, "{file}");

        let target = RequestTarget::Workload {
            namespace: "shop".into(),
            kind: "Deployment".into(),
            name: "web".into(),
        };
        let selectors = prometheus::request_selectors(kind, &target, &["web".into()]);
        let golden = prometheus::golden(&prometheus, sources[0], &selectors, 1_760_000_000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(golden.source, kind);
        assert!(close(golden.request_rate, rate), "{file}: {golden:?}");
        assert!(close(golden.error_ratio, errors), "{file}: {golden:?}");
        assert!(close(golden.latency_ms.p50, p50), "{file}: {golden:?}");
        assert!(close(golden.latency_ms.p95, p95), "{file}: {golden:?}");
        assert_eq!(golden.latency_ms.p99.is_some(), p99.is_some(), "{file}");
        if let Some(p99) = p99 {
            assert!(close(golden.latency_ms.p99, p99), "{file}: {golden:?}");
        }
        assert_eq!(golden.rate_series.len(), 3, "{file}");
        assert_eq!(golden.error_series.len(), 3, "{file}");

        let requests = api.requests();
        assert_eq!(requests.len(), 3, "{file}");
        let detect = &requests[0];
        assert_eq!(detect.path, "/api/v1/label/__name__/values");
        let query = decode(&detect.query);
        assert!(query.starts_with("match[]={__name__=~\""), "{query}");
        assert!(
            query.contains("&start=1759996400&end=1760000000"),
            "{query}"
        );
        // The hour ends on a whole minute.
        for r in &requests[1..] {
            assert!(r.query.contains("&timeout=18s"), "{}", r.query);
            let promql = decode(&r.query);
            assert!(promql.contains("web"), "{promql}");
        }
        let range = requests
            .iter()
            .find(|r| r.path == "/api/v1/query_range")
            .unwrap();
        assert!(
            range
                .query
                .contains("&start=1759996380&end=1759999980&step=60"),
            "{}",
            range.query
        );
    }
}

#[tokio::test]
async fn throttling_is_read_per_container_and_bounded() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api/v1/query" => Reply::json(200, fixture_file("throttling")),
        _ => Reply::not_found(),
    })
    .await;
    let scope = RequestTarget::Pod {
        namespace: "shop".into(),
        name: "web-0".into(),
    }
    .scope();
    let list = prometheus::throttling(&url_prometheus(&api), &scope, 1_760_000_000)
        .await
        .unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].container, "app");
    assert!((list[0].throttled_ratio - 0.42).abs() < 1e-9);
    let promql = decode(&api.requests()[0].query);
    assert!(
        promql.contains(r#"namespace="shop",pod="web-0""#),
        "{promql}"
    );
    assert!(
        promql.contains("container_cpu_cfs_throttled_periods_total"),
        "{promql}"
    );
}

fn fixture_file(name: &str) -> String {
    let path = format!(
        "{}/src/metrics/requests/testdata/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(path).unwrap()
}

#[tokio::test]
async fn no_series_of_the_target_is_no_source_not_zero() {
    let empty = r#"{"status":"success","data":{"resultType":"vector","result":[]}}"#;
    let empty_range = r#"{"status":"success","data":{"resultType":"matrix","result":[]}}"#;
    let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
        "/api/v1/query" => Reply::json(200, empty),
        _ => Reply::json(200, empty_range),
    })
    .await;
    let source = DetectedSource {
        kind: RequestSourceKind::Istio,
        via: RequestVia::Cluster,
        latency: true,
    };
    let none = prometheus::golden(
        &url_prometheus(&api),
        source,
        &["x=\"y\"".into()],
        1_760_000_000,
    )
    .await
    .unwrap();
    assert_eq!(none, None);
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

/// A cluster whose Prometheus has Istio and ingress-nginx metrics, a Deployment `web` and the Services `web` (selects
/// it) and `other` (does not); linkerd-viz is not installed.
async fn cluster() -> FakeApi {
    FakeApi::start(|req: &Request| {
        let path = req.path.as_str();
        if let Some(rest) = path.strip_prefix(PROXY) {
            let promql = decode(&req.query);
            return match rest {
                "/api/v1/label/__name__/values" => Reply::json(
                    200,
                    r#"{"status":"success","data":["istio_requests_total","istio_request_duration_milliseconds_bucket","nginx_ingress_controller_requests"]}"#,
                ),
                "/api/v1/query" if promql.contains("cfs_throttled") => {
                    Reply::json(200, fixture_file("throttling"))
                }
                _ if promql.contains("nginx_ingress") => prometheus_reply("ingress-nginx", rest),
                _ => prometheus_reply("istio", rest),
            };
        }
        match path {
            "/api" => Reply::json(200, API_VERSIONS),
            "/apis/apps/v1/namespaces/shop/deployments/web" => Reply::json(
                200,
                json!({ "metadata": { "name": "web", "namespace": "shop" },
                        "spec": { "selector": { "matchLabels": { "app": "web" } },
                                  "template": { "metadata": { "labels": { "app": "web", "tier": "front" } } } } })
                .to_string(),
            ),
            "/api/v1/namespaces/shop/services" => Reply::json(
                200,
                json!({ "kind": "ServiceList", "apiVersion": "v1", "metadata": {}, "items": [
                    { "metadata": { "name": "web" }, "spec": { "selector": { "app": "web" } } },
                    { "metadata": { "name": "other" }, "spec": { "selector": { "app": "other" } } },
                    { "metadata": { "name": "headless" }, "spec": {} },
                ] })
                .to_string(),
            ),
            _ => Reply::not_found(),
        }
    })
    .await
}

#[tokio::test]
async fn a_workloads_request_health_from_every_source_it_has() {
    forget_sources();
    let api = cluster().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let target = RequestTarget::Workload {
        namespace: "shop".into(),
        kind: "Deployment".into(),
        name: "web".into(),
    };
    let health = request_health(&mgr, &id, &manual(), target.clone())
        .await
        .unwrap();
    assert!(health.prometheus);
    let kinds: Vec<_> = health
        .sources
        .iter()
        .map(|s| (s.kind, s.via, s.latency))
        .collect();
    assert_eq!(
        kinds,
        [
            (RequestSourceKind::Istio, RequestVia::Cluster, true),
            (RequestSourceKind::IngressNginx, RequestVia::Cluster, false)
        ]
    );
    assert_eq!(health.golden.len(), 2);
    assert!(health.failed.is_empty());
    assert!(health.throttling_known);
    assert_eq!(health.throttling[0].container, "app");
    assert_eq!(health.series_step_secs, 60);
    // Only the Service that selects the pods is named; nothing else from the cluster.
    let nginx: Vec<String> = api
        .requests()
        .iter()
        .map(|r| decode(&r.query))
        .filter(|q| q.contains("nginx_ingress_controller_requests{"))
        .collect();
    assert!(!nginx.is_empty());
    for q in &nginx {
        assert!(q.contains(r#"service=~"web""#), "{q}");
        assert!(!q.contains("other") && !q.contains("headless"), "{q}");
    }
    // linkerd-viz was looked for once (absent), and the sources are reused within the connection.
    let viz =
        "/api/v1/namespaces/linkerd-viz/services/prometheus:9090/proxy/api/v1/status/buildinfo";
    assert_eq!(api.count(viz), 1);
    let names = format!("{PROXY}/api/v1/label/__name__/values");
    assert_eq!(api.count(&names), 1);
    request_health(&mgr, &id, &manual(), target).await.unwrap();
    assert_eq!(api.count(&names), 1);
    assert_eq!(api.count(viz), 1);

    // An invalid name is refused before anything is asked.
    let before = api.requests().len();
    let bad = RequestTarget::Pod {
        namespace: "shop".into(),
        name: "x\"}".into(),
    };
    assert_eq!(
        request_health(&mgr, &id, &manual(), bad)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Invalid
    );
    assert_eq!(api.requests().len(), before);
}

#[tokio::test]
async fn prometheus_off_asks_nothing() {
    forget_sources();
    let api = cluster().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let before = api.requests().len();
    let target = RequestTarget::Pod {
        namespace: "shop".into(),
        name: "web-0".into(),
    };
    let health = request_health(&mgr, &id, &PrometheusMode::Off, target)
        .await
        .unwrap();
    assert!(!health.prometheus);
    assert!(health.sources.is_empty() && health.golden.is_empty());
    assert!(!health.throttling_known);
    assert_eq!(api.requests().len(), before);
}
