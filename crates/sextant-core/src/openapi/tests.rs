use serde_json::json;

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;

fn index() -> String {
    json!({ "paths": {
        "api/v1": { "serverRelativeURL": "/openapi/v3/api/v1?hash=AAA" },
        "apis/apps/v1": { "serverRelativeURL": "/openapi/v3/apis/apps/v1?hash=BBB" },
        "apis/example.com/v1": { "serverRelativeURL": "https://elsewhere.example/steal" },
    }})
    .to_string()
}

fn gvk(group: &str, kind: &str) -> Value {
    json!([{ "group": group, "version": "v1", "kind": kind }])
}

/// apps/v1 with references: Deployment → DeploymentSpec → PodTemplateSpec, ObjectMeta, IntOrString, a recursive
/// definition, and one nothing refers to.
fn apps_document() -> String {
    let long = "x".repeat(DESCRIPTION_LIMIT + 100);
    json!({ "openapi": "3.0.0", "paths": { "/apis/apps/v1/deployments": {} }, "components": { "schemas": {
        "io.k8s.api.apps.v1.Deployment": {
            "description": "Deployment enables declarative updates.",
            "type": "object",
            "x-kubernetes-group-version-kind": gvk("apps", "Deployment"),
            "properties": {
                "apiVersion": { "type": "string" },
                "kind": { "type": "string" },
                "metadata": { "description": "Standard object's metadata.", "default": {},
                              "allOf": [{ "$ref": "#/components/schemas/io.k8s.meta.ObjectMeta" }] },
                "spec": { "allOf": [{ "$ref": "#/components/schemas/io.k8s.api.apps.v1.DeploymentSpec" }] },
            },
        },
        "io.k8s.api.apps.v1.StatefulSet": {
            "type": "object",
            "x-kubernetes-group-version-kind": gvk("apps", "StatefulSet"),
            "properties": { "metadata": { "allOf": [{ "$ref": "#/components/schemas/io.k8s.meta.ObjectMeta" }] } },
        },
        "io.k8s.api.apps.v1.DeploymentSpec": {
            "type": "object",
            "required": ["selector", "template"],
            "properties": {
                "replicas": { "type": "integer", "format": "int32", "default": 1 },
                "maxSurge": { "$ref": "#/components/schemas/io.k8s.intstr.IntOrString" },
                "strategy": { "type": "string", "enum": ["Recreate", "RollingUpdate"], "description": long },
                "selector": { "$ref": "#/components/schemas/io.k8s.meta.LabelSelector" },
                "template": { "$ref": "#/components/schemas/io.k8s.api.apps.v1.Tree" },
            },
        },
        "io.k8s.api.apps.v1.Tree": {
            "type": "object",
            "properties": { "children": { "type": "array",
                "items": { "$ref": "#/components/schemas/io.k8s.api.apps.v1.Tree" } } },
        },
        "io.k8s.meta.ObjectMeta": {
            "description": "ObjectMeta is metadata.",
            "type": "object",
            "properties": { "name": { "type": "string" },
                            "labels": { "type": "object", "additionalProperties": { "type": "string" } } },
        },
        "io.k8s.meta.LabelSelector": { "type": "object", "x-kubernetes-map-type": "atomic" },
        "io.k8s.intstr.IntOrString": { "format": "int-or-string",
                                       "oneOf": [{ "type": "integer" }, { "type": "string" }] },
        "io.k8s.Unrelated": { "type": "object", "properties": { "a": { "type": "string" } } },
    }}})
    .to_string()
}

/// A CRD's group/version: an inline schema with preserve-unknown fields, int-or-string, and nesting deeper than
/// [`MAX_DEPTH`].
fn crd_document() -> String {
    let mut deep = json!({ "type": "string" });
    for _ in 0..(MAX_DEPTH + 5) {
        deep = json!({ "type": "object", "properties": { "next": deep } });
    }
    json!({ "components": { "schemas": {
        "com.example.v1.Widget": {
            "type": "object",
            "x-kubernetes-group-version-kind": gvk("example.com", "Widget"),
            "properties": {
                "metadata": { "allOf": [{ "$ref": "#/components/schemas/io.k8s.meta.ObjectMeta" }] },
                "spec": { "type": "object", "required": ["size"], "properties": {
                    "size": { "anyOf": [{ "type": "integer" }, { "type": "string" }],
                              "x-kubernetes-int-or-string": true },
                    "config": { "type": "object", "x-kubernetes-preserve-unknown-fields": true },
                    "deep": deep,
                }},
            },
        },
        "io.k8s.meta.ObjectMeta": { "type": "object", "properties": { "name": { "type": "string" } } },
    }}})
    .to_string()
}

