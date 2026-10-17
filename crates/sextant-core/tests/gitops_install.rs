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
//!
//! The real install of both tools runs only with `SEXTANT_TEST_INSTALL_KUBECONFIG`, pointing at a throwaway kind
//! cluster without Flux and Argo CD (it is skipped with a note when either is there). It installs Flux (the default
//! set) and Argo CD from the pinned files beside the unit tests, first stopping each after its definitions (a partial
//! install) and then applying it whole, waits up to 6 minutes for every workload (image pulls), and leaves both
//! installed: delete the cluster afterwards.
//!
//! ```sh
//! kind create cluster --name sextant-install-test --kubeconfig /tmp/sextant-install-kc
//! SEXTANT_TEST_INSTALL_KUBECONFIG=/tmp/sextant-install-kc cargo test -p sextant-core --test gitops_install \
//!   -- --nocapture real_install
//! kind delete cluster --name sextant-install-test --kubeconfig /tmp/sextant-install-kc
//! ```

mod common;

use std::io::Read;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::Namespace;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::Api;
use kube::api::{DeleteParams, DynamicObject, GroupVersionKind, ListParams, Patch, PatchParams};
use sextant_core::gitops_install::{
    AccessCheck, GitopsTool, InstallPlan, InstallStep, InstalledState, WorkloadState, access_check,
    apply, apply_until, installed, overlap, prepare, readiness,
};
use sextant_core::{ClusterId, ClusterManager};

/// The official `install.yaml` of Flux v2.9.6, kept beside the module's unit tests.
const FLUX_GZ: &[u8] = include_bytes!("../src/gitops_install/testdata/flux-v2.9.6-install.yaml.gz");
/// The official `manifests/install.yaml` of Argo CD v3.5.5.
const ARGOCD_GZ: &[u8] =
    include_bytes!("../src/gitops_install/testdata/argocd-v3.5.5-install.yaml.gz");

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
    let argocd = prepare(GitopsTool::ArgoCd, "v3.5.5", &argocd_manifest()).unwrap();
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

const PRESENT: InstalledState = InstalledState {
    present: true,
    partial: false,
};
const PARTIAL: InstalledState = InstalledState {
    present: false,
    partial: true,
};
/// The Flux components `flux install` leaves out by default, and the API groups of their definitions.
const FLUX_LEFT_OUT: [&str; 3] = [
    "image-reflector-controller",
    "image-automation-controller",
    "source-watcher",
];
const FLUX_LEFT_OUT_GROUPS: [&str; 2] = ["image.toolkit.fluxcd.io", "source.extensions.fluxcd.io"];
/// How long the workloads may take to become ready on a fresh cluster (the images are pulled).
const READY_TIMEOUT: Duration = Duration::from_secs(360);

/// Applies the plan's Namespace and definitions only, through the stop flag, as a cancelled install does.
async fn apply_up_to_the_definitions(mgr: &ClusterManager, id: &ClusterId, plan: &InstallPlan) {
    let early = plan
        .objects
        .iter()
        .take_while(|o| o.kind == "Namespace" || o.kind == "CustomResourceDefinition")
        .count();
    assert!(early > 1, "{:?}: {:?}", plan.tool, plan.objects);
    let stop = AtomicBool::new(false);
    let mut sent = 0;
    let report = apply_until(mgr, id, plan, &stop, |_| {
        sent += 1;
        if sent == early {
            stop.store(true, Ordering::SeqCst);
        }
    })
    .await
    .unwrap();
    assert!(report.stopped, "{:?}", plan.tool);
    assert_eq!(report.applied, plan.objects[..early], "{:?}", plan.tool);
}

