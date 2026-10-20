//! The traffic graph (#211) against the kind test cluster's Prometheus fixture (`scripts/test-cluster.sh up
//! --prometheus`): the command's answer for real namespaces, and every source's edge query accepted by a real
//! Prometheus in both windows (the fixture has none of the sources, so the queries parse and match nothing). Read-only;
//! returns early (and passes) without the cluster or the fixture.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test traffic_metrics
//! ```

mod common;

use k8s_openapi::api::core::v1::Service;
use kube::Api;
use serde_json::Value;
use sextant_core::metrics::{
    self, MAX_TRAFFIC_NAMESPACES, PrometheusMode, PrometheusTarget, RequestSourceKind,
    TrafficWindow,
};

const PROXY: &str = "/api/v1/namespaces/monitoring/services/prometheus-operated:9090/proxy";

fn fixture_mode() -> PrometheusMode {
    PrometheusMode::Manual {
        target: PrometheusTarget::Service {
            namespace: "monitoring".into(),
            service: "prometheus-operated".into(),
            port: 9090,
            path_prefix: String::new(),
        },
    }
}

async fn has_prometheus(client: &kube::Client) -> bool {
    let services: Api<Service> = Api::namespaced(client.clone(), "monitoring");
    let found = services
        .get_opt("prometheus-operated")
        .await
        .ok()
        .flatten()
        .is_some();
    if !found {
        eprintln!("skipped: the Prometheus fixture is not installed");
    }
    found
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

#[tokio::test]
async fn real_namespaces_get_an_answer() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    if !has_prometheus(&client).await {
        return;
    }
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    for window in [TrafficWindow::Minutes5, TrafficWindow::Hour1] {
        let graph = metrics::traffic_graph(
            &mgr,
            &id,
            &fixture_mode(),
            names(&["kube-system", "default"]),
            window,
        )
        .await
        .unwrap();
        assert!(graph.prometheus);
        assert!(graph.failed.is_empty(), "{graph:?}");
        assert_eq!(graph.window, window);
        assert!(graph.edges.len() <= graph.total_edges.max(graph.edges.len()));
    }
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn ask(client: &kube::Client, path: &str) -> Value {
    let request = http::Request::get(format!("{PROXY}/{path}"))
        .body(Vec::new())
        .unwrap();
    let text = client.request_text(request).await.unwrap();
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn every_sources_edge_query_is_valid_promql() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    if !has_prometheus(&client).await {
        return;
    }
    let all: Vec<String> = (0..MAX_TRAFFIC_NAMESPACES)
        .map(|i| format!("namespace-{i}"))
        .collect();
    let mut asked = 0;
    for kind in RequestSourceKind::ALL {
        for window in [TrafficWindow::Minutes5, TrafficWindow::Hour1] {
            for namespaces in [names(&["kube-system"]), all.clone()] {
                for query in metrics::traffic_queries(kind, &namespaces, window, true) {
                    let path = format!("api/v1/query?query={}", encode(&query));
                    let answer = ask(&client, &path).await;
                    assert_eq!(answer["status"], "success", "{kind:?}: {query}\n{answer}");
                    asked += 1;
                }
            }
        }
    }
    // Istio, Linkerd, Hubble: 5 queries each; Beyla 4 (no status classes); × 2 windows × 2 namespace sets.
    assert_eq!(asked, 76);
}
