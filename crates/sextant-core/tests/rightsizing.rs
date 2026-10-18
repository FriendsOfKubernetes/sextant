//! Usage history for right-sizing (#137) against the kind test cluster's Prometheus fixture
//! (`scripts/test-cluster.sh up --prometheus`). Read-only; returns early (and passes) without the cluster or fixture.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test rightsizing
//! ```

mod common;

use k8s_openapi::api::core::v1::Service;
use kube::Api;
use sextant_core::ErrorCode;
use sextant_core::metrics::{self, HistoryScope, HistoryWindow, PrometheusTarget};

fn fixture_prometheus() -> PrometheusTarget {
    PrometheusTarget::Service {
        namespace: "monitoring".into(),
        service: "prometheus-operated".into(),
        port: 9090,
        path_prefix: String::new(),
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

#[tokio::test]
async fn history_of_a_namespace_and_of_one_workload() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    if !has_prometheus(&client).await {
        return;
    }
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let target = fixture_prometheus();

    let scope = HistoryScope::Namespaces {
        namespaces: Some(vec!["kube-system".into()]),
    };
    let history = metrics::usage_history(&mgr, &id, &target, scope, HistoryWindow::Day)
        .await
        .unwrap();
    assert_eq!(history.window_secs, 86_400);
    assert!(!history.truncated);
    let coredns: Vec<_> = history
        .containers
        .iter()
        .filter(|c| c.container == "coredns")
        .collect();
    assert!(!coredns.is_empty(), "{:?}", history.containers);
    for c in &history.containers {
        assert_eq!(c.namespace, "kube-system");
        assert!(c.memory_max_bytes.is_some_and(|m| m > 0.0), "{c:?}");
        assert!(c.cpu_p95_millicores.is_some(), "{c:?}");
        assert!(
            c.first_seen.is_some_and(
                |t| t <= history.evaluated_at && t > history.evaluated_at - 86_400 - 600
            ),
            "{c:?}"
        );
    }

    let workload = HistoryScope::Workload {
        namespace: "kube-system".into(),
        kind: "Deployment".into(),
        name: "coredns".into(),
    };
    let only = metrics::usage_history(&mgr, &id, &target, workload, HistoryWindow::Week)
        .await
        .unwrap();
    assert!(!only.containers.is_empty());
    assert!(
        only.containers
            .iter()
            .all(|c| c.pod.starts_with("coredns-"))
    );

    assert!(only.coverage_known && only.live_known);
    assert!(only.containers.iter().all(|c| c.last_seen.is_some()));

    // Owner-shaped names only: the DaemonSet `kindnet` has `kindnet-<5>` pods; a Deployment or DaemonSet `kube`
    // takes none of `kube-proxy-<5>`, `kube-apiserver-<node>` and the like.
    let daemonset = HistoryScope::Workload {
        namespace: "kube-system".into(),
        kind: "DaemonSet".into(),
        name: "kindnet".into(),
    };
    let kindnet = metrics::usage_history(&mgr, &id, &target, daemonset, HistoryWindow::Day)
        .await
        .unwrap();
    assert!(!kindnet.containers.is_empty());
    for kind in ["Deployment", "DaemonSet"] {
        let scope = HistoryScope::Workload {
            namespace: "kube-system".into(),
            kind: kind.into(),
            name: "kube".into(),
        };
        let none = metrics::usage_history(&mgr, &id, &target, scope, HistoryWindow::Day)
            .await
            .unwrap();
        assert!(none.containers.is_empty(), "{kind}: {:?}", none.containers);
    }

    let bad = HistoryScope::Pod {
        namespace: "kube-system".into(),
        name: r#"x"} or vector(1"#.into(),
    };
    let err = metrics::usage_history(&mgr, &id, &target, bad, HistoryWindow::Day)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
}
