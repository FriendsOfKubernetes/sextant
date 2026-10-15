use std::collections::BTreeSet;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

/// The official `install.yaml` of Flux v2.9.6 (https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml).
const FLUX_GZ: &[u8] = include_bytes!("testdata/flux-v2.9.6-install.yaml.gz");
/// The official `manifests/install.yaml` of Argo CD v3.5.5
/// (https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.5/manifests/install.yaml).
const ARGOCD_GZ: &[u8] = include_bytes!("testdata/argocd-v3.5.5-install.yaml.gz");

fn gunzip(bytes: &[u8]) -> String {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .unwrap();
    text
}

fn flux_manifest() -> String {
    gunzip(FLUX_GZ)
}

fn argocd_manifest() -> String {
    gunzip(ARGOCD_GZ)
}

/// The documents of a manifest read on their own (not through the code under test).
fn raw_documents(yaml: &str) -> Vec<Value> {
    serde_yaml::Deserializer::from_str(yaml)
        .map(|de| serde::Deserialize::deserialize(de).unwrap())
        .filter(|v: &Value| !v.is_null())
        .collect()
}

fn names_of<'a>(plan: &'a InstallPlan, kind: &str) -> BTreeSet<&'a str> {
    plan.objects
        .iter()
        .filter(|o| o.kind == kind)
        .map(|o| o.name.as_str())
        .collect()
}

const DROPPED_FLUX: [&str; 3] = [
    "image-reflector-controller",
    "image-automation-controller",
    "source-watcher",
];

#[test]
fn flux_is_planned_like_flux_install_with_only_the_four_default_controllers() {
    let plan = prepare(GitopsTool::Flux, "v2.9.6", &flux_manifest()).unwrap();

    assert_eq!(plan.namespace, "flux-system");
    assert_eq!(
        names_of(&plan, "Deployment"),
        BTreeSet::from([
            "helm-controller",
            "kustomize-controller",
            "notification-controller",
            "source-controller"
        ])
    );
    assert_eq!(
        names_of(&plan, "ServiceAccount"),
        BTreeSet::from([
            "helm-controller",
            "kustomize-controller",
            "notification-controller",
            "source-controller"
        ])
    );
    for object in &plan.objects {
        for dropped in DROPPED_FLUX {
            assert!(!object.name.contains(dropped), "{object:?}");
        }
    }
    let crds = names_of(&plan, "CustomResourceDefinition");
    assert_eq!(crds.len(), 11, "{crds:?}");
    for crd in &crds {
        assert!(
            !crd.ends_with(".image.toolkit.fluxcd.io")
                && !crd.ends_with(".source.extensions.fluxcd.io"),
            "{crd}"
        );
    }
    assert!(crds.contains("kustomizations.kustomize.toolkit.fluxcd.io"));
    assert!(crds.contains("helmreleases.helm.toolkit.fluxcd.io"));
    // 43 documents in the file: 4 CRDs, 3 ServiceAccounts, 1 Service and 3 Deployments belong to dropped components.
    assert_eq!(plan.objects.len(), 43 - 11);

    // The shared binding no longer names the ServiceAccounts that are not installed.
    let binding = plan
        .documents()
        .iter()
        .find(|d| d.kind_ref().kind == "ClusterRoleBinding" && d.name() == "crd-controller")
        .expect("crd-controller binding");
    let subjects: BTreeSet<&str> = binding.value()["subjects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        subjects,
        BTreeSet::from([
            "helm-controller",
            "kustomize-controller",
            "notification-controller",
            "source-controller"
        ])
    );
}