async fn wait_ready(
    mgr: &ClusterManager,
    id: &ClusterId,
    tool: GitopsTool,
    since: Instant,
) -> Vec<WorkloadState> {
    loop {
        let states = readiness(mgr, id, tool, tool.namespace()).await.unwrap();
        if !states.is_empty() && states.iter().all(|s| s.ready && s.reason.is_none()) {
            eprintln!(
                "{} ready {:.0?} after the apply",
                tool.title(),
                since.elapsed()
            );
            return states;
        }
        assert!(
            since.elapsed() < READY_TIMEOUT,
            "{} did not become ready in {READY_TIMEOUT:?}: {states:?}",
            tool.title()
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

#[tokio::test]
async fn real_install_of_flux_and_argocd_into_a_throwaway_cluster() {
    let Some(kubeconfig) = common::install_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&kubeconfig).await;
    for tool in [GitopsTool::Flux, GitopsTool::ArgoCd] {
        let before = installed(&mgr, &id, tool).await.unwrap();
        if before != InstalledState::default() {
            eprintln!(
                "skipped: the cluster of {} already has {} ({before:?}); this test needs a throwaway cluster \
                 without Flux and Argo CD",
                common::INSTALL_KUBECONFIG_ENV,
                tool.title()
            );
            return;
        }
    }
    assert_eq!(
        access_check(&mgr, &id).await.unwrap(),
        AccessCheck {
            can_create_crds: true,
            can_create_cluster_role_bindings: true,
        }
    );
    let flux = prepare(GitopsTool::Flux, "v2.9.6", &flux_manifest()).unwrap();
    let argocd = prepare(GitopsTool::ArgoCd, "v3.5.5", &argocd_manifest()).unwrap();

    // An install stopped after the definitions is partial; the next install completes it.
    for plan in [&flux, &argocd] {
        let started = Instant::now();
        apply_up_to_the_definitions(&mgr, &id, plan).await;
        assert_eq!(
            installed(&mgr, &id, plan.tool).await.unwrap(),
            PARTIAL,
            "{:?}",
            plan.tool
        );
        eprintln!(
            "{} stopped after its definitions in {:.1?}",
            plan.tool.title(),
            started.elapsed()
        );
    }
    let mut applied_at = Vec::new();
    for plan in [&flux, &argocd] {
        let started = Instant::now();
        let report = apply(&mgr, &id, plan, |_| {}).await.unwrap();
        assert!(!report.stopped);
        assert_eq!(report.applied, plan.objects);
        assert_eq!(
            installed(&mgr, &id, plan.tool).await.unwrap(),
            PRESENT,
            "{:?}",
            plan.tool
        );
        eprintln!(
            "{} applied ({} objects) in {:.1?}",
            plan.tool.title(),
            plan.objects.len(),
            started.elapsed()
        );
        applied_at.push(Instant::now());
    }

    // The sidebar kinds are served without reconnecting; the left-out Flux groups are not.
    let kinds = mgr.kinds(&id).await.unwrap();
    let has = |group: &str, kind: &str| {
        kinds
            .iter()
            .any(|k| k.kind_ref.group == group && k.kind_ref.kind == kind)
    };
    assert!(has("kustomize.toolkit.fluxcd.io", "Kustomization"));
    assert!(has("source.toolkit.fluxcd.io", "GitRepository"));
    assert!(has("helm.toolkit.fluxcd.io", "HelmRelease"));
    assert!(has("argoproj.io", "Application"));
    assert!(has("argoproj.io", "AppProject"));
    assert!(
        !kinds
            .iter()
            .any(|k| FLUX_LEFT_OUT_GROUPS.contains(&k.kind_ref.group.as_str())),
        "a left-out Flux group is served"
    );

    let flux_states = wait_ready(&mgr, &id, GitopsTool::Flux, applied_at[0]).await;
    let mut names: Vec<&str> = flux_states.iter().map(|s| s.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, FLUX_CONTROLLERS, "{flux_states:?}");
    let argocd_states = wait_ready(&mgr, &id, GitopsTool::ArgoCd, applied_at[1]).await;
    for (kind, name) in [
        ("StatefulSet", "argocd-application-controller"),
        ("Deployment", "argocd-server"),
        ("Deployment", "argocd-repo-server"),
        ("Deployment", "argocd-redis"),
    ] {
        assert!(
            argocd_states
                .iter()
                .any(|s| s.kind == kind && s.name == name),
            "{kind} {name}: {argocd_states:?}"
        );
    }
    for tool in [GitopsTool::Flux, GitopsTool::ArgoCd] {
        assert_eq!(
            installed(&mgr, &id, tool).await.unwrap(),
            PRESENT,
            "{tool:?}"
        );
    }

    // Nothing of the left-out Flux components is in the cluster.
    let client = common::client_from(&kubeconfig).await;
    let deployments = Api::<Deployment>::namespaced(client.clone(), "flux-system")
        .list_metadata(&ListParams::default())
        .await
        .unwrap();
    let mut names: Vec<String> = deployments
        .items
        .into_iter()
        .filter_map(|d| d.metadata.name)
        .collect();
    names.sort_unstable();
    assert_eq!(names, FLUX_CONTROLLERS);
    let crds = Api::<CustomResourceDefinition>::all(client)
        .list_metadata(&ListParams::default())
        .await
        .unwrap();
    for crd in crds.items {
        let name = crd.metadata.name.unwrap_or_default();
        assert!(
            !FLUX_LEFT_OUT_GROUPS
                .iter()
                .any(|g| name.ends_with(&format!(".{g}"))),
            "{name}"
        );
    }
    let left = overlap(&mgr, &id, &flux).await.unwrap();
    assert!(left.left_out_controllers.is_empty(), "{left:?}");
    assert!(
        FLUX_LEFT_OUT
            .iter()
            .all(|c| !flux_states.iter().any(|s| s.name == *c))
    );
}
