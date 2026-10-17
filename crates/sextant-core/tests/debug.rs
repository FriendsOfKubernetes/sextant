//! Debug containers (`debug`) and copying files (`files`) against the kind test cluster. Every test makes a scratch
//! namespace of its own (`sextant-debug-*`) and deletes it when it ends; `sextant-demo` is not touched.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test debug -- --test-threads=1
//! ```

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{Namespace, Pod};
use kube::Api;
use kube::api::{DeleteParams, PostParams};
use serde_json::{Value, json};
use sextant_core::debug::{self, DebugCopySpec, DebugSpec, StartCancel};
use sextant_core::exec::{ExecSession, TermEvent, attach_terminal, run_command};
use sextant_core::files::{self, RemoteKind, TransferProgress};
use sextant_core::resources::{KindRef, ObjectRef};
use sextant_core::{ClusterId, ClusterManager, ErrorCode};

/// Distroless-like: no shell, no tar, nothing but `/pause`.
const PAUSE_IMAGE: &str = "registry.k8s.io/pause:3.10";
const BUSYBOX_IMAGE: &str = "busybox:stable";

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

/// A scratch namespace with one pod in phase `phase`, deleted (with everything in it) when dropped.
struct Scratch {
    namespace: String,
    client: kube::Client,
    kubeconfig: PathBuf,
}

impl Scratch {
    async fn new(cluster: &common::TestCluster, namespace: &str) -> Self {
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
                Err(kube::Error::Api(status)) if status.code == 409 => {
                    let _ = namespaces.delete(namespace, &DeleteParams::default()).await;
                    assert!(Instant::now() < deadline, "namespace {namespace} stays");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(e) => panic!("cannot create namespace {namespace}: {e}"),
            }
        }
        Self {
            namespace: namespace.into(),
            client,
            kubeconfig: cluster.kubeconfig.clone(),
        }
    }

    fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    /// Creates pod `name` with `containers` and waits for `phase`.
    async fn pod(&self, name: &str, containers: Value, restart: &str, phase: &str) -> ObjectRef {
        let pod: Pod = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": name, "labels": { "app": name } },
            "spec": { "terminationGracePeriodSeconds": 0, "restartPolicy": restart, "containers": containers },
        }))
        .unwrap();
        self.pods()
            .create(&PostParams::default(), &pod)
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let status =
                serde_json::to_value(self.pods().get(name).await.unwrap()).unwrap()["status"]
                    .clone();
            if status["phase"] == phase {
                break;
            }
            assert!(Instant::now() < deadline, "{name}: no {phase}: {status}");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        pod_ref(&self.namespace, name)
    }

    async fn exists(&self, name: &str) -> bool {
        self.pods().get_opt(name).await.unwrap().is_some()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
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

/// Types `line` and reads output until `done(text)`; panics after 60 s.
async fn run_line(session: &mut ExecSession, line: &str, done: impl Fn(&str) -> bool) -> String {
    session
        .input
        .send(format!("{line}\r").into_bytes())
        .await
        .unwrap();
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !done(&text) {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, session.output.recv()).await {
            Ok(Some(TermEvent::Data(bytes))) => text.push_str(&String::from_utf8_lossy(&bytes)),
            other => panic!("no {line:?} output ({other:?}): {text:?}"),
        }
    }
    text
}

