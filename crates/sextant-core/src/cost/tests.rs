use k8s_openapi::api::core::v1::Service;
use serde_json::json;

use super::client::{aggregate_param, parse, request_uri};
use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
const EMPTY_LIST: &str = r#"{"kind":"ServiceList","apiVersion":"v1","metadata":{},"items":[]}"#;

fn service(namespace: &str, name: &str, labels: serde_json::Value, ports: &[u16]) -> Service {
    let ports: Vec<_> = ports.iter().map(|p| json!({ "port": p })).collect();
    serde_json::from_value(json!({
        "metadata": { "name": name, "namespace": namespace, "labels": labels },
        "spec": { "ports": ports },
    }))
    .unwrap()
}

fn list(services: &[Service]) -> String {
    json!({ "kind": "ServiceList", "apiVersion": "v1", "metadata": {}, "items": services })
        .to_string()
}

fn query(window: CostWindow, aggregate: CostAggregate) -> CostQuery {
    CostQuery {
        window,
        aggregate,
        namespaces: None,
    }
}

fn opencost() -> CostSource {
    CostSource {
        product: CostProduct::Opencost,
        namespace: "opencost".into(),
        service: "opencost".into(),
        port: 9003,
    }
}

#[test]
fn discovery_knows_opencost_and_kubecost_and_their_ports() {
    let oc = service("opencost", "opencost", json!({}), &[9003, 9090]);
    assert_eq!(classify(&oc), Some((CostProduct::Opencost, 9003)));
    let oc_ui_only = service(
        "x",
        "costs",
        json!({"app.kubernetes.io/name": "opencost"}),
        &[9090],
    );
    assert_eq!(classify(&oc_ui_only), Some((CostProduct::Opencost, 9090)));
    let kc = service(
        "kubecost",
        "kubecost-cost-analyzer",
        json!({}),
        &[9003, 9090],
    );
    assert_eq!(classify(&kc), Some((CostProduct::Kubecost, 9090)));
    let kc_label = service("tools", "costs", json!({"app": "cost-analyzer"}), &[9003]);
    assert_eq!(classify(&kc_label), Some((CostProduct::Kubecost, 9003)));
    // A known name on another port, or an unrelated Service, is not a candidate.
    assert_eq!(
        classify(&service("opencost", "opencost", json!({}), &[80])),
        None
    );
    assert_eq!(
        classify(&service("opencost", "prometheus", json!({}), &[9090])),
        None
    );
}

#[test]
fn discovery_prefers_opencost_then_the_known_namespaces() {
    let kc = service("kubecost", "kubecost-cost-analyzer", json!({}), &[9090]);
    let oc_elsewhere = service("tools", "opencost", json!({}), &[9003]);
    let oc = service("opencost", "opencost", json!({}), &[9003]);
    let picked = pick(&[kc.clone(), oc_elsewhere.clone(), oc]).unwrap();
    assert_eq!(picked, opencost());
    assert_eq!(
        pick(&[kc.clone(), oc_elsewhere]).unwrap().namespace,
        "tools"
    );
    assert_eq!(pick(&[kc]).unwrap().product, CostProduct::Kubecost);
    assert_eq!(pick(&[]), None);
}

#[test]
fn api_paths_are_fixed_per_product_and_port() {
    let mut s = opencost();
    assert_eq!(s.api_path(), "/allocation/compute");
    s.port = 9090;
    assert_eq!(s.api_path(), "/model/allocation/compute");
    s.product = CostProduct::Kubecost;
    assert_eq!(s.api_path(), "/model/allocation");
    s.port = 9003;
    assert_eq!(s.api_path(), "/allocation");
}

