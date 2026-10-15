//! Shell in a container (`exec::exec_shell`) against the kind test cluster. Pods are created in namespaces of
//! their own (`sextant-exec-*`) and removed with them; `sextant-demo` is not touched.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test exec -- --test-threads=1
//! ```

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::Api;
use kube::api::{DeleteParams, PostParams};
use serde_json::{Value, json};
use sextant_core::exec::{ExecSession, TermEvent, exec_shell};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::resources::{KindRef, ObjectRef};
use sextant_core::{ClusterId, ClusterManager, ErrorCode, KubeconfigRegistry};

/// Debian-based nginx: has `bash`.
const NGINX_IMAGE: &str = "nginx:stable";
/// The demo nginx (`scripts/fixtures`): Alpine, no `bash`, busybox `top`.
const NGINX_ALPINE_IMAGE: &str = "nginx:stable-alpine";
/// No `bash`, only `sh`.
const BUSYBOX_IMAGE: &str = "busybox:stable";

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

/// A namespace with one running pod, deleted when the test ends.
struct TestPod {
    namespace: String,
    name: String,
    client: kube::Client,
    kubeconfig: PathBuf,
}

impl TestPod {
    async fn run(
        cluster: &common::TestCluster,
        namespace: &str,
        name: &str,
        container: Value,
    ) -> Self {
        let client = cluster.client().await;
        let namespaces = Api::<Namespace>::all(client.clone());
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let ns: Namespace = serde_json::from_value(
                json!({ "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": namespace } }),
            )
            .unwrap();
            match namespaces.create(&PostParams::default(), &ns).await {
                Ok(_) => break,
                // A leftover of an interrupted run may still be terminating.
                Err(kube::Error::Api(status)) if status.code == 409 => {
                    let _ = namespaces.delete(namespace, &DeleteParams::default()).await;
                    assert!(
                        Instant::now() < deadline,
                        "namespace {namespace} will not go away"
                    );
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(e) => panic!("cannot create namespace {namespace}: {e}"),
            }
        }
        let this = Self {
            namespace: namespace.into(),
            name: name.into(),
            client,
            kubeconfig: cluster.kubeconfig.clone(),
        };
        let pod: Pod = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": name },
            "spec": { "terminationGracePeriodSeconds": 0, "containers": [container] },
        }))
        .unwrap();
        let pods = Api::<Pod>::namespaced(this.client.clone(), namespace);
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
        pod_ref(&self.namespace, &self.name)
    }
}

impl Drop for TestPod {
    fn drop(&mut self) {
        // Best effort, from a thread and runtime of its own with a client of its own: the test's client runs on the
        // test's runtime, which is blocked in this `drop`.
        let (name, kubeconfig) = (self.namespace.clone(), self.kubeconfig.clone());
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let client = common::client_from(&kubeconfig).await;
                let _ = tokio::time::timeout(
                    Duration::from_secs(30),
                    Api::<Namespace>::all(client).delete(&name, &DeleteParams::default()),
                )
                .await;
            });
        })
        .join();
    }
}

/// Output of a session collected so far.
struct Screen {
    session: ExecSession,
    text: String,
    exit: Option<Option<i32>>,
}

impl Screen {
    fn new(session: ExecSession) -> Self {
        Self {
            session,
            text: String::new(),
            exit: None,
        }
    }

    async fn type_line(&self, line: &str) {
        self.session
            .input
            .send(format!("{line}\n").into_bytes())
            .await
            .expect("the session takes input");
    }

