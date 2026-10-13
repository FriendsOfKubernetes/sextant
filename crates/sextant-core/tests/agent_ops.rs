//! One-shot operations for the tools of an AI agent (`resources::{resolve, list, events}`, `logs::tail`,
//! `exec::run_command`) against the kind test cluster. `sextant-demo` is only read; pods are created in the
//! namespace `sextant-agent-ops`, removed when each test ends.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test agent_ops -- --test-threads=1
//! ```

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::Api;
use kube::api::{DeleteParams, PostParams};
use serde_json::{Value, json};
use sextant_core::exec::run_command;
use sextant_core::logs::tail;
use sextant_core::resources::{self, KindRef, ObjectRef};
use sextant_core::{ClusterId, ClusterManager, ErrorCode};

use common::DEMO_NAMESPACE;

const NAMESPACE: &str = "sextant-agent-ops";
const BUSYBOX_IMAGE: &str = "busybox:stable";

fn kind(group: &str, version: &str, kind: &str) -> KindRef {
    KindRef {
        group: group.into(),
        version: version.into(),
        kind: kind.into(),
    }
}

fn pod_ref(namespace: &str, name: &str) -> ObjectRef {
    ObjectRef {
        kind: kind("", "v1", "Pod"),
        namespace: Some(namespace.into()),
        name: name.into(),
    }
}

fn names(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|i| i["metadata"]["name"].as_str().unwrap().to_owned())
        .collect()
}

/// The namespace `sextant-agent-ops` with one running pod; the namespace is deleted when the test ends.
struct TestPod {
    name: String,
    kubeconfig: PathBuf,
}

impl TestPod {
    async fn run(cluster: &common::TestCluster, name: &str, containers: Value) -> Self {
        let client = cluster.client().await;
        let namespaces = Api::<Namespace>::all(client.clone());
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let ns: Namespace = serde_json::from_value(
                json!({ "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": NAMESPACE } }),
            )
            .unwrap();
            match namespaces.create(&PostParams::default(), &ns).await {
                Ok(_) => break,
                // A leftover of an interrupted run may still be terminating.
                Err(kube::Error::Api(status)) if status.code == 409 => {
                    let _ = namespaces.delete(NAMESPACE, &DeleteParams::default()).await;
                    assert!(
                        Instant::now() < deadline,
                        "namespace {NAMESPACE} will not go away"
                    );
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(e) => panic!("cannot create namespace {NAMESPACE}: {e}"),
            }
        }
        let this = Self {
            name: name.into(),
            kubeconfig: cluster.kubeconfig.clone(),
        };
        let pod: Pod = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": name },
            "spec": { "terminationGracePeriodSeconds": 0, "containers": containers },
        }))
        .unwrap();
        let pods = Api::<Pod>::namespaced(client, NAMESPACE);
        pods.create(&PostParams::default(), &pod).await.unwrap();
        loop {
            let status =
                serde_json::to_value(pods.get(name).await.unwrap()).unwrap()["status"].clone();
            if status["phase"] == "Running" {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{name}: timed out waiting for Running: {status}"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        this
    }

    fn pod_ref(&self) -> ObjectRef {
        pod_ref(NAMESPACE, &self.name)
    }
}

impl Drop for TestPod {
    fn drop(&mut self) {
        // From a thread and runtime of its own: the test's runtime is blocked in this `drop`.
        let kubeconfig = self.kubeconfig.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let client = common::client_from(&kubeconfig).await;
                let _ = tokio::time::timeout(
                    Duration::from_secs(30),
                    Api::<Namespace>::all(client).delete(NAMESPACE, &DeleteParams::default()),
                )
                .await;
            });
        })
        .join();
    }
}

async fn busybox(cluster: &common::TestCluster) -> TestPod {
    TestPod::run(
        cluster,
        "worker",
        json!([
            {
                "name": "main", "image": BUSYBOX_IMAGE,
                "command": ["sh", "-c", "seq 1 3000 | sed 's/^/line-/'; echo done; sleep 3600"],
            },
            {
                "name": "crash", "image": BUSYBOX_IMAGE,
                "command": ["sh", "-c", "echo crashed-once; sleep 1; exit 1"],
            }
        ]),
    )
    .await
}