#[test]
fn queries_are_checked_before_anything_is_sent() {
    let label = |key: &str| query(CostWindow::Day, CostAggregate::Label { key: key.into() });
    assert!(validate(&label("app")).is_ok());
    assert!(validate(&label("app.kubernetes.io/name")).is_ok());
    for bad in [
        "",
        "a b",
        "x&aggregate=pod",
        "-app",
        "a/b/c",
        "Upper.Case/x",
        "a\"b",
    ] {
        assert_eq!(
            validate(&label(bad)).unwrap_err().code,
            ErrorCode::Invalid,
            "{bad}"
        );
    }
    let mut q = query(CostWindow::Week, CostAggregate::Namespace);
    q.namespaces = Some(vec!["team-a".into()]);
    assert!(validate(&q).is_ok());
    for bad in [
        vec![],
        vec!["Team".to_owned()],
        vec!["a\",\"b".to_owned()],
        vec!["x".repeat(64)],
    ] {
        q.namespaces = Some(bad);
        assert_eq!(validate(&q).unwrap_err().code, ErrorCode::Invalid);
    }
    q.namespaces = Some(
        (0..=MAX_FILTER_NAMESPACES)
            .map(|i| format!("ns{i}"))
            .collect(),
    );
    assert_eq!(validate(&q).unwrap_err().code, ErrorCode::Invalid);
}

#[test]
fn the_request_is_built_from_a_fixed_set_of_parameters() {
    let q = query(CostWindow::Day, CostAggregate::Namespace);
    assert_eq!(
        request_uri(&opencost(), &q),
        "/api/v1/namespaces/opencost/services/opencost:9003/proxy/allocation/compute?window=24h\
         &aggregate=namespace&accumulate=true&includeIdle=true&idle=true&shareIdle=false"
    );
    let mut q = query(
        CostWindow::Month,
        CostAggregate::Label {
            key: "app.kubernetes.io/name".into(),
        },
    );
    q.namespaces = Some(vec!["a".into(), "b".into()]);
    let uri = request_uri(&opencost(), &q);
    assert!(
        uri.contains("window=30d&aggregate=label%3Aapp_kubernetes_io_name&"),
        "{uri}"
    );
    assert!(
        uri.ends_with("&filter=namespace%3A%22a%22%2C%22b%22"),
        "{uri}"
    );
    assert_eq!(
        aggregate_param(&CostAggregate::Workload),
        "namespace,controller"
    );
    assert_eq!(aggregate_param(&CostAggregate::Pod), "namespace,pod");
    assert_eq!(aggregate_param(&CostAggregate::Node), "node");
    assert_eq!(
        query(CostWindow::Week, CostAggregate::Node).window.hours(),
        168.0
    );
}

fn answer() -> serde_json::Value {
    json!({
        "code": 200,
        "data": [{
            "shop/deployment:web": {
                "name": "shop/deployment:web",
                "properties": { "namespace": "shop", "controllerKind": "deployment", "controller": "web",
                                "labels": { "app": "web" } },
                "minutes": 1440.0,
                "cpuCoreHours": 48.0, "cpuCost": 1.2, "cpuCostAdjustment": 0.3, "cpuEfficiency": 0.25,
                "ramByteHours": 103079215104.0, "ramCost": 0.5, "ramEfficiency": "NaN",
                "pvCost": 0.2, "networkCost": 0.1, "gpuCost": 0.0, "loadBalancerCost": 0.4,
                "totalCost": 2.7, "totalEfficiency": 0.3, "rawAllocationOnly": { "huge": [1, 2, 3] }
            },
            "ops/deployment:db": {
                "properties": { "namespace": "ops", "controllerKind": "deployment", "controller": "db" },
                "cpuCost": 5.0, "ramCost": 5.0, "totalCost": 10.0
            },
            "__idle__": { "cpuCost": 3.0, "ramCost": 1.0, "totalCost": 4.0 },
            "__unallocated__": { "totalCost": 0.5 },
            "gone": null
        }]
    })
}

