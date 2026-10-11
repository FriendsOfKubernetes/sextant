//! Reading one object, and the helpers every resource function shares: finding the API of a kind through
//! discovery and turning a `DynamicObject` into the JSON the frontend gets.

use kube::Api;
use kube::api::{ApiResource, DynamicObject};
use serde_json::Value;

use super::{KindRef, ObjectRef};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// Reads one object; a namespaced kind without a namespace is `invalid`. `managedFields` are stripped, `apiVersion` and `kind` are always set.
pub async fn get(mgr: &ClusterManager, cluster: &ClusterId, r: &ObjectRef) -> CoreResult<Value> {
    let client = mgr.client(cluster)?;
    let kind = resolve_kind(mgr, cluster, &r.kind).await?;
    if kind.namespaced {
        r.required_namespace()?;
    }
    let api = kind.api(client, r.namespace.as_deref());
    let obj = api.get(&r.name).await?;
    to_json(obj, &kind.resource)
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

/// Finds `kind` in the cluster's discovery (cached by `ClusterManager::kinds`). A version the cluster does not
/// prefer is still used when the group serves the kind; an unknown kind is `notFound`.
pub(crate) async fn resolve_kind(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    kind: &KindRef,
) -> CoreResult<ResolvedKind> {
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
    let api_version = if kind.group.is_empty() {
        kind.version.clone()
    } else {
        format!("{}/{}", kind.group, kind.version)
    };
    Ok(ResolvedKind {
        resource: ApiResource {
            group: kind.group.clone(),
            version: kind.version.clone(),
            api_version,
            kind: kind.kind.clone(),
            plural: found.plural.clone(),
        },
        namespaced: found.namespaced,
    })
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
/// `metadata.managedFields` removed.
pub(crate) fn to_json(obj: DynamicObject, resource: &ApiResource) -> CoreResult<Value> {
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
}
