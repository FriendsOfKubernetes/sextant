use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, RwLock};

use axum::body::Bytes;
use axum::http::{Method, StatusCode, Uri, header};
use reqwest::Url;
use serde_json::{Value, json};
use sextant_core::KubeconfigRegistry;
use sextant_core::kubeconfig::KubeconfigEnv;

use super::*;

// --- a fake Kubernetes API ---------------------------------------------------------------------------------------

/// One request to the fake API server.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    body: Vec<u8>,
}

type Answer = Arc<dyn Fn(&Seen) -> Option<(u16, String)> + Send + Sync>;

/// A Kubernetes API server on 127.0.0.1: discovery for connecting, then `answer` (`None` → 404). Returns its URL and
/// the requests it got.
async fn fake_kube(
    answer: impl Fn(&Seen) -> Option<(u16, String)> + Send + Sync + 'static,
) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let answer: Answer = Arc::new(answer);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    let app = axum::Router::new().fallback(move |method: Method, uri: Uri, body: Bytes| {
        let answer = Arc::clone(&answer);
        let log = Arc::clone(&log);
        async move {
            let request = Seen {
                method: method.to_string(),
                path: uri.path().to_owned(),
                body: body.to_vec(),
            };
            log.lock().unwrap().push(request.clone());
            let (status, body) = match (request.method.as_str(), request.path.as_str()) {
                ("GET", "/api") => (
                    200,
                    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#
                        .to_owned(),
                ),
                ("GET", "/api/v1") => (
                    200,
                    r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[]}"#.to_owned(),
                ),
                ("GET", "/apis") => (
                    200,
                    r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#.to_owned(),
                ),
                _ => answer(&request).unwrap_or((
                    404,
                    r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}"#
                        .to_owned(),
                )),
            };
            (
                StatusCode::from_u16(status).unwrap(),
                [(header::CONTENT_TYPE, "application/json")],
                body,
            )
        }
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (url, seen)
}

/// A manager whose only cluster is `url`, connected.
async fn connected_to(url: &str) -> (tempfile::TempDir, ClusterManager, ClusterId) {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("kubeconfig");
    std::fs::write(
        &path,
        format!(
            "apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster:\n    server: {url}\n\
             contexts:\n- name: fake\n  context:\n    cluster: fake\n    user: fake\n\
             users:\n- name: fake\n  user: {{}}\ncurrent-context: fake\n"
        ),
    )
    .unwrap();
    let mut registry = KubeconfigRegistry::new(Vec::new(), tmp.path().join("state"));
    registry.set_env(KubeconfigEnv {
        kubeconfig: Some(path.into_os_string()),
        home: Some(tmp.path().join("home")),
    });
    let id = registry.clusters().unwrap()[0].id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
    mgr.connect(&id).await.unwrap();
    (tmp, mgr, id)
}

/// A small Flux-like manifest: its namespace, its key CRD and two controllers.
const MANIFEST: &str = r#"
apiVersion: v1
kind: Namespace
metadata:
  name: flux-system
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: kustomizations.kustomize.toolkit.fluxcd.io
spec:
  group: kustomize.toolkit.fluxcd.io
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: source-controller
  namespace: flux-system
  labels: {app.kubernetes.io/component: source-controller, app.kubernetes.io/part-of: flux}
spec:
  selector: {matchLabels: {app: source-controller}}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kustomize-controller
  namespace: flux-system
  labels: {app.kubernetes.io/component: kustomize-controller, app.kubernetes.io/part-of: flux}
spec:
  selector: {matchLabels: {app: kustomize-controller}}
"#;

fn plan() -> InstallPlan {
    gitops_install::prepare(GitopsTool::Flux, "v2.9.6", MANIFEST).unwrap()
}

fn deployment(name: &str, available: i32) -> Value {
    json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": name, "namespace": "flux-system", "generation": 1,
                     "labels": {"app.kubernetes.io/component": name, "app.kubernetes.io/part-of": "flux"}},
        "spec": {"replicas": 1, "selector": {"matchLabels": {"app": name}},
                 "template": {"metadata": {"labels": {"app": name}}, "spec": {"containers": []}}},
        "status": {"observedGeneration": 1, "replicas": 1, "updatedReplicas": 1,
                   "readyReplicas": available, "availableReplicas": available}
    })
}

fn list(kind: &str, items: Vec<Value>) -> String {
    json!({"apiVersion": "v1", "kind": kind, "metadata": {"resourceVersion": "1"}, "items": items})
        .to_string()
}

