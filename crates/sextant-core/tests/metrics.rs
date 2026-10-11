//! Metrics against the kind test cluster: metrics-server, and the Prometheus from `scripts/fixtures/prometheus/`
//! (`scripts/test-cluster.sh up --prometheus`, namespace `monitoring`, service `prometheus-operated:9090`).
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test metrics -- --test-threads=1
//! ```
//!
//! Tests that need Prometheus return early (and pass) when the fixture is not installed. Nothing is changed in the
//! cluster. The direct-URL test serves a canned Prometheus answer on 127.0.0.1 and needs no cluster.

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

use k8s_openapi::api::core::v1::{Node, Service};
use kube::Api;
use kube::api::ListParams;
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::metrics::{
    self, ChartTarget, PrometheusMode, PrometheusTarget, Series, UsageSource,
};
use sextant_core::{ClusterId, ClusterManager, ClusterSettings, ErrorCode, KubeconfigRegistry};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HOUR: i64 = 3600;

async fn connected(kubeconfig: &Path) -> (tempfile::TempDir, ClusterManager, ClusterId) {
    let tmp = tempfile::tempdir().unwrap();
    let registry =
        KubeconfigRegistry::new(Vec::new(), tmp.path().to_path_buf()).with_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.as_os_str().to_owned()),
            home: None,
        });
    let id = registry.clusters().unwrap()[0].id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
    mgr.connect(&id).await.unwrap();
    (tmp, mgr, id)
}

fn fixture_prometheus() -> PrometheusTarget {
    PrometheusTarget::Service {
        namespace: "monitoring".into(),
        service: "prometheus-operated".into(),
        port: 9090,
        path_prefix: String::new(),
    }
}

fn missing_prometheus() -> PrometheusTarget {
    PrometheusTarget::Service {
        namespace: "monitoring".into(),
        service: "no-such-prometheus".into(),
        port: 9090,
        path_prefix: String::new(),
    }
}

fn settings(prometheus: PrometheusMode, usage_source: UsageSource) -> ClusterSettings {
    ClusterSettings {
        prometheus,
        usage_source,
        ..Default::default()
    }
}

/// The Prometheus fixture is installed (its service exists); otherwise a note and `false`.
async fn has_prometheus(client: &kube::Client) -> bool {
    let services: Api<Service> = Api::namespaced(client.clone(), "monitoring");
    let found = services
        .get_opt("prometheus-operated")
        .await
        .ok()
        .flatten()
        .is_some();
    if !found {
        eprintln!(
            "skipped: the Prometheus fixture is not installed (scripts/test-cluster.sh up --prometheus)"
        );
    }
    found
}

async fn ready_node(client: &kube::Client) -> String {
    let nodes: Api<Node> = Api::all(client.clone());
    nodes
        .list(&ListParams::default())
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|n| {
            n.status
                .as_ref()
                .and_then(|s| s.conditions.as_ref())
                .is_some_and(|c| c.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
        })
        .and_then(|n| n.metadata.name)
        .expect("a ready node")
}

/// The name of a running nginx pod of the demo deployment.
async fn nginx_pod(client: &kube::Client) -> String {
    let pods: Api<k8s_openapi::api::core::v1::Pod> =
        Api::namespaced(client.clone(), common::DEMO_NAMESPACE);
    pods.list(&ListParams::default().labels("app=nginx"))
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|p| p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"))
        .and_then(|p| p.metadata.name)
        .expect("a running nginx pod in sextant-demo")
}

fn metric<'a>(series: &'a [Series], name: &str) -> &'a Series {
    series
        .iter()
        .find(|s| s.metric == name)
        .unwrap_or_else(|| panic!("no {name} series in {series:?}"))
}

#[tokio::test]
async fn metrics_server_fills_pod_and_node_usage() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let client = cluster.client().await;
    let s = settings(PrometheusMode::Off, UsageSource::MetricsServer);

    let pods = metrics::pod_usage(&mgr, &id, &s, Some(vec![common::DEMO_NAMESPACE.into()]))
        .await
        .unwrap();
    let pod = nginx_pod(&client).await;
    let nginx = pods
        .iter()
        .find(|p| p.name == pod)
        .unwrap_or_else(|| panic!("no usage of {pod} in {pods:?}"));
    assert_eq!(nginx.namespace, common::DEMO_NAMESPACE);
    assert!(nginx.usage.memory_bytes > 1024.0 * 1024.0, "{nginx:?}");
    assert_eq!(nginx.containers[0].0, "nginx");
    assert!(pods.iter().all(|p| p.namespace == common::DEMO_NAMESPACE));

    let nodes = metrics::node_usage(&mgr, &id, &s).await.unwrap();
    let node = ready_node(&client).await;
    let usage = nodes
        .iter()
        .find(|n| n.name == node)
        .expect("usage of the ready node");
    assert!(usage.usage.cpu_millicores > 0.0, "{usage:?}");
    assert!(
        usage.usage.memory_bytes > 64.0 * 1024.0 * 1024.0,
        "{usage:?}"
    );
}

