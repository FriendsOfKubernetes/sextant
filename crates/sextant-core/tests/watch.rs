//! Live watch (`resources::watch`) and reading one object (`resources::get`) against the kind test cluster.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test watch -- --test-threads=1
//! ```
//!
//! `watch_survives_a_cluster_restart` stops and starts the kind container; it runs only with
//! `SEXTANT_TEST_DOCKER_RESTART=1` as well.

mod common;

use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use futures::{Stream, StreamExt};
use k8s_openapi::api::apps::v1::Deployment;
use kube::Api;
use kube::api::{Patch, PatchParams};
use serde_json::{Value, json};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::resources::{self, KindRef, ObjectRef, WatchSpec, WatchUpdate};
use sextant_core::{ClusterId, ClusterManager, ErrorCode, KubeconfigRegistry};

type Updates = Pin<Box<dyn Stream<Item = WatchUpdate> + Send>>;

/// A manager connected to the only context of `kubeconfig`.
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

fn kind(group: &str, version: &str, kind: &str) -> KindRef {
    KindRef {
        group: group.into(),
        version: version.into(),
        kind: kind.into(),
    }
}

fn spec(kind: KindRef, namespaces: Option<&[&str]>, labels: Option<&str>) -> WatchSpec {
    WatchSpec {
        kind,
        namespaces: namespaces.map(|ns| ns.iter().map(|n| n.to_string()).collect()),
        label_selector: labels.map(str::to_owned),
        field_selector: None,
    }
}

async fn start(mgr: &ClusterManager, id: &ClusterId, spec: WatchSpec) -> Updates {
    Box::pin(resources::watch(mgr, id, spec).await.expect("watch starts"))
}

/// The next update, failing the test after `secs`.
async fn next(updates: &mut Updates, secs: u64) -> WatchUpdate {
    tokio::time::timeout(Duration::from_secs(secs), updates.next())
        .await
        .unwrap_or_else(|_| panic!("no watch update in {secs}s"))
        .expect("the watch stream ended")
}

fn snapshot(update: WatchUpdate) -> Vec<Value> {
    match update {
        WatchUpdate::Snapshot { items } => items,
        other => panic!("expected a snapshot, got {other:?}"),
    }
}

fn names(items: &[Value]) -> Vec<String> {
    let mut names: Vec<String> = items
        .iter()
        .map(|o| o["metadata"]["name"].as_str().unwrap().to_owned())
        .collect();
    names.sort();
    names
}

async fn scale_nginx(client: kube::Client, replicas: i32) {
    Api::<Deployment>::namespaced(client, common::DEMO_NAMESPACE)
        .patch(
            "nginx",
            &PatchParams::default(),
            &Patch::Merge(json!({ "spec": { "replicas": replicas } })),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn pods_snapshot_then_batched_deltas_follow_a_scale() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let pods = kind("", "v1", "Pod");
    let mut updates = start(
        &mgr,
        &id,
        spec(pods, Some(&[common::DEMO_NAMESPACE]), Some("app=nginx")),
    )
    .await;

    let items = snapshot(next(&mut updates, 30).await);
    assert_eq!(items.len(), 2, "{:?}", names(&items));
    for pod in &items {
        assert_eq!(pod["kind"], "Pod");
        assert_eq!(pod["apiVersion"], "v1");
        assert!(pod["metadata"]["uid"].is_string());
        assert!(
            pod["metadata"].get("managedFields").is_none(),
            "managedFields are stripped"
        );
    }

    scale_nginx(cluster.client().await, 3).await;
    let mut last = Instant::now();
    let mut new_pod = None;
    let deadline = Instant::now() + Duration::from_secs(60);
    while new_pod.is_none() && Instant::now() < deadline {
        let update = next(&mut updates, 60).await;
        let now = Instant::now();
        // Batches: at most one update per 250 ms.
        assert!(
            now - last >= Duration::from_millis(200),
            "updates {:?} apart",
            now - last
        );
        last = now;
        if let WatchUpdate::Delta { upserted, .. } = update {
            new_pod = upserted.into_iter().find(|p| {
                !items
                    .iter()
                    .any(|o| o["metadata"]["uid"] == p["metadata"]["uid"])
            });
        }
    }
    let new_pod = new_pod.expect("the new pod arrives as a delta");
    assert!(new_pod["metadata"].get("managedFields").is_none());
    let new_uid = new_pod["metadata"]["uid"].as_str().unwrap().to_owned();

    scale_nginx(cluster.client().await, 2).await;
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut deleted = Vec::new();
    while deleted.is_empty() && Instant::now() < deadline {
        if let WatchUpdate::Delta { deleted: d, .. } = next(&mut updates, 90).await {
            deleted = d;
        }
    }
    assert_eq!(deleted.len(), 1, "one pod deleted after scaling back");
    // kube scales down the newest pod first.
    assert_eq!(deleted[0], new_uid);
}

#[tokio::test]
async fn several_namespaces_are_watched_together() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let mut updates = start(
        &mgr,
        &id,
        spec(
            kind("", "v1", "Service"),
            Some(&[common::DEMO_NAMESPACE, "default"]),
            None,
        ),
    )
    .await;
    let items = snapshot(next(&mut updates, 30).await);
    assert_eq!(names(&items), ["kubernetes", "nginx"]);
}