#[test]
fn an_answer_keeps_the_needed_fields_with_adjustments_and_the_idle_cost_apart() {
    let q = query(CostWindow::Day, CostAggregate::Workload);
    let report = parse(answer().to_string().as_bytes(), &q).unwrap();
    assert_eq!(report.source, None);
    assert_eq!(report.currency, None);
    let names: Vec<_> = report.rows.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "ops/deployment:db",
            "shop/deployment:web",
            "__unallocated__"
        ]
    );
    let web = &report.rows[1];
    assert!((web.cpu_cost - 1.5).abs() < 1e-9);
    assert!((web.other_cost - 0.4).abs() < 1e-9, "{web:?}");
    assert_eq!(web.total_cost, 2.7);
    assert_eq!(
        (web.namespace.as_deref(), web.controller_kind.as_deref()),
        (Some("shop"), Some("deployment"))
    );
    assert_eq!(web.controller.as_deref(), Some("web"));
    assert_eq!((web.cpu_core_hours, web.minutes), (48.0, 1440.0));
    assert_eq!((web.cpu_efficiency, web.ram_efficiency), (Some(0.25), None));
    let idle = report.idle.unwrap();
    assert_eq!((idle.name.as_str(), idle.total_cost), ("__idle__", 4.0));
    assert_eq!((report.total_rows, report.truncated), (3, false));
}

#[test]
fn sets_are_summed_and_the_namespace_filter_drops_other_namespaces() {
    let mut body = answer();
    let second = body["data"][0].clone();
    body["data"].as_array_mut().unwrap().push(second);
    body["currencyCode"] = json!("eur");
    let mut q = query(CostWindow::Week, CostAggregate::Workload);
    q.namespaces = Some(vec!["shop".into()]);
    let report = parse(body.to_string().as_bytes(), &q).unwrap();
    let names: Vec<_> = report.rows.iter().map(|r| r.name.as_str()).collect();
    // `__unallocated__` has no namespace and stays.
    assert_eq!(names, ["shop/deployment:web", "__unallocated__"]);
    assert!((report.rows[0].total_cost - 5.4).abs() < 1e-9);
    assert_eq!(report.rows[0].cpu_efficiency, None);
    assert_eq!(report.idle.unwrap().total_cost, 8.0);
    assert_eq!(report.currency.as_deref(), Some("EUR"));
}

#[test]
fn error_answers_and_foreign_bodies_are_errors() {
    let q = query(CostWindow::Day, CostAggregate::Namespace);
    let err = parse(br#"{"code":400,"message":"bad window"}"#, &q).unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(err.message.contains("bad window"), "{}", err.message);
    let err = parse(b"<html>nginx</html>", &q).unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    let empty = parse(br#"{"code":200,"data":null}"#, &q).unwrap();
    assert!(empty.rows.is_empty() && empty.idle.is_none());
    // One set instead of a list of sets.
    let one = parse(br#"{"code":200,"data":{"a":{"totalCost":1}}}"#, &q).unwrap();
    assert_eq!(one.rows.len(), 1);
}

#[test]
fn rows_are_capped_most_expensive_first() {
    let set: serde_json::Map<String, serde_json::Value> = (0..MAX_ROWS + 5)
        .map(|i| (format!("ns{i}"), json!({ "totalCost": i as f64 })))
        .collect();
    let body = json!({ "code": 200, "data": [set] }).to_string();
    let report = parse(
        body.as_bytes(),
        &query(CostWindow::Day, CostAggregate::Namespace),
    )
    .unwrap();
    assert_eq!(report.rows.len(), MAX_ROWS);
    assert!(report.truncated);
    assert_eq!(report.total_rows as usize, MAX_ROWS + 5);
    assert_eq!(report.rows[0].name, format!("ns{}", MAX_ROWS + 4));
}

const PROXY: &str = "/api/v1/namespaces/opencost/services/opencost:9003/proxy/allocation/compute";

/// A cluster with OpenCost in `opencost` whose allocation API answers `reply()`.
async fn cluster_with_opencost(
    reply: impl Fn() -> Reply + Send + Sync + 'static,
) -> (FakeApi, tempfile::TempDir, ClusterManager, ClusterId) {
    let oc = list(&[service("opencost", "opencost", json!({}), &[9003, 9090])]);
    let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/namespaces/opencost/services" => Reply::json(200, oc.clone()),
        "/api/v1/namespaces/kubecost/services" | "/api/v1/services" => Reply::json(200, EMPTY_LIST),
        PROXY => reply(),
        _ => Reply::not_found(),
    })
    .await;
    let (tmp, mgr, id) = connected_to(api.url()).await;
    (api, tmp, mgr, id)
}

#[tokio::test]
async fn costs_come_through_the_service_proxy_of_the_discovered_service() {
    let body = answer().to_string();
    let (api, _tmp, mgr, id) = cluster_with_opencost(move || Reply::json(200, body.clone())).await;
    let q = query(CostWindow::Week, CostAggregate::Workload);
    let report = allocation(&mgr, &id, &q).await.unwrap();
    assert_eq!(report.source, Some(opencost()));
    assert_eq!(report.rows.len(), 3);
    let sent: Vec<_> = api
        .requests()
        .into_iter()
        .filter(|r| r.path == PROXY)
        .collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].method, "GET");
    assert_eq!(
        sent[0].query,
        "window=7d&aggregate=namespace%2Ccontroller&accumulate=true&includeIdle=true&idle=true&shareIdle=false"
    );
    assert!(sent[0].body.is_empty());
    // The cluster-wide lookup asks only for the labelled Services.
    let labelled = api
        .requests()
        .into_iter()
        .find(|r| r.path == "/api/v1/services")
        .unwrap();
    assert!(
        labelled.query.contains("labelSelector="),
        "{}",
        labelled.query
    );
    // Discovery is reused for the next call.
    allocation(&mgr, &id, &q).await.unwrap();
    assert_eq!(api.count("/api/v1/namespaces/opencost/services"), 1);
    assert_eq!(api.count(PROXY), 2);
}

