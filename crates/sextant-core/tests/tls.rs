//! Certificates of TLS Secrets against the test cluster: `tls::secret_certificates` parses a real Secret's `tls.crt`
//! without returning its key, `tls::expiry_scan` lists only `kubernetes.io/tls` Secrets, and a user without access to
//! Secrets gets `forbidden`.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test tls -- --test-threads=1
//! ```

mod common;

use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::{Namespace, Secret};
use kube::Api;
use kube::api::{DeleteParams, PostParams};
use serde_json::json;
use sextant_core::ErrorCode;
use sextant_core::tls;

const NS: &str = "sextant-tls";
const CHAIN: &str = include_str!("../src/tls/testdata/chain.pem");
const CA: &str = include_str!("../src/tls/testdata/ca.pem");
/// Not a real key: what the test looks for in every answer.
const KEY: &str =
    "-----BEGIN PRIVATE KEY-----\nU0VYVEFOVC1URVNULUtFWS1NQVJLRVI=\n-----END PRIVATE KEY-----\n";
const KEY_MARK: &str = "U0VYVEFOVC1URVNULUtFWS1NQVJLRVI";

#[tokio::test]
async fn a_real_tls_secret_is_parsed_scanned_and_refused_without_access() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(NS, &DeleteParams::background()).await;
    let deadline = Instant::now() + Duration::from_secs(180);
    while namespaces.get_opt(NS).await.unwrap().is_some() {
        assert!(
            Instant::now() < deadline,
            "the old namespace did not go away"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let ns: Namespace = serde_json::from_value(json!({ "metadata": { "name": NS } })).unwrap();
    namespaces
        .create(&PostParams::default(), &ns)
        .await
        .unwrap();
    let secrets: Api<Secret> = Api::namespaced(client.clone(), NS);
    for (name, kind, data) in [
        (
            "shop-tls",
            "kubernetes.io/tls",
            json!({ "tls.crt": CHAIN, "tls.key": KEY, "ca.crt": CA }),
        ),
        ("opaque", "Opaque", json!({ "tls.crt": CHAIN })),
    ] {
        let secret: Secret = serde_json::from_value(json!({
            "metadata": { "name": name, "namespace": NS },
            "type": kind,
            "stringData": data,
        }))
        .unwrap();
        secrets
            .create(&PostParams::default(), &secret)
            .await
            .unwrap();
    }

    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let info = tls::secret_certificates(&mgr, &id, NS, "shop-tls")
        .await
        .unwrap();
    assert_eq!(
        info.chain[0].common_name.as_deref(),
        Some("shop.example.test")
    );
    assert_eq!(info.chain.len(), 2);
    assert_eq!(info.ca.len(), 1);
    let json = serde_json::to_string(&info).unwrap();
    assert!(!json.contains(KEY_MARK), "{json}");

    // Any Secret with a tls.crt has a certificate; the scan lists only TLS Secrets.
    assert!(
        tls::secret_certificates(&mgr, &id, NS, "opaque")
            .await
            .is_ok()
    );
    let scan = tls::expiry_scan(&mgr, &id, Some(&[NS.to_owned()]))
        .await
        .unwrap();
    let names: Vec<&str> = scan.items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["shop-tls"]);
    assert_eq!(
        scan.items[0].not_after.as_deref(),
        Some("2035-06-01T00:00:00Z")
    );

    let (_tmp2, limited, limited_id) = common::connected(&cluster.limited_kubeconfig).await;
    let err = tls::secret_certificates(&limited, &limited_id, NS, "shop-tls")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    let scan = tls::expiry_scan(&limited, &limited_id, Some(&[NS.to_owned()]))
        .await
        .unwrap();
    assert!(scan.items.is_empty());
    assert_eq!(scan.forbidden, [NS]);

    let _ = namespaces.delete(NS, &DeleteParams::background()).await;
}
