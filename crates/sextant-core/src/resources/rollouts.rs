//! Rollout history of Deployments, StatefulSets and DaemonSets and the rollback `kubectl rollout undo` makes.
//!
//! A Deployment's revisions are its ReplicaSets (annotation `deployment.kubernetes.io/revision`); a StatefulSet's and
//! a DaemonSet's are its ControllerRevisions. Only objects the workload controls (`ownerReferences` with
//! `controller: true` and the workload's uid) count, as in kubectl.
//!
//! [`undo`] sends exactly what `kubectl rollout undo --to-revision=N` sends: for a Deployment a JSON patch that
//! replaces `spec.template` with the ReplicaSet's template (without `pod-template-hash`) and `metadata.annotations`
//! with the ReplicaSet's (keeping the Deployment's own revision bookkeeping); for a StatefulSet or DaemonSet the
//! ControllerRevision's `data` as a strategic merge patch (it is `{"spec":{"template":{…,"$patch":"replace"}}}`).
//! A paused Deployment is refused, and a revision that already matches the live template is skipped.

use std::collections::BTreeMap;

use k8s_openapi::api::apps::v1::{
    ControllerRevision, DaemonSet, Deployment, ReplicaSet, StatefulSet,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use kube::Api;
use kube::api::{ListParams, Patch, PatchParams};
use serde::Serialize;
use serde_json::{Value, json};

use super::ObjectRef;
use super::mutate::FIELD_MANAGER;
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// The revision number the Deployment controller writes on a Deployment and its ReplicaSets.
pub const REVISION_ANNOTATION: &str = "deployment.kubernetes.io/revision";
/// Why a revision was made (`kubectl annotate … kubernetes.io/change-cause=…`).
pub const CHANGE_CAUSE_ANNOTATION: &str = "kubernetes.io/change-cause";
/// The label the Deployment controller adds to a ReplicaSet's template; not part of the Deployment's template.
pub const POD_TEMPLATE_HASH: &str = "pod-template-hash";

/// Annotations kubectl keeps from the Deployment instead of taking them from the ReplicaSet (`annotationsToSkip`).
const ANNOTATIONS_TO_SKIP: [&str; 6] = [
    "kubectl.kubernetes.io/last-applied-configuration",
    REVISION_ANNOTATION,
    "deployment.kubernetes.io/revision-history",
    "deployment.kubernetes.io/desired-replicas",
    "deployment.kubernetes.io/max-replicas",
    "deprecated.deployment.rollback.to",
];

/// One revision of a workload.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub revision: i64,
    /// The ReplicaSet or ControllerRevision that holds it.
    pub name: String,
    /// `metadata.creationTimestamp` of that object.
    pub created: Option<String>,
    pub change_cause: Option<String>,
    /// Images of the template's containers, in order.
    pub images: Vec<String>,
    /// The revision the workload runs (or rolls out to) now.
    pub current: bool,
    /// The pod template of the revision (without `pod-template-hash` and `$patch`).
    pub template: Value,
}

/// What [`undo`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Undo {
    /// The revision rolled back to.
    pub revision: i64,
    /// The live template already matched that revision, so nothing was sent.
    pub skipped: bool,
}

/// The kinds that have a rollout history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Workload {
    Deployment,
    StatefulSet,
    DaemonSet,
}

fn workload_of(r: &ObjectRef) -> CoreResult<Workload> {
    match (r.kind.group.as_str(), r.kind.kind.as_str()) {
        ("apps", "Deployment") => Ok(Workload::Deployment),
        ("apps", "StatefulSet") => Ok(Workload::StatefulSet),
        ("apps", "DaemonSet") => Ok(Workload::DaemonSet),
        _ => Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "only a Deployment, StatefulSet or DaemonSet has a rollout history, not {}",
                r.kind.kind
            ),
        )),
    }
}

