//! Reading one object, and the helpers every resource function shares: finding the API of a kind through
//! discovery and turning a `DynamicObject` into the JSON the frontend gets.

use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use kube::api::{ApiResource, DynamicObject};
use serde_json::{Map, Value};

use super::{KindRef, ObjectRef, WatchObject};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// Annotation set on every Secret the frontend gets without its values; text carrying it is never saved back.
pub const VALUES_HIDDEN_ANNOTATION: &str = "sextant.dev/values-hidden";
/// `kubectl apply` keeps the whole last applied manifest here — for a Secret, its values.
const LAST_APPLIED_ANNOTATION: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// Reads one object; a namespaced kind without a namespace is `invalid`. `managedFields` are stripped, `apiVersion`
/// and `kind` are always set. A Secret comes without its values (see `to_json`).
pub async fn get(mgr: &ClusterManager, cluster: &ClusterId, r: &ObjectRef) -> CoreResult<Value> {
    let (obj, kind) = fetch(mgr, cluster, r).await?;
    to_json(obj, &kind.resource)
}

/// Like `get`, but a Secret keeps its values and its last-applied annotation: only for editing a Secret.
pub async fn get_full(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
) -> CoreResult<Value> {
    let (obj, kind) = fetch(mgr, cluster, r).await?;
    to_json_full(obj, &kind.resource)
}

async fn fetch(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
) -> CoreResult<(DynamicObject, ResolvedKind)> {
    let client = mgr.client(cluster)?;
    let kind = resolve_kind(mgr, cluster, &r.kind).await?;
    if kind.namespaced {
        r.required_namespace()?;
    }
    let api = kind.api(client, r.namespace.as_deref());
    let obj = api.get(&r.name).await?;
    Ok((obj, kind))
}

/// The value of one key of a Secret, decoded from base64 as UTF-8 text. A missing key is `notFound`; a value that
/// is not UTF-8 is `invalid` and names only its size.
pub async fn secret_value(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
    name: &str,
    key: &str,
) -> CoreResult<String> {
    if namespace.is_empty() {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a Secret is namespaced: the namespace is required",
        ));
    }
    let client = mgr.client(cluster)?;
    let secret = Api::<Secret>::namespaced(client, namespace)
        .get(name)
        .await?;
    let Some(bytes) = secret.data.and_then(|mut data| data.remove(key)) else {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            format!("secret {namespace}/{name} has no key {key}"),
        ));
    };
    String::from_utf8(bytes.0).map_err(|err| {
        CoreError::new(
            ErrorCode::Invalid,
            format!("binary value, {} bytes", err.as_bytes().len()),
        )
    })
}

/// Refuses an object that was sent to the frontend without its values (it carries `VALUES_HIDDEN_ANNOTATION`):
/// saving it would replace every value with an empty string.
pub(crate) fn ensure_values_present(value: &Value) -> CoreResult<()> {
    let hidden = value
        .pointer("/metadata/annotations")
        .and_then(Value::as_object)
        .is_some_and(|annotations| annotations.contains_key(VALUES_HIDDEN_ANNOTATION));
    if hidden {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "the secret was loaded without its values: reload the secret before saving",
        ));
    }
    Ok(())
}

/// A kind the cluster serves, ready for `kube::Api`.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedKind {
    pub resource: ApiResource,
    pub namespaced: bool,
}

impl ResolvedKind {
    /// The API for objects of this kind in `namespace`; all namespaces when `None` or when the kind is
    /// cluster-scoped.
    pub fn api(&self, client: kube::Client, namespace: Option<&str>) -> Api<DynamicObject> {
        match namespace {
            Some(ns) if self.namespaced => Api::namespaced_with(client, ns, &self.resource),
            _ => Api::all_with(client, &self.resource),
        }
    }
}