/// Calls `attempt` until it gives a value; panics after `secs` seconds naming `what`.
async fn poll<T, F, Fut>(what: &str, secs: u64, mut attempt: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(value) = attempt().await {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn connect(cluster: &common::TestCluster) -> (tempfile::TempDir, ClusterManager, ClusterId) {
    common::connected(&cluster.kubeconfig).await
}

#[tokio::test]
async fn resolve_names_the_kind_the_cluster_serves() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connect(&cluster).await;

    let deployment = resources::resolve(&mgr, &id, &kind("apps", "v1", "Deployment"))
        .await
        .unwrap();
    assert_eq!(deployment.plural, "deployments");
    assert!(deployment.namespaced);

    // The demo CRD `widgets.demo.sextant.dev`, asked in a version the cluster does not serve.
    let widget = resources::resolve(&mgr, &id, &kind("demo.sextant.dev", "v0", "Widget"))
        .await
        .unwrap();
    assert_eq!(widget.kind_ref.version, "v1");
    assert!(widget.verbs.iter().any(|v| v == "list"), "{widget:?}");

    let err = resources::resolve(&mgr, &id, &kind("demo.sextant.dev", "v1", "NoSuchKind"))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn list_pages_objects_hides_secret_values_and_filters_by_selectors() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connect(&cluster).await;
    let pod = kind("", "v1", "Pod");

    let all = resources::list(&mgr, &id, &pod, Some(DEMO_NAMESPACE), None, None, 500)
        .await
        .unwrap();
    assert!(!all.truncated);
    assert!(all.items.len() >= 2, "{:?}", names(&all.items));
    assert!(
        all.items
            .iter()
            .all(|i| i["metadata"].get("managedFields").is_none())
    );
    assert!(all.items.iter().all(|i| i["kind"] == "Pod"));

    let one = resources::list(&mgr, &id, &pod, Some(DEMO_NAMESPACE), None, None, 1)
        .await
        .unwrap();
    assert_eq!(one.items.len(), 1);
    assert!(one.truncated);

    let nginx = resources::list(
        &mgr,
        &id,
        &pod,
        Some(DEMO_NAMESPACE),
        Some("app=nginx"),
        Some("status.phase=Running"),
        100,
    )
    .await
    .unwrap();
    assert_eq!(nginx.items.len(), 2, "{:?}", names(&nginx.items));
    assert!(
        names(&nginx.items).iter().all(|n| n.starts_with("nginx-")),
        "{:?}",
        names(&nginx.items)
    );

    // All namespaces.
    let everywhere = resources::list(&mgr, &id, &pod, None, Some("app=nginx"), None, 100)
        .await
        .unwrap();
    assert!(everywhere.items.len() >= 2);

    // A cluster-scoped kind ignores the namespace.
    let nodes = resources::list(
        &mgr,
        &id,
        &kind("", "v1", "Node"),
        Some("x"),
        None,
        None,
        10,
    )
    .await
    .unwrap();
    assert!(!nodes.items.is_empty());

    let secrets = resources::list(
        &mgr,
        &id,
        &kind("", "v1", "Secret"),
        Some(DEMO_NAMESPACE),
        None,
        Some("metadata.name=demo-secret"),
        10,
    )
    .await
    .unwrap();
    assert_eq!(names(&secrets.items), ["demo-secret"]);
    let data = secrets.items[0]["data"].as_object().unwrap();
    assert!(!data.is_empty());
    assert!(data.values().all(|v| v == ""), "{data:?}");
}

#[tokio::test]
async fn events_come_for_an_object_and_for_a_namespace_newest_first() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let pod = busybox(&cluster).await;
    let (_tmp, mgr, id) = connect(&cluster).await;

    // The kubelet reports pulling/creating/starting the containers.
    let found = poll("events of the pod", 60, || async {
        let found = resources::events(&mgr, &id, None, Some(&pod.pod_ref()), 100)
            .await
            .unwrap();
        (found.len() >= 2).then_some(found)
    })
    .await;
    assert!(
        found.iter().all(
            |e| e["involvedObject"]["name"] == "worker" && e["involvedObject"]["kind"] == "Pod"
        )
    );
    assert!(found.iter().all(|e| e["kind"] == "Event"));
    let times: Vec<String> = found.iter().map(seen).collect();
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(times, sorted, "newest first");

    let limited = resources::events(&mgr, &id, None, Some(&pod.pod_ref()), 1)
        .await
        .unwrap();
    assert_eq!(limited.len(), 1);
    assert_eq!(seen(&limited[0]), times[0]);

    let namespace = resources::events(&mgr, &id, Some(NAMESPACE), None, 500)
        .await
        .unwrap();
    assert!(namespace.len() >= found.len());
    assert!(
        namespace
            .iter()
            .all(|e| e["metadata"]["namespace"] == NAMESPACE)
    );
}

