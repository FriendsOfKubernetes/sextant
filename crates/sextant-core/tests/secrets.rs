//! Secret values stay in the backend until asked for: the watch and `resources::get` send Secrets without their
//! values, `resources::secret_value` reads one key, `resources::get_full` reads the whole object for editing, and a
//! Secret saved with its values hidden is refused.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test secrets -- --test-threads=1
//! ```
//!
//! Every test works in its own namespace `sextant-secrets-<test>` (created fresh, deleted at the end, also when the
//! test fails). The values are made up for the test.

mod common;

use std::future::Future;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use futures::{FutureExt, StreamExt};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Secret};
use kube::api::{DeleteParams, PostParams};
use kube::{Api, Client};
use serde_json::{Value, json};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::resources::{self, KindRef, ObjectRef, WatchSpec, WatchUpdate};
use sextant_core::{ClusterId, ClusterManager, ErrorCode, KubeconfigRegistry};
use std::panic::AssertUnwindSafe;

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";
const HIDDEN_MARKER: &str = "sextant.dev/values-hidden";
/// "made-up-token" in base64.
const TOKEN_B64: &str = "bWFkZS11cC10b2tlbg==";
/// Three bytes that are not UTF-8 (0xff 0xfe 0x00) in base64.
const BINARY_B64: &str = "//4A";

struct Scratch {
    mgr: ClusterManager,
    id: ClusterId,
    client: Client,
    ns: String,
    _tmp: tempfile::TempDir,
}