#[test]
fn flux_objects_come_namespace_first_then_crds_then_the_file_order() {
    let manifest = flux_manifest();
    let plan = prepare(GitopsTool::Flux, "v2.9.6", &manifest).unwrap();

    assert_eq!(
        plan.objects[0],
        PlannedObject {
            kind: "Namespace".into(),
            name: "flux-system".into(),
            namespace: None,
            cluster_scoped: true,
        }
    );
    let crd_count = 11;
    assert!(
        plan.objects[1..=crd_count]
            .iter()
            .all(|o| o.kind == "CustomResourceDefinition")
    );
    // The rest keeps the file's order.
    let kept: Vec<(String, String)> = raw_documents(&manifest)
        .iter()
        .filter(|d| {
            let kind = d["kind"].as_str().unwrap();
            let component = d["metadata"]["labels"]["app.kubernetes.io/component"]
                .as_str()
                .unwrap_or_default();
            kind != "Namespace"
                && kind != "CustomResourceDefinition"
                && !DROPPED_FLUX.contains(&component)
        })
        .map(|d| {
            (
                d["kind"].as_str().unwrap().to_owned(),
                d["metadata"]["name"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let rest: Vec<(String, String)> = plan.objects[1 + crd_count..]
        .iter()
        .map(|o| (o.kind.clone(), o.name.clone()))
        .collect();
    assert_eq!(rest, kept);
    for object in &plan.objects {
        assert_eq!(
            object.namespace.is_none(),
            object.cluster_scoped,
            "{object:?}"
        );
        if let Some(ns) = &object.namespace {
            assert_eq!(ns, "flux-system");
        }
    }
}

#[test]
fn argocd_gets_its_namespace_first_and_in_every_namespaced_document() {
    let manifest = argocd_manifest();
    let plan = prepare(GitopsTool::ArgoCd, "v3.5.5", &manifest).unwrap();

    assert_eq!(plan.namespace, "argocd");
    let raw = raw_documents(&manifest);
    assert_eq!(plan.objects.len(), raw.len() + 1);
    assert_eq!(
        plan.objects[0],
        PlannedObject {
            kind: "Namespace".into(),
            name: "argocd".into(),
            namespace: None,
            cluster_scoped: true,
        }
    );
    assert_eq!(plan.documents()[0].value()["apiVersion"], "v1");
    let cluster_kinds = [
        "Namespace",
        "CustomResourceDefinition",
        "ClusterRole",
        "ClusterRoleBinding",
    ];
    for (object, doc) in plan.objects.iter().zip(plan.documents()) {
        let cluster_scoped = cluster_kinds.contains(&object.kind.as_str());
        assert_eq!(object.cluster_scoped, cluster_scoped, "{object:?}");
        if cluster_scoped {
            assert_eq!(object.namespace, None, "{object:?}");
            assert!(
                doc.value()["metadata"].get("namespace").is_none(),
                "{object:?}"
            );
        } else {
            assert_eq!(object.namespace.as_deref(), Some("argocd"), "{object:?}");
            assert_eq!(doc.value()["metadata"]["namespace"], "argocd", "{object:?}");
        }
    }
    assert_eq!(
        names_of(&plan, "StatefulSet"),
        BTreeSet::from(["argocd-application-controller"])
    );
    assert_eq!(
        plan.objects[1..4]
            .iter()
            .map(|o| o.name.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "applications.argoproj.io",
            "applicationsets.argoproj.io",
            "appprojects.argoproj.io"
        ])
    );
    // Everything else in the file's order.
    let rest: Vec<String> = raw
        .iter()
        .filter(|d| d["kind"] != "CustomResourceDefinition")
        .map(|d| {
            format!(
                "{} {}",
                d["kind"].as_str().unwrap(),
                d["metadata"]["name"].as_str().unwrap()
            )
        })
        .collect();
    let planned: Vec<String> = plan.objects[4..]
        .iter()
        .map(|o| format!("{} {}", o.kind, o.name))
        .collect();
    assert_eq!(planned, rest);
}

#[test]
fn the_summary_counts_kinds_and_cluster_scoped_objects() {
    let plan = prepare(GitopsTool::ArgoCd, "v3.5.5", &argocd_manifest()).unwrap();
    let summary = plan.summary();

    assert_eq!(summary.tool, GitopsTool::ArgoCd);
    assert_eq!(summary.version, "v3.5.5");
    assert_eq!(summary.namespace, "argocd");
    assert_eq!(summary.objects, plan.objects);
    // From the file: 3 CRDs, 3 ClusterRoles, 3 ClusterRoleBindings, plus the Namespace.
    assert_eq!(summary.cluster_scoped, 10);
    let count = |kind: &str| {
        summary
            .kinds
            .iter()
            .find(|k| k.kind == kind)
            .map(|k| k.count)
    };
    assert_eq!(summary.kinds[0].kind, "Namespace");
    assert_eq!(count("Namespace"), Some(1));
    assert_eq!(count("CustomResourceDefinition"), Some(3));
    assert_eq!(count("Deployment"), Some(6));
    assert_eq!(count("StatefulSet"), Some(1));
    assert_eq!(count("Service"), Some(8));
    assert_eq!(count("ConfigMap"), Some(7));
    assert_eq!(
        summary.kinds.iter().map(|k| k.count).sum::<u32>() as usize,
        plan.objects.len()
    );
}

fn assert_invalid(result: CoreResult<InstallPlan>, needle: &str) {
    let err = result.expect_err("prepared");
    assert_eq!(err.code, ErrorCode::Invalid, "{err}");
    assert!(err.message.contains(needle), "{err}");
}

#[test]
fn a_manifest_with_the_hidden_values_marker_is_refused() {
    let manifest = format!(
        "{}\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  annotations:\n    \
         sextant.dev/values-hidden: \"true\"\n",
        argocd_manifest()
    );
    assert_invalid(prepare(GitopsTool::ArgoCd, "v3.5.5", &manifest), "values");
}

#[test]
fn kinds_the_official_files_do_not_use_are_refused() {
    for (api_version, kind) in [
        ("v1", "Pod"),
        ("batch/v1", "Job"),
        (
            "admissionregistration.k8s.io/v1",
            "MutatingWebhookConfiguration",
        ),
        ("example.com/v1", "Deployment"),
    ] {
        let manifest = format!(
            "{}\n---\napiVersion: {api_version}\nkind: {kind}\nmetadata:\n  name: extra\n",
            argocd_manifest()
        );
        assert_invalid(prepare(GitopsTool::ArgoCd, "v3.5.5", &manifest), kind);
    }
}

#[test]
fn objects_outside_the_tool_namespace_are_refused() {
    let manifest = format!(
        "{}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: extra\n  namespace: kube-system\n",
        argocd_manifest()
    );
    assert_invalid(
        prepare(GitopsTool::ArgoCd, "v3.5.5", &manifest),
        "kube-system",
    );
    // Flux's file as Argo CD's: its objects live in flux-system.
    assert_invalid(
        prepare(GitopsTool::ArgoCd, "v2.9.6", &flux_manifest()),
        "flux-system",
    );
    // Argo CD's file as Flux's: no Flux controllers in it.
    assert_invalid(
        prepare(GitopsTool::Flux, "v3.5.5", &argocd_manifest()),
        "Flux",
    );
}

#[test]
fn a_version_that_is_not_a_release_tag_is_refused() {
    for version in ["latest", "2.9.6", "v2.9", "v2.9.6-rc.1", ""] {
        assert_invalid(
            prepare(GitopsTool::Flux, version, &flux_manifest()),
            "version",
        );
    }
}

// --- Against the fake API server ---------------------------------------------------------------------------------

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
const CORE_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[]}"#;
const API_GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#;
const FORBIDDEN: &str = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"clusterrolebindings.rbac.authorization.k8s.io is forbidden","reason":"Forbidden","code":403}"#;

fn discovery(req: &Request) -> Option<Reply> {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api") => Some(Reply::json(200, API_VERSIONS)),
        ("GET", "/api/v1") => Some(Reply::json(200, CORE_RESOURCES)),
        ("GET", "/apis") => Some(Reply::json(200, API_GROUPS)),
        _ => None,
    }
}

