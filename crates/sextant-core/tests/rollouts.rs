//! Rollout history and `kubectl rollout undo` (`resources::rollouts`) against the kind test cluster.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test rollouts -- --test-threads=1
//! ```
//!
//! The test works in its own namespace `sextant-rollouts` (created fresh, deleted at the end, also when it fails): a
//! Deployment, a StatefulSet and a DaemonSet each get their image changed twice and are rolled back to revision 1.

mod common;

use std::panic::AssertUnwindSafe;

use futures::FutureExt;
use k8s_openapi::api::core::v1::Namespace;
use kube::Api;
use kube::api::{DeleteParams, PostParams};
use serde_json::json;
use sextant_core::resources::rollouts::{self, Undo};
use sextant_core::resources::{self, KindRef, ObjectRef};
use sextant_core::{ClusterId, ClusterManager};

use common::{connected, wait_until};

const NS: &str = "sextant-rollouts";
/// Images the test cluster already has; every container just sleeps.
const IMAGES: [&str; 3] = ["busybox:1.36", "busybox:stable", "nginx:stable-alpine"];

fn workload(kind: &str) -> ObjectRef {
    ObjectRef {
        kind: KindRef {
            group: "apps".into(),
            version: "v1".into(),
            kind: kind.into(),
        },
        namespace: Some(NS.into()),
        name: kind.to_lowercase(),
    }
}

fn manifest(kind: &str) -> String {
    let name = kind.to_lowercase();
    let extra = match kind {
        "Deployment" => "  replicas: 1\n",
        "StatefulSet" => "  replicas: 1\n  serviceName: statefulset\n",
        _ => "",
    };
    format!(
        "apiVersion: apps/v1\nkind: {kind}\nmetadata: {{name: {name}, namespace: {NS}}}\nspec:\n{extra}  \
         selector: {{matchLabels: {{app: {name}}}}}\n  template:\n    metadata: {{labels: {{app: {name}}}}}\n    \
         spec:\n      terminationGracePeriodSeconds: 0\n      containers:\n      - name: main\n        image: {}\n        \
         imagePullPolicy: IfNotPresent\n        command: [sleep, \"3600\"]\n",
        IMAGES[0]
    )
}

async fn history_len(mgr: &ClusterManager, id: &ClusterId, r: &ObjectRef) -> usize {
    rollouts::history(mgr, id, r)
        .await
        .map(|h| h.len())
        .unwrap_or(0)
}

async fn current_images(mgr: &ClusterManager, id: &ClusterId, r: &ObjectRef) -> Vec<String> {
    let live = resources::get(mgr, id, r).await.unwrap();
    live["spec"]["template"]["spec"]["containers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["image"].as_str().unwrap().to_owned())
        .collect()
}

async fn delete_namespace(client: &kube::Client) {
    let api: Api<Namespace> = Api::all(client.clone());
    let _ = api.delete(NS, &DeleteParams::background()).await;
    wait_until("the namespace to go away", 180, || {
        let api = api.clone();
        async move { api.get_opt(NS).await.unwrap().is_none() }
    })
    .await;
}

#[tokio::test]
async fn image_changed_twice_rolls_back_to_revision_one() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    delete_namespace(&client).await;
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": NS } })).unwrap();
    Api::<Namespace>::all(client.clone())
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
    let (_tmp, mgr, id) = connected(&cluster.kubeconfig).await;

    let outcome = AssertUnwindSafe(async {
        for kind in ["Deployment", "StatefulSet", "DaemonSet"] {
            let r = workload(kind);
            resources::apply_yaml(&mgr, &id, &manifest(kind))
                .await
                .unwrap();
            wait_until(&format!("revision 1 of the {kind}"), 60, || {
                let (mgr, id, r) = (&mgr, &id, &r);
                async move { history_len(mgr, id, r).await == 1 }
            })
            .await;
            for (i, image) in IMAGES.iter().enumerate().skip(1) {
                let patch = json!({ "spec": { "template": { "spec": { "containers": [
                    { "name": "main", "image": image }
                ] } } } });
                resources::patch(&mgr, &id, &r, &patch, resources::PatchType::Merge)
                    .await
                    .unwrap();
                wait_until(&format!("revision {} of the {kind}", i + 1), 60, || {
                    let (mgr, id, r) = (&mgr, &id, &r);
                    async move { history_len(mgr, id, r).await == i + 1 }
                })
                .await;
            }
            let history = rollouts::history(&mgr, &id, &r).await.unwrap();
            let listed: Vec<(i64, Vec<String>, bool)> = history
                .iter()
                .map(|h| (h.revision, h.images.clone(), h.current))
                .collect();
            assert_eq!(
                listed,
                vec![
                    (1, vec![IMAGES[0].to_owned()], false),
                    (2, vec![IMAGES[1].to_owned()], false),
                    (3, vec![IMAGES[2].to_owned()], true),
                ],
                "{kind}"
            );
            // The template of revision 3 is what runs: nothing to roll back.
            let same = rollouts::undo(&mgr, &id, &r, 3).await.unwrap();
            assert_eq!(
                same,
                Undo {
                    revision: 3,
                    skipped: true
                },
                "{kind}"
            );

            let done = rollouts::undo(&mgr, &id, &r, 1).await.unwrap();
            assert_eq!(
                done,
                Undo {
                    revision: 1,
                    skipped: false
                },
                "{kind}"
            );
            assert_eq!(
                current_images(&mgr, &id, &r).await,
                vec![IMAGES[0]],
                "{kind}"
            );
            // As with kubectl, revision 1 comes back as the newest revision (4).
            wait_until(
                &format!("the {kind} history after the rollback"),
                60,
                || {
                    let (mgr, id, r) = (&mgr, &id, &r);
                    async move {
                        rollouts::history(mgr, id, r).await.is_ok_and(|h| {
                            h.last().is_some_and(|last| {
                                last.revision == 4 && last.current && last.images == vec![IMAGES[0]]
                            }) && h.iter().all(|r| r.revision != 1)
                        })
                    }
                },
            )
            .await;
        }
    })
    .catch_unwind()
    .await;

    delete_namespace(&client).await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
