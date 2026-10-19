//! Fill levels of claims (#152) against the kind cluster: the admin reads every node's kubelet stats summary through
//! the API server; the `limited` ServiceAccount may not, and is told so (or gets Prometheus' numbers). kind's
//! local-path volumes are hostPath volumes, which the kubelet does not measure, so no claim shows up here: the numbers
//! themselves are covered by the unit tests on the fake API server.

mod common;

use sextant_core::ErrorCode;
use sextant_core::metrics::{PrometheusMode, VolumeUsageSource, volume_usage};

#[tokio::test]
async fn the_admin_reads_every_nodes_stats_summary() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let report = volume_usage(&mgr, &id, &PrometheusMode::Off).await.unwrap();
    assert_eq!(report.source, VolumeUsageSource::Kubelet);
    assert!(report.nodes >= 1, "{report:?}");
    assert_eq!(report.nodes_failed, 0, "{report:?}");
    assert!(!report.kubelet_forbidden && !report.truncated);
}

#[tokio::test]
async fn without_nodes_proxy_the_user_is_told_or_gets_prometheus() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&cluster.limited_kubeconfig).await;
    match volume_usage(&mgr, &id, &PrometheusMode::Off).await {
        Err(err) => {
            assert_eq!(err.code, ErrorCode::Forbidden, "{err:?}");
            assert!(err.message.contains("Prometheus"), "{}", err.message);
        }
        Ok(report) => panic!("the limited account read the kubelets: {report:?}"),
    }
}