/// Answers every PATCH with its body (server-side apply), except `fail` with 403.
async fn apply_server(fail: Option<&'static str>) -> FakeApi {
    FakeApi::start(move |req: &Request| {
        if let Some(reply) = discovery(req) {
            return reply;
        }
        if req.method == "PATCH" {
            if Some(req.path.as_str()) == fail {
                return Reply::json(403, FORBIDDEN);
            }
            return Reply::json(200, String::from_utf8_lossy(&req.body).into_owned());
        }
        Reply::not_found()
    })
    .await
}

fn patches(api: &FakeApi) -> Vec<Request> {
    api.requests()
        .into_iter()
        .filter(|r| r.method == "PATCH")
        .collect()
}

#[tokio::test]
async fn apply_sends_namespace_then_crds_then_the_rest_and_reports_every_step() {
    let api = apply_server(None).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let plan = prepare(GitopsTool::ArgoCd, "v3.5.5", &argocd_manifest()).unwrap();
    mgr.kinds(&id).await.unwrap();
    let discoveries = api.count("/apis");

    let mut steps = Vec::new();
    let report = apply(&mgr, &id, &plan, |step| steps.push(step))
        .await
        .unwrap();

    assert!(!report.stopped);
    assert_eq!(report.applied, plan.objects);
    let expected_steps: Vec<InstallStep> = plan
        .objects
        .iter()
        .map(|o| InstallStep::Applied {
            kind: o.kind.clone(),
            name: o.name.clone(),
        })
        .collect();
    assert_eq!(steps, expected_steps);

    let sent = patches(&api);
    assert_eq!(sent.len(), plan.objects.len());
    assert_eq!(sent[0].path, "/api/v1/namespaces/argocd");
    for request in &sent[1..4] {
        assert!(
            request
                .path
                .starts_with("/apis/apiextensions.k8s.io/v1/customresourcedefinitions/"),
            "{}",
            request.path
        );
    }
    assert_eq!(
        sent[4].path,
        "/api/v1/namespaces/argocd/serviceaccounts/argocd-application-controller"
    );
    assert_eq!(
        sent.last().unwrap().path,
        "/apis/networking.k8s.io/v1/namespaces/argocd/networkpolicies/argocd-server-network-policy"
    );
    for request in &sent {
        assert!(
            request.query.contains("fieldManager=sextant"),
            "{}",
            request.query
        );
        // Objects that exist (an install over a partial one, or applied by kubectl) are taken over, as
        // `flux install` and `kubectl apply --server-side --force-conflicts` do.
        assert!(request.query.contains("force=true"), "{}", request.query);
        assert!(request.header("content-type").contains("apply-patch"));
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        if !request.path.contains("customresourcedefinitions")
            && request.path != "/api/v1/namespaces/argocd"
            && !request.path.contains("/clusterrole")
        {
            assert_eq!(body["metadata"]["namespace"], "argocd", "{}", request.path);
        }
    }
    // The CRDs made discovery stale: the next lookup asks the server again.
    mgr.kinds(&id).await.unwrap();
    assert!(api.count("/apis") > discoveries);
}

