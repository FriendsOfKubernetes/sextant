//! Changing objects (`resources::{replace_yaml, apply_yaml, delete, scale, restart, cordon, drain,
//! trigger_cronjob, suspend_cronjob}`) against the kind test cluster.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test mutate -- --test-threads=1
//! ```
//!
//! Every test works in its own namespace `sextant-mutate-<test>` (created fresh, deleted at the end, also when the
//! test fails) and never touches the fixtures in `sextant-demo` or the real node: node actions run on a fake Node
//! object `sextant-mutate-<test>-node` that has no kubelet, deleted at the end as well.

mod common;

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Node, Pod};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::api::{DeleteParams, ListParams, Patch, PatchParams, PostParams};
use kube::{Api, Client};
use serde_json::{Value, json};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::resources::{self, KindRef, ObjectRef};
use sextant_core::{ClusterId, ClusterManager, ErrorCode, KubeconfigRegistry};

const NGINX_IMAGE: &str = "nginx:stable-alpine";
const BUSYBOX_IMAGE: &str = "busybox:stable";

/// What a test gets: a manager connected as admin, a plain admin client and its own namespace.
struct Scratch {
    mgr: ClusterManager,
    id: ClusterId,
    client: Client,
    ns: String,
    /// Name of the fake node this test may create.
    node: String,
    limited_kubeconfig: PathBuf,
    _tmp: tempfile::TempDir,
}

