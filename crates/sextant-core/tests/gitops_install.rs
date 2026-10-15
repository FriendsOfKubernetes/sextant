//! Installing Flux and Argo CD (`sextant_core::gitops_install`) against a kind cluster.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test gitops_install \
//!   -- --test-threads=1
//! ```
//!
//! The install test needs a cluster without Flux: on the shared test cluster brought up with `--gitops` it is skipped
//! with a note (it never uninstalls the shared Flux). Run it against a separate kind cluster brought up for it, e.g.
//! `kind create cluster --name sextant-install --kubeconfig /tmp/kc` and `SEXTANT_TEST_KUBECONFIG=/tmp/kc`. It
//! deletes only what it installed (the namespace `flux-system` and the plan's cluster-scoped objects), and only when
//! the cluster had no Flux before. The other tests read the shared cluster's Flux and Argo CD (`SEXTANT_TEST_GITOPS=1`)
//! or ask access reviews; they change nothing.

mod common;

use std::io::Read;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::core::v1::Namespace;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::Api;
use kube::api::{DeleteParams, DynamicObject, GroupVersionKind, Patch, PatchParams};
use sextant_core::gitops_install::{
    AccessCheck, GitopsTool, InstallPlan, InstallStep, InstalledState, access_check, apply,
    installed, prepare, readiness,
};

/// The official `install.yaml` of Flux v2.9.6, kept beside the module's unit tests.
const FLUX_GZ: &[u8] = include_bytes!("../src/gitops_install/testdata/flux-v2.9.6-install.yaml.gz");
/// The official `manifests/install.yaml` of Argo CD v3.5.5.
const ARGOCD_GZ: &[u8] =
    include_bytes!("../src/gitops_install/testdata/argocd-v3.5.5-install.yaml.gz");

fn flux_manifest() -> String {
    let mut text = String::new();
    flate2::read::GzDecoder::new(FLUX_GZ)
        .read_to_string(&mut text)
        .unwrap();
    text
}

const FLUX_CONTROLLERS: [&str; 4] = [
    "helm-controller",
    "kustomize-controller",
    "notification-controller",
    "source-controller",
];

#[tokio::test]
async fn flux_installs_into_a_cluster_without_it_and_its_controllers_become_ready() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let before = installed(&mgr, &id, GitopsTool::Flux).await.unwrap();
    if before != InstalledState::default() {
        eprintln!(
            "skipped: the test cluster already has Flux ({before:?}); this test installs Flux only into a cluster \
             without it (see the module comment)"
        );
        return;
    }
    assert_eq!(
        access_check(&mgr, &id).await.unwrap(),
        AccessCheck {
            can_create_crds: true,
            can_create_cluster_role_bindings: true,
        }
    );
    let plan = prepare(GitopsTool::Flux, "v2.9.6", &flux_manifest()).unwrap();

    let outcome = AssertUnwindSafe(async {
        let mut steps = Vec::new();
        let report = apply(&mgr, &id, &plan, |step| steps.push(step))
            .await
            .unwrap();
        assert!(!report.stopped);
        assert_eq!(report.applied, plan.objects);
        assert_eq!(steps.len(), plan.objects.len());
        assert!(
            steps
                .iter()
                .all(|s| matches!(s, InstallStep::Applied { .. }))
        );
        assert_eq!(
            installed(&mgr, &id, GitopsTool::Flux).await.unwrap(),
            InstalledState {
                present: true,
                partial: false,
            }
        );
        // The new kinds are served without reconnecting.
        let kinds = mgr.kinds(&id).await.unwrap();
        assert!(
            kinds
                .iter()
                .any(|k| k.kind_ref.group == "kustomize.toolkit.fluxcd.io"
                    && k.kind_ref.kind == "Kustomization")
        );

        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            let states = readiness(&mgr, &id, GitopsTool::Flux, "flux-system")
                .await
                .unwrap();
            let mut names: Vec<&str> = states.iter().map(|s| s.name.as_str()).collect();
            names.sort_unstable();
            assert_eq!(names, FLUX_CONTROLLERS, "{states:?}");
            if states.iter().all(|s| s.ready && s.reason.is_none()) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Flux did not become ready in 5 minutes: {states:?}"
            );
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    })
    .catch_unwind()
    .await;

    uninstall(&cluster.client().await, &plan).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// Deletes what the plan created in a cluster that had no Flux before it.