    /// Reads output until `done(text)` holds; panics after 30 s.
    async fn wait_for(&mut self, what: &str, done: impl Fn(&str) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !done(&self.text) {
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, self.session.output.recv()).await {
                Ok(Some(TermEvent::Data(bytes))) => {
                    self.text.push_str(&String::from_utf8_lossy(&bytes))
                }
                Ok(Some(TermEvent::Exit { code })) => {
                    self.exit = Some(code);
                    assert!(
                        done(&self.text),
                        "session exited ({code:?}) before {what}: {:?}",
                        self.text
                    );
                }
                Ok(Some(TermEvent::Error(e))) => panic!("session error before {what}: {e}"),
                Ok(None) => panic!("output closed before {what}: {:?}", self.text),
                Err(_) => panic!("timed out waiting for {what}: {:?}", self.text),
            }
        }
    }

    /// Reads until the session exits; returns its exit code.
    async fn wait_exit(&mut self) -> Option<i32> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(code) = self.exit {
                return code;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, self.session.output.recv()).await {
                Ok(Some(TermEvent::Data(bytes))) => {
                    self.text.push_str(&String::from_utf8_lossy(&bytes))
                }
                Ok(Some(TermEvent::Exit { code })) => self.exit = Some(code),
                Ok(Some(TermEvent::Error(e))) => panic!("session error instead of exit: {e}"),
                Ok(None) => panic!("output closed without an exit event: {:?}", self.text),
                Err(_) => panic!("timed out waiting for exit: {:?}", self.text),
            }
        }
    }
}

#[tokio::test]
async fn shell_in_nginx_is_bash_runs_commands_and_follows_resize() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let pod = TestPod::run(
        &cluster,
        "sextant-exec-bash",
        "web",
        json!({ "name": "nginx", "image": NGINX_IMAGE }),
    )
    .await;

    let session = exec_shell(&mgr, &id, &pod.pod_ref(), "nginx", 80, 24)
        .await
        .expect("the shell starts");
    let mut screen = Screen::new(session);

    screen
        .type_line("echo shell=$0 term=$TERM; stty size")
        .await;
    screen
        .wait_for("bash with the initial size", |t| {
            t.contains("shell=bash") && t.contains("24 80")
        })
        .await;
    assert!(
        !screen.text.contains("term= "),
        "TERM is set for full-screen programs: {:?}",
        screen.text
    );

    screen.type_line("ls / && echo listed-ok").await;
    screen
        .wait_for("ls", |t| t.contains("etc") && t.contains("listed-ok"))
        .await;

    screen.session.resize.send((132, 40)).await.unwrap();
    // The size and the keystrokes travel on different websocket channels; let the size arrive first.
    tokio::time::sleep(Duration::from_millis(500)).await;
    screen.type_line("stty size").await;
    screen
        .wait_for("the new size", |t| t.contains("40 132"))
        .await;

    screen.type_line("exit 3").await;
    assert_eq!(screen.wait_exit().await, Some(3));
}

#[tokio::test]
async fn full_screen_top_runs_in_alpine_nginx() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let pod = TestPod::run(
        &cluster,
        "sextant-exec-top",
        "web",
        json!({ "name": "nginx", "image": NGINX_ALPINE_IMAGE }),
    )
    .await;

    let session = exec_shell(&mgr, &id, &pod.pod_ref(), "nginx", 100, 30)
        .await
        .expect("the shell starts");
    let mut screen = Screen::new(session);
    screen.type_line("ls /etc/nginx && echo listed-ok").await;
    screen
        .wait_for("ls", |t| {
            t.contains("nginx.conf") && t.contains("listed-ok")
        })
        .await;

    screen.type_line("top").await;
    screen
        .wait_for("the top screen", |t| {
            t.contains("PID") && t.contains("nginx: master")
        })
        .await;
    screen.session.input.send(b"q".to_vec()).await.unwrap();
    screen.type_line("echo top-exit=$?").await;
    screen
        .wait_for("top to quit", |t| t.contains("top-exit=0"))
        .await;
    assert!(
        !screen.text.contains("TERM environment variable not set"),
        "{:?}",
        screen.text
    );
}

