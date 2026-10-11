//! Port forwarding (`PortForwarder`) against the kind test cluster. The nginx Service in `sextant-demo` is only
//! read; pods that get deleted live in the `sextant-pf-test` namespace, which the test removes afterwards.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test portforward -- --test-threads=1
//! ```

mod common;

use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::Api;
use kube::api::{DeleteParams, PostParams};
use serde_json::json;
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::portforward::{ForwardInfo, ForwardStatus, ForwardTarget, PortForwarder};
use sextant_core::{ClusterId, ClusterManager, ErrorCode, KubeconfigRegistry};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

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

fn nginx_service() -> ForwardTarget {
    ForwardTarget::Service {
        namespace: common::DEMO_NAMESPACE.into(),
        name: "nginx".into(),
    }
}

/// `GET /` through the local port; the whole response.
async fn http_get(port: u16) -> String {
    let mut stream = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect((Ipv4Addr::LOCALHOST, port)),
    )
    .await
    .expect("connect timed out")
    .expect("connect");
    stream
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut response))
        .await
        .expect("read timed out")
        .expect("read");
    String::from_utf8_lossy(&response).into_owned()
}

async fn port_is_free(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await.is_ok()
}

async fn wait_for(what: &str, secs: u64, mut done: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !done().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
async fn forwarding_the_nginx_service_answers_over_the_local_port() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let forwarder = PortForwarder::new();

    let info = forwarder
        .start(&mgr, &id, nginx_service(), 80, None)
        .await
        .unwrap();

    assert_eq!(info.status, ForwardStatus::Active);
    assert_eq!(info.remote_port, 80);
    assert_eq!(info.cluster, id);
    let response = http_get(info.local_port).await;
    assert!(response.starts_with("HTTP/1."), "{response}");
    assert!(response.contains("Welcome to nginx"), "{response}");
    // Another connection works too (each one is its own stream to the pod).
    assert!(http_get(info.local_port).await.contains("200 OK"));
    assert_eq!(forwarder.list(), vec![info]);
    forwarder.stop_all();
}

#[tokio::test]
async fn automatic_local_ports_are_free_and_distinct() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let forwarder = PortForwarder::new();

    let first = forwarder
        .start(&mgr, &id, nginx_service(), 80, None)
        .await
        .unwrap();
    let second = forwarder
        .start(&mgr, &id, nginx_service(), 80, None)
        .await
        .unwrap();

    assert_ne!(first.local_port, 0);
    assert_ne!(first.local_port, second.local_port);
    assert_ne!(first.id, second.id);
    // Before the forward started these ports were free: now they are ours, and stopping gives them back.
    assert!(!port_is_free(first.local_port).await);
    forwarder.stop_all();
}

#[tokio::test]
async fn a_taken_local_port_gives_port_in_use() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let forwarder = PortForwarder::new();
    let squatter = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let taken = squatter.local_addr().unwrap().port();

    let err = forwarder
        .start(&mgr, &id, nginx_service(), 80, Some(taken))
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::PortInUse, "{err}");
    assert!(
        err.message.contains(&taken.to_string()),
        "message names the port: {}",
        err.message
    );
    assert!(forwarder.list().is_empty());
}

#[tokio::test]
async fn stopping_a_forward_frees_the_port_and_publishes_the_list() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let forwarder = PortForwarder::new();
    let mut updates = forwarder.subscribe();

    let info = forwarder
        .start(&mgr, &id, nginx_service(), 80, None)
        .await
        .unwrap();
    let started: Vec<ForwardInfo> = updates.recv().await.unwrap();
    assert_eq!(started, vec![info.clone()]);
    forwarder.stop(&info.id).await.unwrap();
    let stopped: Vec<ForwardInfo> = updates.recv().await.unwrap();

    assert!(stopped.is_empty());
    assert!(forwarder.list().is_empty());
    assert!(port_is_free(info.local_port).await, "the port is released");
    // The same port can be forwarded again, and stopping an unknown id is a notFound error.
    let again = forwarder
        .start(&mgr, &id, nginx_service(), 80, Some(info.local_port))
        .await
        .unwrap();
    assert_eq!(again.local_port, info.local_port);
    let err = forwarder.stop("pf-unknown").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    forwarder.stop_all();
}

