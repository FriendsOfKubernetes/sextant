//! What the Flux and Argo CD features stand on, against the kind test cluster: a CRD created or deleted while
//! connected (`ClusterManager::refresh_kinds`), the shared `resources::patch`, and the GitOps installation of
//! `scripts/test-cluster.sh up --gitops`.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) SEXTANT_TEST_GITOPS=1 \
//!   cargo test -p sextant-core --test gitops -- --test-threads=1
//! ```
//!
//! Without `SEXTANT_TEST_KUBECONFIG` every test is skipped. The tests of the installed tools also need
//! `SEXTANT_TEST_GITOPS=1` (a cluster made with `up --gitops`); the others work on any test cluster. Every test
//! works in its own namespace `sextant-gitops-<test>` or with its own CRD and removes it at the end.

mod common;

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Secret};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{DeleteParams, PostParams};
use kube::{Api, Client};
use serde_json::{Value, json};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::resources::{self, KindRef, ObjectRef, PatchType, ResourceKind};
use sextant_core::{ClusterId, ClusterManager, ErrorCode, KubeconfigRegistry};

/// Turns on the tests of the GitOps tools installed by `scripts/test-cluster.sh up --gitops`.
pub const GITOPS_ENV: &str = "SEXTANT_TEST_GITOPS";

/// The test cluster when it has Flux and Argo CD (`SEXTANT_TEST_GITOPS=1`), otherwise `None` with a note.
fn gitops_cluster() -> Option<common::TestCluster> {
    let cluster = common::test_cluster()?;
    if std::env::var(GITOPS_ENV).as_deref() != Ok("1") {
        eprintln!("skipped: {GITOPS_ENV}=1 is not set (see scripts/test-cluster.sh up --gitops)");
        return None;
    }
    Some(cluster)
}

/// A manager connected to the only context of `kubeconfig`.
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

