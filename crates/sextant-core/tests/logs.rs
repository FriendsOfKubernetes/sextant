//! Pod logs (`logs::stream_logs`) against the kind test cluster. Pods are created in their own namespaces
//! (`sextant-logs-*`) and removed with them; `sextant-demo` is only read.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test logs -- --test-threads=1
//! ```

mod common;

use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use futures::{Stream, StreamExt};
use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::Api;
use kube::api::{DeleteParams, ListParams, PostParams};
use serde_json::{Value, json};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::logs::{LogOptions, LogUpdate, stream_logs};
use sextant_core::resources::{KindRef, ObjectRef};
use sextant_core::{ClusterId, ClusterManager, ErrorCode, KubeconfigRegistry};

type Updates = Pin<Box<dyn Stream<Item = LogUpdate> + Send>>;

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

fn pod_ref(namespace: &str, name: &str) -> ObjectRef {
    ObjectRef {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        },
        namespace: Some(namespace.into()),
        name: name.into(),
    }
}

fn opts(container: &str) -> LogOptions {
    LogOptions {
        container: container.into(),
        follow: false,
        previous: false,
        timestamps: false,
        tail_lines: None,
    }
}

/// A namespace that exists for the duration of a test and is deleted afterwards.
struct TestNamespace {
    name: String,
    client: kube::Client,
}

impl TestNamespace {
    async fn create(client: kube::Client, name: &str) -> Self {
        let namespaces = Api::<Namespace>::all(client.clone());
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
        Self {
            name: name.into(),
            client,
        }
    }

    /// Deletes the namespace and its pods. A test that fails earlier leaves it behind; the next run removes it.
    async fn delete(self) {
        let _ = Api::<Namespace>::all(self.client.clone())
            .delete(&self.name, &DeleteParams::default())
            .await;
    }

    fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.client.clone(), &self.name)
    }

    async fn run(&self, name: &str, mut spec: Value) {
        // Pods die at once, so the namespace is gone quickly.
        spec["terminationGracePeriodSeconds"] = json!(0);
        let pod: Pod = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": name }, "spec": spec,
        }))
        .unwrap();
        self.pods()
            .create(&PostParams::default(), &pod)
            .await
            .unwrap();
    }

    /// Waits until `ready` holds for the pod's status.
    async fn wait(&self, name: &str, what: &str, ready: impl Fn(&Value) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let pod = self.pods().get(name).await.unwrap();
            let status = serde_json::to_value(&pod).unwrap()["status"].clone();
            if ready(&status) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{name}: timed out waiting for {what}: {status}"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn wait_running(&self, name: &str) {
        self.wait(name, "Running", |s| s["phase"] == "Running")
            .await;
    }
}

async fn start(
    mgr: &ClusterManager,
    id: &ClusterId,
    namespace: &str,
    pod: &str,
    options: LogOptions,
) -> Updates {
    Box::pin(
        stream_logs(mgr, id, &pod_ref(namespace, pod), options)
            .await
            .expect("the log stream opens"),
    )
}

/// Reads a non-following stream to its end: every line, then `Ended`.
async fn read_all(mut updates: Updates) -> Vec<String> {
    let mut all = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(30), updates.next())
            .await
            .expect("no log update in 30s")
        {
            Some(LogUpdate::Lines { lines }) => all.extend(lines),
            Some(LogUpdate::Ended) => return all,
            other => panic!("unexpected {other:?}"),
        }
    }
}

const BUSYBOX: &str = "busybox:stable";

fn container(name: &str, script: &str) -> Value {
    json!({ "name": name, "image": BUSYBOX, "command": ["sh", "-c", script] })
}