fn answer(req: &Request) -> Reply {
    match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/openapi/v3" => Reply::json(200, index()),
        "/openapi/v3/apis/apps/v1" if req.query == "hash=BBB" => Reply::json(200, apps_document()),
        "/openapi/v3/apis/example.com/v1" => Reply::json(200, crd_document()),
        _ => Reply::not_found(),
    }
}

#[tokio::test]
async fn a_kind_comes_with_the_definitions_it_reaches_and_nothing_else() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let schema = kind_schema(&mgr, &id, "apps", "v1", "Deployment")
        .await
        .unwrap()
        .unwrap();
    let root = &schema.root;
    assert_eq!(root.types, Some(vec!["object".to_owned()]));
    let props = root.properties.as_ref().unwrap();
    // A property that names its type through `allOf` keeps its own description and default.
    let metadata = &props["metadata"];
    assert_eq!(
        metadata.reference.as_deref(),
        Some("io.k8s.meta.ObjectMeta")
    );
    assert_eq!(
        metadata.description.as_deref(),
        Some("Standard object's metadata.")
    );
    assert_eq!(metadata.default, Some(json!({})));
    let names: Vec<&str> = schema.definitions.keys().map(String::as_str).collect();
    assert_eq!(
        names,
        [
            "io.k8s.api.apps.v1.DeploymentSpec",
            "io.k8s.api.apps.v1.Tree",
            "io.k8s.intstr.IntOrString",
            "io.k8s.meta.LabelSelector",
            "io.k8s.meta.ObjectMeta",
        ]
    );
    let spec = &schema.definitions["io.k8s.api.apps.v1.DeploymentSpec"];
    assert_eq!(
        spec.required,
        Some(vec!["selector".to_owned(), "template".to_owned()])
    );
    let spec_props = spec.properties.as_ref().unwrap();
    assert_eq!(spec_props["replicas"].default, Some(json!(1)));
    assert_eq!(
        spec_props["strategy"].enum_values,
        Some(vec![json!("Recreate"), json!("RollingUpdate")])
    );
    let clipped = spec_props["strategy"].description.as_deref().unwrap();
    assert!(
        clipped.len() <= DESCRIPTION_LIMIT && clipped.ends_with('…'),
        "{}",
        clipped.len()
    );
    let int_or_string = &schema.definitions["io.k8s.intstr.IntOrString"];
    assert_eq!(
        int_or_string.types,
        Some(vec!["integer".to_owned(), "string".to_owned()])
    );
    // The recursive definition is sent once, as a reference to itself.
    let tree = &schema.definitions["io.k8s.api.apps.v1.Tree"];
    let children = &tree.properties.as_ref().unwrap()["children"];
    assert_eq!(
        children.items.as_ref().unwrap().reference.as_deref(),
        Some("io.k8s.api.apps.v1.Tree")
    );
    let labels = &schema.definitions["io.k8s.meta.ObjectMeta"]
        .properties
        .as_ref()
        .unwrap()["labels"];
    assert_eq!(
        labels.additional_properties.as_ref().unwrap().types,
        Some(vec!["string".to_owned()])
    );
    // The JSON the window gets says `ref` and `enum`, and nothing about the document's paths.
    let sent = serde_json::to_string(&schema).unwrap();
    assert!(sent.contains(r#""ref":"io.k8s.meta.ObjectMeta""#), "{sent}");
    assert!(
        !sent.contains("deployments") && !sent.contains("Unrelated"),
        "{sent}"
    );
}

#[tokio::test]
async fn a_group_version_is_fetched_once_and_again_after_a_refresh() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    assert!(
        kind_schema(&mgr, &id, "apps", "v1", "Deployment")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        kind_schema(&mgr, &id, "apps", "v1", "StatefulSet")
            .await
            .unwrap()
            .is_some()
    );
    // A kind the document does not define is no schema, not an error.
    assert!(
        kind_schema(&mgr, &id, "apps", "v1", "DaemonSet")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(api.count("/openapi/v3"), 1);
    assert_eq!(api.count("/openapi/v3/apis/apps/v1"), 1);
    assert_eq!(mgr.openapi().kept(&id), ["apis/apps/v1"]);
    mgr.refresh_kinds(&id);
    assert!(mgr.openapi().kept(&id).is_empty());
    assert!(
        kind_schema(&mgr, &id, "apps", "v1", "Deployment")
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(api.count("/openapi/v3"), 2);
    assert_eq!(api.count("/openapi/v3/apis/apps/v1"), 2);
}

#[tokio::test]
async fn a_group_version_missing_from_the_index_is_not_fetched() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    assert!(
        kind_schema(&mgr, &id, "batch", "v1", "Job")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(api.count("/openapi/v3/apis/batch/v1"), 0);
    // A URL in the index that leads anywhere but the document itself is not followed.
    assert!(
        kind_schema(&mgr, &id, "example.com", "v1", "Widget")
            .await
            .unwrap()
            .is_some()
    );
    let paths: Vec<String> = api.requests().iter().map(|r| r.path.clone()).collect();
    assert!(
        paths.contains(&"/openapi/v3/apis/example.com/v1".to_owned()),
        "{paths:?}"
    );
}

#[tokio::test]
async fn a_crd_schema_keeps_preserve_unknown_fields_int_or_string_and_cuts_deep_nesting() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let schema = kind_schema(&mgr, &id, "example.com", "v1", "Widget")
        .await
        .unwrap()
        .unwrap();
    let spec = &schema.root.properties.as_ref().unwrap()["spec"];
    let props = spec.properties.as_ref().unwrap();
    assert_eq!(spec.required, Some(vec!["size".to_owned()]));
    assert_eq!(
        props["size"].types,
        Some(vec!["integer".to_owned(), "string".to_owned()])
    );
    assert_eq!(props["config"].preserve_unknown, Some(true));
    let mut node = &props["deep"];
    let mut depth = 0;
    while let Some(next) = node.properties.as_ref().and_then(|p| p.get("next")) {
        node = next;
        depth += 1;
    }
    assert_eq!(node.truncated, Some(true));
    assert!(depth < MAX_DEPTH + 5, "{depth}");
    assert_eq!(
        schema.definitions.keys().collect::<Vec<_>>(),
        ["io.k8s.meta.ObjectMeta"]
    );
}

#[tokio::test]
async fn a_cluster_without_openapi_v3_has_no_schema() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    assert!(
        kind_schema(&mgr, &id, "", "v1", "Pod")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn an_oversized_answer_is_refused() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/openapi/v3" => Reply::json(
            200,
            format!(
                r#"{{"paths":{{}},"pad":"{}"}}"#,
                "x".repeat(MAX_INDEX_BYTES)
            ),
        ),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let err = kind_schema(&mgr, &id, "", "v1", "Pod").await.unwrap_err();
    assert!(err.message.contains("larger than 1 MiB"), "{err:?}");
    // Nothing was kept: the next call asks again.
    let _ = kind_schema(&mgr, &id, "", "v1", "Pod").await;
    assert_eq!(api.count("/openapi/v3"), 2);
}