/// Kinds every Kubernetes API server serves, as (group, kind, plural, namespaced): they are used without waiting
/// for discovery, so the first table of a fresh connection does not wait for it.
const BUILT_IN_KINDS: &[(&str, &str, &str, bool)] = &[
    ("", "Binding", "bindings", true),
    ("", "ConfigMap", "configmaps", true),
    ("", "Endpoints", "endpoints", true),
    ("", "Event", "events", true),
    ("", "LimitRange", "limitranges", true),
    ("", "Namespace", "namespaces", false),
    ("", "Node", "nodes", false),
    ("", "PersistentVolume", "persistentvolumes", false),
    ("", "PersistentVolumeClaim", "persistentvolumeclaims", true),
    ("", "Pod", "pods", true),
    ("", "PodTemplate", "podtemplates", true),
    ("", "ReplicationController", "replicationcontrollers", true),
    ("", "ResourceQuota", "resourcequotas", true),
    ("", "Secret", "secrets", true),
    ("", "Service", "services", true),
    ("", "ServiceAccount", "serviceaccounts", true),
    (
        "admissionregistration.k8s.io",
        "MutatingWebhookConfiguration",
        "mutatingwebhookconfigurations",
        false,
    ),
    (
        "admissionregistration.k8s.io",
        "ValidatingWebhookConfiguration",
        "validatingwebhookconfigurations",
        false,
    ),
    (
        "apiextensions.k8s.io",
        "CustomResourceDefinition",
        "customresourcedefinitions",
        false,
    ),
    ("apiregistration.k8s.io", "APIService", "apiservices", false),
    ("apps", "ControllerRevision", "controllerrevisions", true),
    ("apps", "DaemonSet", "daemonsets", true),
    ("apps", "Deployment", "deployments", true),
    ("apps", "ReplicaSet", "replicasets", true),
    ("apps", "StatefulSet", "statefulsets", true),
    (
        "autoscaling",
        "HorizontalPodAutoscaler",
        "horizontalpodautoscalers",
        true,
    ),
    ("batch", "CronJob", "cronjobs", true),
    ("batch", "Job", "jobs", true),
    (
        "certificates.k8s.io",
        "CertificateSigningRequest",
        "certificatesigningrequests",
        false,
    ),
    ("coordination.k8s.io", "Lease", "leases", true),
    ("discovery.k8s.io", "EndpointSlice", "endpointslices", true),
    ("events.k8s.io", "Event", "events", true),
    ("networking.k8s.io", "Ingress", "ingresses", true),
    ("networking.k8s.io", "IngressClass", "ingressclasses", false),
    (
        "networking.k8s.io",
        "NetworkPolicy",
        "networkpolicies",
        true,
    ),
    ("node.k8s.io", "RuntimeClass", "runtimeclasses", false),
    (
        "policy",
        "PodDisruptionBudget",
        "poddisruptionbudgets",
        true,
    ),
    (
        "rbac.authorization.k8s.io",
        "ClusterRole",
        "clusterroles",
        false,
    ),
    (
        "rbac.authorization.k8s.io",
        "ClusterRoleBinding",
        "clusterrolebindings",
        false,
    ),
    ("rbac.authorization.k8s.io", "Role", "roles", true),
    (
        "rbac.authorization.k8s.io",
        "RoleBinding",
        "rolebindings",
        true,
    ),
    (
        "scheduling.k8s.io",
        "PriorityClass",
        "priorityclasses",
        false,
    ),
    ("storage.k8s.io", "CSIDriver", "csidrivers", false),
    ("storage.k8s.io", "CSINode", "csinodes", false),
    ("storage.k8s.io", "StorageClass", "storageclasses", false),
    (
        "storage.k8s.io",
        "VolumeAttachment",
        "volumeattachments",
        false,
    ),
];

/// Whether the kind is one of `BUILT_IN_KINDS` (answered without discovery).
pub(crate) fn is_built_in(group: &str, kind: &str) -> bool {
    BUILT_IN_KINDS
        .iter()
        .any(|(g, k, _, _)| *g == group && *k == kind)
}

