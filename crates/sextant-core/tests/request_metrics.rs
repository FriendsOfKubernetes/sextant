//! Workload request metrics (#212) against the kind test cluster's Prometheus fixture
//! (`scripts/test-cluster.sh up --prometheus`): the command's answer for a real Deployment, and every source's queries
//! accepted by a real Prometheus (the fixture has none of the sources, so they parse and match nothing). Read-only;
//! returns early (and passes) without the cluster or the fixture.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test request_metrics
//! ```

mod common;

use k8s_openapi::api::core::v1::Service;
use kube::Api;
use serde_json::Value;
use sextant_core::metrics::{
    self, PrometheusMode, PrometheusTarget, RequestSourceKind, RequestTarget,
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

fn coredns() -> RequestTarget {
    RequestTarget::Workload {
        namespace: "kube-system".into(),
        kind: "Deployment".into(),
        name: "coredns".into(),
    }
}

#[tokio::test]
async fn a_real_deployment_gets_an_answer_with_its_throttling() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    if !has_prometheus(&client).await {
        return;
    }
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let health = metrics::request_health(&mgr, &id, &fixture_mode(), coredns())
        .await
        .unwrap();
    assert!(health.prometheus);
    assert!(health.failed.is_empty(), "{health:?}");
    assert!(health.throttling_known, "{health:?}");
    // Every source found has its metrics in this Prometheus; a source with data for coredns would be listed too.
    for golden in &health.golden {
        assert!(health.sources.iter().any(|s| s.kind == golden.source));
    }
    let sources = metrics::request_sources(&mgr, &id, &fixture_mode())
        .await
        .unwrap();
    assert_eq!(sources.sources, health.sources);
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
async fn every_sources_queries_are_valid_promql() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    if !has_prometheus(&client).await {
        return;
    }
    let pod = RequestTarget::Pod {
        namespace: "kube-system".into(),
        name: "coredns-0".into(),
    };
    for kind in RequestSourceKind::ALL {
        for target in [coredns(), pod.clone()] {
            let queries = metrics::request_queries(kind, &target, &["kube-dns".into()], true);
            // Caretta (#236) has edges of the traffic graph only, no request metrics of a workload.
            if kind == RequestSourceKind::Caretta {
                assert!(queries.is_none());
                continue;
            }
            let (instant, range) = queries.unwrap();
            let answer = ask(&client, &format!("api/v1/query?query={}", encode(&instant))).await;
            assert_eq!(answer["status"], "success", "{kind:?}: {instant}\n{answer}");
            let path = format!(
                "api/v1/query_range?query={}&start=1760000000&end=1760003600&step=60",
                encode(&range)
            );
            let answer = ask(&client, &path).await;
            assert_eq!(answer["status"], "success", "{kind:?}: {range}\n{answer}");
        }
    }
}
