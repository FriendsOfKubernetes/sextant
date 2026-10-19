use base64::Engine as _;
use serde_json::{Value, json};

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};
use crate::resources::KindRef;

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
const CORE: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[
    {"name":"configmaps","singularName":"configmap","namespaced":true,"kind":"ConfigMap","verbs":["get","list"]},
    {"name":"secrets","singularName":"secret","namespaced":true,"kind":"Secret","verbs":["get","list"]},
    {"name":"services","singularName":"service","namespaced":true,"kind":"Service","verbs":["get","list"]},
    {"name":"nodes","singularName":"node","namespaced":false,"kind":"Node","verbs":["get","list"]}]}"#;
const GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#;

/// Values that must never appear in what the core returns.
const VALUES: [&str; 4] = [
    "s3cr3t-one",
    "s3cr3t-two",
    "s3cr3t-three",
    "s3cr3t-lastapplied",
];

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text)
}

fn secret(ns: &str, name: &str, data: &[(&str, &str)], last_applied: Option<&Value>) -> Value {
    let data: serde_json::Map<String, Value> = data
        .iter()
        .map(|(k, v)| ((*k).to_owned(), json!(b64(v))))
        .collect();
    let mut meta = json!({ "name": name, "namespace": ns, "uid": format!("uid-{name}") });
    if let Some(doc) = last_applied {
        meta["annotations"] = json!({
            "kubectl.kubernetes.io/last-applied-configuration": doc.to_string()
        });
    }
    json!({ "apiVersion": "v1", "kind": "Secret", "metadata": meta, "type": "Opaque", "data": data })
}

fn release_secret(manifest: &str) -> Value {
    let release = json!({
        "name": "web", "namespace": "team", "version": 3,
        "info": { "status": "deployed" }, "chart": { "metadata": { "name": "web" } },
        "manifest": manifest
    });
    let data = b64(&release.to_string());
    json!({
        "apiVersion": "v1", "kind": "Secret", "type": "helm.sh/release.v1",
        "metadata": { "name": "sh.helm.release.v1.web.v3", "namespace": "team",
                      "labels": { "owner": "helm", "name": "web", "version": "3" } },
        "data": { "release": b64(&data) }
    })
}

const MANIFEST: &str = "---
# Source: web/templates/config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
data:
  mode: blue
---
apiVersion: v1
kind: Secret
metadata:
  name: web-secret
stringData:
  password: s3cr3t-one
  token: s3cr3t-two
---
apiVersion: v1
kind: Service
metadata:
  name: web-gone
spec:
  ports: [{ port: 80 }]
---
: not yaml : [
---
apiVersion: v1
kind: ConfigMap
metadata: {}
";

fn list(items: Vec<Value>) -> String {
    json!({ "apiVersion": "v1", "kind": "List", "metadata": {}, "items": items }).to_string()
}

fn answer(req: &Request) -> Reply {
    let applied = json!({ "apiVersion": "v1", "kind": "Secret", "data": { "password": b64("s3cr3t-lastapplied") } });
    let app_a = secret(
        "team",
        "app",
        &[("password", "s3cr3t-one"), ("token", "s3cr3t-two")],
        Some(&applied),
    );
    let app_b = secret(
        "prod",
        "app",
        &[
            ("password", "s3cr3t-one"),
            ("token", "s3cr3t-three"),
            ("extra", "x"),
        ],
        None,
    );
    match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1" => Reply::json(200, CORE),
        "/apis" => Reply::json(200, GROUPS),
        "/api/v1/namespaces/team/secrets/app" => Reply::json(200, app_a.to_string()),
        "/api/v1/namespaces/prod/secrets/app" => Reply::json(200, app_b.to_string()),
        "/api/v1/namespaces/team/secrets" if req.query.contains("labelSelector") => {
            Reply::json(200, list(vec![release_secret(MANIFEST)]))
        }
        "/api/v1/namespaces/team/secrets" => Reply::json(
            200,
            list(vec![
                app_a,
                secret("team", "only-team", &[("k", "s3cr3t-one")], None),
            ]),
        ),
        "/api/v1/namespaces/prod/secrets" => Reply::json(200, list(vec![app_b])),
        "/api/v1/namespaces/team/configmaps/web-config" => Reply::json(
            200,
            json!({ "apiVersion": "v1", "kind": "ConfigMap",
                    "metadata": { "name": "web-config", "namespace": "team", "uid": "c1" },
                    "data": { "mode": "green" } })
            .to_string(),
        ),
        "/api/v1/namespaces/team/secrets/web-secret" => Reply::json(
            200,
            secret(
                "team",
                "web-secret",
                &[("password", "s3cr3t-one"), ("token", "s3cr3t-three")],
                None,
            )
            .to_string(),
        ),
        "/api/v1/namespaces/team/configmaps" => Reply::json(
            200,
            list(vec![json!({ "apiVersion": "v1", "kind": "ConfigMap",
                              "metadata": { "name": "a", "namespace": "team" },
                              "data": { "k": "v" }, "status": { "x": 1 } })]),
        ),
        "/api/v1/namespaces/team/services" => Reply::json(
            403,
            r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}"#,
        ),
        _ => Reply::not_found(),
    }
}