#[tokio::test]
async fn disconnecting_the_cluster_closes_its_forwards() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let forwarder = PortForwarder::new();
    let info = forwarder
        .start(&mgr, &id, nginx_service(), 80, None)
        .await
        .unwrap();

    mgr.disconnect(&id).await;

    wait_for("the forward to close", 10, async || {
        forwarder.list().is_empty() && port_is_free(info.local_port).await
    })
    .await;
}

#[tokio::test]
async fn a_service_without_ready_pods_or_with_an_unknown_port_is_an_error() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let forwarder = PortForwarder::new();

    let no_port = forwarder
        .start(&mgr, &id, nginx_service(), 8081, None)
        .await
        .unwrap_err();
    let missing = forwarder
        .start(
            &mgr,
            &id,
            ForwardTarget::Service {
                namespace: common::DEMO_NAMESPACE.into(),
                name: "no-such-service".into(),
            },
            80,
            None,
        )
        .await
        .unwrap_err();

    assert_eq!(no_port.code, ErrorCode::Invalid, "{no_port}");
    assert_eq!(missing.code, ErrorCode::NotFound, "{missing}");
    assert!(forwarder.list().is_empty());
}

#[tokio::test]
async fn a_deleted_pod_turns_its_forward_into_an_error() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let namespaces = Api::<Namespace>::all(client.clone());
    let name = "sextant-pf-test";
    // A leftover of an interrupted run may still be terminating.
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let ns: Namespace = serde_json::from_value(
            json!({ "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": name } }),
        )
        .unwrap();
        match namespaces.create(&PostParams::default(), &ns).await {
            Ok(_) => break,
            Err(kube::Error::Api(status)) if status.code == 409 => {
                let _ = namespaces.delete(name, &DeleteParams::default()).await;
                assert!(
                    Instant::now() < deadline,
                    "namespace {name} will not go away"
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(e) => panic!("cannot create namespace {name}: {e}"),
        }
    }
    let result = async {
        let pods: Api<Pod> = Api::namespaced(client.clone(), name);
        let pod: Pod = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "web" },
            "spec": {
                "terminationGracePeriodSeconds": 0,
                "containers": [{ "name": "nginx", "image": "nginx:stable-alpine",
                                 "ports": [{ "containerPort": 80 }] }],
            },
        }))
        .unwrap();
        pods.create(&PostParams::default(), &pod).await.unwrap();
        wait_for("the pod to run", 120, async || {
            pods.get("web")
                .await
                .ok()
                .and_then(|p| p.status)
                .is_some_and(|s| s.phase.as_deref() == Some("Running"))
        })
        .await;

        let forwarder = PortForwarder::new();
        let info = forwarder
            .start(
                &mgr,
                &id,
                ForwardTarget::Pod {
                    namespace: name.into(),
                    name: "web".into(),
                },
                80,
                None,
            )
            .await
            .unwrap();
        assert!(http_get(info.local_port).await.contains("Welcome to nginx"));

        pods.delete("web", &DeleteParams::default().grace_period(0))
            .await
            .unwrap();

        wait_for("the forward to report an error", 30, async || {
            matches!(
                forwarder.list().first().map(|f| f.status.clone()),
                Some(ForwardStatus::Error(_))
            )
        })
        .await;
        let ForwardStatus::Error(err) = forwarder.list()[0].status.clone() else {
            unreachable!()
        };
        assert_eq!(err.code, ErrorCode::NotFound, "{err}");
        // The entry stays in the list until it is stopped, and stopping still frees the port.
        forwarder.stop(&info.id).await.unwrap();
        assert!(port_is_free(info.local_port).await);
    }
    .await;
    let _ = namespaces.delete(name, &DeleteParams::default()).await;
    result
}