/// The revisions of a Deployment, StatefulSet or DaemonSet, oldest first.
pub async fn history(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
) -> CoreResult<Vec<Revision>> {
    let workload = workload_of(r)?;
    let ns = r.required_namespace()?;
    let client = mgr.client(cluster)?;
    match workload {
        Workload::Deployment => {
            let deployment = Api::<Deployment>::namespaced(client.clone(), ns)
                .get(&r.name)
                .await?;
            let sets = owned_replica_sets(client, ns, &deployment).await?;
            Ok(deployment_history(&deployment, &sets))
        }
        Workload::StatefulSet => {
            let sts = Api::<StatefulSet>::namespaced(client.clone(), ns)
                .get(&r.name)
                .await?;
            let selector = sts.spec.as_ref().map(|s| &s.selector);
            let revisions = owned_revisions(client, ns, &sts.metadata, selector).await?;
            let current = sts.status.as_ref().and_then(|s| s.update_revision.clone());
            Ok(controller_history(&revisions, current.as_deref()))
        }
        Workload::DaemonSet => {
            let ds = Api::<DaemonSet>::namespaced(client.clone(), ns)
                .get(&r.name)
                .await?;
            let selector = ds.spec.as_ref().map(|s| &s.selector);
            let revisions = owned_revisions(client, ns, &ds.metadata, selector).await?;
            Ok(controller_history(&revisions, None))
        }
    }
}

/// Rolls a workload back to `to_revision` (`0`: the revision before the newest one), like
/// `kubectl rollout undo --to-revision`.
pub async fn undo(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    to_revision: i64,
) -> CoreResult<Undo> {
    let workload = workload_of(r)?;
    if to_revision < 0 {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("a revision cannot be negative ({to_revision})"),
        ));
    }
    let ns = r.required_namespace()?;
    let client = mgr.client(cluster)?;
    match workload {
        Workload::Deployment => {
            let api = Api::<Deployment>::namespaced(client.clone(), ns);
            let deployment = api.get(&r.name).await?;
            if deployment.spec.as_ref().and_then(|s| s.paused) == Some(true) {
                return Err(CoreError::new(
                    ErrorCode::Invalid,
                    format!(
                        "Deployment {} is paused: resume it before rolling it back",
                        r.name
                    ),
                ));
            }
            let sets = owned_replica_sets(client, ns, &deployment).await?;
            let numbered: Vec<(i64, &ReplicaSet)> = sets
                .iter()
                .filter_map(|rs| revision_of(&rs.metadata).map(|n| (n, rs)))
                .collect();
            let (revision, rs) = pick(&numbered, to_revision, &r.name)?;
            let template = template_of_replica_set(rs);
            if template == deployment_template(&deployment) {
                return Ok(Undo {
                    revision,
                    skipped: true,
                });
            }
            let patch = deployment_rollback_patch(&deployment, rs);
            let patch = serde_json::from_value(patch).map_err(|err| {
                CoreError::new(ErrorCode::Other, format!("rollback patch: {err}"))
            })?;
            api.patch(&r.name, &patch_params(), &Patch::Json::<()>(patch))
                .await?;
            Ok(Undo {
                revision,
                skipped: false,
            })
        }
        Workload::StatefulSet | Workload::DaemonSet => {
            let (meta, selector, live_template) = if workload == Workload::StatefulSet {
                let sts = Api::<StatefulSet>::namespaced(client.clone(), ns)
                    .get(&r.name)
                    .await?;
                let template = sts.spec.as_ref().map(|s| to_value(&s.template));
                (sts.metadata, sts.spec.map(|s| s.selector), template)
            } else {
                let ds = Api::<DaemonSet>::namespaced(client.clone(), ns)
                    .get(&r.name)
                    .await?;
                let template = ds.spec.as_ref().map(|s| to_value(&s.template));
                (ds.metadata, ds.spec.map(|s| s.selector), template)
            };
            let revisions = owned_revisions(client.clone(), ns, &meta, selector.as_ref()).await?;
            let numbered: Vec<(i64, &ControllerRevision)> =
                revisions.iter().map(|cr| (cr.revision, cr)).collect();
            let (revision, cr) = pick_controller_revision(&numbered, to_revision)?;
            let data = cr.data.as_ref().map(|d| d.0.clone()).unwrap_or(Value::Null);
            let live = live_template.map(|t| without_nulls(template_patch(&t)));
            if live == Some(without_nulls(data.clone())) {
                return Ok(Undo {
                    revision,
                    skipped: true,
                });
            }
            let params = patch_params();
            let patch = Patch::Strategic(&data);
            if workload == Workload::StatefulSet {
                Api::<StatefulSet>::namespaced(client, ns)
                    .patch(&r.name, &params, &patch)
                    .await?;
            } else {
                Api::<DaemonSet>::namespaced(client, ns)
                    .patch(&r.name, &params, &patch)
                    .await?;
            }
            Ok(Undo {
                revision,
                skipped: false,
            })
        }
    }
}