#[tokio::test]
async fn auto_finds_the_prometheus_fixture() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    if !has_prometheus(&cluster.client().await).await {
        return;
    }
    let found = metrics::prometheus_target(&mgr, &id, &PrometheusMode::Auto)
        .await
        .unwrap();
    assert_eq!(found, Some(fixture_prometheus()));

    let status =
        metrics::metrics_status(&mgr, &id, &PrometheusMode::Auto, &UsageSource::Auto).await;
    assert!(status.metrics_server);
    assert_eq!(status.prometheus, Some(fixture_prometheus()));
    // Both sources: current values from metrics-server.
    assert_eq!(
        status.effective_usage_source,
        Some(UsageSource::MetricsServer)
    );
}

#[tokio::test]
async fn charts_of_pod_deployment_node_and_cluster() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let client = cluster.client().await;
    if !has_prometheus(&client).await {
        return;
    }
    let target = fixture_prometheus();
    let ns = common::DEMO_NAMESPACE.to_owned();

    let pod = nginx_pod(&client).await;
    let series = metrics::query_charts(
        &mgr,
        &id,
        &target,
        ChartTarget::Pod {
            namespace: ns.clone(),
            name: pod,
        },
        HOUR,
    )
    .await
    .unwrap();
    assert!(
        metric(&series, "memory")
            .points
            .iter()
            .all(|(_, v)| *v > 0.0)
    );
    assert!(!metric(&series, "cpu").points.is_empty());

    let series = metrics::query_charts(
        &mgr,
        &id,
        &target,
        ChartTarget::Workload {
            namespace: ns,
            kind: "Deployment".into(),
            name: "nginx".into(),
        },
        HOUR,
    )
    .await
    .unwrap();
    assert!(
        metric(&series, "memory")
            .points
            .iter()
            .all(|(_, v)| *v > 0.0)
    );
    assert!(!metric(&series, "cpu").points.is_empty());

    let node = ready_node(&client).await;
    let series = metrics::query_charts(&mgr, &id, &target, ChartTarget::Node { name: node }, HOUR)
        .await
        .unwrap();
    for name in ["cpu", "memory", "pods", "disk"] {
        let s = metric(&series, name);
        assert!(s.points.iter().any(|(_, v)| *v > 0.0), "{name}: {s:?}");
    }
    // Points are (unix seconds, value), oldest first, within the last hour.
    let points = &metric(&series, "memory").points;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    assert!(points.windows(2).all(|w| w[0].0 < w[1].0));
    assert!(
        points
            .iter()
            .all(|(t, _)| *t > now - HOUR - 120 && *t <= now)
    );

    let series = metrics::query_charts(&mgr, &id, &target, ChartTarget::Cluster, HOUR)
        .await
        .unwrap();
    for name in ["cpu", "memory", "pods", "disk"] {
        let s = metric(&series, name);
        assert!(s.points.iter().any(|(_, v)| *v > 0.0), "{name}: {s:?}");
    }
}

#[tokio::test]
async fn manual_target_is_used_instead_of_the_detected_one() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    if !has_prometheus(&cluster.client().await).await {
        return;
    }
    let manual = PrometheusMode::Manual {
        target: missing_prometheus(),
    };
    assert_eq!(
        metrics::prometheus_target(&mgr, &id, &manual)
            .await
            .unwrap(),
        Some(missing_prometheus())
    );
    // The manual address does not answer: nothing is reported, although auto would find the fixture.
    let status = metrics::metrics_status(&mgr, &id, &manual, &UsageSource::Prometheus).await;
    assert_eq!(status.prometheus, None);
    assert_eq!(status.effective_usage_source, None);
    let err = metrics::pod_usage(&mgr, &id, &settings(manual, UsageSource::Prometheus), None)
        .await
        .unwrap_err();
    assert_ne!(err.code, ErrorCode::Other, "{err:?}");

    let manual = PrometheusMode::Manual {
        target: fixture_prometheus(),
    };
    let status = metrics::metrics_status(&mgr, &id, &manual, &UsageSource::Prometheus).await;
    assert_eq!(status.prometheus, Some(fixture_prometheus()));
    assert_eq!(status.effective_usage_source, Some(UsageSource::Prometheus));

    // Off: no Prometheus at all.
    assert_eq!(
        metrics::prometheus_target(&mgr, &id, &PrometheusMode::Off)
            .await
            .unwrap(),
        None
    );
    let status = metrics::metrics_status(&mgr, &id, &PrometheusMode::Off, &UsageSource::Auto).await;
    assert_eq!(status.prometheus, None);
    assert_eq!(
        status.effective_usage_source,
        Some(UsageSource::MetricsServer)
    );
}