/// Finds the API of `kind`: a built-in kind directly, any other through the cluster's discovery (cached by
/// `ClusterManager::kinds`, shared by callers that ask at the same time). The version asked for is used when
/// discovery lists the kind in it; otherwise the version discovery lists (the one the cluster prefers among those
/// serving the kind) — a frontend that registered `v1` still reads a cluster serving only `v1beta2`. An unknown kind
/// is `notFound`.
pub(crate) async fn resolve_kind(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    kind: &KindRef,
) -> CoreResult<ResolvedKind> {
    let resolved = |version: &str, plural: String, namespaced: bool| ResolvedKind {
        resource: ApiResource {
            group: kind.group.clone(),
            version: version.to_owned(),
            api_version: if kind.group.is_empty() {
                version.to_owned()
            } else {
                format!("{}/{}", kind.group, version)
            },
            kind: kind.kind.clone(),
            plural,
        },
        namespaced,
    };
    if let Some((_, _, plural, namespaced)) = BUILT_IN_KINDS
        .iter()
        .find(|(group, name, _, _)| *group == kind.group && *name == kind.kind)
    {
        return Ok(resolved(&kind.version, (*plural).to_owned(), *namespaced));
    }

    let kinds = mgr.kinds(cluster).await?;
    let same_kind = |k: &&crate::resources::ResourceKind| {
        k.kind_ref.group == kind.group && k.kind_ref.kind == kind.kind
    };
    let found = kinds
        .iter()
        .filter(same_kind)
        .find(|k| k.kind_ref.version == kind.version)
        .or_else(|| kinds.iter().find(same_kind))
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("the cluster does not serve {}", describe(kind)),
            )
        })?;
    Ok(resolved(
        &found.kind_ref.version,
        found.plural.clone(),
        found.namespaced,
    ))
}

/// Finds the API of the kind a YAML document names, for `replace_yaml`/`apply_yaml`: the body carries the document's
/// `apiVersion`, so it goes to the URL of exactly that version. A version discovery lists is used as is; any other is
/// looked up in the group (`GET /apis/<group>/<version>`), because discovery keeps only one version of a kind — a
/// served version that is not the preferred one (`v2beta2` beside `v2`) works, a version the group does not serve is
/// `notFound`. Unlike [`resolve_kind`], the version of discovery is never put in its place.
pub(crate) async fn resolve_document_kind(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    kind: &KindRef,
) -> CoreResult<ResolvedKind> {
    let found = resolve_kind(mgr, cluster, kind).await?;
    if found.resource.version == kind.version {
        return Ok(found);
    }
    let client = mgr.client(cluster)?;
    let listed = if kind.group.is_empty() {
        client.list_core_api_resources(&kind.version).await
    } else {
        client
            .list_api_group_resources(&format!("{}/{}", kind.group, kind.version))
            .await
    };
    let not_served = || {
        CoreError::new(
            ErrorCode::NotFound,
            format!("the cluster does not serve {}", describe(kind)),
        )
    };
    let resources = match listed {
        Ok(list) => list.resources,
        Err(kube::Error::Api(status)) if status.is_not_found() => return Err(not_served()),
        Err(err) => return Err(err.into()),
    };
    let resource = resources
        .into_iter()
        .find(|r| r.kind == kind.kind && !r.name.contains('/'))
        .ok_or_else(not_served)?;
    Ok(ResolvedKind {
        resource: ApiResource {
            group: kind.group.clone(),
            version: kind.version.clone(),
            api_version: api_version_of(kind),
            kind: kind.kind.clone(),
            plural: resource.name,
        },
        namespaced: resource.namespaced,
    })
}

/// "apps/v1", "v1" (the core group).
fn api_version_of(kind: &KindRef) -> String {
    if kind.group.is_empty() {
        kind.version.clone()
    } else {
        format!("{}/{}", kind.group, kind.version)
    }
}

/// "Deployment (apps/v1)", "Pod (v1)".
fn describe(kind: &KindRef) -> String {
    if kind.group.is_empty() {
        format!("{} ({})", kind.kind, kind.version)
    } else {
        format!("{} ({}/{})", kind.kind, kind.group, kind.version)
    }
}

/// The object as JSON for the frontend: `apiVersion`/`kind` set (list items come without them),
/// `metadata.managedFields` removed. A core/v1 Secret also loses its values: every `data`/`stringData` value becomes
/// `""` (the keys stay), `last-applied-configuration` is removed and `VALUES_HIDDEN_ANNOTATION` is set.
pub(crate) fn to_json(obj: DynamicObject, resource: &ApiResource) -> CoreResult<Value> {
    let mut value = to_json_full(obj, resource)?;
    if resource.group.is_empty() && resource.kind == "Secret" {
        hide_secret_values(&mut value);
    }
    Ok(value)
}

