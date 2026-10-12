//! What the Flux section of the frontend (`src/features/flux`) does to a cluster, against the kind test cluster with
//! Flux (`scripts/test-cluster.sh up --gitops`): its actions are merge patches through `resources::patch` —
//! "Reconcile now" sets the annotation `reconcile.fluxcd.io/requestedAt`, "Reconcile with source" sets it on the
//! source and then on the object, Suspend / Resume set `spec.suspend` — and the Flux controllers act on them
//! (`status.lastHandledReconcileAt`; a suspended Kustomization does not restore what was deleted, a resumed one
//! does). Also: the cluster serves every Flux kind at the version the section registers.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) SEXTANT_TEST_GITOPS=1 \
//!   cargo test -p sextant-core --test gitops_flux -- --test-threads=1
//! ```
//!
//! Without both variables every test is skipped. Each test makes its own Flux objects (the podinfo example from
//! GitHub, as the fixtures do) in its own namespace `sextant-flux-<test>` and deletes the namespace at the end; the
//! fixtures in `sextant-flux` are not touched.

mod common;

use common::{connected, gitops_cluster, wait_until};

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::time::Duration;

use futures::FutureExt;
use k8s_openapi::api::core::v1::{Namespace, Service};
use kube::api::{DeleteParams, PostParams};
use kube::{Api, Client};
use serde_json::{Value, json};
use sextant_core::resources::{self, KindRef, ObjectRef, PatchType};
use sextant_core::{ClusterId, ClusterManager};

const REQUESTED_AT: &str = "reconcile.fluxcd.io/requestedAt";

struct Scratch {
    mgr: ClusterManager,
    id: ClusterId,
    client: Client,
    ns: String,
    _tmp: tempfile::TempDir,
}

/// Runs `body` with a manager connected as admin and a fresh namespace `sextant-flux-<test>`; the namespace (and
/// with it every Flux object of the test, and what they deployed) is deleted afterwards, also when `body` panics.
async fn in_namespace<F, Fut>(test: &str, body: F)
where
    F: FnOnce(Scratch) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some(cluster) = gitops_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let ns = format!("sextant-flux-{test}");
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
        _tmp: tmp,
    };
    let result = AssertUnwindSafe(body(scratch)).catch_unwind().await;
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
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

fn git_repository(ns: &str) -> ObjectRef {
    object(
        "source.toolkit.fluxcd.io",
        "v1",
        "GitRepository",
        ns,
        "podinfo",
    )
}

fn kustomization(ns: &str) -> ObjectRef {
    object(
        "kustomize.toolkit.fluxcd.io",
        "v1",
        "Kustomization",
        ns,
        "podinfo",
    )
}

/// The podinfo GitRepository (as `scripts/fixtures/gitops/flux.yaml`), reconciled only on request.
async fn create_git_repository(s: &Scratch) {
    let yaml = format!(
        "apiVersion: source.toolkit.fluxcd.io/v1\nkind: GitRepository\nmetadata:\n  name: podinfo\n  namespace: {ns}\n\
         spec:\n  interval: 1h\n  url: https://github.com/stefanprodan/podinfo\n  ref:\n    branch: master\n",
        ns = s.ns
    );
    resources::apply_yaml(&s.mgr, &s.id, &yaml).await.unwrap();
}

/// A Kustomization of the podinfo example from the GitRepository above, into the test's namespace.
async fn create_kustomization(s: &Scratch) {
    let yaml = format!(
        "apiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\nmetadata:\n  name: podinfo\n  namespace: {ns}\n\
         spec:\n  interval: 1h\n  path: ./kustomize\n  prune: true\n  wait: false\n  targetNamespace: {ns}\n\
         \x20 sourceRef:\n    kind: GitRepository\n    name: podinfo\n",
        ns = s.ns
    );
    resources::apply_yaml(&s.mgr, &s.id, &yaml).await.unwrap();
}

async fn get(s: &Scratch, r: &ObjectRef) -> Value {
    resources::get(&s.mgr, &s.id, r).await.unwrap()
}

/// Waits until the controller has reconciled the object once (its generation observed).
async fn wait_reconciled(s: &Scratch, r: &ObjectRef) {
    wait_until(
        &format!("{} to be reconciled", r.kind.kind),
        120,
        || async {
            let obj = get(s, r).await;
            obj["status"]["observedGeneration"].as_i64() >= obj["metadata"]["generation"].as_i64()
                && obj["status"]["observedGeneration"].is_i64()
        },
    )
    .await;
}

/// What the frontend's "Reconcile now" sends: a merge patch of the annotation with an ISO time.
async fn request_reconcile(s: &Scratch, r: &ObjectRef, at: &str) -> Value {
    resources::patch(
        &s.mgr,
        &s.id,
        r,
        &json!({ "metadata": { "annotations": { REQUESTED_AT: at } } }),
        PatchType::Merge,
    )
    .await
    .unwrap()
}

/// What Suspend / Resume send.
async fn set_suspended(s: &Scratch, r: &ObjectRef, suspend: bool) -> Value {
    resources::patch(
        &s.mgr,
        &s.id,
        r,
        &json!({ "spec": { "suspend": suspend } }),
        PatchType::Merge,
    )
    .await
    .unwrap()
}

async fn handled(s: &Scratch, r: &ObjectRef) -> Option<String> {
    get(s, r).await["status"]["lastHandledReconcileAt"]
        .as_str()
        .map(str::to_owned)
}

async fn wait_handled(s: &Scratch, r: &ObjectRef, at: &str) {
    wait_until(
        &format!("{} to handle the request {at}", r.kind.kind),
        120,
        || async { handled(s, r).await.as_deref() == Some(at) },
    )
    .await;
}