async fn connected(
    cluster: &common::TestCluster,
) -> (tempfile::TempDir, ClusterManager, ClusterId) {
    common::connected(&cluster.kubeconfig).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pod_without_a_shell_is_debugged_with_an_ephemeral_busybox_seeing_its_processes() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let scratch = Scratch::new(&cluster, "sextant-debug-ephemeral").await;
    let pod = scratch
        .pod(
            "distroless",
            json!([{ "name": "app", "image": PAUSE_IMAGE, "imagePullPolicy": "IfNotPresent" }]),
            "Always",
            "Running",
        )
        .await;
    let (_tmp, mgr, id) = connected(&cluster).await;

    // The pod has no shell and no tar: exec fails, copying files says so.
    let err = files::stat(&mgr, &id, &pod, Some("app"), "/pause")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(err.message.contains("has no tar"), "{}", err.message);

    let spec = DebugSpec {
        image: BUSYBOX_IMAGE.into(),
        target: Some("app".into()),
        copy: None,
    };
    let target = debug::start(&mgr, &id, &pod, &spec, &StartCancel::new())
        .await
        .expect("the debug container starts");
    assert_eq!(target.pod, pod);
    assert!(target.copy.is_none());
    assert!(
        target.container.starts_with("debugger-"),
        "{}",
        target.container
    );
    let live = serde_json::to_value(scratch.pods().get("distroless").await.unwrap()).unwrap();
    let added = &live["spec"]["ephemeralContainers"][0];
    assert_eq!(added["name"], json!(target.container));
    assert_eq!(added["targetContainerName"], "app");
    assert_eq!(added["image"], BUSYBOX_IMAGE);

    let mut session = attach_terminal(&mgr, &id, &target.pod, &target.container, 120, 40)
        .await
        .expect("the terminal attaches");
    run_line(&mut session, "echo $((6*7))", |t| t.contains("42")).await;
    // The target's process namespace is shared: `/pause` is visible.
    run_line(&mut session, "ps", |t| t.contains("/pause")).await;
    drop(session);

    // The terminal is gone: its stdin closes and the shell ends with it.
    common::wait_until("the debug container to stop", 60, || {
        let pods = scratch.pods();
        let name = target.container.clone();
        async move {
            let pod = serde_json::to_value(pods.get("distroless").await.unwrap()).unwrap();
            pod["status"]["ephemeralContainerStatuses"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|s| s["name"] == json!(name) && s["state"]["terminated"].is_object())
        }
    })
    .await;

    // A target that is not in the pod is refused before anything changes.
    let wrong = DebugSpec {
        target: Some("nope".into()),
        ..spec
    };
    let err = debug::start(&mgr, &id, &pod, &wrong, &StartCancel::new())
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crashed_pod_is_debugged_as_a_copy_with_a_changed_command_that_goes_with_its_handle() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let scratch = Scratch::new(&cluster, "sextant-debug-copy").await;
    let pod = scratch
        .pod(
            "crashing",
            json!([{ "name": "app", "image": BUSYBOX_IMAGE, "imagePullPolicy": "IfNotPresent",
                     "command": ["sh", "-c", "exit 3"] }]),
            "Never",
            "Failed",
        )
        .await;
    let (_tmp, mgr, id) = connected(&cluster).await;

    let spec = DebugSpec {
        image: BUSYBOX_IMAGE.into(),
        target: Some("app".into()),
        copy: Some(DebugCopySpec {
            command: vec!["sleep".into(), "3600".into()],
        }),
    };
    let target = debug::start(&mgr, &id, &pod, &spec, &StartCancel::new())
        .await
        .expect("the copy starts");
    let copy_name = target.pod.name.clone();
    assert!(copy_name.starts_with("crashing-debug-"), "{copy_name}");
    let copy = serde_json::to_value(scratch.pods().get(&copy_name).await.unwrap()).unwrap();
    assert_eq!(copy["metadata"]["labels"]["sextant.dev/debug-copy"], "true");
    assert!(copy["metadata"]["labels"].get("app").is_none());
    assert_eq!(copy["spec"]["shareProcessNamespace"], true);
    assert_eq!(
        copy["spec"]["containers"][0]["command"],
        json!(["sleep", "3600"])
    );

    let mut session = attach_terminal(&mgr, &id, &target.pod, &target.container, 120, 40)
        .await
        .expect("the terminal attaches");
    run_line(&mut session, "ps", |t| t.contains("sleep 3600")).await;
    drop(session);

    let pending = debug::pending_copies();
    assert!(pending >= 1, "{pending}");
    drop(target);
    common::wait_until("the copy to be deleted", 60, || {
        let scratch = &scratch;
        let name = copy_name.clone();
        async move { !scratch.exists(&name).await }
    })
    .await;
    assert!(scratch.exists("crashing").await, "the original stays");
}

