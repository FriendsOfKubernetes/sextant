//! Upgrade readiness against the test cluster (#142): `upgrade::scan` reads the server version, which of the asked API
//! versions the cluster serves, the versions clients used on live objects (field managers), kubelet and control-plane
//! versions; a user who may not read Secrets still gets a scan, with the Helm source reported as failed.
//!
//! No API version the test cluster serves is deprecated, so the test asks for a served one (`v1` ConfigMap) the way the
//! page asks for deprecated ones.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test upgrade -- --test-threads=1
//! ```

mod common;

use k8s_openapi::api::core::v1::{ConfigMap, Namespace};
use kube::Api;
use kube::api::{DeleteParams, Patch, PatchParams};
use serde_json::json;
use sextant_core::KindRef;
use sextant_core::upgrade::{self, ScanApi, ScanSource, SourceOutcome, UsageOrigin};

const NS: &str = "sextant-upgrade";
const MANAGER: &str = "sextant-upgrade-test";

fn asked() -> Vec<ScanApi> {
    vec![ScanApi {
        api: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "ConfigMap".into(),
        },
        replacement: None,
    }]
}

#[tokio::test]
async fn a_real_cluster_is_scanned_without_writing() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let apply = PatchParams::apply(MANAGER).force();
    let namespaces: Api<Namespace> = Api::all(client.clone());
    namespaces
        .patch(
            NS,
            &apply,
            &Patch::Apply(
                json!({ "apiVersion": "v1", "kind": "Namespace", "metadata": { "name": NS } }),
            ),
        )
        .await
        .unwrap();
    let maps: Api<ConfigMap> = Api::namespaced(client.clone(), NS);
    maps.patch(
        "settings",
        &apply,
        &Patch::Apply(json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "settings" }, "data": { "a": "b" } })),
    )
    .await
    .unwrap();

    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let scan = upgrade::scan(&mgr, &id, asked()).await.unwrap();

    let version = scan.version.as_ref().expect("the server version");
    assert!(version.git_version.starts_with("v1."), "{version:?}");
    assert_eq!(scan.served, vec![asked()[0].api.clone()]);
    assert!(
        scan.usages
            .iter()
            .any(|u| u.namespace.as_deref() == Some(NS)
                && u.name == "settings"
                && u.origin
                    == UsageOrigin::ManagedFields {
                        manager: MANAGER.into()
                    }),
        "{:?}",
        scan.usages
    );
    assert!(!scan.nodes.is_empty());
    assert!(
        scan.nodes
            .iter()
            .all(|n| n.kubelet_version.starts_with("v1."))
    );
    assert!(
        scan.components
            .iter()
            .any(|c| c.component == "kube-apiserver" && c.version.starts_with("v1.")),
        "{:?}",
        scan.components
    );
    for source in &scan.sources {
        assert_ne!(source.outcome, SourceOutcome::Failed, "{source:?}");
    }

    // A user without access to Secrets: the Helm source fails, the scan does not.
    let (_tmp2, limited, limited_id) = common::connected(&cluster.limited_kubeconfig).await;
    let scan = upgrade::scan(&limited, &limited_id, asked()).await.unwrap();
    let helm = scan
        .sources
        .iter()
        .find(|s| s.source == ScanSource::Helm)
        .unwrap();
    assert_eq!(helm.outcome, SourceOutcome::Failed, "{helm:?}");

    let _ = namespaces.delete(NS, &DeleteParams::background()).await;
}