fn side(cluster: &ClusterId, ns: &str, name: &str, last_applied: bool) -> SecretSide {
    SecretSide {
        cluster_id: cluster.clone(),
        namespace: ns.into(),
        name: name.into(),
        last_applied,
    }
}

fn key(key: &str, on_left: bool, on_right: bool, equal: bool) -> SecretKeyComparison {
    SecretKeyComparison {
        key: key.into(),
        on_left,
        on_right,
        equal,
    }
}

fn assert_no_values(output: &impl serde::Serialize) {
    let text = serde_json::to_string(output).unwrap();
    for value in VALUES {
        assert!(!text.contains(value), "{value} leaked: {text}");
        assert!(
            !text.contains(&b64(value)),
            "{value} leaked as base64: {text}"
        );
    }
}

#[tokio::test]
async fn two_secrets_are_compared_by_key_and_hash_without_any_value_in_the_output() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let result = compare_secrets(
        &mgr,
        &side(&id, "team", "app", false),
        &side(&id, "prod", "app", false),
    )
    .await
    .unwrap();
    assert_eq!(result.left, SecretSideState::Found);
    assert_eq!(result.right, SecretSideState::Found);
    assert_eq!(
        result.keys,
        [
            key("extra", false, true, false),
            key("password", true, true, true),
            key("token", true, true, false),
        ]
    );
    assert_no_values(&result);
}

#[tokio::test]
async fn a_missing_secret_and_the_last_applied_side_are_reported() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let missing = compare_secrets(
        &mgr,
        &side(&id, "team", "app", false),
        &side(&id, "team", "nope", false),
    )
    .await
    .unwrap();
    assert_eq!(missing.right, SecretSideState::Missing);
    assert!(
        missing
            .keys
            .iter()
            .all(|k| k.on_left && !k.on_right && !k.equal)
    );

    let applied = compare_secrets(
        &mgr,
        &side(&id, "team", "app", true),
        &side(&id, "team", "app", false),
    )
    .await
    .unwrap();
    assert_eq!(applied.left, SecretSideState::Found);
    assert_eq!(
        applied.keys,
        [
            key("password", true, true, false),
            key("token", false, true, false)
        ]
    );
    assert_no_values(&applied);

    let none = compare_secrets(
        &mgr,
        &side(&id, "prod", "app", true),
        &side(&id, "prod", "app", false),
    )
    .await
    .unwrap();
    assert_eq!(none.left, SecretSideState::NoLastApplied);
}

