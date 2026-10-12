//! Reading one object, and the helpers every resource function shares: finding the API of a kind through
//! discovery and turning a `DynamicObject` into the JSON the frontend gets.

use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use kube::api::{ApiResource, DynamicObject};
use serde_json::{Map, Value};

use super::{KindRef, ObjectRef};
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

/// Finds the API of `kind`: a built-in kind directly, any other through the cluster's discovery (cached by
/// `ClusterManager::kinds`, shared by callers that ask at the same time). A version the cluster does not prefer is
/// still used when the group serves the kind; an unknown kind is `notFound`.
pub(crate) async fn resolve_kind(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    kind: &KindRef,
) -> CoreResult<ResolvedKind> {
    let api_version = if kind.group.is_empty() {
        kind.version.clone()
    } else {
        format!("{}/{}", kind.group, kind.version)
    };
    let resolved = |plural: String, namespaced: bool| ResolvedKind {
        resource: ApiResource {
            group: kind.group.clone(),
            version: kind.version.clone(),
            api_version: api_version.clone(),
            kind: kind.kind.clone(),
            plural,
        },
        namespaced,
    };
    if let Some((_, _, plural, namespaced)) = BUILT_IN_KINDS
        .iter()
        .find(|(group, name, _, _)| *group == kind.group && *name == kind.kind)
    {
        return Ok(resolved((*plural).to_owned(), *namespaced));
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
    Ok(resolved(found.plural.clone(), found.namespaced))
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

fn hide_secret_values(value: &mut Value) {
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
}