#[tokio::test]
async fn a_request_that_does_not_answer_times_out() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        _ => Reply::hang(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    tokio::time::pause();
    let err = kind_schema(&mgr, &id, "", "v1", "Pod").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout, "{err:?}");
}

#[tokio::test]
async fn names_are_checked_before_the_cluster_is_asked() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    for (group, version, kind) in [
        ("apps/../x", "v1", "Pod"),
        ("apps", "v1?x=1", "Pod"),
        ("apps", "v1", ""),
        ("apps", "v1", "Pod/x"),
    ] {
        let err = kind_schema(&mgr, &id, group, version, kind)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{group} {version} {kind}");
    }
    assert_eq!(api.count("/openapi/v3"), 0);
    let other = ClusterId::from("nope".to_owned());
    let err = kind_schema(&mgr, &other, "", "v1", "Pod")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[test]
fn clipping_keeps_whole_characters() {
    let text = "ж".repeat(10);
    let clipped = compact::clip(&text, 8);
    assert!(clipped.len() <= 8 && clipped.ends_with('…'), "{clipped}");
    assert_eq!(compact::clip("short", 8), "short");
}

#[test]
fn every_kind_of_a_real_core_document_reduces_quickly_and_small() {
    // A trimmed copy of a real `api/v1` shape: Pod → PodSpec → Container (shared by three lists).
    let doc = json!({ "components": { "schemas": {
        "io.k8s.api.core.v1.Pod": { "type": "object", "x-kubernetes-group-version-kind": gvk("", "Pod"),
            "properties": { "spec": { "allOf": [{ "$ref": "#/components/schemas/io.k8s.api.core.v1.PodSpec" }] } } },
        "io.k8s.api.core.v1.PodSpec": { "type": "object", "properties": {
            "containers": { "type": "array", "items": { "$ref": "#/components/schemas/io.k8s.api.core.v1.Container" } },
            "initContainers": { "type": "array", "items": { "$ref": "#/components/schemas/io.k8s.api.core.v1.Container" } },
        }},
        "io.k8s.api.core.v1.Container": { "type": "object", "required": ["name"],
            "properties": { "name": { "type": "string" } } },
    }}});
    let schemas = GroupVersionSchemas::from_document(&doc);
    assert_eq!(schemas.len(), 3);
    let pod = schemas.kind("", "v1", "Pod").unwrap();
    // Container is sent once although two lists use it.
    assert_eq!(pod.definitions.len(), 2);
}