#[tokio::test]
async fn flux_kinds_are_served_at_the_versions_the_section_registers() {
    let Some(cluster) = gitops_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let kinds = mgr.kinds(&id).await.unwrap();
    // `FLUX_KINDS` in src/features/flux/model.ts; discovery keeps the version the cluster prefers.
    for (group, version, kind) in [
        ("source.toolkit.fluxcd.io", "v1", "GitRepository"),
        ("source.toolkit.fluxcd.io", "v1", "OCIRepository"),
        ("source.toolkit.fluxcd.io", "v1", "HelmRepository"),
        ("source.toolkit.fluxcd.io", "v1", "HelmChart"),
        ("source.toolkit.fluxcd.io", "v1", "Bucket"),
        ("kustomize.toolkit.fluxcd.io", "v1", "Kustomization"),
        ("helm.toolkit.fluxcd.io", "v2", "HelmRelease"),
        ("image.toolkit.fluxcd.io", "v1", "ImageRepository"),
        ("image.toolkit.fluxcd.io", "v1", "ImagePolicy"),
        ("image.toolkit.fluxcd.io", "v1", "ImageUpdateAutomation"),
        ("notification.toolkit.fluxcd.io", "v1beta3", "Provider"),
        ("notification.toolkit.fluxcd.io", "v1beta3", "Alert"),
        ("notification.toolkit.fluxcd.io", "v1", "Receiver"),
    ] {
        let found = kinds
            .iter()
            .find(|k| k.kind_ref.group == group && k.kind_ref.kind == kind)
            .unwrap_or_else(|| panic!("{kind} ({group}) is not served"));
        assert_eq!(found.kind_ref.version, version, "{kind}");
        assert!(found.namespaced, "{kind}");
    }
}

#[tokio::test]
async fn reconcile_now_sets_the_annotation_and_the_controller_handles_it() {
    in_namespace("reconcile", |s| async move {
        create_git_repository(&s).await;
        let repo = git_repository(&s.ns);
        wait_reconciled(&s, &repo).await;

        let at = "2026-10-12T10:00:00.001Z";
        let saved = request_reconcile(&s, &repo, at).await;
        assert_eq!(saved["metadata"]["annotations"][REQUESTED_AT], at);
        assert_eq!(
            saved["spec"]["url"], "https://github.com/stefanprodan/podinfo",
            "a merge patch keeps the rest"
        );
        wait_handled(&s, &repo, at).await;
    })
    .await;
}

#[tokio::test]
async fn suspend_and_resume_change_spec_suspend_and_the_controller_follows() {
    in_namespace("suspend", |s| async move {
        create_git_repository(&s).await;
        create_kustomization(&s).await;
        let ks = kustomization(&s.ns);
        let services: Api<Service> = Api::namespaced(s.client.clone(), &s.ns);
        wait_until("podinfo to be applied", 120, || async {
            services.get_opt("podinfo").await.unwrap().is_some()
        })
        .await;
        wait_reconciled(&s, &ks).await;

        let saved = set_suspended(&s, &ks, true).await;
        assert_eq!(saved["spec"]["suspend"], true);
        // A suspended Kustomization leaves the cluster as it is, even when asked to reconcile…
        services
            .delete("podinfo", &DeleteParams::default())
            .await
            .unwrap();
        request_reconcile(&s, &ks, "2026-10-12T10:00:00.002Z").await;
        tokio::time::sleep(Duration::from_secs(8)).await;
        assert!(
            services.get_opt("podinfo").await.unwrap().is_none(),
            "a suspended Kustomization restored the deleted Service"
        );

        // …and applies its sources again once resumed.
        let saved = set_suspended(&s, &ks, false).await;
        assert_eq!(saved["spec"]["suspend"], false);
        let at = "2026-10-12T10:00:00.004Z";
        request_reconcile(&s, &ks, at).await;
        wait_handled(&s, &ks, at).await;
        wait_until(
            "the resumed Kustomization to restore the Service",
            120,
            || async { services.get_opt("podinfo").await.unwrap().is_some() },
        )
        .await;
    })
    .await;
}

#[tokio::test]
async fn reconcile_with_source_reaches_the_source_and_then_the_kustomization() {
    in_namespace("with-source", |s| async move {
        create_git_repository(&s).await;
        create_kustomization(&s).await;
        let (repo, ks) = (git_repository(&s.ns), kustomization(&s.ns));
        wait_reconciled(&s, &repo).await;
        wait_reconciled(&s, &ks).await;

        // The order of the frontend's "Reconcile with source": the source first, then the object.
        let at = "2026-10-12T10:00:00.003Z";
        request_reconcile(&s, &repo, at).await;
        request_reconcile(&s, &ks, at).await;
        wait_handled(&s, &repo, at).await;
        wait_handled(&s, &ks, at).await;
        let applied = get(&s, &ks).await;
        assert!(
            applied["status"]["inventory"]["entries"]
                .as_array()
                .is_some_and(|e| !e.is_empty()),
            "the Kustomization lists what it applied: {}",
            applied["status"]
        );
    })
    .await;
}

#[tokio::test]
async fn a_flux_kind_asked_in_a_version_the_cluster_does_not_serve_is_read_in_the_one_it_serves() {
    let Some(cluster) = gitops_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    // Flux v2.9 serves source.toolkit.fluxcd.io only in v1; a client that registered v1beta2 (older Flux) still
    // gets the fixture, in v1.
    let repo = resources::get(
        &mgr,
        &id,
        &object(
            "source.toolkit.fluxcd.io",
            "v1beta2",
            "GitRepository",
            "sextant-flux",
            "podinfo",
        ),
    )
    .await
    .unwrap();
    assert_eq!(repo["apiVersion"], "source.toolkit.fluxcd.io/v1");
    assert_eq!(repo["metadata"]["name"], "podinfo");
}