/// Applies every PATCH (echoing it), except `fail` (403); lists the Deployments from `deployments()`.
fn cluster_answer(
    fail: Option<&'static str>,
    deployments: impl Fn() -> Vec<Value> + Send + Sync + 'static,
) -> impl Fn(&Seen) -> Option<(u16, String)> + Send + Sync + 'static {
    move |req: &Seen| {
        match (req.method.as_str(), req.path.as_str()) {
        ("PATCH", path) if Some(path) == fail => Some((
            403,
            r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"deployments.apps is forbidden","reason":"Forbidden","code":403}"#
                .to_owned(),
        )),
        ("PATCH", _) => Some((200, String::from_utf8_lossy(&req.body).into_owned())),
        ("GET", "/apis/apps/v1/namespaces/flux-system/deployments") => {
            Some((200, list("DeploymentList", deployments())))
        }
        ("GET", "/apis/apps/v1/namespaces/flux-system/statefulsets") => {
            Some((200, list("StatefulSetList", vec![])))
        }
        ("GET", "/api/v1/namespaces/flux-system/pods") => Some((200, list("PodList", vec![]))),
        _ => None,
    }
    }
}

const FAST: Timing = Timing {
    poll: Duration::from_millis(20),
    timeout: Duration::from_secs(5),
};

async fn run_collect(
    mgr: &ClusterManager,
    id: &ClusterId,
    plan: &InstallPlan,
    stop: &AtomicBool,
    timing: Timing,
) -> Vec<InstallEvent> {
    let mut events = Vec::new();
    run(mgr, id, plan, stop, timing, |e| events.push(e)).await;
    events
}

fn applied(kind: &str, name: &str) -> InstallEvent {
    InstallEvent::Applied {
        kind: kind.into(),
        name: name.into(),
    }
}

// --- run ----------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_install_applies_every_object_then_waits_until_every_controller_is_ready() {
    let polls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&polls);
    // The first look finds one controller still starting, the next finds both available.
    let (url, seen) = fake_kube(cluster_answer(None, move || {
        let first = counter.fetch_add(1, Ordering::SeqCst) == 0;
        vec![
            deployment("source-controller", 1),
            deployment("kustomize-controller", if first { 0 } else { 1 }),
        ]
    }))
    .await;
    let (_tmp, mgr, id) = connected_to(&url).await;

    let events = run_collect(&mgr, &id, &plan(), &AtomicBool::new(false), FAST).await;

    assert_eq!(
        events[..4],
        [
            applied("Namespace", "flux-system"),
            applied(
                "CustomResourceDefinition",
                "kustomizations.kustomize.toolkit.fluxcd.io"
            ),
            applied("Deployment", "source-controller"),
            applied("Deployment", "kustomize-controller"),
        ]
    );
    let InstallEvent::Waiting { workloads } = &events[4] else {
        panic!("{:?}", events[4]);
    };
    assert_eq!(
        workloads.iter().map(|w| w.ready).collect::<Vec<_>>(),
        [true, false]
    );
    let InstallEvent::Done { workloads } = events.last().unwrap() else {
        panic!("{events:?}");
    };
    assert_eq!(workloads.len(), 2);
    assert!(workloads.iter().all(|w| w.ready));
    let patched = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.method == "PATCH")
        .count();
    assert_eq!(patched, 4);
}

#[tokio::test]
async fn no_workload_yet_is_never_ready_and_the_wait_times_out_with_the_reasons() {
    let (url, _) = fake_kube(cluster_answer(None, Vec::new)).await;
    let (_tmp, mgr, id) = connected_to(&url).await;
    let timing = Timing {
        poll: Duration::from_millis(20),
        timeout: Duration::from_millis(150),
    };

    let events = run_collect(&mgr, &id, &plan(), &AtomicBool::new(false), timing).await;

    assert!(
        !events
            .iter()
            .any(|e| matches!(e, InstallEvent::Done { .. })),
        "{events:?}"
    );
    let InstallEvent::TimedOut { workloads } = events.last().unwrap() else {
        panic!("{events:?}");
    };
    let names: Vec<(&str, bool)> = workloads
        .iter()
        .map(|w| (w.name.as_str(), w.ready))
        .collect();
    assert_eq!(
        names,
        [
            ("source-controller", false),
            ("kustomize-controller", false)
        ]
    );
    assert!(workloads.iter().all(|w| w.reason.is_some()));
}