#[tokio::test]
async fn cluster_scoped_kinds_ignore_namespaces() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let mut updates = start(
        &mgr,
        &id,
        spec(
            kind("", "v1", "Node"),
            Some(&[common::DEMO_NAMESPACE]),
            None,
        ),
    )
    .await;
    let items = snapshot(next(&mut updates, 30).await);
    assert_eq!(names(&items), ["sextant-test-control-plane"]);
}

#[tokio::test]
async fn empty_namespace_gives_an_empty_snapshot() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let mut updates = start(
        &mgr,
        &id,
        spec(kind("", "v1", "Pod"), Some(&["default"]), None),
    )
    .await;
    assert_eq!(snapshot(next(&mut updates, 30).await), Vec::<Value>::new());
}

#[tokio::test]
async fn secrets_without_permission_give_forbidden_and_end() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.limited_kubeconfig).await;
    let mut updates = start(
        &mgr,
        &id,
        spec(
            kind("", "v1", "Secret"),
            Some(&[common::DEMO_NAMESPACE]),
            None,
        ),
    )
    .await;
    match next(&mut updates, 30).await {
        WatchUpdate::Error(err) => assert_eq!(err.code, ErrorCode::Forbidden, "{err}"),
        other => panic!("expected forbidden, got {other:?}"),
    }
    let end = tokio::time::timeout(Duration::from_secs(5), updates.next()).await;
    assert!(
        matches!(end, Ok(None)),
        "the stream ends after a fatal error"
    );

    // Other kinds still work for the same account.
    let mut pods = start(
        &mgr,
        &id,
        spec(
            kind("", "v1", "Pod"),
            Some(&[common::DEMO_NAMESPACE]),
            Some("app=nginx"),
        ),
    )
    .await;
    assert_eq!(snapshot(next(&mut pods, 30).await).len(), 2);
}

#[tokio::test]
async fn custom_resources_and_their_definitions_are_watched() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let mut widgets = start(
        &mgr,
        &id,
        spec(kind("demo.sextant.dev", "v1", "Widget"), None, None),
    )
    .await;
    let items = snapshot(next(&mut widgets, 30).await);
    assert_eq!(names(&items), ["demo-widget"]);
    assert_eq!(items[0]["spec"]["size"], "large");
    assert_eq!(items[0]["apiVersion"], "demo.sextant.dev/v1");
    assert_eq!(items[0]["kind"], "Widget");

    let mut crds = start(
        &mgr,
        &id,
        spec(
            kind("apiextensions.k8s.io", "v1", "CustomResourceDefinition"),
            None,
            None,
        ),
    )
    .await;
    let items = snapshot(next(&mut crds, 30).await);
    assert!(names(&items).contains(&"widgets.demo.sextant.dev".to_owned()));
}

