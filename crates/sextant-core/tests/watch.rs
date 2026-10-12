//! Live watch (`resources::watch`) and reading one object (`resources::get`) against the kind test cluster.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test watch -- --test-threads=1
//! ```
//!
//! `watch_survives_a_cluster_restart` stops and starts the kind container; it runs only with
//! `SEXTANT_TEST_DOCKER_RESTART=1` as well. `the_first_nodes_come_within_2_seconds_on_a_big_cluster` needs the load
//! fixture (`scripts/fixtures/load/load.sh apply`, then `delete`); without it, it is skipped.

mod common;

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use futures::{FutureExt, Stream, StreamExt};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Pod, Secret};
use k8s_openapi::api::rbac::v1::{Role, RoleBinding};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::Api;
use kube::api::{DeleteParams, ListParams, Patch, PatchParams, PostParams};
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

    // No permission in any of several namespaces: the same error, the stream ends.
    let mut updates = start(
        &mgr,
        &id,
        spec(
            kind("", "v1", "Secret"),
            Some(&[common::DEMO_NAMESPACE, "default"]),
            None,
        ),
    )
    .await;
    loop {
        match next(&mut updates, 30).await {
            WatchUpdate::Forbidden { .. } => continue,
            WatchUpdate::Error(err) => {
                assert_eq!(err.code, ErrorCode::Forbidden, "{err}");
                break;
            }
            other => panic!("expected forbidden, got {other:?}"),
        }
    }
    let end = tokio::time::timeout(Duration::from_secs(5), updates.next()).await;
    assert!(matches!(end, Ok(None)), "the stream ends");

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