/// What `to_json` gives, as the watch keeps it. Any kind but a core Secret is written straight from the object kube
/// read (no `Value` tree in between: the watch takes every listed object through here); a Secret goes through
/// `to_json`, which hides its values.
pub(crate) fn to_watch_object(
    mut obj: DynamicObject,
    resource: &ApiResource,
) -> CoreResult<WatchObject> {
    if resource.group.is_empty() && resource.kind == "Secret" {
        return Ok(WatchObject::new(&to_json(obj, resource)?)?);
    }
    obj.types = Some(kube::api::TypeMeta {
        api_version: resource.api_version.clone(),
        kind: resource.kind.clone(),
    });
    obj.metadata.managed_fields = None;
    Ok(WatchObject::new(&obj)?)
}

/// `to_json` without hiding anything of a Secret.
fn to_json_full(obj: DynamicObject, resource: &ApiResource) -> CoreResult<Value> {
    let mut value = serde_json::to_value(obj)?;
    if let Some(map) = value.as_object_mut() {
        map.insert(
            "apiVersion".into(),
            Value::String(resource.api_version.clone()),
        );
        map.insert("kind".into(), Value::String(resource.kind.clone()));
        if let Some(meta) = map.get_mut("metadata").and_then(Value::as_object_mut) {
            meta.remove("managedFields");
        }
    }
    Ok(value)
}

