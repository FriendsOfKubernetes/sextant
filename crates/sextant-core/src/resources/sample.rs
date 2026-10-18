//! Whether a namespace holds objects of given kinds, for the "Cleanup" page (#147): per kind, a metadata-only list of
//! at most `limit` objects in the namespace (`limit=` on the request, so the cluster sends no more), answering only the
//! names and, for a Secret, the ServiceAccount a token belongs to. Nothing else of an object leaves the core — no
//! labels, no other annotations, never a value. One call checks many kinds, `PARALLEL` at a time, each request
//! under [`STEP_TIMEOUT`](super::STEP_TIMEOUT); a kind that cannot be read carries its error instead of failing the
//! call, so the page can treat it as unknown.

use futures::{StreamExt, stream};
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::KindRef;
use super::get::resolve_kind;
use super::mutate::STEP_TIMEOUT;
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::kubeconfig::ClusterId;

/// Kinds one call may check.
pub const MAX_SAMPLED_KINDS: usize = 300;
/// Objects asked for per kind, at most.
pub const MAX_SAMPLE: u32 = 5;
/// Requests in flight at once.
const PARALLEL: usize = 8;
/// The annotation naming the ServiceAccount of a token Secret.
const SA_NAME_ANNOTATION: &str = "kubernetes.io/service-account.name";

/// One object found: its name, and the ServiceAccount of a service account token Secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SampledObject {
    pub name: String,
    pub service_account: Option<String>,
}

/// What the namespace holds of one kind: up to `limit` objects, `more` when it holds more; `error` when the kind
/// could not be listed there (no permission, not served, a timeout).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KindSample {
    pub kind: KindRef,
    pub objects: Vec<SampledObject>,
    pub more: bool,
    pub error: Option<CoreError>,
}

fn is_dns_label(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 63
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !text.starts_with('-')
        && !text.ends_with('-')
}

/// Checks the input before anything is sent.
fn validate(namespace: &str, kinds: &[KindRef], limit: u32) -> CoreResult<()> {
    if !is_dns_label(namespace) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("{namespace:?} is not a namespace name"),
        ));
    }
    if kinds.len() > MAX_SAMPLED_KINDS {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "at most {MAX_SAMPLED_KINDS} kinds can be checked at once, not {}",
                kinds.len()
            ),
        ));
    }
    if limit == 0 || limit > MAX_SAMPLE {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("the limit must be between 1 and {MAX_SAMPLE}"),
        ));
    }
    Ok(())
}

async fn sample_kind(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
    kind: &KindRef,
    limit: u32,
) -> CoreResult<(Vec<SampledObject>, bool)> {
    let client = mgr.client(cluster)?;
    let resolved = resolve_kind(mgr, cluster, kind).await?;
    if !resolved.namespaced {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("{} is not a namespaced kind", kind.kind),
        ));
    }
    let api = resolved.api(client, Some(namespace));
    let params = ListParams {
        limit: Some(limit),
        ..ListParams::default()
    };
    let page = api.list_metadata(&params).await?;
    let more = page
        .metadata
        .continue_
        .as_deref()
        .is_some_and(|token| !token.is_empty())
        || page.items.len() > limit as usize;
    let objects = page
        .items
        .into_iter()
        .take(limit as usize)
        .map(|item| SampledObject {
            name: item.metadata.name.unwrap_or_default(),
            service_account: (kind.group.is_empty() && kind.kind == "Secret")
                .then(|| {
                    item.metadata
                        .annotations
                        .as_ref()
                        .and_then(|a| a.get(SA_NAME_ANNOTATION).cloned())
                })
                .flatten(),
        })
        .collect();
    Ok((objects, more))
}