/// The JSON patch `kubectl rollout undo` sends to bring `deployment` back to the template of `rs`.
pub fn deployment_rollback_patch(deployment: &Deployment, rs: &ReplicaSet) -> Value {
    let mut annotations = BTreeMap::new();
    let own = deployment.metadata.annotations.as_ref();
    for key in ANNOTATIONS_TO_SKIP {
        if let Some(value) = own.and_then(|a| a.get(key)) {
            annotations.insert(key.to_owned(), value.clone());
        }
    }
    for (key, value) in rs.metadata.annotations.iter().flatten() {
        if !ANNOTATIONS_TO_SKIP.contains(&key.as_str()) {
            annotations.insert(key.clone(), value.clone());
        }
    }
    json!([
        { "op": "replace", "path": "/spec/template", "value": template_of_replica_set(rs) },
        { "op": "replace", "path": "/metadata/annotations", "value": annotations },
    ])
}

/// `{"spec":{"template":{…,"$patch":"replace"}}}`: what a StatefulSet's or DaemonSet's ControllerRevision holds.
fn template_patch(template: &Value) -> Value {
    let mut template = template.clone();
    if let Some(map) = template.as_object_mut() {
        map.insert("$patch".into(), Value::String("replace".into()));
    }
    json!({ "spec": { "template": template } })
}

/// `value` without `null` members: the controller writes `"creationTimestamp":null` into a revision, which the typed
/// object read back leaves out.
fn without_nulls(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, without_nulls(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(without_nulls).collect()),
        other => other,
    }
}

fn deployment_history(deployment: &Deployment, sets: &[ReplicaSet]) -> Vec<Revision> {
    let mut revisions: Vec<Revision> = sets
        .iter()
        .filter_map(|rs| {
            let revision = revision_of(&rs.metadata)?;
            let template = template_of_replica_set(rs);
            Some(Revision {
                revision,
                name: rs.metadata.name.clone().unwrap_or_default(),
                created: created_of(&rs.metadata),
                change_cause: annotation(&rs.metadata, CHANGE_CAUSE_ANNOTATION),
                images: images_of(&template),
                current: false,
                template,
            })
        })
        .collect();
    revisions.sort_by_key(|r| r.revision);
    let current = revision_of(&deployment.metadata)
        .filter(|n| revisions.iter().any(|r| r.revision == *n))
        .or_else(|| revisions.last().map(|r| r.revision));
    for r in &mut revisions {
        r.current = Some(r.revision) == current;
    }
    revisions
}

fn controller_history(revisions: &[ControllerRevision], current: Option<&str>) -> Vec<Revision> {
    let mut out: Vec<Revision> = revisions
        .iter()
        .map(|cr| {
            let mut template = without_nulls(
                cr.data
                    .as_ref()
                    .and_then(|d| d.0.pointer("/spec/template").cloned())
                    .unwrap_or(Value::Null),
            );
            if let Some(map) = template.as_object_mut() {
                map.remove("$patch");
            }
            Revision {
                revision: cr.revision,
                name: cr.metadata.name.clone().unwrap_or_default(),
                created: created_of(&cr.metadata),
                change_cause: annotation(&cr.metadata, CHANGE_CAUSE_ANNOTATION),
                images: images_of(&template),
                current: false,
                template,
            }
        })
        .collect();
    out.sort_by_key(|r| r.revision);
    let current = current
        .and_then(|name| out.iter().find(|r| r.name == name))
        .or(out.last())
        .map(|r| r.revision);
    for r in &mut out {
        r.current = Some(r.revision) == current;
    }
    out
}

/// kubectl's choice for a Deployment: the named revision, or for `0` the second newest.
fn pick<'a, T>(
    numbered: &[(i64, &'a T)],
    to_revision: i64,
    name: &str,
) -> CoreResult<(i64, &'a T)> {
    if to_revision > 0 {
        return numbered
            .iter()
            .find(|(n, _)| *n == to_revision)
            .map(|(n, rs)| (*n, *rs))
            .ok_or_else(|| revision_not_found(to_revision));
    }
    let mut sorted: Vec<&(i64, &T)> = numbered.iter().collect();
    sorted.sort_by_key(|(n, _)| *n);
    sorted
        .iter()
        .rev()
        .nth(1)
        .map(|(n, rs)| (*n, *rs))
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("no earlier revision of {name} to roll back to"),
            )
        })
}