#[tokio::test]
async fn apply_stops_at_the_first_error_and_sends_nothing_after_it() {
    const FAILING: &str =
        "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/argocd-application-controller";
    let api = apply_server(Some(FAILING)).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let plan = prepare(GitopsTool::ArgoCd, "v3.5.5", &argocd_manifest()).unwrap();

    let mut steps = Vec::new();
    let err = apply(&mgr, &id, &plan, |step| steps.push(step))
        .await
        .unwrap_err();

    assert_eq!(err.code, ErrorCode::Forbidden, "{err}");
    assert!(err.message.contains("ClusterRoleBinding"), "{err}");
    assert!(
        err.message.contains("argocd-application-controller"),
        "{err}"
    );
    assert!(err.message.contains("forbidden"), "{err}");
    let failed_at = plan
        .objects
        .iter()
        .position(|o| o.kind == "ClusterRoleBinding" && o.name == "argocd-application-controller")
        .unwrap();
    assert_eq!(steps.len(), failed_at + 1);
    assert!(
        steps[..failed_at]
            .iter()
            .all(|s| matches!(s, InstallStep::Applied { .. }))
    );
    match &steps[failed_at] {
        InstallStep::Failed { kind, name, error } => {
            assert_eq!(kind, "ClusterRoleBinding");
            assert_eq!(name, "argocd-application-controller");
            assert!(error.contains("forbidden"), "{error}");
        }
        other => panic!("{other:?}"),
    }
    assert!(
        err.message
            .contains(&format!("{failed_at} of {}", plan.objects.len())),
        "{err}"
    );
    let sent = patches(&api);
    assert_eq!(sent.len(), failed_at + 1);
    assert_eq!(sent.last().unwrap().path, FAILING);
}

#[tokio::test]
async fn a_stop_ends_the_apply_after_the_current_object() {
    let api = apply_server(None).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let plan = prepare(GitopsTool::Flux, "v2.9.6", &flux_manifest()).unwrap();

    let stop = AtomicBool::new(false);
    let mut steps = 0;
    let report = apply_until(&mgr, &id, &plan, &stop, |_| {
        steps += 1;
        if steps == 2 {
            stop.store(true, Ordering::SeqCst);
        }
    })
    .await
    .unwrap();

    assert!(report.stopped);
    assert_eq!(report.applied, plan.objects[..2].to_vec());
    assert_eq!(patches(&api).len(), 2);
}

// --- readiness ---

fn list(kind: &str, items: Vec<Value>) -> String {
    json!({"apiVersion": "v1", "kind": kind, "metadata": {"resourceVersion": "1"}, "items": items})
        .to_string()
}

fn deployment(name: &str, component: &str, available: i32) -> Value {
    json!({
        "apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": name, "namespace": "flux-system", "generation": 1,
                     "labels": {"app.kubernetes.io/component": component, "app.kubernetes.io/part-of": "flux"}},
        "spec": {"replicas": 1, "selector": {"matchLabels": {"app": name}}, "template": {"metadata": {"labels": {"app": name}}, "spec": {"containers": []}}},
        "status": {"observedGeneration": 1, "replicas": 1, "updatedReplicas": 1, "readyReplicas": available, "availableReplicas": available}
    })
}

fn pod(name: &str, labels: Value, status: Value) -> Value {
    json!({
        "apiVersion": "v1", "kind": "Pod",
        "metadata": {"name": name, "labels": labels},
        "spec": {"containers": []},
        "status": status
    })
}

