//! The Argo CD actions of the window (`src/features/argocd`) against the kind test cluster with Argo CD: the merge
//! patches it sends through `resources::patch` start a sync, ask for a refresh and terminate a running operation;
//! the web UI answers through a port forwarded to `argocd-server`, which is found by its label.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) SEXTANT_TEST_GITOPS=1 \
//!   cargo test -p sextant-core --test gitops_argocd -- --test-threads=1
//! ```
//!
//! Without both variables every test is skipped. Each test makes its own Application `sextant-argocd-<test>` in
//! `argocd` (Argo CD only picks up Applications there) that deploys the guestbook example into its own namespace
//! `sextant-gitops-argocd-<test>`; both are removed afterwards. The fixture `argocd/guestbook` is only read.

mod common;

use common::{connected, gitops_cluster, wait_until};

use std::future::Future;
use std::net::Ipv4Addr;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Namespace, Service};
use kube::api::{
    ApiResource, DeleteParams, DynamicObject, GroupVersionKind, ListParams, PostParams,
};
use kube::{Api, Client};
use serde_json::{Value, json};
use sextant_core::portforward::{ForwardTarget, PortForwarder};
use sextant_core::resources::{self, KindRef, ObjectRef, PatchType};
use sextant_core::{ClusterId, ClusterManager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Where `up --gitops` installs Argo CD.
const ARGOCD_NAMESPACE: &str = "argocd";
/// The label the window finds argocd-server by (`ARGOCD_SERVER_SELECTOR` in `src/features/argocd/server.ts`).
const SERVER_SELECTOR: &str = "app.kubernetes.io/name=argocd-server";
const REFRESH_ANNOTATION: &str = "argocd.argoproj.io/refresh";

fn applications(client: &Client) -> Api<DynamicObject> {
    let gvk = GroupVersionKind::gvk("argoproj.io", "v1alpha1", "Application");
    Api::namespaced_with(
        client.clone(),
        ARGOCD_NAMESPACE,
        &ApiResource::from_gvk(&gvk),
    )
}

fn application_ref(name: &str) -> ObjectRef {
    ObjectRef {
        kind: KindRef {
            group: "argoproj.io".into(),
            version: "v1alpha1".into(),
            kind: "Application".into(),
        },
        namespace: Some(ARGOCD_NAMESPACE.into()),
        name: name.into(),
    }
}

struct Scratch {
    mgr: ClusterManager,
    id: ClusterId,
    client: Client,
    /// The Application, in `argocd`.
    app: String,
    /// Its destination namespace.
    dest: String,
    _tmp: tempfile::TempDir,
}

impl Scratch {
    async fn app(&self) -> Value {
        let obj = applications(&self.client).get(&self.app).await.unwrap();
        serde_json::to_value(obj).unwrap()
    }

    /// `resources::patch` of the Application with a merge patch, as the window sends it.
    async fn patch(&self, patch: Value) -> Value {
        resources::patch(
            &self.mgr,
            &self.id,
            &application_ref(&self.app),
            &patch,
            PatchType::Merge,
        )
        .await
        .unwrap()
    }
}

/// Removes the Application (without cascading: it has no finalizer) and its destination namespace.
async fn remove(client: &Client, app: &str, dest: &str) {
    let apps = applications(client);
    let _ = apps.delete(app, &DeleteParams::background()).await;
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(dest, &DeleteParams::background()).await;
    wait_until("the old Application and namespace to go away", 180, || {
        let (apps, namespaces) = (apps.clone(), namespaces.clone());
        async move {
            apps.get_opt(app).await.unwrap().is_none()
                && namespaces.get_opt(dest).await.unwrap().is_none()
        }
    })
    .await;
}

/// Runs `body` with a manager connected as admin and a fresh manual-sync Application `sextant-argocd-<test>` of the
/// guestbook example into `sextant-gitops-argocd-<test>`; both are removed afterwards, also when `body` panics.
async fn with_application<F, Fut>(test: &str, body: F)
where
    F: FnOnce(Scratch) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some(cluster) = gitops_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let app = format!("sextant-argocd-{test}");
    let dest = format!("sextant-gitops-argocd-{test}");
    remove(&client, &app, &dest).await;

    let manifest: DynamicObject = serde_json::from_value(json!({
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Application",
        "metadata": { "name": app, "namespace": ARGOCD_NAMESPACE },
        "spec": {
            "project": "default",
            "source": {
                "repoURL": "https://github.com/argoproj/argocd-example-apps",
                "targetRevision": "HEAD",
                "path": "guestbook",
            },
            "destination": { "server": "https://kubernetes.default.svc", "namespace": dest },
            "syncPolicy": { "syncOptions": ["CreateNamespace=true"] },
        },
    }))
    .unwrap();
    applications(&client)
        .create(&PostParams::default(), &manifest)
        .await
        .unwrap();

    let (tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let scratch = Scratch {
        mgr,
        id,
        client: client.clone(),
        app: app.clone(),
        dest: dest.clone(),
        _tmp: tmp,
    };
    let result = AssertUnwindSafe(body(scratch)).catch_unwind().await;
    remove(&client, &app, &dest).await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

fn phase(app: &Value) -> Option<&str> {
    app["status"]["operationState"]["phase"].as_str()
}

// ---------- Sync ----------

#[tokio::test]
async fn the_sync_patch_starts_an_operation_that_deploys_the_app_and_names_its_initiator() {
    with_application("sync", |s| async move {
        // `syncPatch` of the Sync dialog: revision, prune, dry run and the app's own sync options.
        let saved = s
            .patch(json!({
                "operation": {
                    "initiatedBy": { "username": "sextant" },
                    "sync": {
                        "revision": "HEAD",
                        "prune": false,
                        "dryRun": false,
                        "syncOptions": ["CreateNamespace=true"],
                    },
                },
            }))
            .await;
        assert_eq!(saved["operation"]["sync"]["revision"], "HEAD");

        // The controller takes the operation up (status.operationState) and runs it to the end.
        wait_until("the sync to succeed", 120, || async {
            let app = s.app().await;
            matches!(phase(&app), Some("Failed" | "Error"))
                .then(|| panic!("the sync failed: {}", app["status"]["operationState"]));
            phase(&app) == Some("Succeeded")
        })
        .await;
        let app = s.app().await;
        assert_eq!(
            app["status"]["operationState"]["operation"]["initiatedBy"]["username"],
            "sextant"
        );
        let history = app["status"]["history"].as_array().expect("a sync history");
        let last = history.last().unwrap();
        assert_eq!(last["initiatedBy"]["username"], "sextant", "{last}");
        assert!(
            last["revision"].as_str().is_some_and(|r| r.len() == 40),
            "{last}"
        );
        let deployments: Api<Deployment> = Api::namespaced(s.client.clone(), &s.dest);
        assert!(
            deployments.get_opt("guestbook-ui").await.unwrap().is_some(),
            "the sync deployed the guestbook into {}",
            s.dest
        );
    })
    .await;
}

#[tokio::test]
async fn a_dry_run_sync_changes_nothing() {
    with_application("dry-run", |s| async move {
        s.patch(json!({
            "operation": {
                "initiatedBy": { "username": "sextant" },
                "sync": {
                    "revision": "HEAD",
                    "prune": false,
                    "dryRun": true,
                    "syncOptions": ["CreateNamespace=true"],
                },
            },
        }))
        .await;
        wait_until("the dry run to finish", 120, || async {
            let app = s.app().await;
            matches!(phase(&app), Some("Succeeded" | "Failed" | "Error"))
        })
        .await;
        let app = s.app().await;
        assert_eq!(phase(&app), Some("Succeeded"), "{}", app["status"]);
        assert!(
            app["status"]["history"]
                .as_array()
                .is_none_or(Vec::is_empty),
            "a dry run is not a deployment: {}",
            app["status"]["history"]
        );
        let namespaces: Api<Namespace> = Api::all(s.client.clone());
        assert!(namespaces.get_opt(&s.dest).await.unwrap().is_none());
    })
    .await;
}

// ---------- Refresh ----------

#[tokio::test]
async fn refresh_and_hard_refresh_set_the_annotation_the_controller_acts_on() {
    with_application("refresh", |s| async move {
        wait_until("the first comparison", 60, || async {
            s.app().await["status"]["reconciledAt"].is_string()
        })
        .await;
        for kind in ["normal", "hard"] {
            let before = s.app().await["status"]["reconciledAt"].clone();
            // Compared at second precision: let a second pass so the next comparison has a new time.
            tokio::time::sleep(Duration::from_millis(1100)).await;
            let saved = s
                .patch(json!({ "metadata": { "annotations": { REFRESH_ANNOTATION: kind } } }))
                .await;
            assert_eq!(saved["metadata"]["annotations"][REFRESH_ANNOTATION], kind);
            // The controller compares the app again and removes the annotation.
            wait_until(&format!("the {kind} refresh to be done"), 60, || async {
                let app = s.app().await;
                app["metadata"]["annotations"][REFRESH_ANNOTATION].is_null()
                    && app["status"]["reconciledAt"] != before
            })
            .await;
        }
    })
    .await;
}

// ---------- Terminate ----------

#[tokio::test]
async fn terminate_stops_a_running_operation() {
    with_application("terminate", |s| async move {
        // A sync to a revision that does not exist keeps failing; with a long retry backoff the operation stays
        // Running between attempts — long enough to terminate it.
        s.patch(json!({
            "operation": {
                "initiatedBy": { "username": "sextant" },
                "sync": { "revision": "sextant-no-such-revision", "syncOptions": ["CreateNamespace=true"] },
                "retry": { "limit": 5, "backoff": { "duration": "3m" } },
            },
        }))
        .await;
        // Waiting for the next attempt (not in the middle of one, whose end would overwrite the phase).
        wait_until("the operation to wait for a retry", 90, || async {
            let app = s.app().await;
            phase(&app) == Some("Running")
                && app["status"]["operationState"]["retryCount"]
                    .as_i64()
                    .is_some_and(|n| n >= 1)
        })
        .await;

        // `terminatePatch`.
        let started = Instant::now();
        let saved = s
            .patch(json!({ "status": { "operationState": { "phase": "Terminating" } } }))
            .await;
        assert_eq!(phase(&saved), Some("Terminating"));
        wait_until("the operation to end", 60, || async {
            let app = s.app().await;
            matches!(phase(&app), Some("Failed" | "Error")) && app["operation"].is_null()
        })
        .await;
        assert!(
            started.elapsed() < Duration::from_secs(120),
            "ended by the termination, not by the next retry"
        );
        let app = s.app().await;
        assert!(app["status"]["operationState"]["finishedAt"].is_string());
    })
    .await;
}

// ---------- Web UI ----------

/// `GET /` through the local port; the response head.
async fn http_get(port: u16) -> String {
    let mut stream = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect((Ipv4Addr::LOCALHOST, port)),
    )
    .await
    .expect("connect timed out")
    .expect("connect");
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut response)).await;
    String::from_utf8_lossy(&response).into_owned()
}

