//! Shell on a node (`node_shell`) against the kind test cluster: the privileged pod in `kube-system`, the shell in the
//! node's namespaces, removal of the pod, and the sweep of forgotten pods when a cluster connects. Every pod a test
//! makes is removed before it ends (`kubectl -n kube-system get pods -l sextant.dev/node-shell=true` stays empty).
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test node_shell -- --test-threads=1
//! ```

mod common;

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{Node, Pod};
use kube::Api;
use kube::api::{DeleteParams, ListParams, PostParams};
use serde_json::json;
use sextant_core::exec::{ExecSession, TermEvent, exec_shell};
use sextant_core::node_shell::{self, NodeShellPod, StartCancel};
use sextant_core::{ClusterManager, ErrorCode};

const NAMESPACE: &str = "kube-system";
const SELECTOR: &str = "sextant.dev/node-shell=true";

async fn first_node(client: &kube::Client) -> String {
    let nodes = Api::<Node>::all(client.clone())
        .list(&ListParams::default())
        .await
        .unwrap();
    nodes.items[0].metadata.name.clone().unwrap()
}

async fn pod_exists(client: &kube::Client, name: &str) -> bool {
    Api::<Pod>::namespaced(client.clone(), NAMESPACE)
        .get_opt(name)
        .await
        .unwrap()
        .is_some()
}

async fn wait_gone(client: &kube::Client, name: &str) {
    common::wait_until(&format!("pod {name} to be deleted"), 60, || {
        let client = client.clone();
        let name = name.to_owned();
        async move { !pod_exists(&client, &name).await }
    })
    .await;
}

/// Node shell pods left by this test file are removed even when an assertion fails.
struct Cleanup(kube::Client);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let client = self.0.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let pods = Api::<Pod>::namespaced(client, NAMESPACE);
                let _ = pods
                    .delete_collection(
                        &DeleteParams {
                            grace_period_seconds: Some(0),
                            ..Default::default()
                        },
                        &ListParams::default().labels(SELECTOR),
                    )
                    .await;
            });
        })
        .join();
    }
}

/// Types `line` and reads the output until `done(text)`; panics after 30 s.
async fn run_line(session: &mut ExecSession, line: &str, done: impl Fn(&str) -> bool) -> String {
    session
        .input
        .send(format!("{line}\n").into_bytes())
        .await
        .unwrap();
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !done(&text) {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, session.output.recv()).await {
            Ok(Some(TermEvent::Data(bytes))) => text.push_str(&String::from_utf8_lossy(&bytes)),
            other => panic!("no {line:?} output ({other:?}): {text:?}"),
        }
    }
    text
}