/// Runs `body` in a fresh namespace `sextant-mutate-<test>`; cleans up whether `body` passes or panics.
async fn in_scratch<F, Fut>(test: &str, body: F)
where
    F: FnOnce(Scratch) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let ns = format!("sextant-mutate-{test}");
    let node = format!("{ns}-node");
    cleanup(&client, &ns, &node).await;
    wait_until("the old namespace to go away", 180, || {
        let api: Api<Namespace> = Api::all(client.clone());
        let ns = ns.clone();
        async move { api.get_opt(&ns).await.unwrap().is_none() }
    })
    .await;
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": ns } })).unwrap();
    Api::<Namespace>::all(client.clone())
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();

    let (tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let scratch = Scratch {
        mgr,
        id,
        client: client.clone(),
        ns: ns.clone(),
        node: node.clone(),
        limited_kubeconfig: cluster.limited_kubeconfig.clone(),
        _tmp: tmp,
    };
    let result = AssertUnwindSafe(body(scratch)).catch_unwind().await;
    cleanup(&client, &ns, &node).await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

/// Deletes the namespace and the fake node. Pods on the fake node never terminate by themselves (no kubelet), so
/// every pod of the namespace is force-deleted until none is left.
async fn cleanup(client: &Client, ns: &str, node: &str) {
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(ns, &DeleteParams::background()).await;
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    let force = DeleteParams {
        grace_period_seconds: Some(0),
        ..DeleteParams::background()
    };
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let left = pods
            .list(&ListParams::default())
            .await
            .map(|l| l.items)
            .unwrap_or_default();
        if left.is_empty() || Instant::now() > deadline {
            break;
        }
        for pod in left {
            if let Some(name) = pod.metadata.name {
                let _ = pods.delete(&name, &force).await;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let nodes: Api<Node> = Api::all(client.clone());
    let _ = nodes.delete(node, &DeleteParams::default()).await;
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

fn kind(group: &str, version: &str, kind: &str) -> KindRef {
    KindRef {
        group: group.into(),
        version: version.into(),
        kind: kind.into(),
    }
}

fn object(kind: KindRef, ns: Option<&str>, name: &str) -> ObjectRef {
    ObjectRef {
        kind,
        namespace: ns.map(str::to_owned),
        name: name.into(),
    }
}

fn config_map_ref(ns: &str, name: &str) -> ObjectRef {
    object(kind("", "v1", "ConfigMap"), Some(ns), name)
}

fn deployment_ref(ns: &str, name: &str) -> ObjectRef {
    object(kind("apps", "v1", "Deployment"), Some(ns), name)
}

async fn create_config_map(client: &Client, ns: &str, name: &str, data: Value) -> ConfigMap {
    let cm: ConfigMap = serde_json::from_value(json!({
        "metadata": { "name": name, "namespace": ns },
        "data": data,
    }))
    .unwrap();
    Api::<ConfigMap>::namespaced(client.clone(), ns)
        .create(&PostParams::default(), &cm)
        .await
        .unwrap()
}

fn deployment_yaml(ns: &str, name: &str, replicas: i32) -> String {
    format!(
        "\
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {name}
  namespace: {ns}
spec:
  replicas: {replicas}
  selector:
    matchLabels: {{ app: {name} }}
  template:
    metadata:
      labels: {{ app: {name} }}
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: web
          image: {NGINX_IMAGE}
"
    )
}

/// The object as the editor loads it (`resources::get`).
async fn load(s: &Scratch, r: &ObjectRef) -> Value {
    resources::get(&s.mgr, &s.id, r).await.unwrap()
}

// ---------- R09i: edit and save ----------

#[tokio::test]
async fn a_label_changed_in_the_editor_is_saved_to_the_cluster() {
    in_scratch("label", |s| async move {
        create_config_map(&s.client, &s.ns, "app-config", json!({ "mode": "a" })).await;
        let r = config_map_ref(&s.ns, "app-config");

        let mut obj = load(&s, &r).await;
        assert!(obj["metadata"].get("managedFields").is_none());
        obj["metadata"]["labels"] = json!({ "edited-by": "sextant" });
        obj["data"]["mode"] = json!("b");
        let yaml = serde_yaml::to_string(&obj).unwrap();

        let saved = resources::replace_yaml(&s.mgr, &s.id, &yaml).await.unwrap();
        assert_eq!(saved["metadata"]["labels"]["edited-by"], "sextant");
        assert_ne!(
            saved["metadata"]["resourceVersion"], obj["metadata"]["resourceVersion"],
            "the saved object carries the new resourceVersion"
        );
        assert!(saved["metadata"].get("managedFields").is_none());

        // What `kubectl get --show-labels` reads.
        let live = Api::<ConfigMap>::namespaced(s.client.clone(), &s.ns)
            .get("app-config")
            .await
            .unwrap();
        assert_eq!(live.metadata.labels.unwrap()["edited-by"], "sextant");
        assert_eq!(live.data.unwrap()["mode"], "b");
    })
    .await;
}

// ---------- R09i.2: conflict ----------

#[tokio::test]
async fn saving_over_a_change_made_in_the_cluster_is_a_conflict_and_overwrites_nothing() {
    in_scratch("conflict", |s| async move {
        create_config_map(&s.client, &s.ns, "shared", json!({ "owner": "nobody" })).await;
        let r = config_map_ref(&s.ns, "shared");
        let mut opened = load(&s, &r).await;

        // Someone else changes the object after the editor loaded it.
        Api::<ConfigMap>::namespaced(s.client.clone(), &s.ns)
            .patch(
                "shared",
                &PatchParams::default(),
                &Patch::Merge(json!({ "data": { "owner": "cluster" } })),
            )
            .await
            .unwrap();

        opened["data"]["owner"] = json!("editor");
        let yaml = serde_yaml::to_string(&opened).unwrap();
        let err = resources::replace_yaml(&s.mgr, &s.id, &yaml)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict, "{err}");

        let live = Api::<ConfigMap>::namespaced(s.client.clone(), &s.ns)
            .get("shared")
            .await
            .unwrap();
        assert_eq!(live.data.unwrap()["owner"], "cluster", "not overwritten");

        // Without a resourceVersion the save is refused instead of overwriting blindly.
        let mut blind = opened.clone();
        blind["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("resourceVersion");
        let err = resources::replace_yaml(&s.mgr, &s.id, &serde_yaml::to_string(&blind).unwrap())
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        assert!(err.message.contains("resourceVersion"), "{err}");
    })
    .await;
}

// ---------- R09i.1: invalid YAML and server validation ----------

#[tokio::test]
async fn broken_yaml_and_rejected_objects_are_invalid_with_the_reason() {
    in_scratch("invalid", |s| async move {
        let err = resources::replace_yaml(&s.mgr, &s.id, "metadata:\n  name: [x\n")
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        assert!(err.message.contains("line"), "names the position: {err}");

        create_config_map(&s.client, &s.ns, "strict", json!({})).await;
        let mut obj = load(&s, &config_map_ref(&s.ns, "strict")).await;
        obj["metadata"]["labels"] = json!({ "bad": "not a valid label value!" });
        let err = resources::replace_yaml(&s.mgr, &s.id, &serde_yaml::to_string(&obj).unwrap())
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        assert!(err.message.contains("labels"), "server's reason: {err}");
    })
    .await;
}

// ---------- R09i.5: create from YAML ----------

#[tokio::test]
async fn one_text_creates_a_config_map_and_a_deployment_and_applies_again() {
    in_scratch("apply", |s| async move {
        let text = format!(
            "\
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-settings
  namespace: {ns}
data:
  greeting: hello
---
{deployment}",
            ns = s.ns,
            deployment = deployment_yaml(&s.ns, "web", 1),
        );
        let applied = resources::apply_yaml(&s.mgr, &s.id, &text).await.unwrap();
        assert_eq!(
            applied,
            vec![
                config_map_ref(&s.ns, "web-settings"),
                deployment_ref(&s.ns, "web")
            ]
        );
        let cm = Api::<ConfigMap>::namespaced(s.client.clone(), &s.ns)
            .get("web-settings")
            .await
            .unwrap();
        assert_eq!(cm.data.unwrap()["greeting"], "hello");
        let managers: Vec<String> = cm
            .metadata
            .managed_fields
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| m.manager)
            .collect();
        assert!(managers.contains(&"sextant".to_owned()), "{managers:?}");
        Api::<Deployment>::namespaced(s.client.clone(), &s.ns)
            .get("web")
            .await
            .unwrap();

        // Applying the same text again (e.g. after editing a value) does not fail.
        let again = resources::apply_yaml(&s.mgr, &s.id, &text.replace("hello", "hi"))
            .await
            .unwrap();
        assert_eq!(again, applied);
        let cm = Api::<ConfigMap>::namespaced(s.client.clone(), &s.ns)
            .get("web-settings")
            .await
            .unwrap();
        assert_eq!(cm.data.unwrap()["greeting"], "hi");
    })
    .await;
}

#[tokio::test]
async fn a_broken_document_names_itself_and_nothing_is_applied() {
    in_scratch("apply-broken", |s| async move {
        let text = format!(
            "\
apiVersion: v1
kind: ConfigMap
metadata: {{ name: never, namespace: {ns} }}
---
apiVersion: v1
kind: ConfigMap
metadata: {{ namespace: {ns} }}
",
            ns = s.ns
        );
        let err = resources::apply_yaml(&s.mgr, &s.id, &text)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        assert!(err.message.contains("document 2"), "{err}");
        let cms: Api<ConfigMap> = Api::namespaced(s.client.clone(), &s.ns);
        assert!(cms.get_opt("never").await.unwrap().is_none());

        // An object the server rejects: the error names the document and what was applied before it.
        let text = format!(
            "\
apiVersion: v1
kind: ConfigMap
metadata: {{ name: first, namespace: {ns} }}
---
apiVersion: v1
kind: ConfigMap
metadata: {{ name: second, namespace: {ns}, labels: {{ bad: 'no spaces allowed' }} }}
",
            ns = s.ns
        );
        let err = resources::apply_yaml(&s.mgr, &s.id, &text)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        assert!(
            err.message.contains("document 2 (ConfigMap second)"),
            "{err}"
        );
        assert!(err.message.contains("ConfigMap"), "{err}");
        assert!(
            err.message.contains("first"),
            "lists what was applied: {err}"
        );
    })
    .await;
}

// ---------- R09i.3 and the 403 path ----------

#[tokio::test]
async fn delete_removes_the_object() {
    in_scratch("delete", |s| async move {
        create_config_map(&s.client, &s.ns, "doomed", json!({})).await;
        resources::delete(&s.mgr, &s.id, &config_map_ref(&s.ns, "doomed"))
            .await
            .unwrap();
        let cms: Api<ConfigMap> = Api::namespaced(s.client.clone(), &s.ns);
        wait_until("the ConfigMap to be deleted", 30, || {
            let cms = cms.clone();
            async move { cms.get_opt("doomed").await.unwrap().is_none() }
        })
        .await;

        let err = resources::delete(&s.mgr, &s.id, &config_map_ref(&s.ns, "doomed"))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{err}");
    })
    .await;
}

#[tokio::test]
async fn changes_without_permission_are_forbidden_and_change_nothing() {
    in_scratch("forbidden", |s| async move {
        create_config_map(&s.client, &s.ns, "protected", json!({ "k": "v" })).await;
        let (_tmp, limited, limited_id) = connected(&s.limited_kubeconfig).await;

        let err = resources::delete(&limited, &limited_id, &config_map_ref(&s.ns, "protected"))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden, "{err}");
        assert!(err.message.contains("forbidden"), "{err}");
        let cms: Api<ConfigMap> = Api::namespaced(s.client.clone(), &s.ns);
        assert!(cms.get_opt("protected").await.unwrap().is_some());

        let yaml =
            serde_yaml::to_string(&load(&s, &config_map_ref(&s.ns, "protected")).await).unwrap();
        let err = resources::replace_yaml(&limited, &limited_id, &yaml)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden, "{err}");
    })
    .await;
}

// ---------- R09i.4: scale and restart ----------

#[tokio::test]
async fn scale_changes_replicas_and_restart_rolls_the_pods() {
    in_scratch("workload", |s| async move {
        resources::apply_yaml(&s.mgr, &s.id, &deployment_yaml(&s.ns, "web", 1))
            .await
            .unwrap();
        let r = deployment_ref(&s.ns, "web");
        let deployments: Api<Deployment> = Api::namespaced(s.client.clone(), &s.ns);

        resources::scale(&s.mgr, &s.id, &r, 2).await.unwrap();
        let live = deployments.get("web").await.unwrap();
        assert_eq!(live.spec.unwrap().replicas, Some(2));

        let err = resources::scale(&s.mgr, &s.id, &r, -1).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);

        // Wait for the first rollout so that the restart is a second revision.
        let replica_sets: Api<ReplicaSet> = Api::namespaced(s.client.clone(), &s.ns);
        wait_until("the first ReplicaSet", 60, || {
            let rs = replica_sets.clone();
            async move { rs.list(&ListParams::default()).await.unwrap().items.len() == 1 }
        })
        .await;

        resources::restart(&s.mgr, &s.id, &r).await.unwrap();
        let live = deployments.get("web").await.unwrap();
        let annotations = live
            .spec
            .unwrap()
            .template
            .metadata
            .unwrap()
            .annotations
            .unwrap_or_default();
        assert!(
            annotations.contains_key("kubectl.kubernetes.io/restartedAt"),
            "{annotations:?}"
        );
        // A new pod template means a new ReplicaSet: the pods are replaced.
        wait_until("a second ReplicaSet after the restart", 60, || {
            let rs = replica_sets.clone();
            async move { rs.list(&ListParams::default()).await.unwrap().items.len() == 2 }
        })
        .await;

        let err = resources::restart(&s.mgr, &s.id, &config_map_ref(&s.ns, "x"))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
    })
    .await;
}

