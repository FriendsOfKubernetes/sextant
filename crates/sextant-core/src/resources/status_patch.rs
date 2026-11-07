//! A patch of the `status` subresource, for the custom kinds whose tools change their objects there (Argo Rollouts'
//! `kubectl argo rollouts promote|abort|retry` set `status.pauseConditions`, `status.currentStepIndex`,
//! `status.promoteFull` and `status.abort` through it, ADR-0097): only for an extension, only of the custom kinds the
//! user granted it (`statusPatches`, ADR-0155). Neither the window nor the MCP server offers it.

use serde_json::Value;

use super::get::to_json;
use super::mutate::{object_api, patch_body, patch_params};
use super::{ObjectRef, PatchType};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// Patches the `status` subresource of a custom resource (an API group with a dot that is not Kubernetes' own), for an
/// extension granted that kind (ADR-0155); anything else is `invalid` before a request is sent. Sent once.
pub async fn patch_custom_status(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    patch: &Value,
    patch_type: PatchType,
) -> CoreResult<Value> {
    let group = r.kind.group.to_ascii_lowercase();
    let custom = group.contains('.')
        && group != "k8s.io"
        && !group.ends_with(".k8s.io")
        && !group.ends_with(".kubernetes.io");
    if !custom {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "the status of {} cannot be patched: not a custom resource",
                r.kind.kind
            ),
        ));
    }
    if !super::serves_status(mgr, cluster, &r.kind).await? {
        return Err(no_status(r));
    }
    send_status_patch(mgr, cluster, r, patch, patch_type).await
}

/// The answer for a kind whose CRD declares no status subresource (Argo Rollouts v0.9): `notFound`, as the API server
/// would answer, but before anything is sent or anyone is asked (#374).
pub fn no_status(r: &ObjectRef) -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        format!(
            "{} has no status subresource in this cluster: patch the object instead",
            r.kind.kind
        ),
    )
}

async fn send_status_patch(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    patch: &Value,
    patch_type: PatchType,
) -> CoreResult<Value> {
    let body = patch_body(patch, patch_type)?;
    let (api, kind) = object_api(mgr, cluster, r).await?;
    let saved = api.patch_status(&r.name, &patch_params(), &body).await?;
    to_json(saved, &kind.resource)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};
    use crate::resources::KindRef;
    use serde_json::json;

    const ROLLOUT: &str = r#"{"apiVersion":"argoproj.io/v1alpha1","kind":"Rollout","metadata":{"name":"web","namespace":"shop","uid":"u","resourceVersion":"2"},"status":{"abort":true}}"#;

    fn argo(req: &Request) -> Reply {
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(
                200,
                r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
            ),
            ("GET", "/api/v1") => Reply::json(
                200,
                r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[]}"#,
            ),
            ("GET", "/apis") => Reply::json(
                200,
                r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[
                {"name":"argoproj.io","versions":[{"groupVersion":"argoproj.io/v1alpha1","version":"v1alpha1"}],
                 "preferredVersion":{"groupVersion":"argoproj.io/v1alpha1","version":"v1alpha1"}}]}"#,
            ),
            ("GET", "/apis/argoproj.io/v1alpha1") => Reply::json(
                200,
                r#"{"kind":"APIResourceList","groupVersion":"argoproj.io/v1alpha1","resources":[
                {"name":"rollouts","singularName":"rollout","namespaced":true,"kind":"Rollout","verbs":["get","list","watch","patch"]},
                {"name":"rollouts/status","singularName":"","namespaced":true,"kind":"Rollout","verbs":["get","patch","update"]},
                {"name":"workflows","singularName":"workflow","namespaced":true,"kind":"Workflow","verbs":["get","list","watch","patch"]}]}"#,
            ),
            ("PATCH", "/apis/argoproj.io/v1alpha1/namespaces/shop/rollouts/web/status") => {
                Reply::json(200, ROLLOUT)
            }
            _ => Reply::not_found(),
        }
    }

    fn reference(kind: &str, name: &str) -> ObjectRef {
        ObjectRef {
            kind: KindRef {
                group: "argoproj.io".into(),
                version: "v1alpha1".into(),
                kind: kind.into(),
            },
            namespace: Some("shop".into()),
            name: name.into(),
        }
    }

    #[tokio::test]
    async fn a_rollout_status_patch_goes_to_the_status_subresource_once() {
        let api = FakeApi::start(argo).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let patch = json!({ "status": { "abort": true } });
        let saved = patch_custom_status(
            &mgr,
            &id,
            &reference("Rollout", "web"),
            &patch,
            PatchType::Merge,
        )
        .await
        .unwrap();
        assert_eq!(saved["status"]["abort"], true);
        let requests = api.requests();
        let sent: Vec<&Request> = requests.iter().filter(|r| r.method != "GET").collect();
        let lines: Vec<String> = sent.iter().map(|r| r.line()).collect();
        assert_eq!(
            lines,
            ["PATCH /apis/argoproj.io/v1alpha1/namespaces/shop/rollouts/web/status"]
        );
        assert!(
            sent[0].query.contains("fieldManager=sextant"),
            "{}",
            sent[0].query
        );
    }

    #[tokio::test]
    async fn a_built_in_kind_or_a_hidden_values_marker_sends_nothing() {
        let api = FakeApi::start(argo).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let patch = json!({ "status": { "phase": "Succeeded" } });
        let pod = ObjectRef {
            kind: KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: "Pod".into(),
            },
            namespace: Some("shop".into()),
            name: "p".into(),
        };
        let err = patch_custom_status(&mgr, &id, &pod, &patch, PatchType::Merge)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        let hidden =
            json!({ "metadata": { "annotations": { "sextant.dev/values-hidden": "true" } } });
        let err = patch_custom_status(
            &mgr,
            &id,
            &reference("Rollout", "web"),
            &hidden,
            PatchType::Merge,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(api.requests().iter().all(|r| r.method == "GET"));
    }

    #[tokio::test]
    async fn a_kind_without_a_status_subresource_is_refused_before_sending() {
        let api = FakeApi::start(argo).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let patch = json!({ "status": { "phase": "Running" } });
        let err = patch_custom_status(
            &mgr,
            &id,
            &reference("Workflow", "w"),
            &patch,
            PatchType::Merge,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(
            err.message.contains("no status subresource"),
            "{}",
            err.message
        );
        assert!(api.requests().iter().all(|r| r.method == "GET"));
        assert!(serves_status_of(&mgr, &id, "Rollout").await);
    }

    async fn serves_status_of(mgr: &ClusterManager, id: &ClusterId, kind: &str) -> bool {
        crate::resources::serves_status(mgr, id, &reference(kind, "x").kind)
            .await
            .unwrap()
    }
}