async fn uninstall(client: &kube::Client, plan: &InstallPlan) {
    let params = DeleteParams::default();
    for object in plan.objects.iter().filter(|o| o.cluster_scoped) {
        let name = object.name.as_str();
        let deleted = match object.kind.as_str() {
            "Namespace" => Api::<Namespace>::all(client.clone())
                .delete(name, &params)
                .await
                .map(drop),
            "CustomResourceDefinition" => Api::<CustomResourceDefinition>::all(client.clone())
                .delete(name, &params)
                .await
                .map(drop),
            "ClusterRole" => Api::<ClusterRole>::all(client.clone())
                .delete(name, &params)
                .await
                .map(drop),
            "ClusterRoleBinding" => Api::<ClusterRoleBinding>::all(client.clone())
                .delete(name, &params)
                .await
                .map(drop),
            other => panic!("unexpected cluster-scoped kind {other}"),
        };
        if let Err(err) = deleted {
            eprintln!("cleanup: {} {name}: {err}", object.kind);
        }
    }
    let namespaces = Api::<Namespace>::all(client.clone());
    common::wait_until("flux-system to be deleted", 180, || async {
        matches!(namespaces.get_opt("flux-system").await, Ok(None))
    })
    .await;
}

#[tokio::test]
async fn the_shared_gitops_cluster_has_both_tools_installed_and_ready() {
    let Some(cluster) = common::gitops_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let present = InstalledState {
        present: true,
        partial: false,
    };
    assert_eq!(
        installed(&mgr, &id, GitopsTool::Flux).await.unwrap(),
        present
    );
    assert_eq!(
        installed(&mgr, &id, GitopsTool::ArgoCd).await.unwrap(),
        present
    );

    // The shared cluster has Flux's whole file; only the default set counts.
    let flux = readiness(&mgr, &id, GitopsTool::Flux, "flux-system")
        .await
        .unwrap();
    let mut names: Vec<&str> = flux.iter().map(|s| s.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, FLUX_CONTROLLERS, "{flux:?}");
    assert!(flux.iter().all(|s| s.ready), "{flux:?}");

    let argocd = readiness(&mgr, &id, GitopsTool::ArgoCd, "argocd")
        .await
        .unwrap();
    assert!(
        argocd
            .iter()
            .any(|s| s.kind == "StatefulSet" && s.name == "argocd-application-controller"),
        "{argocd:?}"
    );
    assert!(
        argocd
            .iter()
            .any(|s| s.kind == "Deployment" && s.name == "argocd-server"),
        "{argocd:?}"
    );
    assert!(argocd.iter().all(|s| s.ready), "{argocd:?}");
}

/// Every document of both plans, as the real API server reads it: a forced server-side apply with `dryRun=All` (the
/// server validates and merges, stores nothing) over the shared cluster's own Flux and Argo CD.
#[tokio::test]
async fn the_api_server_accepts_every_planned_document() {
    let Some(cluster) = common::gitops_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let argocd = {
        let mut text = String::new();
        flate2::read::GzDecoder::new(ARGOCD_GZ)
            .read_to_string(&mut text)
            .unwrap();
        prepare(GitopsTool::ArgoCd, "v3.5.5", &text).unwrap()
    };
    let flux = prepare(GitopsTool::Flux, "v2.9.6", &flux_manifest()).unwrap();
    let params = PatchParams::apply("sextant").force().dry_run();
    for plan in [&flux, &argocd] {
        for (object, doc) in plan.objects.iter().zip(plan.documents()) {
            let kind = doc.kind_ref();
            let gvk = GroupVersionKind::gvk(&kind.group, &kind.version, &kind.kind);
            let (resource, _) = kube::discovery::pinned_kind(&client, &gvk).await.unwrap();
            let api: Api<DynamicObject> = match &object.namespace {
                Some(ns) => Api::namespaced_with(client.clone(), ns, &resource),
                None => Api::all_with(client.clone(), &resource),
            };
            api.patch(&object.name, &params, &Patch::Apply(doc.value()))
                .await
                .unwrap_or_else(|e| panic!("{:?} {object:?}: {e}", plan.tool));
        }
    }
}

#[tokio::test]
async fn a_user_without_cluster_rights_is_told_before_the_install() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&cluster.limited_kubeconfig).await;
    assert_eq!(
        access_check(&mgr, &id).await.unwrap(),
        AccessCheck {
            can_create_crds: false,
            can_create_cluster_role_bindings: false,
        }
    );
}