/// Runs `body` in a fresh namespace `sextant-secrets-<test>` with Secret `creds` and ConfigMap `settings`, both
/// carrying a last-applied annotation; cleans up whether `body` passes or panics.
async fn in_scratch<F, Fut>(test: &str, body: F)
where
    F: FnOnce(Scratch) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let ns = format!("sextant-secrets-{test}");
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(&ns, &DeleteParams::background()).await;
    let deadline = Instant::now() + Duration::from_secs(180);
    while namespaces.get_opt(&ns).await.unwrap().is_some() {
        assert!(
            Instant::now() < deadline,
            "the old namespace {ns} did not go away"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": ns } })).unwrap();
    namespaces
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();

    let secret: Secret = serde_json::from_value(json!({
        "metadata": {
            "name": "creds",
            "namespace": ns,
            "annotations": { LAST_APPLIED: "{\"data\":{\"token\":\"bWFkZS11cC10b2tlbg==\"}}", "team": "web" }
        },
        "type": "Opaque",
        "data": { "token": TOKEN_B64, "blob": BINARY_B64 }
    }))
    .unwrap();
    Api::<Secret>::namespaced(client.clone(), &ns)
        .create(&PostParams::default(), &secret)
        .await
        .unwrap();
    let config_map: ConfigMap = serde_json::from_value(json!({
        "metadata": {
            "name": "settings",
            "namespace": ns,
            "annotations": { LAST_APPLIED: "{\"data\":{\"mode\":\"fast\"}}" }
        },
        "data": { "mode": "fast" }
    }))
    .unwrap();
    Api::<ConfigMap>::namespaced(client.clone(), &ns)
        .create(&PostParams::default(), &config_map)
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

fn core_kind(kind: &str) -> KindRef {
    KindRef {
        group: String::new(),
        version: "v1".into(),
        kind: kind.into(),
    }
}

fn object(kind: &str, ns: &str, name: &str) -> ObjectRef {
    ObjectRef {
        kind: core_kind(kind),
        namespace: Some(ns.to_owned()),
        name: name.to_owned(),
    }
}

/// The first snapshot of a watch on `kind` in `ns`.
async fn watched(s: &Scratch, kind: &str) -> Vec<Arc<Value>> {
    let spec = WatchSpec {
        kind: core_kind(kind),
        namespaces: Some(vec![s.ns.clone()]),
        label_selector: None,
        field_selector: None,
        metadata_only: false,
    };
    let mut updates = Box::pin(
        resources::watch(&s.mgr, &s.id, spec)
            .await
            .expect("watch starts"),
    );
    let first = tokio::time::timeout(Duration::from_secs(30), updates.next())
        .await
        .expect("a watch update in 30s")
        .expect("the watch stream ended");
    match first {
        WatchUpdate::Snapshot { items } => items,
        other => panic!("expected a snapshot, got {other:?}"),
    }
}

/// A Secret as the frontend gets it: every key, no value, no last-applied copy, the marker set.
fn assert_values_hidden(secret: &Value) {
    let data = secret["data"].as_object().expect("data keeps its keys");
    let mut keys: Vec<&str> = data.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["blob", "token"]);
    assert!(
        data.values().all(|v| v == ""),
        "values must be empty: {data:?}"
    );
    let annotations = secret["metadata"]["annotations"]
        .as_object()
        .expect("annotations");
    assert!(
        !annotations.contains_key(LAST_APPLIED),
        "last-applied must be removed"
    );
    assert_eq!(annotations[HIDDEN_MARKER], "true");
    assert_eq!(annotations["team"], "web", "other annotations stay");
    assert!(
        !secret.to_string().contains(TOKEN_B64),
        "no copy of the value anywhere"
    );
}

#[tokio::test]
async fn watch_and_get_send_secrets_without_values_and_config_maps_whole() {
    in_scratch("hidden", |s| async move {
        let secrets = watched(&s, "Secret").await;
        let creds = secrets
            .iter()
            .find(|o| o["metadata"]["name"] == "creds")
            .expect("creds in the snapshot");
        assert_values_hidden(creds);

        let got = resources::get(&s.mgr, &s.id, &object("Secret", &s.ns, "creds"))
            .await
            .unwrap();
        assert_values_hidden(&got);

        let maps = watched(&s, "ConfigMap").await;
        let settings = maps
            .iter()
            .find(|o| o["metadata"]["name"] == "settings")
            .expect("settings in the snapshot");
        let got = resources::get(&s.mgr, &s.id, &object("ConfigMap", &s.ns, "settings"))
            .await
            .unwrap();
        for cm in [settings, &got] {
            assert_eq!(cm["data"]["mode"], "fast");
            let annotations = cm["metadata"]["annotations"].as_object().unwrap();
            assert!(annotations.contains_key(LAST_APPLIED));
            assert!(!annotations.contains_key(HIDDEN_MARKER));
        }
    })
    .await;
}

#[tokio::test]
async fn secret_value_decodes_one_key_and_refuses_binary() {
    in_scratch("value", |s| async move {
        let value = resources::secret_value(&s.mgr, &s.id, &s.ns, "creds", "token")
            .await
            .unwrap();
        assert_eq!(value, "made-up-token");

        let err = resources::secret_value(&s.mgr, &s.id, &s.ns, "creds", "blob")
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(err.message.contains("binary value, 3 bytes"), "{err:?}");

        let err = resources::secret_value(&s.mgr, &s.id, &s.ns, "creds", "missing")
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    })
    .await;
}

#[tokio::test]
async fn get_full_reads_the_secret_with_its_values() {
    in_scratch("full", |s| async move {
        let full = resources::get_full(&s.mgr, &s.id, &object("Secret", &s.ns, "creds"))
            .await
            .unwrap();
        assert_eq!(full["data"]["token"], TOKEN_B64);
        assert_eq!(full["data"]["blob"], BINARY_B64);
        let annotations = full["metadata"]["annotations"].as_object().unwrap();
        assert!(annotations.contains_key(LAST_APPLIED));
        assert!(!annotations.contains_key(HIDDEN_MARKER));
        assert!(full["metadata"].get("managedFields").is_none());
    })
    .await;
}

#[tokio::test]
async fn saving_a_secret_with_hidden_values_is_refused_and_changes_nothing() {
    in_scratch("save", |s| async move {
        let hidden = resources::get(&s.mgr, &s.id, &object("Secret", &s.ns, "creds"))
            .await
            .unwrap();
        let yaml = serde_yaml::to_string(&hidden).unwrap();
        let err = resources::replace_yaml(&s.mgr, &s.id, &yaml)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(err.message.contains("reload"), "{err:?}");
        let err = resources::apply_yaml(&s.mgr, &s.id, &yaml)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);

        let live = Api::<Secret>::namespaced(s.client.clone(), &s.ns)
            .get("creds")
            .await
            .unwrap();
        assert_eq!(live.data.unwrap()["token"].0, b"made-up-token");

        // The whole object saves as usual.
        let full = resources::get_full(&s.mgr, &s.id, &object("Secret", &s.ns, "creds"))
            .await
            .unwrap();
        let saved = resources::replace_yaml(&s.mgr, &s.id, &serde_yaml::to_string(&full).unwrap())
            .await
            .unwrap();
        assert_values_hidden(&saved);
    })
    .await;
}