/// kubectl's choice for a StatefulSet or DaemonSet: the named revision, or for `0` the second newest.
fn pick_controller_revision<'a>(
    numbered: &[(i64, &'a ControllerRevision)],
    to_revision: i64,
) -> CoreResult<(i64, &'a ControllerRevision)> {
    if to_revision == 0 && numbered.len() <= 1 {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            "no last revision to roll back to",
        ));
    }
    pick(numbered, to_revision, "the workload")
}

fn revision_not_found(revision: i64) -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        format!("revision {revision} is not in the rollout history"),
    )
}

/// The ReplicaSets `deployment` controls (its selector, then the controller reference), as kubectl lists them.
async fn owned_replica_sets(
    client: kube::Client,
    ns: &str,
    deployment: &Deployment,
) -> CoreResult<Vec<ReplicaSet>> {
    let Some(selector) = deployment
        .spec
        .as_ref()
        .and_then(|s| selector_string(&s.selector))
    else {
        return Ok(Vec::new());
    };
    let uid = deployment.metadata.uid.as_deref().unwrap_or_default();
    let list = Api::<ReplicaSet>::namespaced(client, ns)
        .list(&ListParams::default().labels(&selector))
        .await?;
    Ok(list
        .items
        .into_iter()
        .filter(|rs| controlled_by(&rs.metadata, uid))
        .collect())
}

/// The ControllerRevisions the workload with `meta` controls.
async fn owned_revisions(
    client: kube::Client,
    ns: &str,
    meta: &ObjectMeta,
    selector: Option<&LabelSelector>,
) -> CoreResult<Vec<ControllerRevision>> {
    let Some(selector) = selector.and_then(selector_string) else {
        return Ok(Vec::new());
    };
    let uid = meta.uid.as_deref().unwrap_or_default();
    let list = Api::<ControllerRevision>::namespaced(client, ns)
        .list(&ListParams::default().labels(&selector))
        .await?;
    Ok(list
        .items
        .into_iter()
        .filter(|cr| controlled_by(&cr.metadata, uid))
        .collect())
}

fn controlled_by(meta: &ObjectMeta, uid: &str) -> bool {
    !uid.is_empty()
        && meta
            .owner_references
            .iter()
            .flatten()
            .any(|o| o.controller == Some(true) && o.uid == uid)
}