/// Hides the values of a core/v1 Secret as JSON (what `to_json` does to one): every `data`/`stringData` value becomes
/// `""`, `last-applied-configuration` is removed and `VALUES_HIDDEN_ANNOTATION` is set.
pub(crate) fn hide_secret_values(value: &mut Value) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    for field in ["data", "stringData"] {
        if let Some(values) = map.get_mut(field).and_then(Value::as_object_mut) {
            for v in values.values_mut() {
                *v = Value::String(String::new());
            }
        }
    }
    let meta = map
        .entry("metadata")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(meta) = meta.as_object_mut() {
        let annotations = meta
            .entry("annotations")
            .or_insert_with(|| Value::Object(Map::new()));
        if !annotations.is_object() {
            *annotations = Value::Object(Map::new());
        }
        if let Some(annotations) = annotations.as_object_mut() {
            annotations.remove(LAST_APPLIED_ANNOTATION);
            annotations.insert(
                VALUES_HIDDEN_ANNOTATION.into(),
                Value::String("true".into()),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_json_strips_managed_fields_and_sets_the_type() {
        let obj: DynamicObject = serde_json::from_value(serde_json::json!({
            "metadata": {
                "name": "web",
                "namespace": "default",
                "uid": "u1",
                "managedFields": [{ "manager": "kubectl" }]
            },
            "spec": { "replicas": 2 }
        }))
        .unwrap();
        let resource = ApiResource {
            group: "apps".into(),
            version: "v1".into(),
            api_version: "apps/v1".into(),
            kind: "Deployment".into(),
            plural: "deployments".into(),
        };
        let json = to_json(obj, &resource).unwrap();
        assert_eq!(json["apiVersion"], "apps/v1");
        assert_eq!(json["kind"], "Deployment");
        assert_eq!(json["spec"]["replicas"], 2);
        assert_eq!(json["metadata"]["name"], "web");
        assert!(json["metadata"].get("managedFields").is_none());
    }

    #[test]
    fn the_watch_keeps_the_same_json_as_to_json() {
        let resource = |group: &str, kind: &str| ApiResource {
            group: group.into(),
            version: "v1".into(),
            api_version: if group.is_empty() {
                "v1".into()
            } else {
                format!("{group}/v1")
            },
            kind: kind.into(),
            plural: format!("{}s", kind.to_lowercase()),
        };
        let cases = [
            (
                resource("apps", "Deployment"),
                serde_json::json!({
                    "apiVersion": "apps/v1beta1",
                    "metadata": {
                        "name": "web", "namespace": "default", "uid": "u1", "labels": { "app": "web" },
                        "managedFields": [{ "manager": "kubectl" }]
                    },
                    "spec": { "replicas": 2, "paused": false, "selector": null },
                    "status": { "ratio": 0.5 }
                }),
            ),
            (
                resource("", "Secret"),
                serde_json::json!({
                    "metadata": {
                        "name": "creds", "namespace": "default",
                        "annotations": { LAST_APPLIED_ANNOTATION: "{}" },
                        "managedFields": [{ "manager": "kubectl" }]
                    },
                    "type": "Opaque",
                    "data": { "token": "eA==" }
                }),
            ),
            (
                resource("", "Namespace"),
                serde_json::json!({ "metadata": { "name": "bare" } }),
            ),
        ];
        for (resource, json) in cases {
            let obj: DynamicObject = serde_json::from_value(json).unwrap();
            let kept = to_watch_object(obj.clone(), &resource).unwrap();
            assert_eq!(
                kept.to_value(),
                to_json(obj, &resource).unwrap(),
                "{}",
                resource.kind
            );
        }
    }

    #[test]
    fn a_secret_without_annotations_gets_the_marker_and_loses_its_values() {
        let obj: DynamicObject = serde_json::from_value(serde_json::json!({
            "metadata": { "name": "creds", "namespace": "default" },
            "data": { "token": "eA==" },
            "stringData": { "plain": "x" }
        }))
        .unwrap();
        let resource = ApiResource {
            group: String::new(),
            version: "v1".into(),
            api_version: "v1".into(),
            kind: "Secret".into(),
            plural: "secrets".into(),
        };
        let json = to_json(obj, &resource).unwrap();
        assert_eq!(json["data"]["token"], "");
        assert_eq!(json["stringData"]["plain"], "");
        assert_eq!(
            json["metadata"]["annotations"][VALUES_HIDDEN_ANNOTATION],
            "true"
        );
        assert!(ensure_values_present(&json).is_err());
    }

    /// A cluster with Flux older than 2.7: `image.toolkit.fluxcd.io` serves only `v1beta2`; `source.toolkit.fluxcd.io`
    /// serves `v1`. Discovery by group version (no aggregated discovery); every request is recorded.
    mod older_flux {
        use crate::fake_api::{FakeApi, Reply, Request};

        const API_VERSIONS: &str =
            r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
        const CORE_RESOURCES: &str =
            r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[]}"#;
        const API_GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[
            {"name":"image.toolkit.fluxcd.io","versions":[{"groupVersion":"image.toolkit.fluxcd.io/v1beta2","version":"v1beta2"}],
             "preferredVersion":{"groupVersion":"image.toolkit.fluxcd.io/v1beta2","version":"v1beta2"}},
            {"name":"source.toolkit.fluxcd.io","versions":[{"groupVersion":"source.toolkit.fluxcd.io/v1","version":"v1"}],
             "preferredVersion":{"groupVersion":"source.toolkit.fluxcd.io/v1","version":"v1"}}]}"#;
        const IMAGE_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"image.toolkit.fluxcd.io/v1beta2","resources":[
            {"name":"imagepolicies","singularName":"imagepolicy","namespaced":true,"kind":"ImagePolicy","verbs":["get","list","watch"]}]}"#;
        const SOURCE_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"source.toolkit.fluxcd.io/v1","resources":[
            {"name":"gitrepositories","singularName":"gitrepository","namespaced":true,"kind":"GitRepository","verbs":["get","list","watch"]}]}"#;
        const POLICY: &str = r#"{"apiVersion":"image.toolkit.fluxcd.io/v1beta2","kind":"ImagePolicy","metadata":{"name":"app","namespace":"ns","uid":"p1"}}"#;
        const POLICY_LIST: &str = r#"{"apiVersion":"image.toolkit.fluxcd.io/v1beta2","kind":"ImagePolicyList","metadata":{"resourceVersion":"1"},"items":[
            {"metadata":{"name":"app","namespace":"ns","uid":"p1"}}]}"#;
        const REPOSITORY: &str = r#"{"apiVersion":"source.toolkit.fluxcd.io/v1","kind":"GitRepository","metadata":{"name":"app","namespace":"ns","uid":"g1"}}"#;

        fn answer(req: &Request) -> Reply {
            if req.query.contains("watch=") {
                return Reply::stream(String::new());
            }
            match req.path.as_str() {
                "/api" => Reply::json(200, API_VERSIONS),
                "/api/v1" => Reply::json(200, CORE_RESOURCES),
                "/apis" => Reply::json(200, API_GROUPS),
                "/apis/image.toolkit.fluxcd.io/v1beta2" => Reply::json(200, IMAGE_RESOURCES),
                "/apis/source.toolkit.fluxcd.io/v1" => Reply::json(200, SOURCE_RESOURCES),
                "/apis/image.toolkit.fluxcd.io/v1beta2/namespaces/ns/imagepolicies/app" => {
                    Reply::json(200, POLICY)
                }
                "/apis/image.toolkit.fluxcd.io/v1beta2/imagepolicies" => {
                    Reply::json(200, POLICY_LIST)
                }
                "/apis/source.toolkit.fluxcd.io/v1/namespaces/ns/gitrepositories/app" => {
                    Reply::json(200, REPOSITORY)
                }
                _ => Reply::not_found(),
            }
        }

        pub async fn server() -> FakeApi {
            FakeApi::start(answer).await
        }

        /// The request lines so far ("GET /apis/…").
        pub fn lines(api: &FakeApi) -> Vec<String> {
            api.requests().iter().map(Request::line).collect()
        }
    }

    fn flux_ref(group: &str, version: &str, kind: &str) -> ObjectRef {
        ObjectRef {
            kind: KindRef {
                group: group.into(),
                version: version.into(),
                kind: kind.into(),
            },
            namespace: Some("ns".into()),
            name: "app".into(),
        }
    }

    #[tokio::test]
    async fn a_version_the_cluster_does_not_serve_is_read_in_the_version_it_serves() {
        let api = older_flux::server().await;
        let (_tmp, mgr, id) = crate::fake_api::connected_to(api.url()).await;

        let policy = get(
            &mgr,
            &id,
            &flux_ref("image.toolkit.fluxcd.io", "v1", "ImagePolicy"),
        )
        .await
        .unwrap();
        assert_eq!(policy["apiVersion"], "image.toolkit.fluxcd.io/v1beta2");
        let requests = older_flux::lines(&api);
        assert!(
            requests.iter().any(|r| r.starts_with(
                "GET /apis/image.toolkit.fluxcd.io/v1beta2/namespaces/ns/imagepolicies/app"
            )),
            "{requests:?}"
        );
        assert!(
            !requests
                .iter()
                .any(|r| r.contains("image.toolkit.fluxcd.io/v1/")),
            "{requests:?}"
        );

        // The table of the kind (a watch) too.
        let spec = crate::resources::WatchSpec {
            kind: flux_ref("image.toolkit.fluxcd.io", "v1", "ImagePolicy").kind,
            namespaces: None,
            label_selector: None,
            field_selector: None,
            metadata_only: false,
        };
        let mut updates = Box::pin(crate::resources::watch(&mgr, &id, spec).await.unwrap());
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            futures::StreamExt::next(&mut updates),
        )
        .await
        {
            Ok(Some(crate::resources::WatchUpdate::Snapshot { items })) => {
                assert_eq!(items.len(), 1);
                assert_eq!(
                    items[0].to_value()["apiVersion"],
                    "image.toolkit.fluxcd.io/v1beta2"
                );
            }
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_version_the_cluster_serves_is_read_as_asked() {
        let api = older_flux::server().await;
        let (_tmp, mgr, id) = crate::fake_api::connected_to(api.url()).await;

        let repo = get(
            &mgr,
            &id,
            &flux_ref("source.toolkit.fluxcd.io", "v1", "GitRepository"),
        )
        .await
        .unwrap();
        assert_eq!(repo["apiVersion"], "source.toolkit.fluxcd.io/v1");
        let requests = older_flux::lines(&api);
        assert!(
            requests.iter().any(|r| r.starts_with(
                "GET /apis/source.toolkit.fluxcd.io/v1/namespaces/ns/gitrepositories/app"
            )),
            "{requests:?}"
        );
    }
}