// ---------- R09i.6: nodes ----------

/// A Node object without a kubelet, with room for pods so the scheduler can place DaemonSet pods on it.
async fn create_fake_node(client: &Client, name: &str) {
    let nodes: Api<Node> = Api::all(client.clone());
    let node: Node = serde_json::from_value(json!({
        "metadata": { "name": name, "labels": { "sextant.dev/fake-node": name } }
    }))
    .unwrap();
    nodes.create(&PostParams::default(), &node).await.unwrap();
    let room = json!({ "pods": "20", "cpu": "4", "memory": "4Gi" });
    nodes
        .patch_status(
            name,
            &PatchParams::default(),
            &Patch::Merge(json!({ "status": { "capacity": room, "allocatable": room } })),
        )
        .await
        .unwrap();
}

/// A pod bound to `node` directly (no scheduler), shown as running and ready.
async fn create_bound_pod(client: &Client, ns: &str, node: &str, name: &str) {
    let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
    let pod: Pod = serde_json::from_value(json!({
        "metadata": { "name": name, "namespace": ns, "labels": { "app": name } },
        "spec": {
            "nodeName": node,
            "terminationGracePeriodSeconds": 1,
            // The fake node is unreachable (no kubelet), so it gets the `unreachable:NoExecute` taint; without this
            // toleration the taint manager would delete the pod after the default 300 s, in the middle of the test.
            "tolerations": [{ "operator": "Exists" }],
            "containers": [{ "name": "c", "image": BUSYBOX_IMAGE }]
        }
    }))
    .unwrap();
    pods.create(&PostParams::default(), &pod).await.unwrap();
    pods.patch_status(
        name,
        &PatchParams::default(),
        &Patch::Merge(json!({ "status": {
            "phase": "Running",
            "conditions": [{ "type": "Ready", "status": "True" }]
        } })),
    )
    .await
    .unwrap();
}

