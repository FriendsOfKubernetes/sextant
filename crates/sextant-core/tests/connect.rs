//! Connecting to the kind cluster from `scripts/test-cluster.sh` through `KubeconfigRegistry` + `ClusterManager`.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test connect -- --test-threads=1
//! ```
//!
//! `cluster_restart_gives_unreachable_then_reconnects` stops and starts the kind container; it runs only with
//! `SEXTANT_TEST_DOCKER_RESTART=1` as well.

mod common;

use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::{
    ClusterId, ClusterInfo, ClusterManager, ConnectionState, ErrorCode, KubeconfigRegistry,
};

/// A registry that sees exactly `files` as `KUBECONFIG` (the developer's own kubeconfig is never read).
fn registry_for(files: &[&Path], pasted: &Path) -> KubeconfigRegistry {
    let env = std::env::join_paths(files).unwrap();
    KubeconfigRegistry::new(Vec::new(), pasted.to_path_buf()).with_env(KubeconfigEnv {
        kubeconfig: Some(env),
        home: None,
    })
}

fn find<'a>(clusters: &'a [ClusterInfo], context: &str) -> &'a ClusterInfo {
    clusters
        .iter()
        .find(|c| c.context == context)
        .unwrap_or_else(|| panic!("context {context} not in {clusters:?}"))
}

#[tokio::test]
async fn kubeconfig_list_shows_both_test_contexts_with_stable_ids() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let files = [
        cluster.kubeconfig.as_path(),
        cluster.limited_kubeconfig.as_path(),
    ];
    let clusters = registry_for(&files, tmp.path()).clusters().unwrap();
    let admin = find(&clusters, common::ADMIN_CONTEXT);
    let limited = find(&clusters, common::LIMITED_CONTEXT);
    assert!(admin.server.starts_with("https://127.0.0.1:"), "{admin:?}");
    assert_eq!(limited.namespace.as_deref(), Some(common::DEMO_NAMESPACE));

    // Same files, new registry (= next start): same ids.
    let again = registry_for(&files, tmp.path()).clusters().unwrap();
    assert_eq!(find(&again, common::ADMIN_CONTEXT).id, admin.id);
    assert_eq!(
        admin.id,
        ClusterId::for_context(&cluster.kubeconfig, common::ADMIN_CONTEXT)
    );
}

#[tokio::test]
async fn client_certificate_and_token_clusters_connect_at_the_same_time() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let registry = registry_for(
        &[&cluster.kubeconfig, &cluster.limited_kubeconfig],
        tmp.path(),
    );
    let clusters = registry.clusters().unwrap();
    let admin = find(&clusters, common::ADMIN_CONTEXT).id.clone();
    let limited = find(&clusters, common::LIMITED_CONTEXT).id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));

    let (a, b) = tokio::join!(mgr.connect(&admin), mgr.connect(&limited));
    a.expect("admin (client certificate) connects");
    b.expect("limited (ServiceAccount token) connects");
    assert_eq!(mgr.state(&admin), ConnectionState::Connected);
    assert_eq!(mgr.state(&limited), ConnectionState::Connected);

    // Both clients work side by side, each with its own identity.
    let pods = kube::Api::<k8s_openapi::api::core::v1::Pod>::namespaced(
        mgr.client(&limited).unwrap(),
        common::DEMO_NAMESPACE,
    );
    pods.list(&Default::default()).await.unwrap();
    let secrets = kube::Api::<k8s_openapi::api::core::v1::Secret>::namespaced(
        mgr.client(&limited).unwrap(),
        common::DEMO_NAMESPACE,
    );
    assert!(secrets.list(&Default::default()).await.is_err());
    let admin_secrets = kube::Api::<k8s_openapi::api::core::v1::Secret>::namespaced(
        mgr.client(&admin).unwrap(),
        common::DEMO_NAMESPACE,
    );
    admin_secrets.list(&Default::default()).await.unwrap();

    mgr.disconnect(&limited).await;
    assert_eq!(mgr.state(&limited), ConnectionState::Disconnected);
    assert!(mgr.client(&limited).is_err());
    assert_eq!(mgr.state(&admin), ConnectionState::Connected);
}