#[tokio::test]
async fn container_tail_and_timestamps_options_change_the_output() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let ns = TestNamespace::create(cluster.client().await, "sextant-logs-options").await;
    ns.run(
        "multi",
        json!({
            "restartPolicy": "Never",
            "initContainers": [container("setup", "echo from-init")],
            "containers": [
                container("app", "echo app-1; echo app-2; echo app-3; sleep 3600"),
                container("sidecar", "echo from-sidecar; sleep 3600"),
            ],
        }),
    )
    .await;
    ns.wait_running("multi").await;
    // Give the containers a moment to write.
    tokio::time::sleep(Duration::from_secs(2)).await;

    let app = read_all(start(&mgr, &id, &ns.name, "multi", opts("app")).await).await;
    assert_eq!(app, ["app-1", "app-2", "app-3"]);
    let sidecar = read_all(start(&mgr, &id, &ns.name, "multi", opts("sidecar")).await).await;
    assert_eq!(sidecar, ["from-sidecar"]);
    let init = read_all(start(&mgr, &id, &ns.name, "multi", opts("setup")).await).await;
    assert_eq!(init, ["from-init"], "init containers are readable");

    let tail = LogOptions {
        tail_lines: Some(2),
        ..opts("app")
    };
    assert_eq!(
        read_all(start(&mgr, &id, &ns.name, "multi", tail).await).await,
        ["app-2", "app-3"]
    );

    let stamped = LogOptions {
        timestamps: true,
        ..opts("app")
    };
    let lines = read_all(start(&mgr, &id, &ns.name, "multi", stamped).await).await;
    assert_eq!(lines.len(), 3);
    for (line, expected) in lines.iter().zip(["app-1", "app-2", "app-3"]) {
        let (stamp, text) = line.split_once(' ').expect("`<timestamp> <text>`");
        assert_eq!(text, expected);
        assert!(
            stamp.len() >= 20
                && stamp.as_bytes()[4] == b'-'
                && stamp.contains('T')
                && stamp.ends_with('Z'),
            "not an RFC 3339 timestamp: {stamp}"
        );
    }
    ns.delete().await;
}

#[tokio::test]
async fn previous_returns_the_log_of_the_terminated_container() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let ns = TestNamespace::create(cluster.client().await, "sextant-logs-previous").await;
    // The first run leaves a marker in an emptyDir and exits; the restarted container is a different run.
    ns.run(
        "crashy",
        json!({
            "restartPolicy": "Always",
            "volumes": [{ "name": "state", "emptyDir": {} }],
            "containers": [{
                "name": "main", "image": BUSYBOX,
                "volumeMounts": [{ "name": "state", "mountPath": "/state" }],
                "command": ["sh", "-c",
                    "if [ -f /state/ran ]; then echo second-run; sleep 3600; else touch /state/ran; echo first-run; exit 1; fi"],
            }],
        }),
    )
    .await;
    ns.wait("crashy", "a restart", |s| {
        s["containerStatuses"][0]["restartCount"]
            .as_i64()
            .unwrap_or(0)
            >= 1
            && s["containerStatuses"][0]["state"]["running"].is_object()
    })
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;

    let current = read_all(start(&mgr, &id, &ns.name, "crashy", opts("main")).await).await;
    assert_eq!(current, ["second-run"]);
    let previous = LogOptions {
        previous: true,
        ..opts("main")
    };
    let before = read_all(start(&mgr, &id, &ns.name, "crashy", previous).await).await;
    assert_eq!(before, ["first-run"]);
    ns.delete().await;
}

#[tokio::test]
async fn follow_streams_live_in_batches_and_deleting_the_pod_ends_the_stream() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let ns = TestNamespace::create(cluster.client().await, "sextant-logs-follow").await;
    ns.run(
        "ticker",
        json!({
            "restartPolicy": "Never",
            "containers": [container("main", "i=0; while true; do echo tick-$i; i=$((i+1)); sleep 0.3; done")],
        }),
    )
    .await;
    ns.wait_running("ticker").await;

    let follow = LogOptions {
        follow: true,
        tail_lines: Some(1000),
        ..opts("main")
    };
    let mut updates = start(&mgr, &id, &ns.name, "ticker", follow).await;
    let mut seen = Vec::new();
    let mut arrivals = Vec::new();
    while seen.len() < 10 {
        let update = tokio::time::timeout(Duration::from_secs(30), updates.next())
            .await
            .expect("no log update in 30s")
            .expect("the stream ended early");
        let LogUpdate::Lines { lines } = update else {
            panic!("unexpected {update:?}");
        };
        arrivals.push(Instant::now());
        seen.extend(lines);
    }
    // Lines are consecutive ticks, in order, and arrived over several batches at least ~100 ms apart.
    let first: usize = seen[0].strip_prefix("tick-").unwrap().parse().unwrap();
    for (offset, line) in seen.iter().enumerate() {
        assert_eq!(line, &format!("tick-{}", first + offset));
    }
    assert!(
        arrivals.len() >= 3,
        "{} batches for {} lines",
        arrivals.len(),
        seen.len()
    );
    for pair in arrivals.windows(2) {
        assert!(
            pair[1] - pair[0] >= Duration::from_millis(80),
            "batches {:?} apart",
            pair[1] - pair[0]
        );
    }

    ns.pods()
        .delete("ticker", &DeleteParams::default().grace_period(0))
        .await
        .unwrap();
    let ended = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            match updates.next().await {
                Some(LogUpdate::Lines { .. }) => {}
                other => return other,
            }
        }
    })
    .await
    .expect("the stream did not end after the pod was deleted");
    assert_eq!(ended, Some(LogUpdate::Ended));
    assert!(updates.next().await.is_none());
    ns.delete().await;
}