#[tokio::test]
async fn the_first_failure_is_reported_and_nothing_after_it_is_sent() {
    let (url, seen) = fake_kube(cluster_answer(
        Some("/apis/apps/v1/namespaces/flux-system/deployments/source-controller"),
        Vec::new,
    ))
    .await;
    let (_tmp, mgr, id) = connected_to(&url).await;

    let events = run_collect(&mgr, &id, &plan(), &AtomicBool::new(false), FAST).await;

    assert_eq!(events.len(), 4, "{events:?}");
    assert!(matches!(
        &events[2],
        InstallEvent::Failed { kind, name, .. } if kind == "Deployment" && name == "source-controller"
    ));
    let InstallEvent::Error { message } = &events[3] else {
        panic!("{events:?}");
    };
    assert!(message.contains("2 of 4 objects"), "{message}");
    assert!(
        !seen
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.path.ends_with("/kustomize-controller")),
        "nothing after the failure is sent"
    );
}

#[tokio::test]
async fn a_stop_ends_the_install_after_the_current_object_or_while_waiting() {
    let (url, seen) = fake_kube(cluster_answer(None, Vec::new)).await;
    let (_tmp, mgr, id) = connected_to(&url).await;
    let stop = AtomicBool::new(false);
    let mut events = Vec::new();
    run(&mgr, &id, &plan(), &stop, FAST, |e| {
        if matches!(e, InstallEvent::Applied { .. }) {
            stop.store(true, Ordering::SeqCst);
        }
        events.push(e);
    })
    .await;
    assert_eq!(
        events,
        [
            applied("Namespace", "flux-system"),
            InstallEvent::Stopped { applied: 1 }
        ]
    );
    let patched = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.method == "PATCH")
        .count();
    assert_eq!(patched, 1);

    // While waiting for readiness.
    let stop = AtomicBool::new(false);
    let mut events = Vec::new();
    run(&mgr, &id, &plan(), &stop, FAST, |e| {
        if matches!(e, InstallEvent::Waiting { .. }) {
            stop.store(true, Ordering::SeqCst);
        }
        events.push(e);
    })
    .await;
    assert_eq!(
        events.last(),
        Some(&InstallEvent::Stopped { applied: 4 }),
        "{events:?}"
    );
}

#[test]
fn install_events_have_the_wire_format_of_the_contract() {
    let workload = WorkloadState {
        kind: "Deployment".into(),
        name: "argocd-server".into(),
        ready: false,
        reason: Some("pod x: ImagePullBackOff".into()),
    };
    let cases = [
        (
            InstallEvent::Applied {
                kind: "Namespace".into(),
                name: "argocd".into(),
            },
            json!({"type": "applied", "kind": "Namespace", "name": "argocd"}),
        ),
        (
            InstallEvent::TimedOut {
                workloads: vec![workload],
            },
            json!({"type": "timedOut", "workloads": [{"kind": "Deployment", "name": "argocd-server", "ready": false, "reason": "pod x: ImagePullBackOff"}]}),
        ),
        (
            InstallEvent::Stopped { applied: 3 },
            json!({"type": "stopped", "applied": 3}),
        ),
        (
            InstallEvent::Error {
                message: "m".into(),
            },
            json!({"type": "error", "message": "m"}),
        ),
    ];
    for (event, wire) in cases {
        assert_eq!(serde_json::to_value(&event).unwrap(), wire);
    }
}

// --- prepared plans and running installs ---------------------------------------------------------------------------

#[test]
fn a_prepared_plan_is_taken_once_for_its_own_cluster_within_ten_minutes() {
    let installs = GitopsInstalls::default();
    let mine = ClusterId::from("mine");
    let other = ClusterId::from("other");

    let token = installs.keep(mine.clone(), plan()).unwrap();
    assert_eq!(installs.take(&mine, &token).unwrap().version, "v2.9.6");
    assert_eq!(
        installs.take(&mine, &token).unwrap_err().code,
        ErrorCode::NotFound,
        "single use"
    );

    let token = installs.keep(mine.clone(), plan()).unwrap();
    assert_eq!(
        installs.take(&other, &token).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert!(
        installs.take(&mine, &token).is_err(),
        "a token tried against another cluster is spent"
    );

    let token = installs.keep(mine.clone(), plan()).unwrap();
    installs.age(&token, PLAN_TTL);
    assert_eq!(
        installs.take(&mine, &token).unwrap_err().code,
        ErrorCode::NotFound
    );
}

/// An `on_abort` that records why.
fn recorder() -> (Arc<Mutex<Vec<String>>>, impl Fn() -> OnAbort) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    (seen, move || {
        let log = Arc::clone(&log);
        Box::new(move |why: &str| log.lock().unwrap().push(why.to_owned())) as OnAbort
    })
}