async fn unschedulable(client: &Client, node: &str) -> bool {
    let node = Api::<Node>::all(client.clone()).get(node).await.unwrap();
    node.spec.and_then(|s| s.unschedulable).unwrap_or(false)
}

async fn being_deleted(pods: &Api<Pod>, name: &str) -> bool {
    match pods.get_opt(name).await.unwrap() {
        None => true,
        Some(pod) => pod.metadata.deletion_timestamp.is_some(),
    }
}

#[tokio::test]
async fn cordon_uncordon_and_drain_that_skips_daemon_sets_and_reports_a_budget() {
    in_scratch("node", |s| async move {
        create_fake_node(&s.client, &s.node).await;

        resources::cordon(&s.mgr, &s.id, &s.node, true)
            .await
            .unwrap();
        assert!(unschedulable(&s.client, &s.node).await);
        resources::cordon(&s.mgr, &s.id, &s.node, false)
            .await
            .unwrap();
        assert!(!unschedulable(&s.client, &s.node).await);

        // A DaemonSet pod (must stay), a lonely pod (evicted) and a pod a budget protects (refused).
        let ds: DaemonSet = serde_json::from_value(json!({
            "metadata": { "name": "agent", "namespace": s.ns },
            "spec": {
                "selector": { "matchLabels": { "app": "agent" } },
                "template": {
                    "metadata": { "labels": { "app": "agent" } },
                    "spec": {
                        "nodeSelector": { "sextant.dev/fake-node": s.node },
                        "tolerations": [{ "operator": "Exists" }],
                        "containers": [{ "name": "c", "image": BUSYBOX_IMAGE }]
                    }
                }
            }
        }))
        .unwrap();
        Api::<DaemonSet>::namespaced(s.client.clone(), &s.ns)
            .create(&PostParams::default(), &ds)
            .await
            .unwrap();
        let pods: Api<Pod> = Api::namespaced(s.client.clone(), &s.ns);
        let agent_on_node = ListParams::default()
            .labels("app=agent")
            .fields(&format!("spec.nodeName={}", s.node));
        wait_until("the DaemonSet pod on the fake node", 60, || {
            let pods = pods.clone();
            let lp = agent_on_node.clone();
            async move { pods.list(&lp).await.unwrap().items.len() == 1 }
        })
        .await;

        create_bound_pod(&s.client, &s.ns, &s.node, "lonely").await;
        create_bound_pod(&s.client, &s.ns, &s.node, "guarded").await;
        let pdb: PodDisruptionBudget = serde_json::from_value(json!({
            "metadata": { "name": "guarded", "namespace": s.ns },
            "spec": { "minAvailable": 1, "selector": { "matchLabels": { "app": "guarded" } } }
        }))
        .unwrap();
        let pdbs: Api<PodDisruptionBudget> = Api::namespaced(s.client.clone(), &s.ns);
        pdbs.create(&PostParams::default(), &pdb).await.unwrap();
        // The budget must actually forbid the eviction: one healthy pod, none may go.
        wait_until("the budget to protect the pod", 60, || {
            let pdbs = pdbs.clone();
            async move {
                let pdb = pdbs.get("guarded").await.unwrap();
                let generation = pdb.metadata.generation;
                pdb.status.is_some_and(|st| {
                    st.observed_generation == generation
                        && st.expected_pods == Some(1)
                        && st.current_healthy == Some(1)
                        && st.desired_healthy == Some(1)
                        && st.disruptions_allowed == Some(0)
                })
            }
        })
        .await;

        let started = Instant::now();
        let err = resources::drain(&s.mgr, &s.id, &s.node).await.unwrap_err();
        // The refusal (HTTP 429) is reported at once, not retried for minutes.
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "drain took {:?}",
            started.elapsed()
        );
        assert!(err.message.contains("guarded"), "names the pod: {err}");
        assert!(
            err.message.contains("disruption budget"),
            "gives the server's reason: {err}"
        );
        assert!(!err.message.contains("lonely"), "{err}");
        assert!(unschedulable(&s.client, &s.node).await, "drain cordons");
        assert!(being_deleted(&pods, "lonely").await, "lonely pod evicted");
        assert!(!being_deleted(&pods, "guarded").await, "budget respected");
        let agents = pods.list(&agent_on_node).await.unwrap().items;
        assert_eq!(agents.len(), 1);
        assert!(
            agents[0].metadata.deletion_timestamp.is_none(),
            "DaemonSet pod left alone"
        );
    })
    .await;
}

