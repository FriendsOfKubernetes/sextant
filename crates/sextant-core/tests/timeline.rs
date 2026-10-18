//! Change timeline against the test cluster (#145), read-only: the field managers of a Deployment kind runs
//! (`coredns` in `kube-system`), the partial history of `kube-system` (managers' last changes, the Deployment's
//! ReplicaSet revision, DaemonSet ControllerRevisions) and one object's history. Nothing is written to the cluster.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test timeline -- --test-threads=1
//! ```

mod common;

use sextant_core::timeline::{self, HistorySource};
use sextant_core::{KindRef, ObjectRef};

fn kind(group: &str, k: &str) -> KindRef {
    KindRef {
        group: group.into(),
        version: "v1".into(),
        kind: k.into(),
    }
}

fn coredns() -> ObjectRef {
    ObjectRef {
        kind: kind("apps", "Deployment"),
        namespace: Some("kube-system".into()),
        name: "coredns".into(),
    }
}

#[tokio::test]
async fn managers_and_partial_history_of_kube_system() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;

    let found = timeline::managers(&mgr, &id, vec![coredns()])
        .await
        .unwrap();
    assert!(found[0].error.is_none(), "{:?}", found[0].error);
    assert!(found[0].uid.is_some());
    assert!(
        found[0].managers.iter().any(|m| m.time.is_some()),
        "{:?}",
        found[0].managers
    );

    let history = timeline::history(
        &mgr,
        &id,
        vec!["kube-system".into()],
        vec![
            kind("apps", "Deployment"),
            kind("apps", "ReplicaSet"),
            kind("apps", "ControllerRevision"),
            kind("", "ConfigMap"),
        ],
        true,
    )
    .await
    .unwrap();
    assert!(
        history.reports.iter().all(|r| r.error.is_none()),
        "{:?}",
        history.reports
    );
    let has = |source: HistorySource, name: &str| {
        history
            .entries
            .iter()
            .any(|e| e.source == source && e.object.name.starts_with(name))
    };
    assert!(has(HistorySource::FieldManager, "coredns"));
    // coredns's ReplicaSet tells its revision; kube-proxy is a DaemonSet with ControllerRevisions.
    assert!(has(HistorySource::Revision, "coredns-"));
    assert!(has(HistorySource::Revision, "kube-proxy-"));
    // Status writes are never history.
    assert!(
        history
            .entries
            .iter()
            .all(|e| e.subresource.as_deref() != Some("status"))
    );
    let times: Vec<_> = history.entries.iter().map(|e| e.time.clone()).collect();
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(times, sorted, "newest first");

    let object = timeline::object_history(&mgr, &id, coredns())
        .await
        .unwrap();
    assert!(
        object
            .entries
            .iter()
            .any(|e| e.source == HistorySource::Revision
                && e.owner.as_ref().is_some_and(|o| o.name == "coredns")),
        "{:?}",
        object.entries
    );
}