#[tokio::test]
async fn without_a_cost_service_the_report_is_empty_and_nothing_is_proxied() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/services" => Reply::json(403, r#"{"kind":"Status","code":403}"#),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let report = allocation(&mgr, &id, &query(CostWindow::Day, CostAggregate::Namespace))
        .await
        .unwrap();
    assert_eq!(report.source, None);
    assert!(report.rows.is_empty() && report.idle.is_none());
    assert!(api.requests().iter().all(|r| !r.path.contains("/proxy")));
}

#[tokio::test]
async fn an_invalid_query_sends_nothing() {
    let (api, _tmp, mgr, id) = cluster_with_opencost(|| Reply::json(200, "{}")).await;
    let before = api.requests().len();
    let q = query(CostWindow::Day, CostAggregate::Label { key: "a&b".into() });
    assert_eq!(
        allocation(&mgr, &id, &q).await.unwrap_err().code,
        ErrorCode::Invalid
    );
    assert_eq!(api.requests().len(), before);
}

#[tokio::test]
async fn an_answer_over_the_size_cap_is_refused() {
    let (_api, _tmp, mgr, id) = cluster_with_opencost(|| {
        let name = "x".repeat(MAX_BODY);
        Reply::json(
            200,
            format!(r#"{{"code":200,"data":[{{"{name}":{{"totalCost":1}}}}]}}"#),
        )
    })
    .await;
    let err = allocation(&mgr, &id, &query(CostWindow::Day, CostAggregate::Pod))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(err.message.contains("8 MiB"), "{}", err.message);
}

#[tokio::test]
async fn proxy_refusals_become_clear_errors() {
    let (_api, _tmp, mgr, id) =
        cluster_with_opencost(|| Reply::json(403, r#"{"kind":"Status","code":403}"#)).await;
    let q = query(CostWindow::Day, CostAggregate::Namespace);
    let err = allocation(&mgr, &id, &q).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert!(err.message.contains("services/proxy"), "{}", err.message);

    let (_api, _tmp, mgr, id) = cluster_with_opencost(|| Reply::json(503, "no endpoints")).await;
    assert_eq!(
        allocation(&mgr, &id, &q).await.unwrap_err().code,
        ErrorCode::Unreachable
    );
}