// ---------- R09i.6: CronJob ----------

#[tokio::test]
async fn trigger_creates_a_job_and_suspend_sets_the_flag() {
    in_scratch("cronjob", |s| async move {
        let text = format!(
            "\
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly
  namespace: {ns}
spec:
  schedule: '0 3 1 1 *'
  jobTemplate:
    metadata:
      labels: {{ app: nightly }}
    spec:
      template:
        spec:
          restartPolicy: Never
          terminationGracePeriodSeconds: 1
          containers:
            - name: run
              image: {BUSYBOX_IMAGE}
              command: ['true']
",
            ns = s.ns
        );
        resources::apply_yaml(&s.mgr, &s.id, &text).await.unwrap();
        let r = object(kind("batch", "v1", "CronJob"), Some(&s.ns), "nightly");

        let job_ref = resources::trigger_cronjob(&s.mgr, &s.id, &r).await.unwrap();
        assert_eq!(job_ref.kind, kind("batch", "v1", "Job"));
        assert_eq!(job_ref.namespace.as_deref(), Some(s.ns.as_str()));
        let suffix = job_ref
            .name
            .strip_prefix("nightly-manual-")
            .unwrap_or_else(|| panic!("named <cronjob>-manual-<ts>: {}", job_ref.name));
        assert!(suffix.chars().all(|c| c.is_ascii_digit()), "{suffix}");
        let job = Api::<Job>::namespaced(s.client.clone(), &s.ns)
            .get(&job_ref.name)
            .await
            .unwrap();
        let owner = &job.metadata.owner_references.unwrap()[0];
        assert_eq!(
            (owner.kind.as_str(), owner.name.as_str()),
            ("CronJob", "nightly")
        );
        assert_eq!(job.metadata.labels.unwrap()["app"], "nightly");

        let cronjobs: Api<CronJob> = Api::namespaced(s.client.clone(), &s.ns);
        resources::suspend_cronjob(&s.mgr, &s.id, &r, true)
            .await
            .unwrap();
        assert_eq!(
            cronjobs.get("nightly").await.unwrap().spec.suspend,
            Some(true)
        );
        resources::suspend_cronjob(&s.mgr, &s.id, &r, false)
            .await
            .unwrap();
        assert_eq!(
            cronjobs.get("nightly").await.unwrap().spec.suspend,
            Some(false)
        );
    })
    .await;
}