#[tokio::test]
async fn running_installs_stop_by_flag_and_are_aborted_with_their_cluster() {
    let (aborted, on_abort) = recorder();
    let installs = GitopsInstalls::default();
    let a = ClusterId::from("a");
    let b = ClusterId::from("b");
    let spawn = || tokio::spawn(std::future::pending::<()>());
    let (task_a, task_b) = (spawn(), spawn());
    let (stop_a, stop_b) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
    installs
        .register(
            "s-a",
            a.clone(),
            Arc::clone(&stop_a),
            task_a.abort_handle(),
            on_abort(),
        )
        .unwrap();
    installs
        .register(
            "s-b",
            b.clone(),
            Arc::clone(&stop_b),
            task_b.abort_handle(),
            on_abort(),
        )
        .unwrap();
    let taken = tokio::spawn(std::future::pending::<()>());
    assert_eq!(
        installs
            .register(
                "s-a",
                a.clone(),
                Arc::default(),
                taken.abort_handle(),
                on_abort()
            )
            .unwrap_err()
            .code,
        ErrorCode::Invalid
    );
    assert!(
        installs
            .register(
                "bad id",
                a.clone(),
                Arc::default(),
                taken.abort_handle(),
                on_abort()
            )
            .is_err()
    );

    assert!(installs.stop("s-b"));
    assert!(stop_b.load(Ordering::SeqCst) && !task_b.is_finished());
    assert!(!installs.stop("unknown"));
    assert!(aborted.lock().unwrap().is_empty(), "a stop is not an abort");

    // A disconnect aborts the cluster's install, tells the window why, and drops its prepared plans.
    let plan_a = installs.keep(a.clone(), plan()).unwrap();
    let plan_b = installs.keep(b.clone(), plan()).unwrap();
    installs.stop_cluster(&a);
    assert!(task_a.await.unwrap_err().is_cancelled());
    assert_eq!(installs.running(), 1);
    assert_eq!(*aborted.lock().unwrap(), [ABORTED_DISCONNECTED]);
    assert_eq!(
        installs.take(&a, &plan_a).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert!(installs.take(&b, &plan_b).is_ok());

    installs.stop_all();
    assert!(task_b.await.unwrap_err().is_cancelled());
    assert_eq!(installs.running(), 0);
    assert_eq!(
        *aborted.lock().unwrap(),
        [ABORTED_DISCONNECTED, ABORTED_CLOSED]
    );
}

#[test]
fn an_aborted_install_ends_with_an_error_saying_what_was_applied() {
    let InstallEvent::Error { message } = aborted(ABORTED_DISCONNECTED, 3, 32) else {
        panic!()
    };
    assert!(
        message.contains("the cluster was disconnected"),
        "{message}"
    );
    assert!(
        message.contains("3 of 32 objects were applied"),
        "{message}"
    );
    let InstallEvent::Error { message } = aborted(ABORTED_CLOSED, 32, 32) else {
        panic!()
    };
    assert!(message.contains("all 32 objects were applied"), "{message}");
}

// --- prepare ------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn prepare_downloads_checks_and_previews_the_plan_under_a_token() {
    use axum::response::IntoResponse;
    // The fake GitHub serves the manifest and the checksums of its release.
    let sums = format!(
        "{}  install.yaml\n",
        download::sha256_hex(MANIFEST.as_bytes())
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let github = listener.local_addr().unwrap();
    let app = axum::Router::new().fallback(move |uri: Uri| {
        let sums = sums.clone();
        async move {
            match uri.path() {
                "/github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml" => {
                    MANIFEST.to_owned().into_response()
                }
                "/github.com/fluxcd/flux2/releases/download/v2.9.6/flux_2.9.6_checksums.txt" => {
                    sums.into_response()
                }
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let installs = GitopsInstalls::new(GitopsDownloader::redirected(
        Arc::new(move |url: &Url| {
            Url::parse(&format!(
                "http://{github}/{}{}",
                url.host_str().unwrap(),
                url.path()
            ))
            .unwrap()
        }),
        download::DOWNLOAD_TIMEOUT,
        download::MAX_MANIFEST_BYTES,
        download::MAX_RELEASES_BYTES,
    ));
    // The cluster: allowed to create everything, the namespace is there already.
    let (url, _) =
        fake_kube(|req: &Seen| {
            match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews") => {
            let mut review: Value = serde_json::from_slice(&req.body).unwrap();
            review["status"] = json!({"allowed": true});
            Some((201, review.to_string()))
        }
        ("GET", "/api/v1/namespaces/flux-system") => Some((
            200,
            json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "flux-system"}})
                .to_string(),
        )),
        ("GET", "/api/v1/namespaces") => Some((
            200,
            json!({"apiVersion": "v1", "kind": "NamespaceList", "metadata": {},
                   "items": [{"metadata": {"name": "flux-system"}}]})
            .to_string(),
        )),
        ("GET", "/apis/apiextensions.k8s.io/v1/customresourcedefinitions") => Some((
            200,
            json!({"apiVersion": "v1", "kind": "List", "metadata": {}, "items": []}).to_string(),
        )),
        ("GET", "/apis/apps/v1/namespaces/flux-system/deployments") => {
            Some((200, list("DeploymentList", vec![deployment("image-reflector-controller", 1)])))
        }
        _ => None,
    }
        })
        .await;
    let (_tmp, mgr, id) = connected_to(&url).await;

    let preview = prepare(&installs, &mgr, &id, GitopsTool::Flux, "v2.9.6")
        .await
        .unwrap();

    assert_eq!(
        preview.source_url,
        "https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml"
    );
    assert_eq!(preview.sha256, download::sha256_hex(MANIFEST.as_bytes()));
    assert!(preview.checksum_verified);
    assert_eq!(preview.namespace, "flux-system");
    assert_eq!(preview.summary.objects.len(), 4);
    assert_eq!(preview.summary.cluster_scoped, 2);
    assert!(preview.access.can_create_crds && preview.access.can_create_cluster_role_bindings);
    assert_eq!(
        preview.existing,
        InstalledState {
            present: false,
            partial: true
        }
    );
    assert_eq!(
        preview
            .overlap
            .cluster_objects
            .iter()
            .map(|o| o.name.as_str())
            .collect::<Vec<_>>(),
        ["flux-system"]
    );
    assert_eq!(
        preview.overlap.left_out_controllers,
        ["image-reflector-controller"]
    );
    let plan = installs.take(&id, &preview.token).unwrap();
    assert_eq!(plan.objects.len(), 4);

    // Not connected: refused before anything is downloaded.
    let err = prepare(
        &installs,
        &mgr,
        &ClusterId::from("nope"),
        GitopsTool::Flux,
        "v2.9.6",
    )
    .await
    .unwrap_err();
    assert_ne!(err.code, ErrorCode::Invalid);
}

