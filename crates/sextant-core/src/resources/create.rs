//! Creating one new object (#152): a POST, so an object of the same name that already exists — also one that appears
//! between a check and the request — is never touched: the API server answers `AlreadyExists` (409, `conflict`)
//! atomically. Used by the storage actions (a VolumeSnapshot, a restored claim, a Velero Backup or Restore) after the
//! window's confirmation; never by agents or extensions. Sent once (the client repeats only reads).

use kube::api::DynamicObject;
use serde_json::Value;

use super::ObjectRef;
use super::get::resolve_document_kind;
use super::mutate::{Document, post_params};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// Creates the one object of `yaml`; its ref as created. An object with the hidden-values marker (a Secret loaded
/// without its values) is `invalid` before any request, as for an apply; so is a text that is not exactly one object.
pub async fn create_yaml(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    yaml: &str,
) -> CoreResult<ObjectRef> {
    let value: Value = serde_yaml::from_str(yaml)?;
    let doc = Document::from_value(value)?;
    if doc
        .value()
        .pointer("/metadata/resourceVersion")
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty())
    {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a new object has no metadata.resourceVersion",
        ));
    }
    let client = mgr.client(cluster)?;
    let kind = resolve_document_kind(mgr, cluster, doc.kind_ref()).await?;
    let namespace = kind.namespaced.then(|| {
        doc.namespace()
            .unwrap_or(client.default_namespace())
            .to_owned()
    });
    let api = kind.api(client.clone(), namespace.as_deref());
    let obj: DynamicObject = serde_json::from_value(doc.value().clone())?;
    let created = api.create(&post_params(), &obj).await?;
    Ok(ObjectRef {
        kind: doc.kind_ref().clone(),
        namespace,
        name: created
            .metadata
            .name
            .unwrap_or_else(|| doc.name().to_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    const CONFIG_MAP: &str =
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n  namespace: ns\ndata:\n  k: v\n";

    async fn server(exists: bool) -> FakeApi {
        FakeApi::start(move |req: &Request| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("POST", "/api/v1/namespaces/ns/configmaps") if exists => Reply::json(
                409,
                r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"AlreadyExists","code":409,"message":"configmaps \"a\" already exists"}"#,
            ),
            ("POST", "/api/v1/namespaces/ns/configmaps") => Reply::json(
                201,
                r#"{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"a","namespace":"ns","uid":"u","resourceVersion":"1"}}"#,
            ),
            _ => Reply::not_found(),
        })
        .await
    }

    #[tokio::test]
    async fn a_new_object_is_posted_once() {
        let api = server(false).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let created = create_yaml(&mgr, &id, CONFIG_MAP).await.unwrap();
        assert_eq!(
            (created.namespace.as_deref(), created.name.as_str()),
            (Some("ns"), "a")
        );
        let sent: Vec<String> = api
            .requests()
            .iter()
            .filter(|r| r.method != "GET")
            .map(Request::line)
            .collect();
        assert_eq!(sent, ["POST /api/v1/namespaces/ns/configmaps"]);
        assert!(
            api.requests()
                .iter()
                .any(|r| r.query.contains("fieldManager=sextant"))
        );
    }

    #[tokio::test]
    async fn an_object_that_exists_is_a_conflict_and_is_not_touched() {
        let api = server(true).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let err = create_yaml(&mgr, &id, CONFIG_MAP).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
        let sent: Vec<String> = api
            .requests()
            .iter()
            .filter(|r| r.method != "GET")
            .map(Request::line)
            .collect();
        assert_eq!(sent, ["POST /api/v1/namespaces/ns/configmaps"]);
    }

    #[tokio::test]
    async fn hidden_values_or_a_resource_version_send_nothing() {
        let api = server(false).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let hidden = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: ns\n  annotations:\n    sextant.dev/values-hidden: \"true\"\n";
        assert_eq!(
            create_yaml(&mgr, &id, hidden).await.unwrap_err().code,
            ErrorCode::Invalid
        );
        let versioned = CONFIG_MAP.replace(
            "  namespace: ns\n",
            "  namespace: ns\n  resourceVersion: \"5\"\n",
        );
        assert_eq!(
            create_yaml(&mgr, &id, &versioned).await.unwrap_err().code,
            ErrorCode::Invalid
        );
        assert!(api.requests().iter().all(|r| r.method == "GET"));
    }
}