#[tokio::test]
async fn a_large_burst_arrives_complete_and_in_order() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let ns = TestNamespace::create(cluster.client().await, "sextant-logs-burst").await;
    ns.run(
        "burst",
        json!({
            "restartPolicy": "Never",
            "containers": [container("main", "i=0; while [ $i -lt 20000 ]; do echo line-$i; i=$((i+1)); done; sleep 3600")],
        }),
    )
    .await;
    ns.wait_running("burst").await;
    tokio::time::sleep(Duration::from_secs(3)).await;

    let lines = read_all(start(&mgr, &id, &ns.name, "burst", opts("main")).await).await;
    assert_eq!(lines.len(), 20000);
    assert_eq!(lines[0], "line-0");
    assert_eq!(lines[19999], "line-19999");
    ns.delete().await;
}

#[tokio::test]
async fn nginx_in_the_demo_namespace_logs_a_request_live() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let client = cluster.client().await;
    let pods = Api::<Pod>::namespaced(client.clone(), common::DEMO_NAMESPACE);
    let pod = pods
        .list(&ListParams::default().labels("app=nginx"))
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|p| p.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running"))
        .expect("a running nginx pod in sextant-demo");
    let name = pod.metadata.name.unwrap();

    let follow = LogOptions {
        follow: true,
        tail_lines: Some(1000),
        ..opts("nginx")
    };
    let mut updates = start(&mgr, &id, common::DEMO_NAMESPACE, &name, follow).await;
    // The first batch is what nginx logged so far (its start-up notices).
    let first = tokio::time::timeout(Duration::from_secs(30), updates.next())
        .await
        .unwrap();
    assert!(matches!(first, Some(LogUpdate::Lines { .. })), "{first:?}");

    // A request through the API server's pod proxy reaches nginx and lands in its access log.
    let request = kube::core::Request::new(format!(
        "/api/v1/namespaces/{}/pods/{name}:80/proxy",
        common::DEMO_NAMESPACE
    ))
    .get(
        "sextant-logs-probe",
        &kube::core::params::GetParams::default(),
    )
    .unwrap();
    let _ = client.request_text(request).await; // nginx answers 404; the request is logged either way
    let found = tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(update) = updates.next().await {
            if let LogUpdate::Lines { lines } = update
                && lines.iter().any(|l| l.contains("/sextant-logs-probe"))
            {
                return true;
            }
        }
        false
    })
    .await
    .expect("the request did not show up in 30s");
    assert!(found, "the stream ended before the request was logged");
}

#[tokio::test]
async fn opening_a_stream_that_cannot_exist_fails_with_a_meaningful_code() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let client = cluster.client().await;
    let pods = Api::<Pod>::namespaced(client, common::DEMO_NAMESPACE);
    let name = pods
        .list(&ListParams::default().labels("app=nginx"))
        .await
        .unwrap()
        .items[0]
        .metadata
        .name
        .clone()
        .unwrap();

    let missing_pod = stream_logs(
        &mgr,
        &id,
        &pod_ref(common::DEMO_NAMESPACE, "no-such-pod"),
        opts("nginx"),
    )
    .await;
    assert_eq!(missing_pod.err().unwrap().code, ErrorCode::NotFound);

    let missing_container = stream_logs(
        &mgr,
        &id,
        &pod_ref(common::DEMO_NAMESPACE, &name),
        opts("nope"),
    )
    .await;
    let err = missing_container.err().unwrap();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(err.message.contains("nope"), "{err}");

    let previous = LogOptions {
        previous: true,
        ..opts("nginx")
    };
    // nginx has restarted in some runs of the cluster; either way the error must not be a hang or a panic.
    if let Err(e) = stream_logs(&mgr, &id, &pod_ref(common::DEMO_NAMESPACE, &name), previous).await
    {
        assert_eq!(e.code, ErrorCode::Invalid, "{e}");
    }

    let no_namespace = ObjectRef {
        namespace: None,
        ..pod_ref("x", "y")
    };
    let err = stream_logs(&mgr, &id, &no_namespace, opts(""))
        .await
        .err()
        .unwrap();
    assert_eq!(err.code, ErrorCode::Invalid);
}