#[tokio::test]
async fn kinds_include_builtin_kinds_and_the_test_crd_with_printer_columns() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let registry = registry_for(&[&cluster.kubeconfig], tmp.path());
    let id = registry.clusters().unwrap()[0].id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
    mgr.connect(&id).await.unwrap();

    let kinds = mgr.kinds(&id).await.unwrap();
    let kind = |group: &str, name: &str| {
        kinds
            .iter()
            .find(|k| k.kind_ref.group == group && k.kind_ref.kind == name)
            .unwrap_or_else(|| panic!("{group}/{name} not discovered"))
    };
    let pod = kind("", "Pod");
    assert_eq!(pod.plural, "pods");
    assert_eq!(pod.kind_ref.version, "v1");
    assert!(pod.namespaced);
    assert!(pod.verbs.iter().any(|v| v == "watch"));
    assert!(!kind("", "Node").namespaced);
    assert_eq!(kind("apps", "Deployment").kind_ref.version, "v1");
    assert!(kind("apps", "Deployment").printer_columns.is_empty());
    assert!(
        !kinds.iter().any(|k| k.plural.contains('/')),
        "no subresources"
    );

    let widget = kind("demo.sextant.dev", "Widget");
    assert_eq!(widget.plural, "widgets");
    let columns: Vec<_> = widget
        .printer_columns
        .iter()
        .map(|c| (c.name.as_str(), c.json_path.as_str()))
        .collect();
    assert_eq!(columns.len(), 3, "{columns:?}");
    assert_eq!(
        columns.iter().map(|c| c.0).collect::<Vec<_>>(),
        ["Size", "Replicas", "Age"]
    );
    assert!(columns[0].1.contains("size"), "{columns:?}");

    // Cached until reconnect.
    assert_eq!(mgr.kinds(&id).await.unwrap(), kinds);
}

#[tokio::test]
async fn rejected_token_gives_unauthorized() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let text = std::fs::read_to_string(&cluster.limited_kubeconfig).unwrap();
    let token_line = text
        .lines()
        .find(|l| l.trim_start().starts_with("token:"))
        .expect("the limited kubeconfig has a token");
    let indent = &token_line[..token_line.len() - token_line.trim_start().len()];
    let forged = text.replace(token_line, &format!("{indent}token: not-a-valid-token"));
    let path = tmp.path().join("forged.yaml");
    std::fs::write(&path, forged).unwrap();

    let registry = registry_for(&[&path], tmp.path());
    let id = registry.clusters().unwrap()[0].id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
    let err = mgr.connect(&id).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unauthorized, "{err}");
    assert!(!err.message.contains("not-a-valid-token"));
}

fn docker(args: &[&str]) {
    let status = std::process::Command::new("docker")
        .args(args)
        .status()
        .expect("docker runs");
    assert!(status.success(), "docker {args:?} failed");
}

#[tokio::test]
async fn cluster_restart_gives_unreachable_then_reconnects() {
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
    let tmp = tempfile::tempdir().unwrap();
    let registry = registry_for(&[&cluster.kubeconfig], tmp.path());
    let id = registry.clusters().unwrap()[0].id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
    mgr.connect(&id).await.unwrap();

    docker(&["stop", container]);
    let err = mgr.connect(&id).await.unwrap_err();
    docker(&["start", container]);
    assert_eq!(err.code, ErrorCode::Unreachable, "{err}");
    assert!(matches!(mgr.state(&id), ConnectionState::Error(_)));

    // "Reconnect" once the API server is back.
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match mgr.connect(&id).await {
            Ok(()) => break,
            Err(err) if Instant::now() < deadline => {
                eprintln!("waiting for the API server: {err}");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            Err(err) => panic!("cluster did not come back: {err}"),
        }
    }
    assert_eq!(mgr.state(&id), ConnectionState::Connected);
}
