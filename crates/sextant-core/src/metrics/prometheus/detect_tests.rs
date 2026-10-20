//! Auto-detection of Prometheus and VictoriaMetrics (#226) against the fake API server: the known names and ports,
//! the order when both exist, the vmselect path prefix, the probe and its fallback.

use std::collections::HashMap;

use super::*;
use crate::fake_api::{FakeApi, Reply, Request};

const BUILDINFO: &str = r#"{"status":"success","data":{"version":"2.24.0"}}"#;
const VECTOR: &str = r#"{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1,"1"]}]}}"#;

fn service_list(services: &[(&str, &[u16])]) -> String {
    let items: Vec<Value> = services
        .iter()
        .map(|(name, ports)| {
            serde_json::json!({
                "metadata": {"name": name},
                "spec": {"ports": ports.iter().map(|p| serde_json::json!({"port": p})).collect::<Vec<_>>()}
            })
        })
        .collect();
    serde_json::json!({"kind": "ServiceList", "apiVersion": "v1", "metadata": {}, "items": items})
        .to_string()
}

/// Services by namespace: `(namespace, [(name, ports)])`.
type Namespaces = [(&'static str, &'static [(&'static str, &'static [u16])])];
/// A service name and ports, and what it should be found as.
type Case = (
    &'static str,
    &'static [u16],
    Option<(MetricsSourceKind, u16, &'static str)>,
);

/// A fake API server whose namespaces hold `services`; every service proxy path in `answering` answers buildinfo.
async fn cluster(services: &Namespaces, answering: &[&'static str]) -> FakeApi {
    let lists: HashMap<String, String> = services
        .iter()
        .map(|(ns, list)| {
            (
                format!("/api/v1/namespaces/{ns}/services"),
                service_list(list),
            )
        })
        .collect();
    let answering: Vec<String> = answering
        .iter()
        .map(|p| format!("{p}/api/v1/status/buildinfo"))
        .collect();
    FakeApi::start(move |req: &Request| {
        if let Some(list) = lists.get(&req.path) {
            return Reply::json(200, list.clone());
        }
        if req.path.ends_with("/services") {
            return Reply::json(200, service_list(&[]));
        }
        if answering.contains(&req.path) {
            return Reply::json(200, BUILDINFO);
        }
        Reply::not_found()
    })
    .await
}

fn client(api: &FakeApi) -> kube::Client {
    kube::Client::try_from(kube::Config::new(api.url().parse().unwrap())).unwrap()
}

fn service(namespace: &str, service: &str, port: u16, path_prefix: &str) -> PrometheusTarget {
    PrometheusTarget::Service {
        namespace: namespace.into(),
        service: service.into(),
        port,
        path_prefix: path_prefix.into(),
    }
}

#[test]
fn the_known_names_their_kinds_and_ports() {
    let cases: [Case; 12] = [
        (
            "prometheus-operated",
            &[9090],
            Some((MetricsSourceKind::Prometheus, 9090, "")),
        ),
        (
            "prometheus-server",
            &[80],
            Some((MetricsSourceKind::Prometheus, 80, "")),
        ),
        // The operator's VMSingle: 8429, with 8428 added as an alias.
        (
            "vmsingle-vmks-victoria-metrics-k8s-stack",
            &[8428, 8429],
            Some((MetricsSourceKind::VictoriaMetricsSingle, 8429, "")),
        ),
        (
            "vmsingle-vm",
            &[8428],
            Some((MetricsSourceKind::VictoriaMetricsSingle, 8428, "")),
        ),
        (
            "vm-victoria-metrics-single-server",
            &[8428],
            Some((MetricsSourceKind::VictoriaMetricsSingle, 8428, "")),
        ),
        (
            "victoria-metrics-single-server",
            &[8428],
            Some((MetricsSourceKind::VictoriaMetricsSingle, 8428, "")),
        ),
        (
            "vmselect-vm",
            &[8481],
            Some((
                MetricsSourceKind::VictoriaMetricsCluster,
                8481,
                VMSELECT_PATH_PREFIX,
            )),
        ),
        (
            "vmc-victoria-metrics-cluster-vmselect",
            &[8481],
            Some((
                MetricsSourceKind::VictoriaMetricsCluster,
                8481,
                VMSELECT_PATH_PREFIX,
            )),
        ),
        // Not a query API: vmagent, vminsert, the headless vmselect of the operator, a single without its port.
        ("vmagent-vm", &[8429], None),
        ("vminsert-vm", &[8480], None),
        ("vmselectinternal-vm", &[8481], None),
        ("vmsingle-vm", &[9090], None),
    ];
    for (name, ports, expected) in cases {
        let svc: Service = serde_json::from_str(&service_list(&[(name, ports)]))
            .map(|l: kube::core::ObjectList<Service>| l.items.into_iter().next().unwrap())
            .unwrap();
        let got = candidate(&svc).map(|(k, port)| (k.kind, port, k.path_prefix));
        assert_eq!(got, expected, "{name} {ports:?}");
    }
}

#[test]
fn the_kind_of_a_target_by_its_name_or_vmselect_path() {
    let kind = |t: &PrometheusTarget| source_kind(t);
    assert_eq!(
        kind(&service("monitoring", "prometheus-operated", 9090, "")),
        Some(MetricsSourceKind::Prometheus)
    );
    assert_eq!(
        kind(&service("vm", "vmsingle-x", 8429, "")),
        Some(MetricsSourceKind::VictoriaMetricsSingle)
    );
    assert_eq!(
        kind(&service("vm", "vmselect-x", 8481, "/select/0/prometheus")),
        Some(MetricsSourceKind::VictoriaMetricsCluster)
    );
    assert_eq!(
        kind(&service(
            "vm",
            "my-select",
            8481,
            "/select/12:34/prometheus/"
        )),
        Some(MetricsSourceKind::VictoriaMetricsCluster)
    );
    assert_eq!(
        kind(&service("vm", "my-select", 8481, "/select/x/prometheus")),
        None
    );
    assert_eq!(kind(&service("vm", "thanos-query", 9090, "")), None);
    let url = |u: &str| PrometheusTarget::Url { url: u.into() };
    assert_eq!(
        kind(&url("https://vm.example.com/select/0/prometheus")),
        Some(MetricsSourceKind::VictoriaMetricsCluster)
    );
    assert_eq!(
        kind(&url("https://vm.example.com:8481/select/1:2/prometheus/")),
        Some(MetricsSourceKind::VictoriaMetricsCluster)
    );
    assert_eq!(kind(&url("https://prometheus.example.com")), None);
    assert_eq!(kind(&url("https://x.example.com/select//prometheus")), None);
}

const VM_SINGLE: &str =
    "/api/v1/namespaces/victoria-metrics/services/vm-victoria-metrics-single-server:8428/proxy";
const VMSELECT: &str = "/api/v1/namespaces/vm/services/vmselect-vm:8481/proxy/select/0/prometheus";
const PROMETHEUS: &str = "/api/v1/namespaces/observability/services/prometheus:9090/proxy";

#[tokio::test]
async fn prometheus_comes_first_even_in_a_later_namespace() {
    let api = cluster(
        &[
            ("monitoring", &[("vmsingle-vm", &[8429])]),
            ("observability", &[("prometheus", &[9090])]),
        ],
        &[
            "/api/v1/namespaces/monitoring/services/vmsingle-vm:8429/proxy",
            PROMETHEUS,
        ],
    )
    .await;
    assert_eq!(
        detect_uncached(&client(&api)).await,
        Some(service("observability", "prometheus", 9090, ""))
    );
}

#[tokio::test]
async fn victoria_metrics_is_found_where_there_is_no_prometheus() {
    let api = cluster(
        &[(
            "victoria-metrics",
            &[
                ("vmagent-vm", &[8429]),
                ("vm-victoria-metrics-single-server", &[8428]),
            ],
        )],
        &[VM_SINGLE],
    )
    .await;
    assert_eq!(
        detect_uncached(&client(&api)).await,
        Some(service(
            "victoria-metrics",
            "vm-victoria-metrics-single-server",
            8428,
            ""
        ))
    );
    // vmagent was never asked.
    assert!(api.requests().iter().all(|r| !r.path.contains("vmagent")));
}

#[tokio::test]
async fn vmselect_is_probed_and_used_under_its_tenant_path() {
    let api = cluster(&[("vm", &[("vmselect-vm", &[8481])])], &[VMSELECT]).await;
    let found = detect_uncached(&client(&api)).await;
    assert_eq!(
        found,
        Some(service("vm", "vmselect-vm", 8481, VMSELECT_PATH_PREFIX))
    );
    assert_eq!(api.count(&format!("{VMSELECT}/api/v1/status/buildinfo")), 1);

    // Queries go under the same prefix.
    let prometheus = Prometheus::new(&client(&api), &found.unwrap()).unwrap();
    let _ = prometheus.query("up").await;
    assert_eq!(api.count(&format!("{VMSELECT}/api/v1/query")), 1);
}

#[tokio::test]
async fn a_server_without_buildinfo_is_probed_with_a_constant_query() {
    // VictoriaMetrics before v1.77.0 has no buildinfo handler.
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api/v1/namespaces/vm/services" => {
            Reply::json(200, service_list(&[("vmsingle-old", &[8429])]))
        }
        p if p.ends_with("/services") => Reply::json(200, service_list(&[])),
        p if p.ends_with("/api/v1/status/buildinfo") => Reply::json(
            400,
            r#"{"status":"error","errorType":"bad_data","error":"unsupported path"}"#,
        ),
        p if p.ends_with("/api/v1/query") && req.query.contains("vector%281%29") => {
            Reply::json(200, VECTOR)
        }
        _ => Reply::not_found(),
    })
    .await;
    assert_eq!(
        detect_uncached(&client(&api)).await,
        Some(service("vm", "vmsingle-old", 8429, ""))
    );

    // A server that answers neither is not taken.
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api/v1/namespaces/vm/services" => {
            Reply::json(200, service_list(&[("vmsingle-old", &[8429])]))
        }
        p if p.ends_with("/services") => Reply::json(200, service_list(&[])),
        _ => Reply::json(400, "not json"),
    })
    .await;
    assert_eq!(detect_uncached(&client(&api)).await, None);
}