#[tokio::test]
async fn container_without_bash_gets_sh_and_exit_ends_the_session() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let pod = TestPod::run(
        &cluster,
        "sextant-exec-sh",
        "box",
        json!({ "name": "busybox", "image": BUSYBOX_IMAGE, "command": ["sleep", "3600"] }),
    )
    .await;

    let session = exec_shell(&mgr, &id, &pod.pod_ref(), "busybox", 80, 24)
        .await
        .expect("the shell starts");
    let mut screen = Screen::new(session);
    screen.type_line("echo shell=$0").await;
    screen.wait_for("sh", |t| t.contains("shell=sh")).await;
    assert!(
        !screen.text.contains("executable file not found"),
        "the failed bash attempt is not shown: {:?}",
        screen.text
    );

    screen.type_line("exit").await;
    assert_eq!(screen.wait_exit().await, Some(0));
}

/// The owner stops taking output (the window is behind, #122): the session stops reading the websocket rather than
/// buffering without end, and keystrokes still reach the shell, so Ctrl+C stops a command that prints without a pause.
#[tokio::test]
async fn a_flooding_command_whose_output_is_not_taken_still_gets_ctrl_c() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let pod = TestPod::run(
        &cluster,
        "sextant-exec-flood",
        "box",
        json!({ "name": "busybox", "image": BUSYBOX_IMAGE, "command": ["sleep", "3600"] }),
    )
    .await;

    let session = exec_shell(&mgr, &id, &pod.pod_ref(), "busybox", 80, 24)
        .await
        .expect("the shell starts");
    let mut screen = Screen::new(session);
    screen.type_line("echo ready-$((1+1))").await;
    screen
        .wait_for("the shell", |t| t.contains("ready-2"))
        .await;
    screen.type_line("yes").await;
    // Nobody reads: the output channel fills and the session stops reading the shell.
    tokio::time::sleep(Duration::from_secs(2)).await;
    screen.session.input.send(b"\x03".to_vec()).await.unwrap();
    screen.type_line("echo stopped-$((40+2))").await;
    screen
        .wait_for("yes to stop", |t| t.contains("stopped-42"))
        .await;
}

#[tokio::test]
async fn closing_input_ends_the_session() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let pod = TestPod::run(
        &cluster,
        "sextant-exec-close",
        "box",
        json!({ "name": "busybox", "image": BUSYBOX_IMAGE, "command": ["sleep", "3600"] }),
    )
    .await;

    let ExecSession {
        input,
        resize,
        mut output,
    } = exec_shell(&mgr, &id, &pod.pod_ref(), "busybox", 80, 24)
        .await
        .expect("the shell starts");
    drop(input);
    drop(resize);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, output.recv())
            .await
            .expect("the session ends after its input is closed")
        {
            Some(TermEvent::Data(_)) => continue,
            Some(TermEvent::Exit { .. }) | None => break,
            Some(TermEvent::Error(e)) => panic!("unexpected error: {e}"),
        }
    }
}

#[tokio::test]
async fn missing_pod_or_container_is_an_error_not_a_session() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let err = exec_shell(
        &mgr,
        &id,
        &pod_ref("sextant-demo", "no-such-pod"),
        "x",
        80,
        24,
    )
    .await
    .err()
    .expect("no session for a missing pod");
    assert_eq!(err.code, ErrorCode::NotFound, "{err}");

    let pod = TestPod::run(
        &cluster,
        "sextant-exec-missing",
        "box",
        json!({ "name": "busybox", "image": BUSYBOX_IMAGE, "command": ["sleep", "3600"] }),
    )
    .await;
    let err = exec_shell(&mgr, &id, &pod.pod_ref(), "no-such-container", 80, 24)
        .await
        .err()
        .expect("no session for a missing container");
    assert!(err.message.contains("no-such-container"), "{err}");
}

#[tokio::test]
async fn shell_needs_a_connected_cluster() {
    let tmp = tempfile::tempdir().unwrap();
    let registry =
        KubeconfigRegistry::new(Vec::new(), tmp.path().to_path_buf()).with_env(KubeconfigEnv {
            kubeconfig: None,
            home: Some(tmp.path().to_path_buf()),
        });
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
    let err = exec_shell(
        &mgr,
        &ClusterId::from("nope"),
        &pod_ref("default", "p"),
        "c",
        80,
        24,
    )
    .await
    .err()
    .expect("not connected");
    assert_eq!(err.code, ErrorCode::NotFound);
}