/// Waits (up to `secs`) until `done` is true.
async fn wait_until<F, Fut>(what: &str, secs: u64, mut done: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !done().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Runs `body` with a fresh namespace `ns` (deleted before and after, also when `body` panics).
async fn in_namespace<F, Fut>(client: &kube::Client, ns: &str, body: F)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ()>,
{
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(ns, &DeleteParams::background()).await;
    wait_until("the old namespace to go away", 180, || {
        let namespaces = namespaces.clone();
        async move { namespaces.get_opt(ns).await.unwrap().is_none() }
    })
    .await;
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": ns } })).unwrap();
    namespaces
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
    let result = AssertUnwindSafe(body()).catch_unwind().await;
    let _ = namespaces.delete(ns, &DeleteParams::background()).await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

async fn create_secret(client: &kube::Client, ns: &str, name: &str) {
    let secret: Secret = serde_json::from_value(json!({
        "metadata": { "name": name, "namespace": ns },
        "stringData": { "key": "value" }
    }))
    .unwrap();
    Api::<Secret>::namespaced(client.clone(), ns)
        .create(&PostParams::default(), &secret)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_namespace_without_permission_is_reported_and_the_others_keep_streaming() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let admin = cluster.client().await;
    // `limited` may read Secrets only in this namespace (a Role of its own), not in `sextant-demo`.
    let ns = "sextant-watch-forbidden";
    in_namespace(&admin, ns, || async {
        let role: Role = serde_json::from_value(json!({
            "metadata": { "name": "read-secrets", "namespace": ns },
            "rules": [{ "apiGroups": [""], "resources": ["secrets"], "verbs": ["get", "list", "watch"] }]
        }))
        .unwrap();
        Api::<Role>::namespaced(admin.clone(), ns)
            .create(&PostParams::default(), &role)
            .await
            .unwrap();
        let binding: RoleBinding = serde_json::from_value(json!({
            "metadata": { "name": "read-secrets", "namespace": ns },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "read-secrets" },
            "subjects": [{ "kind": "ServiceAccount", "name": "limited", "namespace": common::DEMO_NAMESPACE }]
        }))
        .unwrap();
        Api::<RoleBinding>::namespaced(admin.clone(), ns)
            .create(&PostParams::default(), &binding)
            .await
            .unwrap();
        create_secret(&admin, ns, "visible").await;
        let limited = cluster.limited_client().await;
        wait_until("the Role to take effect", 30, || {
            let secrets: Api<Secret> = Api::namespaced(limited.clone(), ns);
            async move { secrets.list(&Default::default()).await.is_ok() }
        })
        .await;

        let (_tmp, mgr, id) = connected(&cluster.limited_kubeconfig).await;
        let mut updates = start(
            &mgr,
            &id,
            spec(
                kind("", "v1", "Secret"),
                Some(&[ns, common::DEMO_NAMESPACE]),
                None,
            ),
        )
        .await;
        let (mut forbidden, mut items) = (None, None);
        while forbidden.is_none() || items.is_none() {
            match next(&mut updates, 30).await {
                WatchUpdate::Forbidden { namespaces } => forbidden = Some(namespaces),
                WatchUpdate::Snapshot { items: list } => items = Some(list),
                other => panic!("expected forbidden and a snapshot, got {other:?}"),
            }
        }
        assert_eq!(forbidden.unwrap(), [common::DEMO_NAMESPACE]);
        assert_eq!(names(&items.unwrap()), ["visible"]);

        // The allowed namespace keeps streaming.
        create_secret(&admin, ns, "later").await;
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut added = Vec::new();
        while added.is_empty() && Instant::now() < deadline {
            match next(&mut updates, 30).await {
                WatchUpdate::Delta { upserted, .. } => added = names(&upserted),
                WatchUpdate::Error(err) => panic!("the watch ended: {err}"),
                _ => {}
            }
        }
        assert_eq!(added, ["later"]);
    })
    .await;
}

/// A Role in `ns` that lets the `limited` ServiceAccount use `verbs` on Secrets.
async fn grant_secrets(admin: &kube::Client, ns: &str, verbs: &[&str]) {
    let role: Role = serde_json::from_value(json!({
        "metadata": { "name": "secrets", "namespace": ns },
        "rules": [{ "apiGroups": [""], "resources": ["secrets"], "verbs": verbs }]
    }))
    .unwrap();
    Api::<Role>::namespaced(admin.clone(), ns)
        .create(&PostParams::default(), &role)
        .await
        .unwrap();
    let binding: RoleBinding = serde_json::from_value(json!({
        "metadata": { "name": "secrets", "namespace": ns },
        "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "secrets" },
        "subjects": [{ "kind": "ServiceAccount", "name": "limited", "namespace": common::DEMO_NAMESPACE }]
    }))
    .unwrap();
    Api::<RoleBinding>::namespaced(admin.clone(), ns)
        .create(&PostParams::default(), &binding)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_namespace_listed_but_not_watchable_is_left_out_after_its_list_and_the_others_keep_streaming()
 {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let admin = cluster.client().await;
    // `limited` may list Secrets in `list_only` but not watch them; in `full` it may do both.
    let (list_only, full) = ("sextant-watch-list-only", "sextant-watch-full");
    in_namespace(&admin, list_only, || async {
        in_namespace(&admin, full, || async {
            grant_secrets(&admin, list_only, &["get", "list"]).await;
            grant_secrets(&admin, full, &["get", "list", "watch"]).await;
            create_secret(&admin, list_only, "listed").await;
            create_secret(&admin, full, "kept").await;
            let limited = cluster.limited_client().await;
            wait_until("the Roles to take effect", 30, || {
                let (a, b): (Api<Secret>, Api<Secret>) = (
                    Api::namespaced(limited.clone(), list_only),
                    Api::namespaced(limited.clone(), full),
                );
                async move {
                    a.list(&Default::default()).await.is_ok()
                        && b.list(&Default::default()).await.is_ok()
                }
            })
            .await;

            let (_tmp, mgr, id) = connected(&cluster.limited_kubeconfig).await;
            let mut updates = start(
                &mgr,
                &id,
                spec(kind("", "v1", "Secret"), Some(&[list_only, full]), None),
            )
            .await;
            // The list of `list_only` succeeds; its watch is refused right after.
            let (mut forbidden, mut items) = (None, Vec::new());
            let deadline = Instant::now() + Duration::from_secs(30);
            while forbidden.is_none() || names(&items) != ["kept"] {
                assert!(
                    Instant::now() < deadline,
                    "forbidden {forbidden:?}, items {:?}",
                    names(&items)
                );
                match next(&mut updates, 30).await {
                    WatchUpdate::Forbidden { namespaces } => forbidden = Some(namespaces),
                    WatchUpdate::Snapshot { items: list } => items = list,
                    WatchUpdate::Delta { .. } => {}
                    other => panic!("expected forbidden and snapshots, got {other:?}"),
                }
            }
            assert_eq!(forbidden.unwrap(), [list_only]);

            create_secret(&admin, full, "later").await;
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut added = Vec::new();
            while added.is_empty() && Instant::now() < deadline {
                match next(&mut updates, 30).await {
                    WatchUpdate::Delta { upserted, .. } => added = names(&upserted),
                    WatchUpdate::Error(err) => panic!("the watch ended: {err}"),
                    WatchUpdate::Reconnecting => panic!("the watch lost its connection"),
                    _ => {}
                }
            }
            assert_eq!(added, ["later"]);
        })
        .await;
    })
    .await;
}

/// Namespace and CRD label of `scripts/fixtures/load/load.sh`.
const LOAD_NAMESPACE: &str = "sextant-load";
const LOAD_CRDS: &str = "sextant.dev/fixture=load";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_first_nodes_come_within_2_seconds_on_a_big_cluster() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let admin = cluster.client().await;
    let crds = Api::<CustomResourceDefinition>::all(admin.clone())
        .list_metadata(&ListParams::default().labels(LOAD_CRDS))
        .await
        .unwrap()
        .items
        .len();
    let pods = Api::<Pod>::namespaced(admin, LOAD_NAMESPACE)
        .list_metadata(&ListParams::default())
        .await
        .unwrap()
        .items
        .len();
    if crds < 150 || pods < 450 {
        eprintln!(
            "skipped: the load fixture is not applied ({crds} CRDs, {pods} pods; scripts/fixtures/load/load.sh apply)"
        );
        return;
    }

    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let started = Instant::now();
    let first = |kind_ref: KindRef| {
        let (mgr, id) = (mgr.clone(), id.clone());
        async move {
            let mut updates = start(&mgr, &id, spec(kind_ref, None, None)).await;
            let items = snapshot(next(&mut updates, 60).await);
            (started.elapsed(), items.len())
        }
    };
    // What a fresh window starts at once: the Nodes table, the Pods table (all namespaces) and the sidebar's
    // discovery (custom resources).
    let ((nodes_at, nodes), (pods_at, pods), (kinds_at, kinds)) = tokio::join!(
        first(kind("", "v1", "Node")),
        first(kind("", "v1", "Pod")),
        async {
            let kinds = mgr.kinds(&id).await.unwrap();
            (started.elapsed(), kinds)
        }
    );
    eprintln!(
        "first snapshot: Nodes {nodes_at:?} ({nodes}), Pods {pods_at:?} ({pods}); discovery {kinds_at:?} ({} kinds)",
        kinds.len()
    );
    assert!(pods >= 450, "{pods} pods");
    let load_kinds = kinds
        .iter()
        .filter(|k| k.kind_ref.group.ends_with(".load.sextant.dev"))
        .count();
    assert!(load_kinds >= 150, "{load_kinds} load kinds discovered");
    assert!(
        nodes_at < Duration::from_secs(2),
        "the first Nodes snapshot took {nodes_at:?}"
    );
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