/// What `namespace` holds of each of `kinds` (in their order): at most `limit` (1–[`MAX_SAMPLE`]) objects per kind.
pub async fn sample_namespace(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
    kinds: &[KindRef],
    limit: u32,
) -> CoreResult<Vec<KindSample>> {
    validate(namespace, kinds, limit)?;
    mgr.client(cluster)?;
    let samples = stream::iter(kinds.iter().cloned())
        .map(|kind| async move {
            let result = with_timeout(
                STEP_TIMEOUT,
                "the list",
                sample_kind(mgr, cluster, namespace, &kind, limit),
            )
            .await;
            match result {
                Ok((objects, more)) => KindSample {
                    kind,
                    objects,
                    more,
                    error: None,
                },
                Err(error) => KindSample {
                    kind,
                    objects: Vec::new(),
                    more: false,
                    error: Some(error),
                },
            }
        })
        .buffered(PARALLEL)
        .collect()
        .await;
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    const CORE: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[
        {"name":"configmaps","singularName":"configmap","namespaced":true,"kind":"ConfigMap","verbs":["list"]},
        {"name":"secrets","singularName":"secret","namespaced":true,"kind":"Secret","verbs":["list"]},
        {"name":"nodes","singularName":"node","namespaced":false,"kind":"Node","verbs":["list"]}]}"#;
    const GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[
        {"name":"argoproj.io","versions":[{"groupVersion":"argoproj.io/v1alpha1","version":"v1alpha1"}],
         "preferredVersion":{"groupVersion":"argoproj.io/v1alpha1","version":"v1alpha1"}}]}"#;
    const ARGO: &str = r#"{"kind":"APIResourceList","groupVersion":"argoproj.io/v1alpha1","resources":[
        {"name":"applications","singularName":"application","namespaced":true,"kind":"Application","verbs":["list"]}]}"#;

    fn answer(req: &Request) -> Reply {
        match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1" => Reply::json(200, CORE),
            "/apis" => Reply::json(200, GROUPS),
            "/apis/argoproj.io/v1alpha1" => Reply::json(200, ARGO),
            "/api/v1/namespaces/team/configmaps" => Reply::json(
                200,
                r#"{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadataList","metadata":{"continue":"next"},
                   "items":[{"metadata":{"name":"kube-root-ca.crt"}},{"metadata":{"name":"app"}}]}"#,
            ),
            "/api/v1/namespaces/team/secrets" => Reply::json(
                200,
                r#"{"apiVersion":"meta.k8s.io/v1","kind":"PartialObjectMetadataList","metadata":{},
                   "items":[{"metadata":{"name":"default-token-x","annotations":{
                     "kubernetes.io/service-account.name":"default",
                     "kubectl.kubernetes.io/last-applied-configuration":"{\"data\":{\"k\":\"c2VjcmV0\"}}"}}}]}"#,
            ),
            "/apis/argoproj.io/v1alpha1/namespaces/team/applications" => Reply::json(
                403,
                r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}"#,
            ),
            _ => Reply::not_found(),
        }
    }

    fn kind(group: &str, version: &str, kind: &str) -> KindRef {
        KindRef {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
        }
    }

    #[tokio::test]
    async fn a_namespace_is_sampled_by_metadata_with_limits_and_per_kind_errors() {
        let api = FakeApi::start(answer).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let kinds = [
            kind("", "v1", "ConfigMap"),
            kind("", "v1", "Secret"),
            kind("argoproj.io", "v1alpha1", "Application"),
            kind("", "v1", "Node"),
        ];
        let samples = sample_namespace(&mgr, &id, "team", &kinds, 2)
            .await
            .unwrap();
        assert_eq!(samples.len(), 4);
        assert_eq!(
            samples[0]
                .objects
                .iter()
                .map(|o| o.name.as_str())
                .collect::<Vec<_>>(),
            ["kube-root-ca.crt", "app"]
        );
        assert!(samples[0].more);
        assert_eq!(
            samples[1].objects[0].service_account.as_deref(),
            Some("default")
        );
        // Only the name and the ServiceAccount come back: no other annotation of a Secret.
        let text = serde_json::to_string(&samples[1]).unwrap();
        assert!(
            !text.contains("c2VjcmV0") && !text.contains("last-applied"),
            "{text}"
        );
        assert_eq!(
            samples[2].error.as_ref().map(|e| e.code),
            Some(ErrorCode::Forbidden)
        );
        assert_eq!(
            samples[3].error.as_ref().map(|e| e.code),
            Some(ErrorCode::Invalid)
        );
        let lists: Vec<Request> = api
            .requests()
            .into_iter()
            .filter(|r| r.path.ends_with("/configmaps"))
            .collect();
        assert!(lists[0].query.contains("limit=2"), "{}", lists[0].query);
        assert!(
            lists[0]
                .header("accept")
                .contains("PartialObjectMetadataList"),
            "{}",
            lists[0].head
        );
    }

    #[tokio::test]
    async fn bad_input_is_refused_before_any_request() {
        let api = FakeApi::start(answer).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let before = api.requests().len();
        for (ns, limit) in [
            ("Not A Namespace", 1),
            ("team", 0),
            ("team", MAX_SAMPLE + 1),
        ] {
            let err = sample_namespace(&mgr, &id, ns, &[kind("", "v1", "ConfigMap")], limit)
                .await
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        }
        let many = vec![kind("", "v1", "ConfigMap"); MAX_SAMPLED_KINDS + 1];
        let err = sample_namespace(&mgr, &id, "team", &many, 1)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        assert_eq!(api.requests().len(), before);
    }
}