#[tokio::test(flavor = "multi_thread")]
async fn a_node_shell_pod_runs_privileged_on_the_node_and_its_shell_is_the_nodes() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let _cleanup = Cleanup(client.clone());
    let node = first_node(&client).await;
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;

    let shell = node_shell::create(&mgr, &id, &node, node_shell::DEFAULT_IMAGE)
        .await
        .expect("the node shell pod starts");
    let name = shell.pod().name.clone();
    assert!(
        name.starts_with(&format!("sextant-node-shell-{node}-")),
        "{name}"
    );
    assert_eq!(shell.pod().namespace.as_deref(), Some(NAMESPACE));

    // Story 26: what the pod is.
    let pod = Api::<Pod>::namespaced(client.clone(), NAMESPACE)
        .get(&name)
        .await
        .unwrap();
    let pod = serde_json::to_value(pod).unwrap();
    assert_eq!(pod["status"]["phase"], "Running");
    let spec = &pod["spec"];
    assert_eq!(spec["nodeName"], json!(node));
    assert_eq!(spec["hostPID"], true);
    assert_eq!(spec["hostNetwork"], true);
    assert_eq!(spec["activeDeadlineSeconds"], 8 * 60 * 60);
    assert_eq!(spec["tolerations"], json!([{ "operator": "Exists" }]));
    assert_eq!(spec["containers"][0]["image"], "busybox:stable");
    assert_eq!(spec["containers"][0]["securityContext"]["privileged"], true);
    let labels = &pod["metadata"]["labels"];
    assert_eq!(labels["app.kubernetes.io/managed-by"], "sextant");
    assert_eq!(labels["sextant.dev/node-shell"], "true");
    assert_eq!(
        labels["sextant.dev/session"],
        json!(node_shell::session_id())
    );

    // The shell is the node's: its hostname, its file system (the busybox image has no kubelet directory).
    let mut session = exec_shell(&mgr, &id, shell.pod(), node_shell::CONTAINER, 120, 30)
        .await
        .expect("a shell in the pod");
    // The typed command is echoed; the answer is a line of its own.
    run_line(&mut session, "hostname", |t| {
        t.split(['\r', '\n']).any(|l| l == node)
    })
    .await;
    run_line(
        &mut session,
        "[ -d /var/lib/kubelet ] && echo host-fs-$((40+2))",
        |t| t.contains("host-fs-42"),
    )
    .await;
    drop(session);

    // Deleting it removes the pod.
    shell.delete().await.expect("the pod is deleted");
    wait_gone(&client, &name).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_node_shell_deletes_its_pod() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let _cleanup = Cleanup(client.clone());
    let node = first_node(&client).await;
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;

    let shell: NodeShellPod = node_shell::create(&mgr, &id, &node, "")
        .await
        .expect("an empty image means the default one");
    let name = shell.pod().name.clone();
    assert!(pod_exists(&client, &name).await);
    // The cluster disconnects first: the pod is still deleted, with the client it was made with.
    mgr.disconnect(&id).await;
    drop(shell);
    assert!(
        node_shell::wait_for_deletions(Duration::from_secs(15)),
        "the deletion did not finish"
    );
    wait_gone(&client, &name).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_image_that_cannot_be_pulled_fails_with_the_reason_and_leaves_no_pod() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let _cleanup = Cleanup(client.clone());
    let node = first_node(&client).await;
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;

    let started = Instant::now();
    let err = node_shell::create(&mgr, &id, &node, "sextant.invalid/no-such-image:1")
        .await
        .expect_err("the image does not exist");
    assert!(
        started.elapsed() < node_shell::START_TIMEOUT + Duration::from_secs(15),
        "took {:?}",
        started.elapsed()
    );
    let text = err.message.to_lowercase();
    assert!(
        text.contains("sextant.invalid/no-such-image"),
        "the reason from the pod's events is missing: {err}"
    );
    assert!(text.contains("pull"), "{err}");
    let left = Api::<Pod>::namespaced(client.clone(), NAMESPACE)
        .list(&ListParams::default().labels(SELECTOR))
        .await
        .unwrap();
    for pod in &left.items {
        assert!(
            pod.metadata.deletion_timestamp.is_some(),
            "pod {:?} was left behind",
            pod.metadata.name
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn without_permission_to_create_pods_in_kube_system_the_message_says_so() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let node = first_node(&client).await;
    let (_tmp, mgr, id) = common::connected(&cluster.limited_kubeconfig).await;

    let err = node_shell::create(&mgr, &id, &node, node_shell::DEFAULT_IMAGE)
        .await
        .expect_err("the limited account may not create pods in kube-system");
    assert_eq!(err.code, ErrorCode::Forbidden, "{err}");
    assert_eq!(
        err.message,
        "You need permission to create privileged pods in kube-system"
    );
}

/// A pod in `kube-system` with `labels`, sleeping (not privileged).
async fn labelled_pod(client: &kube::Client, node: &str, name: &str, labels: serde_json::Value) {
    let pod: Pod = serde_json::from_value(json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": { "name": name, "labels": labels },
        "spec": {
            "nodeName": node,
            "terminationGracePeriodSeconds": 0,
            "tolerations": [{ "operator": "Exists" }],
            "containers": [{ "name": "shell", "image": "busybox:stable", "command": ["sleep", "600"] }],
        },
    }))
    .unwrap();
    Api::<Pod>::namespaced(client.clone(), NAMESPACE)
        .create(&PostParams::default(), &pod)
        .await
        .unwrap();
}