// --- not for agents or extensions ----------------------------------------------------------------------------------

#[test]
fn neither_agents_nor_extensions_can_install_flux_or_argocd() {
    let tools = crate::mcp::server::all_tools().names();
    assert!(tools.len() > 10, "{tools:?}");
    // The only installing tool agents have is Helm's (a chart into a namespace, under the access rules).
    let installing: Vec<&str> = tools
        .iter()
        .map(String::as_str)
        .filter(|name| name.contains("install"))
        .collect();
    assert_eq!(installing, ["helm_install", "helm_uninstall"], "{tools:?}");
    let methods = crate::extensions::api::METHODS;
    assert!(
        !methods
            .iter()
            .any(|m| m.contains("install") || m.contains("gitops")),
        "{methods:?}"
    );
}

#[tokio::test]
async fn disconnecting_the_cluster_and_a_reload_of_the_window_abort_its_installs() {
    let dir = tempfile::tempdir().unwrap();
    let state = crate::AppState::new(&dir.path().join("config"), &dir.path().join("data"));
    let cluster = ClusterId::from("c");
    let first = tokio::spawn(std::future::pending::<()>());
    state
        .gitops
        .register(
            "i-1",
            cluster.clone(),
            Arc::default(),
            first.abort_handle(),
            Box::new(|_: &str| {}),
        )
        .unwrap();
    state.close_cluster(&cluster);
    let ended = tokio::time::timeout(Duration::from_secs(2), first).await;
    assert!(ended.expect("aborted").unwrap_err().is_cancelled());

    let second = tokio::spawn(std::future::pending::<()>());
    state
        .gitops
        .register(
            "i-2",
            cluster,
            Arc::default(),
            second.abort_handle(),
            Box::new(|_: &str| {}),
        )
        .unwrap();
    state.reset_streams();
    let ended = tokio::time::timeout(Duration::from_secs(2), second).await;
    assert!(ended.expect("aborted").unwrap_err().is_cancelled());
    assert_eq!(state.gitops.running(), 0);
}