#[tokio::test]
async fn readiness_names_the_waiting_reason_of_a_pod_that_cannot_start() {
    let selectors = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&selectors);
    let api = FakeApi::start(move |req: &Request| {
        if let Some(reply) = discovery(req) {
            return reply;
        }
        match req.path.as_str() {
            "/apis/apps/v1/namespaces/flux-system/deployments" => {
                seen.lock().unwrap().push(req.query.clone());
                Reply::json(
                    200,
                    list(
                        "DeploymentList",
                        vec![
                            deployment("image-reflector-controller", "image-reflector-controller", 0),
                            deployment("kustomize-controller", "kustomize-controller", 0),
                            deployment("source-controller", "source-controller", 1),
                        ],
                    ),
                )
            }
            "/apis/apps/v1/namespaces/flux-system/statefulsets" => {
                Reply::json(200, list("StatefulSetList", vec![]))
            }
            "/api/v1/namespaces/flux-system/pods" => Reply::json(
                200,
                list(
                    "PodList",
                    vec![
                        pod(
                            "source-controller-abc",
                            json!({"app": "source-controller"}),
                            json!({"phase": "Running"}),
                        ),
                        pod(
                            "kustomize-controller-xyz",
                            json!({"app": "kustomize-controller", "pod-template-hash": "1"}),
                            json!({"phase": "Pending", "containerStatuses": [{
                                "name": "manager", "ready": false, "restartCount": 0, "image": "x", "imageID": "",
                                "state": {"waiting": {"reason": "ImagePullBackOff",
                                                      "message": "Back-off pulling image \"ghcr.io/fluxcd/kustomize-controller\""}}
                            }]}),
                        ),
                    ],
                ),
            ),
            _ => Reply::not_found(),
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;

    let states = readiness(&mgr, &id, GitopsTool::Flux, "flux-system")
        .await
        .unwrap();

    assert_eq!(states.len(), 2, "{states:?}");
    let kustomize = states
        .iter()
        .find(|s| s.name == "kustomize-controller")
        .unwrap();
    assert_eq!(kustomize.kind, "Deployment");
    assert!(!kustomize.ready);
    let reason = kustomize.reason.as_deref().unwrap();
    assert!(reason.contains("ImagePullBackOff"), "{reason}");
    assert!(reason.contains("kustomize-controller-xyz"), "{reason}");
    assert_eq!(
        states
            .iter()
            .find(|s| s.name == "source-controller")
            .unwrap(),
        &WorkloadState {
            kind: "Deployment".into(),
            name: "source-controller".into(),
            ready: true,
            reason: None,
        }
    );
    let selectors = selectors.lock().unwrap();
    assert!(
        selectors[0].contains("labelSelector=app.kubernetes.io%2Fpart-of%3Dflux"),
        "{selectors:?}"
    );
}

#[tokio::test]
async fn readiness_covers_argocd_statefulset_and_an_unschedulable_pod() {
    let api = FakeApi::start(|req: &Request| {
        if let Some(reply) = discovery(req) {
            return reply;
        }
        match req.path.as_str() {
            "/apis/apps/v1/namespaces/argocd/deployments" => {
                Reply::json(200, list("DeploymentList", vec![]))
            }
            "/apis/apps/v1/namespaces/argocd/statefulsets" => Reply::json(
                200,
                list(
                    "StatefulSetList",
                    vec![json!({
                        "apiVersion": "apps/v1", "kind": "StatefulSet",
                        "metadata": {"name": "argocd-application-controller", "namespace": "argocd", "generation": 1},
                        "spec": {"replicas": 1, "serviceName": "x",
                                 "selector": {"matchLabels": {"app.kubernetes.io/name": "argocd-application-controller"}},
                                 "template": {"spec": {"containers": []}}},
                        "status": {"observedGeneration": 1, "replicas": 1, "readyReplicas": 0}
                    })],
                ),
            ),
            "/api/v1/namespaces/argocd/pods" => Reply::json(
                200,
                list(
                    "PodList",
                    vec![pod(
                        "argocd-application-controller-0",
                        json!({"app.kubernetes.io/name": "argocd-application-controller"}),
                        json!({"phase": "Pending", "conditions": [{
                            "type": "PodScheduled", "status": "False", "reason": "Unschedulable",
                            "message": "0/1 nodes are available: 1 Insufficient memory."
                        }]}),
                    )],
                ),
            ),
            _ => Reply::not_found(),
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;

    let states = readiness(&mgr, &id, GitopsTool::ArgoCd, "argocd")
        .await
        .unwrap();

    assert_eq!(states.len(), 1, "{states:?}");
    assert_eq!(states[0].kind, "StatefulSet");
    assert_eq!(states[0].name, "argocd-application-controller");
    assert!(!states[0].ready);
    let reason = states[0].reason.as_deref().unwrap();
    assert!(reason.contains("Insufficient memory"), "{reason}");
}

// --- installed ---

/// A cluster whose CRDs are `crds` and whose namespaces are `namespaces`.
async fn cluster_with(crds: Vec<String>, namespaces: Vec<&'static str>) -> FakeApi {
    cluster_with_workloads(crds, namespaces, Workloads::Listed(vec![])).await
}

/// The Deployments and StatefulSets a fake cluster has in every namespace it has.
#[derive(Clone)]
enum Workloads {
    /// (kind, name, `app.kubernetes.io/name`)
    Listed(Vec<(&'static str, String, Option<String>)>),
    /// Listing them is forbidden.
    Forbidden,
}

fn partial_list(items: Vec<Value>) -> Reply {
    Reply::json(
        200,
        json!({"apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadataList", "metadata": {}, "items": items})
            .to_string(),
    )
}

/// A cluster whose CRDs are `crds`, whose namespaces are `namespaces`, with `workloads` in each of them.
async fn cluster_with_workloads(
    crds: Vec<String>,
    namespaces: Vec<&'static str>,
    workloads: Workloads,
) -> FakeApi {
    FakeApi::start(move |req: &Request| {
        if let Some(reply) = discovery(req) {
            return reply;
        }
        if req.path == "/apis/apiextensions.k8s.io/v1/customresourcedefinitions" {
            let items: Vec<Value> = crds
                .iter()
                .map(|name| json!({"apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": {"name": name}}))
                .collect();
            return partial_list(items);
        }
        if let Some(rest) = req.path.strip_prefix("/apis/apps/v1/namespaces/")
            && let Some((ns, plural)) = rest.split_once('/')
            && namespaces.contains(&ns)
        {
            let kind = match plural {
                "deployments" => "Deployment",
                "statefulsets" => "StatefulSet",
                _ => return Reply::not_found(),
            };
            let listed = match &workloads {
                Workloads::Forbidden => return Reply::json(403, FORBIDDEN),
                Workloads::Listed(listed) => listed,
            };
            let items: Vec<Value> = listed
                .iter()
                .filter(|(k, _, _)| *k == kind)
                .map(|(_, name, label)| {
                    let labels = label
                        .as_ref()
                        .map_or(json!({}), |l| json!({"app.kubernetes.io/name": l}));
                    json!({"apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": {"name": name, "namespace": ns, "labels": labels}})
                })
                .collect();
            return partial_list(items);
        }
        if let Some(ns) = req.path.strip_prefix("/api/v1/namespaces/")
            && namespaces.contains(&ns)
        {
            return Reply::json(
                200,
                json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": ns}}).to_string(),
            );
        }
        Reply::not_found()
    })
    .await
}

/// The Deployments and StatefulSets of the tool's plan (the standard set), as a cluster lists them.
fn planned_workloads(tool: GitopsTool) -> Vec<(&'static str, String, Option<String>)> {
    let (version, manifest) = match tool {
        GitopsTool::Flux => ("v2.9.6", flux_manifest()),
        GitopsTool::ArgoCd => ("v3.5.5", argocd_manifest()),
    };
    prepare(tool, version, &manifest)
        .unwrap()
        .objects
        .into_iter()
        .filter_map(|o| match o.kind.as_str() {
            "Deployment" => Some(("Deployment", o.name, None)),
            "StatefulSet" => Some(("StatefulSet", o.name, None)),
            _ => None,
        })
        .collect()
}

fn flux_crds() -> Vec<String> {
    prepare(GitopsTool::Flux, "v2.9.6", &flux_manifest())
        .unwrap()
        .objects
        .into_iter()
        .filter(|o| o.kind == "CustomResourceDefinition")
        .map(|o| o.name)
        .collect()
}

#[tokio::test]
async fn installed_tells_none_present_and_partial() {
    let none = InstalledState {
        present: false,
        partial: false,
    };
    let present = InstalledState {
        present: true,
        partial: false,
    };
    let partial = InstalledState {
        present: false,
        partial: true,
    };
    let argo_crds = || {
        vec![
            "applications.argoproj.io".to_owned(),
            "applicationsets.argoproj.io".to_owned(),
            "appprojects.argoproj.io".to_owned(),
        ]
    };
    let unrelated = vec![
        "widgets.example.com".to_owned(),
        "workflows.argoproj.io".to_owned(),
    ];
    let cases: Vec<(GitopsTool, Vec<String>, Vec<&'static str>, InstalledState)> = vec![
        (GitopsTool::Flux, unrelated.clone(), vec!["default"], none),
        // Installed elsewhere (another namespace): what runs there cannot be told, the definitions decide.
        (GitopsTool::Flux, flux_crds(), vec![], present),
        (GitopsTool::Flux, vec![], vec!["flux-system"], partial),
        (
            GitopsTool::Flux,
            flux_crds()[..3].to_vec(),
            vec!["default"],
            partial,
        ),
        (GitopsTool::ArgoCd, unrelated, vec!["default"], none),
        (GitopsTool::ArgoCd, argo_crds(), vec![], present),
        (GitopsTool::ArgoCd, vec![], vec!["argocd"], partial),
        (
            GitopsTool::ArgoCd,
            argo_crds()[..1].to_vec(),
            vec![],
            partial,
        ),
    ];
    for (tool, crds, namespaces, expected) in cases {
        let what = format!("{tool:?} crds={crds:?} namespaces={namespaces:?}");
        let api = cluster_with(crds, namespaces).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        assert_eq!(
            installed(&mgr, &id, tool).await.unwrap(),
            expected,
            "{what}"
        );
    }
}

#[tokio::test]
async fn an_install_that_stopped_after_its_definitions_is_partial_until_every_controller_exists() {
    let present = InstalledState {
        present: true,
        partial: false,
    };
    let partial = InstalledState {
        present: false,
        partial: true,
    };
    let argo_crds: Vec<String> = ARGOCD_CRDS.iter().map(|s| (*s).to_owned()).collect();
    let flux_all = planned_workloads(GitopsTool::Flux);
    let argo_all = planned_workloads(GitopsTool::ArgoCd);
    // An install applies the workloads in the file's order: one that stopped before the last has the first ones.
    let flux_some = flux_all[..2].to_vec();
    let argo_without_controller: Vec<_> = argo_all
        .iter()
        .filter(|(kind, _, _)| *kind != "StatefulSet")
        .cloned()
        .collect();
    // Argo CD from its Helm chart: `<release>-argocd-server` and so on, with the standard `app.kubernetes.io/name`.
    let argo_helm: Vec<_> = argo_all
        .iter()
        .map(|(kind, name, _)| (*kind, format!("prod-{name}"), Some(name.clone())))
        .collect();
    // The HA install runs Redis as argocd-redis-ha-*, not argocd-redis.
    let argo_ha: Vec<_> = argo_all
        .iter()
        .filter(|(_, name, _)| name != "argocd-redis")
        .cloned()
        .chain([("StatefulSet", "argocd-redis-ha-server".to_owned(), None)])
        .collect();
    // Helm with dex, notifications and the ApplicationSet controller turned off: a working Argo CD.
    let argo_helm_minimal: Vec<_> = argo_helm
        .iter()
        .filter(|(_, _, label)| {
            ![
                "argocd-dex-server",
                "argocd-notifications-controller",
                "argocd-applicationset-controller",
            ]
            .contains(&label.as_deref().unwrap_or_default())
        })
        .cloned()
        .collect();
    // `flux bootstrap --components source-controller,kustomize-controller`.
    let flux_minimal: Vec<_> = flux_all
        .iter()
        .filter(|(_, name, _)| name == "source-controller" || name == "kustomize-controller")
        .cloned()
        .collect();
    let mut flux_more = flux_all.clone();
    flux_more.push(("Deployment", "image-reflector-controller".to_owned(), None));
    let cases: Vec<(
        GitopsTool,
        Vec<String>,
        &'static str,
        Workloads,
        InstalledState,
    )> = vec![
        (
            GitopsTool::Flux,
            flux_crds(),
            "flux-system",
            Workloads::Listed(vec![]),
            partial,
        ),
        (
            GitopsTool::Flux,
            flux_crds(),
            "flux-system",
            Workloads::Listed(flux_some),
            partial,
        ),
        (
            GitopsTool::Flux,
            flux_crds(),
            "flux-system",
            Workloads::Listed(flux_all),
            present,
        ),
        (
            GitopsTool::Flux,
            flux_crds(),
            "flux-system",
            Workloads::Listed(flux_more),
            present,
        ),
        (
            GitopsTool::ArgoCd,
            argo_crds.clone(),
            "argocd",
            Workloads::Listed(argo_without_controller),
            partial,
        ),
        (
            GitopsTool::ArgoCd,
            argo_crds.clone(),
            "argocd",
            Workloads::Listed(argo_all),
            present,
        ),
        (
            GitopsTool::ArgoCd,
            argo_crds.clone(),
            "argocd",
            Workloads::Listed(argo_helm),
            present,
        ),
        (
            GitopsTool::ArgoCd,
            argo_crds.clone(),
            "argocd",
            Workloads::Listed(argo_ha),
            present,
        ),
        (
            GitopsTool::ArgoCd,
            argo_crds.clone(),
            "argocd",
            Workloads::Listed(argo_helm_minimal),
            present,
        ),
        (
            GitopsTool::Flux,
            flux_crds(),
            "flux-system",
            Workloads::Listed(flux_minimal),
            present,
        ),
        // The user may not list workloads there: the definitions decide.
        (
            GitopsTool::ArgoCd,
            argo_crds,
            "argocd",
            Workloads::Forbidden,
            present,
        ),
    ];
    for (tool, crds, namespace, workloads, expected) in cases {
        let what = match &workloads {
            Workloads::Listed(listed) => format!("{tool:?} {listed:?}"),
            Workloads::Forbidden => format!("{tool:?} forbidden"),
        };
        let api = cluster_with_workloads(crds, vec![namespace], workloads).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        assert_eq!(
            installed(&mgr, &id, tool).await.unwrap(),
            expected,
            "{what}"
        );
    }
}

#[tokio::test]
async fn access_check_asks_self_subject_access_reviews() {
    let api = FakeApi::start(|req: &Request| {
        if let Some(reply) = discovery(req) {
            return reply;
        }
        if req.method == "POST"
            && req.path == "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews"
        {
            let mut review: Value = serde_json::from_slice(&req.body).unwrap();
            let allowed =
                review["spec"]["resourceAttributes"]["resource"] == "customresourcedefinitions";
            review["status"] = json!({"allowed": allowed});
            return Reply::json(201, review.to_string());
        }
        Reply::not_found()
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;

    let access = access_check(&mgr, &id).await.unwrap();

    assert_eq!(
        access,
        AccessCheck {
            can_create_crds: true,
            can_create_cluster_role_bindings: false,
        }
    );
    let asked: BTreeSet<(String, String, String)> = api
        .requests()
        .iter()
        .filter(|r| r.method == "POST")
        .map(|r| {
            let body: Value = serde_json::from_slice(&r.body).unwrap();
            let attributes = &body["spec"]["resourceAttributes"];
            (
                attributes["verb"].as_str().unwrap().to_owned(),
                attributes["group"].as_str().unwrap().to_owned(),
                attributes["resource"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        asked,
        BTreeSet::from([
            (
                "create".to_owned(),
                "apiextensions.k8s.io".to_owned(),
                "customresourcedefinitions".to_owned()
            ),
            (
                "create".to_owned(),
                "rbac.authorization.k8s.io".to_owned(),
                "clusterrolebindings".to_owned()
            ),
        ])
    );
}

// --- overlap ---

fn metadata_list(names: &[&str]) -> String {
    let items: Vec<Value> = names
        .iter()
        .map(|name| json!({"apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": {"name": name}}))
        .collect();
    json!({"apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadataList", "metadata": {}, "items": items})
        .to_string()
}

#[tokio::test]
async fn overlap_names_existing_cluster_objects_and_flux_controllers_the_install_leaves_out() {
    let plan = prepare(GitopsTool::Flux, "v2.9.6", &flux_manifest()).unwrap();
    // The real names from the file, so the test does not rely on the code under test to pick them.
    assert!(names_of(&plan, "ClusterRole").contains("crd-controller"));
    let api = FakeApi::start(|req: &Request| {
        if let Some(reply) = discovery(req) {
            return reply;
        }
        match req.path.as_str() {
            "/api/v1/namespaces" => Reply::json(200, metadata_list(&["default", "flux-system"])),
            "/apis/apiextensions.k8s.io/v1/customresourcedefinitions" => Reply::json(
                200,
                metadata_list(&[
                    "gitrepositories.source.toolkit.fluxcd.io",
                    "imagepolicies.image.toolkit.fluxcd.io",
                    "widgets.example.com",
                ]),
            ),
            "/apis/rbac.authorization.k8s.io/v1/clusterroles" => Reply::json(
                200,
                metadata_list(&["crd-controller", "flux-edit", "admin"]),
            ),
            // Listing the bindings is not allowed: they are left out, not an error.
            "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings" => Reply::json(403, FORBIDDEN),
            "/apis/apps/v1/namespaces/flux-system/deployments" => Reply::json(
                200,
                list(
                    "Deployment",
                    vec![
                        deployment("source-controller", "source-controller", 1),
                        deployment(
                            "image-reflector-controller",
                            "image-reflector-controller",
                            1,
                        ),
                        deployment(
                            "image-automation-controller",
                            "image-automation-controller",
                            1,
                        ),
                    ],
                ),
            ),
            _ => Reply::not_found(),
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;

    let found = overlap(&mgr, &id, &plan).await.unwrap();

    let named: Vec<(&str, &str)> = found
        .cluster_objects
        .iter()
        .map(|o| (o.kind.as_str(), o.name.as_str()))
        .collect();
    assert_eq!(
        named,
        [
            ("Namespace", "flux-system"),
            (
                "CustomResourceDefinition",
                "gitrepositories.source.toolkit.fluxcd.io"
            ),
            ("ClusterRole", "crd-controller"),
            ("ClusterRole", "flux-edit"),
        ]
    );
    assert!(found.cluster_objects.iter().all(|o| o.cluster_scoped));
    assert_eq!(
        found.left_out_controllers,
        ["image-reflector-controller", "image-automation-controller"]
    );
}

#[tokio::test]
async fn overlap_on_an_empty_cluster_is_empty_and_argocd_has_no_left_out_controllers() {
    let plan = prepare(GitopsTool::ArgoCd, "v3.5.5", &argocd_manifest()).unwrap();
    let api = FakeApi::start(|req: &Request| {
        if let Some(reply) = discovery(req) {
            return reply;
        }
        match req.path.as_str() {
            "/api/v1/namespaces"
            | "/apis/apiextensions.k8s.io/v1/customresourcedefinitions"
            | "/apis/rbac.authorization.k8s.io/v1/clusterroles"
            | "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings" => {
                Reply::json(200, metadata_list(&["default"]))
            }
            _ => Reply::not_found(),
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;

    let found = overlap(&mgr, &id, &plan).await.unwrap();

    assert!(found.cluster_objects.is_empty(), "{found:?}");
    assert!(found.left_out_controllers.is_empty());
    assert!(
        !api.requests()
            .iter()
            .any(|r| r.path.contains("deployments")),
        "Argo CD leaves nothing out, so its Deployments are not read"
    );
}