/// `app=web,tier in (a,b),!legacy`; `None` for a selector that selects nothing.
pub fn selector_string(selector: &LabelSelector) -> Option<String> {
    let mut parts: Vec<String> = selector
        .match_labels
        .iter()
        .flatten()
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    for e in selector.match_expressions.iter().flatten() {
        let values = e.values.as_deref().unwrap_or_default().join(",");
        match e.operator.as_str() {
            "In" => parts.push(format!("{} in ({values})", e.key)),
            "NotIn" => parts.push(format!("{} notin ({values})", e.key)),
            "Exists" => parts.push(e.key.clone()),
            "DoesNotExist" => parts.push(format!("!{}", e.key)),
            _ => {}
        }
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

fn revision_of(meta: &ObjectMeta) -> Option<i64> {
    annotation(meta, REVISION_ANNOTATION)?.parse().ok()
}

fn annotation(meta: &ObjectMeta, key: &str) -> Option<String> {
    meta.annotations.as_ref()?.get(key).cloned()
}

fn created_of(meta: &ObjectMeta) -> Option<String> {
    meta.creation_timestamp
        .as_ref()
        .and_then(|t| serde_json::to_value(t).ok())
        .and_then(|v| v.as_str().map(str::to_owned))
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// The template of a ReplicaSet without the `pod-template-hash` label.
fn template_of_replica_set(rs: &ReplicaSet) -> Value {
    let mut template = rs
        .spec
        .as_ref()
        .and_then(|s| s.template.as_ref())
        .map(to_value)
        .unwrap_or(Value::Null);
    if let Some(labels) = template
        .pointer_mut("/metadata/labels")
        .and_then(Value::as_object_mut)
    {
        labels.remove(POD_TEMPLATE_HASH);
    }
    template
}

fn deployment_template(deployment: &Deployment) -> Value {
    let mut template = deployment
        .spec
        .as_ref()
        .map(|s| to_value(&s.template))
        .unwrap_or(Value::Null);
    if let Some(labels) = template
        .pointer_mut("/metadata/labels")
        .and_then(Value::as_object_mut)
    {
        labels.remove(POD_TEMPLATE_HASH);
    }
    template
}

fn images_of(template: &Value) -> Vec<String> {
    template
        .pointer("/spec/containers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| c.get("image").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

fn patch_params() -> PatchParams {
    PatchParams {
        field_manager: Some(FIELD_MANAGER.to_owned()),
        ..PatchParams::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};
    use crate::resources::KindRef;

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;

    fn apps(kind: &str, name: &str) -> ObjectRef {
        ObjectRef {
            kind: KindRef {
                group: "apps".into(),
                version: "v1".into(),
                kind: kind.into(),
            },
            namespace: Some("ns".into()),
            name: name.into(),
        }
    }

    fn template(image: &str, hash: Option<&str>) -> Value {
        let mut labels = json!({ "app": "web" });
        if let Some(hash) = hash {
            labels[POD_TEMPLATE_HASH] = Value::String(hash.into());
        }
        json!({
            "metadata": { "labels": labels },
            "spec": { "containers": [{ "name": "web", "image": image }] }
        })
    }

    fn owner(kind: &str, uid: &str) -> Value {
        json!([{ "apiVersion": "apps/v1", "kind": kind, "name": "web", "uid": uid, "controller": true }])
    }

    fn deployment(image: &str, revision: i64, paused: bool) -> Value {
        json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {
                "name": "web", "namespace": "ns", "uid": "dep-uid",
                "annotations": {
                    REVISION_ANNOTATION: revision.to_string(),
                    "kubectl.kubernetes.io/last-applied-configuration": "{}",
                    "team": "shop"
                }
            },
            "spec": {
                "paused": paused,
                "selector": { "matchLabels": { "app": "web" } },
                "template": template(image, None)
            }
        })
    }

    fn replica_set(name: &str, revision: i64, image: &str, cause: &str, owner_uid: &str) -> Value {
        json!({
            "apiVersion": "apps/v1", "kind": "ReplicaSet",
            "metadata": {
                "name": name, "namespace": "ns", "uid": format!("{name}-uid"),
                "creationTimestamp": "2026-10-01T10:00:00Z",
                "annotations": {
                    REVISION_ANNOTATION: revision.to_string(),
                    CHANGE_CAUSE_ANNOTATION: cause,
                    "deployment.kubernetes.io/desired-replicas": "3",
                    "team": "shop"
                },
                "ownerReferences": owner("Deployment", owner_uid)
            },
            "spec": {
                "selector": { "matchLabels": { "app": "web" } },
                "template": template(image, Some(&format!("{name}-hash")))
            }
        })
    }

    fn list(kind: &str, items: Vec<Value>) -> String {
        json!({ "apiVersion": "apps/v1", "kind": kind, "metadata": { "resourceVersion": "1" }, "items": items })
            .to_string()
    }

    fn replica_sets() -> String {
        list(
            "ReplicaSetList",
            vec![
                replica_set("web-1", 1, "nginx:1.25", "first", "dep-uid"),
                replica_set("web-2", 2, "nginx:1.26", "second", "dep-uid"),
                replica_set("web-3", 3, "nginx:1.27", "third", "dep-uid"),
                // Matches the selector but belongs to someone else.
                replica_set("stranger", 9, "busybox", "", "other-uid"),
            ],
        )
    }

    fn controller_revision(owner_kind: &str, name: &str, revision: i64, image: &str) -> Value {
        let mut data_template = template(image, None);
        // As the controller writes it.
        data_template["metadata"]["creationTimestamp"] = Value::Null;
        data_template["$patch"] = Value::String("replace".into());
        json!({
            "apiVersion": "apps/v1", "kind": "ControllerRevision",
            "metadata": {
                "name": name, "namespace": "ns", "uid": format!("{name}-uid"),
                "creationTimestamp": "2026-10-02T10:00:00Z",
                "labels": { "app": "web" },
                "ownerReferences": owner(owner_kind, "set-uid")
            },
            "revision": revision,
            "data": { "spec": { "template": data_template } }
        })
    }

    fn set(kind: &str, image: &str) -> Value {
        json!({
            "apiVersion": "apps/v1", "kind": kind,
            "metadata": { "name": "web", "namespace": "ns", "uid": "set-uid" },
            "spec": {
                "selector": { "matchLabels": { "app": "web" } },
                "serviceName": "web",
                "template": template(image, None)
            },
            "status": { "updateRevision": "web-b", "currentRevision": "web-b", "replicas": 1 }
        })
    }

    fn revisions_of(kind: &str) -> String {
        list(
            "ControllerRevisionList",
            vec![
                controller_revision(kind, "web-a", 1, "redis:7.0"),
                controller_revision(kind, "web-b", 2, "redis:7.2"),
            ],
        )
    }

    fn deployment_server(paused: bool) -> impl Fn(&Request) -> Reply + Send + Sync + 'static {
        move |req: &Request| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("GET", "/apis/apps/v1/namespaces/ns/deployments/web") => {
                Reply::json(200, deployment("nginx:1.27", 3, paused).to_string())
            }
            ("PATCH", "/apis/apps/v1/namespaces/ns/deployments/web") => {
                Reply::json(200, deployment("nginx:1.25", 4, paused).to_string())
            }
            ("GET", "/apis/apps/v1/namespaces/ns/replicasets") => Reply::json(200, replica_sets()),
            _ => Reply::not_found(),
        }
    }

    fn set_server(kind: &'static str) -> impl Fn(&Request) -> Reply + Send + Sync + 'static {
        let plural = if kind == "StatefulSet" {
            "statefulsets"
        } else {
            "daemonsets"
        };
        let path = format!("/apis/apps/v1/namespaces/ns/{plural}/web");
        move |req: &Request| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("GET", p) if p == path => Reply::json(200, set(kind, "redis:7.2").to_string()),
            ("PATCH", p) if p == path => Reply::json(200, set(kind, "redis:7.0").to_string()),
            ("GET", "/apis/apps/v1/namespaces/ns/controllerrevisions") => {
                Reply::json(200, revisions_of(kind))
            }
            _ => Reply::not_found(),
        }
    }

    fn patch_of(api: &FakeApi) -> Request {
        api.requests()
            .into_iter()
            .find(|r| r.method == "PATCH")
            .expect("a PATCH request")
    }

    #[tokio::test]
    async fn a_deployment_history_lists_its_own_replica_sets_with_the_current_one_marked() {
        let api = FakeApi::start(deployment_server(false)).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let revisions = history(&mgr, &id, &apps("Deployment", "web"))
            .await
            .unwrap();
        let summary: Vec<(i64, &str, bool, Vec<String>)> = revisions
            .iter()
            .map(|r| {
                (
                    r.revision,
                    r.change_cause.as_deref().unwrap_or_default(),
                    r.current,
                    r.images.clone(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (1, "first", false, vec!["nginx:1.25".to_owned()]),
                (2, "second", false, vec!["nginx:1.26".to_owned()]),
                (3, "third", true, vec!["nginx:1.27".to_owned()]),
            ]
        );
        assert_eq!(revisions[0].name, "web-1");
        assert_eq!(
            revisions[0].created.as_deref(),
            Some("2026-10-01T10:00:00Z")
        );
        assert_eq!(revisions[0].template, template("nginx:1.25", None));
        let listed = api
            .requests()
            .into_iter()
            .find(|r| r.path.ends_with("/replicasets"))
            .unwrap();
        assert!(
            listed.query.contains("labelSelector=app%3Dweb"),
            "{}",
            listed.query
        );
    }

    #[tokio::test]
    async fn a_deployment_rollback_sends_kubectls_json_patch() {
        let api = FakeApi::start(deployment_server(false)).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let done = undo(&mgr, &id, &apps("Deployment", "web"), 1)
            .await
            .unwrap();
        assert_eq!(
            done,
            Undo {
                revision: 1,
                skipped: false
            }
        );
        let patch = patch_of(&api);
        assert_eq!(patch.header("content-type"), "application/json-patch+json");
        assert!(
            patch.query.contains("fieldManager=sextant"),
            "{}",
            patch.query
        );
        let body: Value = serde_json::from_slice(&patch.body).unwrap();
        assert_eq!(
            body,
            json!([
                { "op": "replace", "path": "/spec/template", "value": template("nginx:1.25", None) },
                { "op": "replace", "path": "/metadata/annotations", "value": {
                    // The Deployment's own bookkeeping stays; the rest comes from the ReplicaSet.
                    REVISION_ANNOTATION: "3",
                    "kubectl.kubernetes.io/last-applied-configuration": "{}",
                    CHANGE_CAUSE_ANNOTATION: "first",
                    "team": "shop"
                } }
            ])
        );
    }

    #[tokio::test]
    async fn a_deployment_rollback_without_a_revision_goes_to_the_previous_one() {
        let api = FakeApi::start(deployment_server(false)).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let done = undo(&mgr, &id, &apps("Deployment", "web"), 0)
            .await
            .unwrap();
        assert_eq!(done.revision, 2);
        let body: Value = serde_json::from_slice(&patch_of(&api).body).unwrap();
        assert_eq!(body[0]["value"], template("nginx:1.26", None));
    }

    #[tokio::test]
    async fn a_rollback_to_the_current_template_or_an_unknown_revision_sends_nothing() {
        let api = FakeApi::start(deployment_server(false)).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let done = undo(&mgr, &id, &apps("Deployment", "web"), 3)
            .await
            .unwrap();
        assert!(done.skipped);
        let err = undo(&mgr, &id, &apps("Deployment", "web"), 9)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{err}");
        assert!(api.requests().iter().all(|r| r.method != "PATCH"));
    }

    #[tokio::test]
    async fn a_paused_deployment_is_not_rolled_back() {
        let api = FakeApi::start(deployment_server(true)).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let err = undo(&mgr, &id, &apps("Deployment", "web"), 1)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        assert!(err.message.contains("paused"), "{err}");
        assert!(api.requests().iter().all(|r| r.method != "PATCH"));
    }

    #[tokio::test]
    async fn statefulset_and_daemonset_histories_come_from_controller_revisions() {
        for kind in ["StatefulSet", "DaemonSet"] {
            let api = FakeApi::start(set_server(kind)).await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;
            let revisions = history(&mgr, &id, &apps(kind, "web")).await.unwrap();
            let summary: Vec<(i64, &str, bool)> = revisions
                .iter()
                .map(|r| (r.revision, r.name.as_str(), r.current))
                .collect();
            assert_eq!(
                summary,
                vec![(1, "web-a", false), (2, "web-b", true)],
                "{kind}"
            );
            assert_eq!(revisions[0].template, template("redis:7.0", None), "{kind}");
            assert_eq!(revisions[0].images, vec!["redis:7.0".to_owned()], "{kind}");
        }
    }

    #[tokio::test]
    async fn statefulset_and_daemonset_rollbacks_send_the_revision_data_as_a_strategic_patch() {
        for kind in ["StatefulSet", "DaemonSet"] {
            let api = FakeApi::start(set_server(kind)).await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;
            let done = undo(&mgr, &id, &apps(kind, "web"), 0).await.unwrap();
            assert_eq!(
                done,
                Undo {
                    revision: 1,
                    skipped: false
                },
                "{kind}"
            );
            let patch = patch_of(&api);
            assert_eq!(
                patch.header("content-type"),
                "application/strategic-merge-patch+json",
                "{kind}"
            );
            let body: Value = serde_json::from_slice(&patch.body).unwrap();
            let mut expected = template("redis:7.0", None);
            expected["metadata"]["creationTimestamp"] = Value::Null;
            expected["$patch"] = Value::String("replace".into());
            assert_eq!(body, json!({ "spec": { "template": expected } }), "{kind}");

            // The newest revision is what runs now: nothing to do.
            let done = undo(&mgr, &id, &apps(kind, "web"), 2).await.unwrap();
            assert!(done.skipped, "{kind}");
            assert_eq!(
                api.requests()
                    .iter()
                    .filter(|r| r.method == "PATCH")
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn other_kinds_have_no_history() {
        let api = FakeApi::start(deployment_server(false)).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let err = undo(&mgr, &id, &apps("ReplicaSet", "web"), 0)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        let err = history(&mgr, &id, &apps("ReplicaSet", "web"))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
    }

    #[test]
    fn selectors_become_label_selector_strings() {
        let selector: LabelSelector = serde_json::from_value(json!({
            "matchLabels": { "app": "web" },
            "matchExpressions": [
                { "key": "tier", "operator": "In", "values": ["a", "b"] },
                { "key": "legacy", "operator": "DoesNotExist" }
            ]
        }))
        .unwrap();
        assert_eq!(
            selector_string(&selector).as_deref(),
            Some("app=web,tier in (a,b),!legacy")
        );
        assert_eq!(selector_string(&LabelSelector::default()), None);
    }
}