#[test]
fn older_clusters_int_or_string_and_quantity_accept_numbers() {
    // Before about 1.27 both are a plain `type: string`; the format (or only the name) says more.
    let doc = json!({ "paths": { "/api/v1/pods": { "get": {} } }, "components": { "schemas": {
        "io.k8s.api.core.v1.Pod": { "type": "object", "x-kubernetes-group-version-kind": gvk("", "Pod"),
            "properties": {
                "port": { "allOf": [{ "$ref": "#/components/schemas/io.k8s.apimachinery.pkg.util.intstr.IntOrString" }] },
                "cpu": { "$ref": "#/components/schemas/io.k8s.apimachinery.pkg.api.resource.Quantity" },
                "size": { "type": "string", "format": "quantity" },
                "surge": { "type": "string", "format": "int-or-string" },
                "raw": { "type": "object", "x-kubernetes-embedded-resource": true,
                         "properties": { "spec": { "type": "object" } } },
                "extra": { "type": "object", "additionalProperties": true },
            } },
        "io.k8s.apimachinery.pkg.util.intstr.IntOrString": { "type": "string", "format": "int-or-string" },
        "io.k8s.apimachinery.pkg.api.resource.Quantity": { "type": "string" },
    }}});
    let bytes = serde_json::to_vec(&doc).unwrap();
    let schemas = GroupVersionSchemas::from_slice(&bytes).unwrap();
    let pod = schemas.kind("", "v1", "Pod").unwrap();
    let types = |name: &str| pod.definitions[name].types.clone().unwrap();
    assert_eq!(
        types("io.k8s.apimachinery.pkg.util.intstr.IntOrString"),
        ["integer", "string"]
    );
    assert_eq!(
        types("io.k8s.apimachinery.pkg.api.resource.Quantity"),
        ["string", "number"]
    );
    let props = pod.root.properties.as_ref().unwrap();
    assert_eq!(
        props["size"].types,
        Some(vec!["string".to_owned(), "number".to_owned()])
    );
    assert_eq!(
        props["surge"].types,
        Some(vec!["integer".to_owned(), "string".to_owned()])
    );
    // An embedded object's apiVersion, kind and metadata are never unknown fields.
    assert_eq!(props["raw"].preserve_unknown, Some(true));
    assert_eq!(
        props["extra"].additional_properties.as_deref(),
        Some(&SchemaNode::default())
    );
}

#[test]
fn reading_the_bytes_gives_what_reading_the_parsed_document_gives() {
    let text = apps_document();
    let parsed: Value = serde_json::from_str(&text).unwrap();
    let whole = GroupVersionSchemas::from_document(&parsed);
    let streamed = GroupVersionSchemas::from_slice(text.as_bytes()).unwrap();
    assert_eq!(streamed.len(), whole.len());
    for kind in ["Deployment", "StatefulSet"] {
        assert_eq!(
            streamed.kind("apps", "v1", kind),
            whole.kind("apps", "v1", kind),
            "{kind}"
        );
    }
    assert!(GroupVersionSchemas::from_slice(b"{\"components\": {\"schemas\": [1]}}").is_err());
    assert!(GroupVersionSchemas::from_slice(b"{\"components\": {").is_err());
    assert!(GroupVersionSchemas::from_slice(b"{}").unwrap().is_empty());
}

#[test]
fn forgetting_one_cluster_keeps_what_another_cluster_is_fetching() {
    let cache = SchemaCache::default();
    let a = ClusterId::from("a".to_owned());
    let b = ClusterId::from("b".to_owned());
    let started_a = cache.with(&a, 1, |_, generation| generation);
    let started_b = cache.with(&b, 1, |_, generation| generation);
    cache.forget(&b);
    let schemas = Arc::new(GroupVersionSchemas::default());
    cache.store(&a, 1, started_a, |e| {
        e.keep("apis/apps/v1".to_owned(), Arc::clone(&schemas))
    });
    cache.store(&b, 1, started_b, |e| {
        e.keep("apis/apps/v1".to_owned(), Arc::clone(&schemas))
    });
    assert_eq!(cache.kept(&a), ["apis/apps/v1"]);
    // B's fetch started before B was forgotten: it may predate a CRD change.
    assert!(cache.kept(&b).is_empty());
}