/// The last time an event was seen, as a sortable UTC text (seconds; microseconds when given).
fn seen(event: &Value) -> String {
    let text = ["lastTimestamp", "eventTime", "firstTimestamp"]
        .iter()
        .filter_map(|f| event[*f].as_str())
        .map(|t| {
            let t = t.trim_end_matches('Z');
            match t.split_once('.') {
                Some((secs, frac)) => format!("{secs}.{frac:0<6}"),
                None => format!("{t}.000000"),
            }
        })
        .max();
    text.unwrap_or_else(|| {
        event["metadata"]["creationTimestamp"]
            .as_str()
            .unwrap()
            .into()
    })
}

#[tokio::test]
async fn tail_gives_the_last_lines_of_a_container_and_of_its_previous_run() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let pod = busybox(&cluster).await;
    let (_tmp, mgr, id) = connect(&cluster).await;

    let text = poll("all log lines", 30, || async {
        let text = tail(&mgr, &id, &pod.pod_ref(), Some("main"), 3, false)
            .await
            .unwrap();
        text.contains("done").then_some(text)
    })
    .await;
    assert_eq!(text, "line-2999\nline-3000\ndone\n");

    let capped = tail(&mgr, &id, &pod.pod_ref(), Some("main"), 100_000, false)
        .await
        .unwrap();
    let lines: Vec<&str> = capped.lines().collect();
    assert_eq!(lines.len(), 2000);
    assert_eq!(lines[0], "line-1002");

    let previous = poll("the previous run of the crashing container", 90, || async {
        tail(&mgr, &id, &pod.pod_ref(), Some("crash"), 10, true)
            .await
            .ok()
    })
    .await;
    assert_eq!(previous, "crashed-once\n");

    // `main` never restarted: no previous run.
    let err = tail(&mgr, &id, &pod.pod_ref(), Some("main"), 10, true)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{err}");

    let err = tail(&mgr, &id, &pod.pod_ref(), Some("nope"), 10, false)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{err}");
    assert!(err.message.contains("nope"), "{err}");

    // No container named: the first one, as `kubectl logs` picks it.
    let first = tail(&mgr, &id, &pod.pod_ref(), None, 1, false)
        .await
        .unwrap();
    assert_eq!(first, "done\n");

    let err = tail(&mgr, &id, &pod_ref(NAMESPACE, "missing"), None, 10, false)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{err}");
    assert!(err.message.contains("missing"), "{err}");
}

fn cmd(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_owned()).collect()
}

#[tokio::test]
async fn run_command_collects_both_streams_the_exit_code_and_stops_at_the_limits() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let pod = busybox(&cluster).await;
    let (_tmp, mgr, id) = connect(&cluster).await;
    let target = pod.pod_ref();
    let minute = Duration::from_secs(60);

    let ok = run_command(
        &mgr,
        &id,
        &target,
        Some("main"),
        &cmd(&["sh", "-c", "echo hello; echo oops >&2"]),
        minute,
        1024,
    )
    .await
    .unwrap();
    assert_eq!(ok.stdout, "hello\n");
    assert_eq!(ok.stderr, "oops\n");
    assert_eq!(ok.exit_code, Some(0));
    assert!(!ok.truncated && !ok.timed_out);

    let failed = run_command(
        &mgr,
        &id,
        &target,
        Some("main"),
        &cmd(&["sh", "-c", "exit 3"]),
        minute,
        1024,
    )
    .await
    .unwrap();
    assert_eq!(failed.exit_code, Some(3));
    assert!(!failed.timed_out);

    // The default container (the first one) when none is named.
    let big = run_command(
        &mgr,
        &id,
        &target,
        None,
        &cmd(&["seq", "1", "100000"]),
        minute,
        1000,
    )
    .await
    .unwrap();
    assert_eq!(big.stdout.len(), 1000);
    assert!(big.stdout.starts_with("1\n2\n3\n"));
    assert!(big.truncated);
    assert_eq!(big.exit_code, Some(0));

    let started = Instant::now();
    let slow = run_command(
        &mgr,
        &id,
        &target,
        Some("main"),
        &cmd(&["sh", "-c", "echo before; sleep 30"]),
        Duration::from_secs(2),
        1024,
    )
    .await
    .unwrap();
    assert!(slow.timed_out);
    assert_eq!(slow.exit_code, None);
    assert_eq!(slow.stdout, "before\n");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );

    let err = run_command(
        &mgr,
        &id,
        &target,
        Some("main"),
        &cmd(&["no-such-binary"]),
        minute,
        1024,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{err}");

    let err = run_command(&mgr, &id, &target, Some("main"), &[], minute, 1024)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{err}");

    let err = run_command(
        &mgr,
        &id,
        &pod_ref(NAMESPACE, "missing"),
        None,
        &cmd(&["true"]),
        minute,
        1024,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{err}");
}