#[tokio::test]
async fn usage_source_switches_between_metrics_server_and_prometheus() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let client = cluster.client().await;
    if !has_prometheus(&client).await {
        return;
    }
    let demo = Some(vec![common::DEMO_NAMESPACE.to_owned()]);
    let pod = nginx_pod(&client).await;

    // prometheus: values from Prometheus — they depend on Prometheus being reachable, not on metrics-server.
    let from_prometheus = settings(PrometheusMode::Auto, UsageSource::Prometheus);
    let pods = metrics::pod_usage(&mgr, &id, &from_prometheus, demo.clone())
        .await
        .unwrap();
    let nginx = pods
        .iter()
        .find(|p| p.name == pod)
        .expect("nginx from Prometheus");
    assert!(nginx.usage.memory_bytes > 1024.0 * 1024.0, "{nginx:?}");
    assert_eq!(nginx.containers[0].0, "nginx");
    assert!(pods.iter().all(|p| p.namespace == common::DEMO_NAMESPACE));
    let node = ready_node(&client).await;
    let nodes = metrics::node_usage(&mgr, &id, &from_prometheus)
        .await
        .unwrap();
    let usage = nodes
        .iter()
        .find(|n| n.name == node)
        .expect("node usage from Prometheus");
    assert!(
        usage.usage.cpu_millicores > 0.0 && usage.usage.memory_bytes > 0.0,
        "{usage:?}"
    );

    let unreachable = settings(
        PrometheusMode::Manual {
            target: missing_prometheus(),
        },
        UsageSource::Prometheus,
    );
    assert!(
        metrics::pod_usage(&mgr, &id, &unreachable, demo.clone())
            .await
            .is_err()
    );
    let off = settings(PrometheusMode::Off, UsageSource::Prometheus);
    let err = metrics::node_usage(&mgr, &id, &off).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);

    // metrics-server (and auto, which prefers it) do not need Prometheus.
    for usage_source in [UsageSource::MetricsServer, UsageSource::Auto] {
        let s = settings(
            PrometheusMode::Manual {
                target: missing_prometheus(),
            },
            usage_source,
        );
        let pods = metrics::pod_usage(&mgr, &id, &s, demo.clone())
            .await
            .unwrap();
        assert!(
            pods.iter().any(|p| p.name == pod),
            "{usage_source:?}: {pods:?}"
        );
    }

    // off: no values at all.
    let s = settings(PrometheusMode::Auto, UsageSource::Off);
    assert_eq!(
        metrics::pod_usage(&mgr, &id, &s, demo)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    let status = metrics::metrics_status(&mgr, &id, &PrometheusMode::Auto, &UsageSource::Off).await;
    assert_eq!(status.effective_usage_source, None);
    assert_eq!(status.usage_source, UsageSource::Off);
}

/// A one-shot HTTP server that answers every request with `body` and records the request lines.
async fn canned_server(body: &'static str) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16 * 1024];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                log.lock()
                    .unwrap()
                    .push(request.lines().next().unwrap_or_default().to_owned());
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (format!("http://{addr}"), seen)
}

#[tokio::test]
async fn direct_url_target_is_queried_with_its_path_prefix() {
    // A cluster is still needed for the manager, but the queries go straight to the URL.
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let (url, seen) = canned_server(
        r#"{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1700000000,"250"],[1700000060,"NaN"],[1700000120,"500"]]}]}}"#,
    )
    .await;
    let target = PrometheusTarget::Url {
        url: format!("{url}/prom"),
    };
    let series = metrics::query_charts(
        &mgr,
        &id,
        &target,
        ChartTarget::Pod {
            namespace: "ns".into(),
            name: "web-0".into(),
        },
        HOUR,
    )
    .await
    .unwrap();
    // NaN points are dropped.
    assert_eq!(
        metric(&series, "cpu").points,
        vec![(1700000000, 250.0), (1700000120, 500.0)]
    );
    let requests = seen.lock().unwrap().clone();
    assert!(!requests.is_empty());
    for line in &requests {
        assert!(
            line.starts_with("GET /prom/api/v1/query_range?query="),
            "{line}"
        );
        assert!(line.contains("web-0"), "{line}");
    }
}