async fn wait_until<F, Fut>(what: &str, secs: u64, mut done: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !done().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Runs `body` with a manager connected as admin, an admin client and a fresh namespace `sextant-gitops-<test>`;
/// the namespace is deleted afterwards, also when `body` panics.
async fn in_namespace<F, Fut>(test: &str, body: F)
where
    F: FnOnce(Scratch) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let ns = format!("sextant-gitops-{test}");
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    wait_until("the old namespace to go away", 180, || {
        let namespaces = namespaces.clone();
        let ns = ns.clone();
        async move { namespaces.get_opt(&ns).await.unwrap().is_none() }
    })
    .await;
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": ns } })).unwrap();
    namespaces
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();

    let (tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let scratch = Scratch {
        mgr,
        id,
        client: client.clone(),
        ns: ns.clone(),
        limited_kubeconfig: cluster.limited_kubeconfig.clone(),
        _tmp: tmp,
    };
    let result = AssertUnwindSafe(body(scratch)).catch_unwind().await;
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

struct Scratch {
    mgr: ClusterManager,
    id: ClusterId,
    client: Client,
    ns: String,
    limited_kubeconfig: std::path::PathBuf,
    _tmp: tempfile::TempDir,
}

fn object(group: &str, version: &str, kind: &str, ns: &str, name: &str) -> ObjectRef {
    ObjectRef {
        kind: KindRef {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
        },
        namespace: Some(ns.into()),
        name: name.into(),
    }
}

fn served(kinds: &[ResourceKind], group: &str, kind: &str) -> bool {
    kinds
        .iter()
        .any(|k| k.kind_ref.group == group && k.kind_ref.kind == kind)
}

// ---------- G01: CRDs without reconnecting ----------

const GIZMO_GROUP: &str = "refresh.sextant.dev";
const GIZMO_CRD: &str = "gizmos.refresh.sextant.dev";

fn gizmo_crd() -> CustomResourceDefinition {
    serde_json::from_value(json!({
        "metadata": { "name": GIZMO_CRD },
        "spec": {
            "group": GIZMO_GROUP,
            "scope": "Namespaced",
            "names": { "kind": "Gizmo", "plural": "gizmos", "singular": "gizmo", "listKind": "GizmoList" },
            "versions": [{
                "name": "v1",
                "served": true,
                "storage": true,
                "schema": { "openAPIV3Schema": { "type": "object", "x-kubernetes-preserve-unknown-fields": true } }
            }]
        }
    }))
    .unwrap()
}

async fn delete_gizmo_crd(crds: &Api<CustomResourceDefinition>) {
    let _ = crds.delete(GIZMO_CRD, &DeleteParams::default()).await;
    wait_until("the CRD to go away", 120, || {
        let crds = crds.clone();
        async move { crds.get_opt(GIZMO_CRD).await.unwrap().is_none() }
    })
    .await;
}

#[tokio::test]
async fn a_crd_created_while_connected_is_served_after_a_refresh_and_gone_after_its_deletion() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    delete_gizmo_crd(&crds).await;

    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let result = AssertUnwindSafe(async {
        assert!(!served(
            &mgr.kinds(&id).await.unwrap(),
            GIZMO_GROUP,
            "Gizmo"
        ));

        crds.create(&PostParams::default(), &gizmo_crd())
            .await
            .unwrap();
        wait_until("the CRD to be established", 60, || {
            let crds = crds.clone();
            async move {
                crds.get_opt(GIZMO_CRD)
                    .await
                    .unwrap()
                    .and_then(|crd| crd.status?.conditions)
                    .is_some_and(|conditions| {
                        conditions
                            .iter()
                            .any(|c| c.type_ == "Established" && c.status == "True")
                    })
            }
        })
        .await;
        // The discovery of this connection is cached: the new kind is unknown until refreshed.
        assert!(!served(
            &mgr.kinds(&id).await.unwrap(),
            GIZMO_GROUP,
            "Gizmo"
        ));
        // The API server may take a moment to publish an established CRD in its discovery.
        wait_until("the new kind in the refreshed discovery", 30, || async {
            mgr.refresh_kinds(&id);
            served(&mgr.kinds(&id).await.unwrap(), GIZMO_GROUP, "Gizmo")
        })
        .await;
        // The kind is now usable without reconnecting.
        let list = resources::watch(
            &mgr,
            &id,
            resources::WatchSpec {
                kind: KindRef {
                    group: GIZMO_GROUP.into(),
                    version: "v1".into(),
                    kind: "Gizmo".into(),
                },
                namespaces: None,
                label_selector: None,
                field_selector: None,
                metadata_only: false,
            },
        )
        .await;
        assert!(list.is_ok(), "{:?}", list.err());

        delete_gizmo_crd(&crds).await;
        assert!(served(&mgr.kinds(&id).await.unwrap(), GIZMO_GROUP, "Gizmo"));
        wait_until(
            "the deleted kind to leave the refreshed discovery",
            30,
            || async {
                mgr.refresh_kinds(&id);
                !served(&mgr.kinds(&id).await.unwrap(), GIZMO_GROUP, "Gizmo")
            },
        )
        .await;
    })
    .catch_unwind()
    .await;
    delete_gizmo_crd(&crds).await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

// ---------- R04i: the shared patch command ----------

async fn create_config_map(client: &Client, ns: &str, name: &str) {
    let cm: ConfigMap = serde_json::from_value(json!({
        "metadata": { "name": name, "namespace": ns },
        "data": { "a": "1" },
    }))
    .unwrap();
    Api::<ConfigMap>::namespaced(client.clone(), ns)
        .create(&PostParams::default(), &cm)
        .await
        .unwrap();
}

#[tokio::test]
async fn merge_and_json_patches_change_the_object_and_are_signed_by_sextant() {
    in_namespace("patch", |s| async move {
        create_config_map(&s.client, &s.ns, "demo").await;
        let r = object("", "v1", "ConfigMap", &s.ns, "demo");

        let saved = resources::patch(
            &s.mgr,
            &s.id,
            &r,
            &json!({ "metadata": { "annotations": { "reconcile.fluxcd.io/requestedAt": "now" } } }),
            PatchType::Merge,
        )
        .await
        .unwrap();
        assert_eq!(
            saved["metadata"]["annotations"]["reconcile.fluxcd.io/requestedAt"],
            "now"
        );
        assert_eq!(saved["kind"], "ConfigMap");
        assert_eq!(saved["data"]["a"], "1", "a merge patch keeps the rest");
        assert!(saved["metadata"].get("managedFields").is_none());

        let saved = resources::patch(
            &s.mgr,
            &s.id,
            &r,
            &json!([
                { "op": "replace", "path": "/data/a", "value": "2" },
                { "op": "add", "path": "/data/b", "value": "3" }
            ]),
            PatchType::Json,
        )
        .await
        .unwrap();
        assert_eq!(saved["data"], json!({ "a": "2", "b": "3" }));

        let live = Api::<ConfigMap>::namespaced(s.client.clone(), &s.ns)
            .get("demo")
            .await
            .unwrap();
        assert_eq!(
            live.metadata.annotations.unwrap()["reconcile.fluxcd.io/requestedAt"],
            "now"
        );
        let managers: Vec<String> = live
            .metadata
            .managed_fields
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| m.manager)
            .collect();
        assert!(managers.contains(&"sextant".to_owned()), "{managers:?}");
    })
    .await;
}

#[tokio::test]
async fn a_patched_secret_comes_back_without_its_values() {
    in_namespace("patch-secret", |s| async move {
        let secret: Secret = serde_json::from_value(json!({
            "metadata": { "name": "creds", "namespace": s.ns },
            "stringData": { "password": "do-not-show" },
        }))
        .unwrap();
        let secrets: Api<Secret> = Api::namespaced(s.client.clone(), &s.ns);
        secrets
            .create(&PostParams::default(), &secret)
            .await
            .unwrap();

        let saved = resources::patch(
            &s.mgr,
            &s.id,
            &object("", "v1", "Secret", &s.ns, "creds"),
            &json!({ "metadata": { "labels": { "touched": "yes" } } }),
            PatchType::Merge,
        )
        .await
        .unwrap();
        assert_eq!(saved["metadata"]["labels"]["touched"], "yes");
        assert_eq!(saved["data"]["password"], "");
        assert!(
            !saved.to_string().contains("ZG8tbm90LXNob3c"),
            "no value: {saved}"
        );
        assert!(saved["metadata"]["annotations"]["sextant.dev/values-hidden"].is_string());

        let live = secrets.get("creds").await.unwrap();
        assert_eq!(
            live.data.unwrap()["password"].0,
            b"do-not-show".to_vec(),
            "the value itself is untouched"
        );
    })
    .await;
}

#[tokio::test]
async fn patches_without_permission_are_forbidden_and_malformed_ones_invalid() {
    in_namespace("patch-refused", |s| async move {
        create_config_map(&s.client, &s.ns, "demo").await;
        let r = object("", "v1", "ConfigMap", &s.ns, "demo");

        let (_tmp, limited, limited_id) = connected(&s.limited_kubeconfig).await;
        let err = resources::patch(
            &limited,
            &limited_id,
            &r,
            &json!({ "metadata": { "labels": { "x": "y" } } }),
            PatchType::Merge,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden, "{err}");

        // A merge patch is an object; a JSON patch a list of operations.
        for (patch, patch_type) in [
            (json!(["not", "an", "object"]), PatchType::Merge),
            (json!({ "op": "add" }), PatchType::Json),
            (json!([{ "op": "frobnicate", "path": "/data" }]), PatchType::Json),
        ] {
            let err = resources::patch(&s.mgr, &s.id, &r, &patch, patch_type)
                .await
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{patch}: {err}");
        }
        // A patch must not carry the marker of a Secret sent without its values.
        for (patch, patch_type) in [
            (
                json!({ "metadata": { "annotations": { "sextant.dev/values-hidden": "true" } } }),
                PatchType::Merge,
            ),
            (
                json!([{ "op": "add", "path": "/metadata/annotations/sextant.dev~1values-hidden", "value": "" }]),
                PatchType::Json,
            ),
        ] {
            let err = resources::patch(&s.mgr, &s.id, &r, &patch, patch_type)
                .await
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{patch}: {err}");
        }
        let live = Api::<ConfigMap>::namespaced(s.client.clone(), &s.ns)
            .get("demo")
            .await
            .unwrap();
        assert!(live.metadata.labels.is_none() && live.metadata.annotations.is_none());

        let missing = object("", "v1", "ConfigMap", &s.ns, "missing");
        let err = resources::patch(&s.mgr, &s.id, &missing, &json!({}), PatchType::Merge)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{err}");
    })
    .await;
}

// ---------- the GitOps test cluster (`up --gitops`) ----------

#[tokio::test]
async fn flux_and_argo_cd_are_installed_with_their_fixtures() {
    let Some(cluster) = gitops_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let kinds = mgr.kinds(&id).await.unwrap();
    for (group, kind) in [
        ("source.toolkit.fluxcd.io", "GitRepository"),
        ("source.toolkit.fluxcd.io", "HelmRepository"),
        ("kustomize.toolkit.fluxcd.io", "Kustomization"),
        ("helm.toolkit.fluxcd.io", "HelmRelease"),
        ("image.toolkit.fluxcd.io", "ImagePolicy"),
        ("notification.toolkit.fluxcd.io", "Alert"),
        ("argoproj.io", "Application"),
        ("argoproj.io", "ApplicationSet"),
        ("argoproj.io", "AppProject"),
    ] {
        assert!(served(&kinds, group, kind), "{group}/{kind} is not served");
    }

    for r in [
        object(
            "source.toolkit.fluxcd.io",
            "v1",
            "GitRepository",
            "sextant-flux",
            "podinfo",
        ),
        object(
            "kustomize.toolkit.fluxcd.io",
            "v1",
            "Kustomization",
            "sextant-flux",
            "podinfo",
        ),
        object(
            "source.toolkit.fluxcd.io",
            "v1",
            "HelmRepository",
            "sextant-flux",
            "podinfo",
        ),
        object(
            "helm.toolkit.fluxcd.io",
            "v2",
            "HelmRelease",
            "sextant-flux",
            "podinfo-helm",
        ),
        object(
            "argoproj.io",
            "v1alpha1",
            "Application",
            "argocd",
            "guestbook",
        ),
    ] {
        let obj: Value = resources::get(&mgr, &id, &r)
            .await
            .unwrap_or_else(|e| panic!("{} {}: {e}", r.kind.kind, r.name));
        assert_eq!(obj["metadata"]["name"], r.name.as_str());
    }

    let client = cluster.client().await;
    for (ns, deployment) in [
        ("flux-system", "source-controller"),
        ("flux-system", "kustomize-controller"),
        ("flux-system", "helm-controller"),
        ("argocd", "argocd-server"),
        ("argocd", "argocd-repo-server"),
    ] {
        let api: Api<k8s_openapi::api::apps::v1::Deployment> = Api::namespaced(client.clone(), ns);
        let ready = api
            .get(deployment)
            .await
            .unwrap()
            .status
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);
        assert!(ready > 0, "{ns}/{deployment} has no ready pod");
    }
}