#[tokio::test]
async fn the_web_ui_answers_through_a_forward_to_argocd_server_found_by_its_label() {
    let Some(cluster) = gitops_cluster() else {
        return;
    };
    let client = cluster.client().await;
    // How the window finds Argo CD: the Service with the label, in any namespace.
    let services: Api<Service> = Api::all(client.clone());
    let found = services
        .list(&ListParams::default().labels(SERVER_SELECTOR))
        .await
        .unwrap();
    let server = found
        .items
        .iter()
        .find(|s| s.metadata.name.as_deref() == Some("argocd-server"))
        .expect("argocd-server by its label");
    assert_eq!(server.metadata.namespace.as_deref(), Some(ARGOCD_NAMESPACE));
    let ports: Vec<i32> = server
        .spec
        .as_ref()
        .and_then(|s| s.ports.as_ref())
        .map(|ports| ports.iter().map(|p| p.port).collect())
        .unwrap_or_default();
    assert!(ports.contains(&443), "{ports:?}");

    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let forwarder = PortForwarder::new();
    let info = forwarder
        .start(
            &mgr,
            &id,
            ForwardTarget::Service {
                namespace: ARGOCD_NAMESPACE.into(),
                name: "argocd-server".into(),
            },
            443,
            None,
        )
        .await
        .unwrap();
    // The server speaks TLS; a plain HTTP request on the same port is redirected to https — the scheme the window
    // opens.
    let response = http_get(info.local_port).await;
    forwarder.stop(&info.id).await.unwrap();
    let head = response.lines().next().unwrap_or_default();
    assert!(head.starts_with("HTTP/1.1 307"), "{response}");
    assert!(
        response
            .lines()
            .any(|l| l.to_ascii_lowercase().starts_with("location: https://")),
        "{response}"
    );
}
