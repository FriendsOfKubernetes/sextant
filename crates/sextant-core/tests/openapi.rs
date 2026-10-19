//! The YAML editor's schema against the test cluster (#151): `openapi::kind_schema` reads `/openapi/v3` and the
//! group/version documents, and sends one kind with the definitions it reaches, small enough for the window.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test openapi -- --test-threads=1
//! ```

mod common;

use std::time::Instant;

use sextant_core::openapi;

#[tokio::test]
async fn built_in_kinds_and_crds_have_a_compact_schema() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    for (group, version, kind, field) in [
        ("", "v1", "Pod", "spec"),
        ("apps", "v1", "Deployment", "spec"),
        (
            "apiextensions.k8s.io",
            "v1",
            "CustomResourceDefinition",
            "spec",
        ),
    ] {
        let started = Instant::now();
        let schema = openapi::kind_schema(&mgr, &id, group, version, kind)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("no schema for {kind}"));
        let fetched = started.elapsed();
        let props = schema.root.properties.as_ref().unwrap();
        assert!(props.contains_key(field), "{kind}: {:?}", props.keys());
        assert!(props.contains_key("metadata"), "{kind}");
        let sent = serde_json::to_string(&schema).unwrap().len();
        eprintln!(
            "{kind}: {} definitions, {sent} bytes, {fetched:?}",
            schema.definitions.len()
        );
        assert!(sent < 2 * 1024 * 1024, "{kind}: {sent} bytes");
        // The second ask is answered from the cache.
        let started = Instant::now();
        openapi::kind_schema(&mgr, &id, group, version, kind)
            .await
            .unwrap()
            .unwrap();
        assert!(
            started.elapsed().as_millis() < 500,
            "{kind}: {:?}",
            started.elapsed()
        );
    }
    let containers = openapi::kind_schema(&mgr, &id, "", "v1", "Pod")
        .await
        .unwrap()
        .unwrap()
        .definitions["io.k8s.api.core.v1.PodSpec"]
        .properties
        .clone()
        .unwrap()["containers"]
        .clone();
    assert_eq!(containers.types, Some(vec!["array".to_owned()]));
    assert!(
        openapi::kind_schema(&mgr, &id, "nope.example.com", "v1", "Thing")
            .await
            .unwrap()
            .is_none()
    );
}