#[tokio::test]
async fn unknown_kind_or_disconnected_cluster_cannot_be_watched() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let err = resources::watch(
        &mgr,
        &id,
        spec(kind("nope.example", "v1", "Nope"), None, None),
    )
    .await
    .err()
    .expect("unknown kind fails");
    assert_eq!(err.code, ErrorCode::NotFound, "{err}");

    mgr.disconnect(&id).await;
    let err = resources::watch(&mgr, &id, spec(kind("", "v1", "Pod"), None, None))
        .await
        .err()
        .expect("disconnected cluster fails");
    assert_eq!(err.code, ErrorCode::NotFound, "{err}");
}

#[tokio::test]
async fn get_returns_the_object_without_managed_fields() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let nginx = ObjectRef {
        kind: kind("apps", "v1", "Deployment"),
        namespace: Some(common::DEMO_NAMESPACE.into()),
        name: "nginx".into(),
    };
    let obj = resources::get(&mgr, &id, &nginx).await.unwrap();
    assert_eq!(obj["kind"], "Deployment");
    assert_eq!(obj["apiVersion"], "apps/v1");
    assert_eq!(obj["metadata"]["name"], "nginx");
    assert!(obj["spec"]["template"].is_object());
    assert!(obj["metadata"].get("managedFields").is_none());

    let node = ObjectRef {
        kind: kind("", "v1", "Node"),
        namespace: None,
        name: "sextant-test-control-plane".into(),
    };
    assert_eq!(
        resources::get(&mgr, &id, &node).await.unwrap()["kind"],
        "Node"
    );

    let missing = ObjectRef {
        name: "no-such-deployment".into(),
        ..nginx
    };
    let err = resources::get(&mgr, &id, &missing).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{err}");
}

#[tokio::test]
async fn get_without_permission_gives_forbidden() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.limited_kubeconfig).await;
    let secret = ObjectRef {
        kind: kind("", "v1", "Secret"),
        namespace: Some(common::DEMO_NAMESPACE.into()),
        name: "demo-secret".into(),
    };
    let err = resources::get(&mgr, &id, &secret).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden, "{err}");
}

fn docker(args: &[&str]) {
    let status = std::process::Command::new("docker")
        .args(args)
        .status()
        .expect("docker runs");
    assert!(status.success(), "docker {args:?} failed");
}

#[tokio::test]
async fn watch_survives_a_cluster_restart() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    if std::env::var_os("SEXTANT_TEST_DOCKER_RESTART").is_none() {
        eprintln!(
            "skipped: set SEXTANT_TEST_DOCKER_RESTART=1 to stop and start the kind container"
        );
        return;
    }
    let container = "sextant-test-control-plane";
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let mut updates = start(
        &mgr,
        &id,
        spec(
            kind("", "v1", "Pod"),
            Some(&[common::DEMO_NAMESPACE]),
            Some("app=nginx"),
        ),
    )
    .await;
    let before = snapshot(next(&mut updates, 30).await);
    assert_eq!(before.len(), 2);

    docker(&["stop", container]);
    let mut reconnecting = false;
    let deadline = Instant::now() + Duration::from_secs(120);
    while !reconnecting && Instant::now() < deadline {
        match next(&mut updates, 120).await {
            WatchUpdate::Reconnecting => reconnecting = true,
            WatchUpdate::Error(err) => panic!("a lost connection is not fatal: {err}"),
            _ => {}
        }
    }
    docker(&["start", container]);
    assert!(reconnecting, "the watch reports reconnecting");

    // Fresh data once the API server is back (a new list, not a resumed watch).
    let deadline = Instant::now() + Duration::from_secs(240);
    let mut fresh = None;
    while fresh.is_none() && Instant::now() < deadline {
        match next(&mut updates, 240).await {
            WatchUpdate::Snapshot { items } => fresh = Some(items),
            WatchUpdate::Error(err) => panic!("a lost connection is not fatal: {err}"),
            _ => {}
        }
    }
    let fresh = fresh.expect("a fresh snapshot after the restart");
    assert_eq!(fresh.len(), 2, "{:?}", names(&fresh));
}