#[tokio::test(flavor = "multi_thread")]
async fn files_are_downloaded_and_uploaded_through_tar() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let scratch = Scratch::new(&cluster, "sextant-debug-files").await;
    let pod = scratch
        .pod(
            "box",
            json!([{ "name": "box", "image": BUSYBOX_IMAGE, "imagePullPolicy": "IfNotPresent",
                     "command": ["sleep", "3600"] }]),
            "Always",
            "Running",
        )
        .await;
    let (_tmp, mgr, id) = connected(&cluster).await;
    let dir = tempfile::tempdir().unwrap();

    // A file: its size, then its content alone.
    let entry = files::stat(&mgr, &id, &pod, None, "/etc/hostname")
        .await
        .unwrap();
    assert_eq!(entry.kind, RemoteKind::File);
    assert_eq!(entry.name, "hostname");
    assert_eq!(entry.size, Some("box\n".len() as u64));
    let saved = dir.path().join("hostname.txt");
    let mut seen: Vec<TransferProgress> = Vec::new();
    let done = files::download(
        &mgr,
        &id,
        &pod,
        None,
        "/etc/hostname",
        Some(RemoteKind::File),
        &saved,
        &mut |p| seen.push(p),
    )
    .await
    .unwrap();
    assert_eq!(done.kind, RemoteKind::File);
    assert_eq!(std::fs::read_to_string(&saved).unwrap(), "box\n");
    assert_eq!(seen.last().unwrap().total, Some(4));

    // An upload, read back in the container and downloaded again.
    let content: Vec<u8> = (0..1_500_000u32).map(|i| (i % 251) as u8).collect();
    let source = dir.path().join("payload.bin");
    std::fs::write(&source, &content).unwrap();
    let mut sent = Vec::new();
    let bytes = files::upload(
        &mgr,
        &id,
        &pod,
        Some("box"),
        &source,
        "/tmp/payload.bin",
        &mut |p| sent.push(p.transferred),
    )
    .await
    .unwrap();
    assert_eq!(bytes, content.len() as u64);
    assert_eq!(*sent.last().unwrap(), content.len() as u64);
    let size = run_command(
        &mgr,
        &id,
        &pod,
        None,
        &["wc".into(), "-c".into(), "/tmp/payload.bin".into()],
        Duration::from_secs(20),
        1024,
    )
    .await
    .unwrap();
    assert!(
        size.stdout.starts_with(&content.len().to_string()),
        "{:?}",
        size.stdout
    );
    let back = dir.path().join("back.bin");
    files::download(
        &mgr,
        &id,
        &pod,
        None,
        "/tmp/payload.bin",
        None,
        &back,
        &mut |_| {},
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(&back).unwrap(), content);

    // A folder: a .tar.gz with every file in it.
    let entry = files::stat(&mgr, &id, &pod, None, "/etc").await.unwrap();
    assert_eq!(entry.kind, RemoteKind::Directory);
    assert!(entry.size.is_some_and(|s| s > 0), "{:?}", entry.size);
    let archive = dir.path().join("etc.tar.gz");
    let done = files::download(
        &mgr,
        &id,
        &pod,
        None,
        "/etc",
        Some(RemoteKind::Directory),
        &archive,
        &mut |_| {},
    )
    .await
    .unwrap();
    assert_eq!(done.kind, RemoteKind::Directory);
    let listing = std::process::Command::new("tar")
        .arg("tzf")
        .arg(&archive)
        .output()
        .expect("tar runs here");
    let listing = String::from_utf8_lossy(&listing.stdout);
    assert!(listing.contains("etc/hostname"), "{listing}");
    // What stat saw must still hold when the download runs.
    let err = files::download(
        &mgr,
        &id,
        &pod,
        None,
        "/etc",
        Some(RemoteKind::File),
        &archive,
        &mut |_| {},
    )
    .await
    .unwrap_err();
    assert!(
        err.message.contains("changed since it was checked"),
        "{}",
        err.message
    );

    // Errors: a missing path, a missing folder for an upload, a link.
    let err = files::stat(&mgr, &id, &pod, None, "/no/such/file")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{}", err.message);
    let err = files::upload(
        &mgr,
        &id,
        &pod,
        None,
        &source,
        "/no/such/dir/x",
        &mut |_| {},
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("cannot copy"), "{}", err.message);
    run_command(
        &mgr,
        &id,
        &pod,
        None,
        &[
            "ln".into(),
            "-s".into(),
            "/etc/hostname".into(),
            "/tmp/link".into(),
        ],
        Duration::from_secs(20),
        1024,
    )
    .await
    .unwrap();
    let entry = files::stat(&mgr, &id, &pod, None, "/tmp/link")
        .await
        .unwrap();
    assert_eq!(entry.kind, RemoteKind::Symlink);
    assert_eq!(entry.link_target.as_deref(), Some("/etc/hostname"));
}