#[tokio::test]
async fn secret_input_is_checked_and_a_cluster_is_never_connected_implicitly() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let err = compare_secrets(
        &mgr,
        &side(&id, "Bad NS", "app", false),
        &side(&id, "team", "app", false),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, crate::ErrorCode::Invalid);
    let other = ClusterId::from("not-connected".to_owned());
    let before = api.requests().len();
    let err = compare_secrets(
        &mgr,
        &side(&id, "team", "app", false),
        &side(&other, "team", "app", false),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, crate::ErrorCode::NotFound, "{err:?}");
    assert_eq!(
        api.requests().len(),
        before,
        "nothing is read when a side is not connected"
    );
}

#[tokio::test]
async fn secrets_of_two_namespaces_are_compared_by_name() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let ns = |namespace: &str| NamespaceSide {
        cluster_id: id.clone(),
        namespace: namespace.into(),
    };
    let result = compare_secret_namespaces(&mgr, &ns("team"), &ns("prod"))
        .await
        .unwrap();
    assert!(!result.truncated);
    assert_eq!(result.secrets.len(), 1);
    assert_eq!(result.secrets[0].name, "app");
    assert_eq!(result.secrets[0].keys.iter().filter(|k| k.equal).count(), 1);
    assert_no_values(&result);
}

#[tokio::test]
async fn a_namespace_is_listed_per_kind_without_status_and_with_errors_per_kind() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let kind = |k: &str| KindRef {
        group: String::new(),
        version: "v1".into(),
        kind: k.into(),
    };
    let lists = list_namespace(
        &mgr,
        &id,
        "team",
        &[kind("ConfigMap"), kind("Service"), kind("Node")],
        10,
    )
    .await
    .unwrap();
    assert_eq!(lists.len(), 3);
    assert_eq!(lists[0].objects.len(), 1);
    assert!(lists[0].objects[0].get("status").is_none());
    assert_eq!(lists[0].objects[0]["data"]["k"], "v");
    assert_eq!(
        lists[1].error.as_ref().unwrap().code,
        crate::ErrorCode::Forbidden
    );
    assert_eq!(
        lists[2].error.as_ref().unwrap().code,
        crate::ErrorCode::Invalid
    );
    let err = list_namespace(
        &mgr,
        &id,
        "team",
        &[kind("ConfigMap")],
        MAX_COMPARE_LIMIT + 1,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, crate::ErrorCode::Invalid);
}

#[test]
fn a_manifest_is_cut_into_objects_and_unreadable_documents_are_counted() {
    let mut unreadable = 0;
    let objects = drift::manifest_objects(MANIFEST, &mut unreadable);
    let names: Vec<_> = objects
        .iter()
        .map(|(k, _, n, _)| format!("{}/{n}", k.kind))
        .collect();
    assert_eq!(
        names,
        [
            "ConfigMap/web-config",
            "Secret/web-secret",
            "Service/web-gone"
        ]
    );
    assert_eq!(unreadable, 2);
}

#[tokio::test]
async fn helm_drift_puts_the_manifest_next_to_live_objects_and_secrets_by_hash_only() {
    let api = FakeApi::start(answer).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let drift = helm_drift(&mgr, &id, "team", "web").await.unwrap();
    assert_eq!(drift.revision, 3);
    assert_eq!(drift.unreadable, 2);
    assert_eq!(drift.objects.len(), 3);

    let config = &drift.objects[0];
    assert_eq!(config.object.namespace.as_deref(), Some("team"));
    assert_eq!(config.rendered["data"]["mode"], "blue");
    assert_eq!(config.live.as_ref().unwrap()["data"]["mode"], "green");

    let secret = &drift.objects[1];
    assert_eq!(
        secret.secret_keys.as_deref().unwrap(),
        [
            key("password", true, true, true),
            key("token", true, true, false)
        ]
    );
    assert_eq!(secret.rendered["stringData"]["password"], "");

    let gone = &drift.objects[2];
    assert!(gone.live.is_none() && gone.error.is_none());
    assert_no_values(&drift);
}