/// The labels of a node shell pod of `owner`'s run `session`.
fn shell_labels(owner: &str, session: &str) -> serde_json::Value {
    json!({
        "app.kubernetes.io/managed-by": "sextant",
        "sextant.dev/node-shell": "true",
        "sextant.dev/session": session,
        "sextant.dev/owner": owner,
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn connecting_removes_this_users_node_shell_pods_of_earlier_runs_only() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let _cleanup = Cleanup(client.clone());
    let node = first_node(&client).await;
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let ours = node_shell::create(&mgr, &id, &node, node_shell::DEFAULT_IMAGE)
        .await
        .unwrap();
    let ours_name = ours.pod().name.clone();
    let me = node_shell::owner_id();
    let earlier = "sextant-node-shell-earlier-run";
    let colleague = "sextant-node-shell-colleague";
    let lookalike = "sextant-node-shell-lookalike";
    let unrelated = "sextant-node-shell-unrelated";
    labelled_pod(&client, &node, earlier, shell_labels(me, "earlier-run")).await;
    // A colleague's live shell on the same cluster (another owner, another session) stays.
    labelled_pod(
        &client,
        &node,
        colleague,
        shell_labels("colleague0000", "their-run"),
    )
    .await;
    // Only one of the two labels: not Sextant's pod, it stays.
    labelled_pod(
        &client,
        &node,
        lookalike,
        json!({ "sextant.dev/node-shell": "true", "sextant.dev/session": "earlier-run", "sextant.dev/owner": me }),
    )
    .await;
    let mut labels = BTreeMap::new();
    labels.insert("app".to_owned(), "not-a-node-shell".to_owned());
    labelled_pod(&client, &node, unrelated, json!(labels)).await;

    // A manager made as the application makes it: it sweeps on connect.
    let app_mgr = ClusterManager::new(mgr.registry());
    app_mgr.sweep_node_shells_on_connect();
    app_mgr.connect(&id).await.unwrap();
    wait_gone(&client, earlier).await;
    assert!(
        pod_exists(&client, &ours_name).await,
        "this run's pod was removed"
    );
    for kept in [colleague, lookalike, unrelated] {
        assert!(pod_exists(&client, kept).await, "{kept} was removed");
    }

    // A manager that does not sweep (tests, the default) leaves them alone.
    let earlier_2 = "sextant-node-shell-earlier-run-2";
    labelled_pod(&client, &node, earlier_2, shell_labels(me, "earlier-run")).await;
    mgr.connect(&id).await.unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(pod_exists(&client, earlier_2).await);

    let pods = Api::<Pod>::namespaced(client.clone(), NAMESPACE);
    for name in [colleague, lookalike, unrelated, earlier_2] {
        let _ = pods.delete(name, &DeleteParams::default()).await;
    }
    ours.delete().await.unwrap();
    for name in [
        ours_name.as_str(),
        colleague,
        lookalike,
        unrelated,
        earlier_2,
    ] {
        wait_gone(&client, name).await;
    }
}

/// An image whose registry never answers: the pod stays in `ContainerCreating` (not a failure) for a long time.
const HANGING_IMAGE: &str = "10.255.255.1:5000/sextant/never:1";

#[tokio::test(flavor = "multi_thread")]
async fn a_start_called_off_while_the_pod_starts_deletes_it_and_is_waited_for() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let _cleanup = Cleanup(client.clone());
    let node = first_node(&client).await;
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let cancel = StartCancel::new();
    let start = tokio::spawn({
        let (mgr, id, node, cancel) = (mgr.clone(), id.clone(), node.clone(), cancel.clone());
        async move { node_shell::create_until(&mgr, &id, &node, HANGING_IMAGE, &cancel).await }
    });
    let pods = Api::<Pod>::namespaced(client.clone(), NAMESPACE);
    let selector = format!(
        "{SELECTOR},sextant.dev/session={}",
        node_shell::session_id()
    );
    common::wait_until("the starting pod to be made", 30, || {
        let pods = pods.clone();
        let selector = selector.clone();
        async move {
            !pods
                .list(&ListParams::default().labels(&selector))
                .await
                .unwrap()
                .items
                .is_empty()
        }
    })
    .await;
    assert!(!start.is_finished(), "the pod started after all");

    cancel.cancel();
    // The application waits for this on exit, from another thread than the runtime's.
    let waited =
        tokio::task::spawn_blocking(|| node_shell::wait_for_deletions(Duration::from_secs(15)))
            .await
            .unwrap();
    assert!(waited, "the called-off start was not waited for");
    let err = start.await.unwrap().expect_err("the start was called off");
    assert_eq!(err, StartCancel::error());
    let left = pods
        .list(&ListParams::default().labels(&selector))
        .await
        .unwrap();
    assert!(
        left.items
            .iter()
            .all(|p| p.metadata.deletion_timestamp.is_some()),
        "the pod was not deleted"
    );
    // The kubelet, still pulling the image, takes minutes to let the pod go; `Cleanup` force-removes it.
}
