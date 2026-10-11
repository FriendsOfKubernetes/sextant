//! Changes to objects: replace, server-side apply, delete, scale, restart, node and CronJob actions.
//!
//! Every function changes exactly what its caller names; confirmation is the frontend's job. Errors from the API
//! server keep their code (`forbidden`, `conflict`, `invalid`, …) and the server's own text.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Node, Pod};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};
use kube::Api;
use kube::api::{
    DeleteParams, DynamicObject, EvictParams, ListParams, Patch, PatchParams, PostParams,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::get::{ResolvedKind, resolve_kind, to_json};
use super::{KindRef, ObjectRef};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// Field manager of every change Sextant makes (server-side apply and updates).
pub const FIELD_MANAGER: &str = "sextant";
/// Pod template annotation `kubectl rollout restart` sets; a new value rolls the pods.
pub const RESTARTED_AT_ANNOTATION: &str = "kubectl.kubernetes.io/restartedAt";
/// Static pods have a read-only "mirror" in the API; evicting it does nothing.
const MIRROR_ANNOTATION: &str = "kubernetes.io/config.mirror";
/// The annotation `kubectl create job --from=cronjob/…` puts on a Job started by hand.
const INSTANTIATE_ANNOTATION: &str = "cronjob.kubernetes.io/instantiate";
/// Longest name of a Job (its name goes into a pod label).
const MAX_JOB_NAME: usize = 63;

/// PUT of an edited object; a stale `resourceVersion` gives `Conflict`.
///
/// The YAML must carry `metadata.resourceVersion` (the editor keeps the one it loaded): without it the server would
/// overwrite whatever changed since, which is exactly what must not happen silently.
pub async fn replace_yaml(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    yaml: &str,
) -> CoreResult<Value> {
    let value: Value = serde_yaml::from_str(yaml)?;
    let doc = Document::from_value(value)?;
    if doc
        .value
        .pointer("/metadata/resourceVersion")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "metadata.resourceVersion is missing: it is needed to detect changes made in the cluster since the \
             object was loaded",
        ));
    }
    let client = mgr.client(cluster)?;
    let kind = resolve_kind(mgr, cluster, &doc.kind).await?;
    let api = kind.api(client.clone(), Some(doc.namespace_or(&client)));
    let obj: DynamicObject = serde_json::from_value(doc.value)?;
    let params = PostParams {
        field_manager: Some(FIELD_MANAGER.to_owned()),
        ..PostParams::default()
    };
    let saved = api.replace(&doc.name, &params, &obj).await?;
    to_json(saved, &kind.resource)
}

/// Multi-document server-side apply with field manager `sextant`.
///
/// Every document is parsed and its kind resolved before anything is sent, so a typo in the third document
/// changes nothing. Documents are then applied in order; a failure names the document and lists what was already
/// applied. Empty documents are skipped; a `kind: List` is applied item by item.
pub async fn apply_yaml(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    yaml: &str,
) -> CoreResult<Vec<ObjectRef>> {
    let docs = parse_documents(yaml)?;
    if docs.is_empty() {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "the text has no objects to apply",
        ));
    }
    let client = mgr.client(cluster)?;
    let mut targets = Vec::with_capacity(docs.len());
    for (label, doc) in docs {
        let kind = resolve_kind(mgr, cluster, &doc.kind)
            .await
            .map_err(|e| in_document(&label, &doc, e))?;
        targets.push((label, doc, kind));
    }

    let params = PatchParams::apply(FIELD_MANAGER);
    let mut applied: Vec<ObjectRef> = Vec::with_capacity(targets.len());
    for (label, mut doc, kind) in targets {
        let namespace = kind
            .namespaced
            .then(|| doc.namespace_or(&client).to_owned());
        if let Some(meta) = doc.value.get_mut("metadata").and_then(Value::as_object_mut) {
            // Server-side apply rejects a body that sets managedFields (YAML copied from an editor may have them).
            meta.remove("managedFields");
        }
        let api = kind.api(client.clone(), namespace.as_deref());
        if let Err(err) = api
            .patch(&doc.name, &params, &Patch::Apply(&doc.value))
            .await
        {
            let mut err = in_document(&label, &doc, err.into());
            if !applied.is_empty() {
                let done: Vec<String> = applied.iter().map(describe_ref).collect();
                err.message
                    .push_str(&format!(" (already applied: {})", done.join(", ")));
            }
            return Err(err);
        }
        applied.push(ObjectRef {
            kind: doc.kind,
            namespace,
            name: doc.name,
        });
    }
    Ok(applied)
}

/// Deletes one object; dependents (a Deployment's ReplicaSets and pods) are removed in the background.
pub async fn delete(mgr: &ClusterManager, cluster: &ClusterId, r: &ObjectRef) -> CoreResult<()> {
    let (api, _) = object_api(mgr, cluster, r).await?;
    api.delete(&r.name, &DeleteParams::background()).await?;
    Ok(())
}

/// Sets the replica count through the `scale` subresource (Deployment, StatefulSet, ReplicaSet, scalable CRs).
pub async fn scale(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    replicas: i32,
) -> CoreResult<()> {
    if replicas < 0 {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("the number of replicas cannot be negative ({replicas})"),
        ));
    }
    let (api, _) = object_api(mgr, cluster, r).await?;
    let patch = json!({ "spec": { "replicas": replicas } });
    api.patch_scale(&r.name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// Rollout restart: patches `kubectl.kubernetes.io/restartedAt` on the pod template.
pub async fn restart(mgr: &ClusterManager, cluster: &ClusterId, r: &ObjectRef) -> CoreResult<()> {
    ensure_kind(r, "apps", &["Deployment", "StatefulSet", "DaemonSet"])?;
    let (api, _) = object_api(mgr, cluster, r).await?;
    let patch = restart_patch(&now_rfc3339());
    api.patch(
        &r.name,
        &PatchParams {
            field_manager: Some(FIELD_MANAGER.to_owned()),
            ..PatchParams::default()
        },
        &Patch::Merge(&patch),
    )
    .await?;
    Ok(())
}

/// Marks a node (un)schedulable.
pub async fn cordon(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    node: &str,
    unschedulable: bool,
) -> CoreResult<()> {
    let nodes: Api<Node> = Api::all(mgr.client(cluster)?);
    let patch = json!({ "spec": { "unschedulable": unschedulable } });
    nodes
        .patch(node, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// Cordon + eviction of every pod except DaemonSet-owned and mirror pods.
///
/// Every pod is tried, also after one fails; the error lists each pod that was not evicted with the server's reason
/// (e.g. "Cannot evict pod as it would violate the pod's disruption budget."). The node stays cordoned. Does not
/// wait for the evicted pods to terminate.
pub async fn drain(mgr: &ClusterManager, cluster: &ClusterId, node: &str) -> CoreResult<()> {
    cordon(mgr, cluster, node, true).await?;
    let client = eviction_client(mgr, cluster).await?;
    let pods: Api<Pod> = Api::all(client.clone());
    let on_node = pods
        .list(&ListParams::default().fields(&format!("spec.nodeName={node}")))
        .await?;

    let mut failures: Vec<(ErrorCode, String)> = Vec::new();
    for pod in pods_to_evict(&on_node.items) {
        let (Some(namespace), Some(name)) = (&pod.metadata.namespace, &pod.metadata.name) else {
            continue;
        };
        let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
        match api.evict(name, &EvictParams::default()).await {
            Ok(_) => {}
            Err(err) => {
                let err = CoreError::from(err);
                if err.code != ErrorCode::NotFound {
                    failures.push((err.code, format!("{namespace}/{name}: {}", err.message)));
                }
            }
        }
    }
    match failures.first() {
        None => Ok(()),
        Some((code, _)) => {
            let reasons: Vec<&str> = failures.iter().map(|(_, text)| text.as_str()).collect();
            Err(CoreError::new(
                *code,
                format!(
                    "node {node} is cordoned, but {} pod(s) could not be evicted: {}",
                    failures.len(),
                    reasons.join("; ")
                ),
            ))
        }
    }
}

/// Creates a Job from the CronJob's template, named `<cronjob>-manual-<unix seconds>`.
pub async fn trigger_cronjob(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
) -> CoreResult<ObjectRef> {
    ensure_kind(r, "batch", &["CronJob"])?;
    let namespace = required_namespace(r)?;
    let client = mgr.client(cluster)?;
    let cronjobs: Api<CronJob> = Api::namespaced(client.clone(), namespace);
    let cronjob = cronjobs.get(&r.name).await?;
    let job = job_from_cronjob(&cronjob, &manual_job_name(&r.name, unix_seconds()));
    let jobs: Api<Job> = Api::namespaced(client, namespace);
    let params = PostParams {
        field_manager: Some(FIELD_MANAGER.to_owned()),
        ..PostParams::default()
    };
    let created = jobs.create(&params, &job).await?;
    Ok(ObjectRef {
        kind: KindRef {
            group: "batch".into(),
            version: "v1".into(),
            kind: "Job".into(),
        },
        namespace: Some(namespace.to_owned()),
        name: created.metadata.name.unwrap_or_default(),
    })
}

/// Sets `spec.suspend` of a CronJob.
pub async fn suspend_cronjob(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    suspend: bool,
) -> CoreResult<()> {
    ensure_kind(r, "batch", &["CronJob"])?;
    let namespace = required_namespace(r)?;
    let cronjobs: Api<CronJob> = Api::namespaced(mgr.client(cluster)?, namespace);
    let patch = json!({ "spec": { "suspend": suspend } });
    cronjobs
        .patch(&r.name, &PatchParams::default(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

// ---------- helpers ----------

/// A client for the cluster that does not retry `429 Too Many Requests`.
///
/// The API server refuses an eviction that a PodDisruptionBudget forbids with 429. The connection's client retries
/// 429 (kube's default: up to 15 times with growing pauses), so a drain would hang for minutes before reporting the
/// budget — and would even report success if the pod disappeared meanwhile. Evictions are therefore sent once.
async fn eviction_client(mgr: &ClusterManager, cluster: &ClusterId) -> CoreResult<kube::Client> {
    // Only for a connected cluster, like every other action.
    mgr.client(cluster)?;
    let kubeconfig = {
        let registry = mgr.registry();
        let registry = registry.read().unwrap_or_else(|e| e.into_inner());
        registry.kubeconfig_for(cluster)?
    };
    let options = kube::config::KubeConfigOptions {
        context: kubeconfig.current_context.clone(),
        ..Default::default()
    };
    let mut config = kube::Config::from_custom_kubeconfig(kubeconfig, &options).await?;
    config.default_retry = false;
    Ok(kube::Client::try_from(config)?)
}

/// One object from YAML: its JSON, kind and name.
#[derive(Debug, Clone)]
struct Document {
    value: Value,
    kind: KindRef,
    name: String,
    namespace: Option<String>,
}

impl Document {
    fn from_value(value: Value) -> CoreResult<Self> {
        let Some(map) = value.as_object() else {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                "expected an object with apiVersion, kind and metadata",
            ));
        };
        let text = |key: &str| map.get(key).and_then(Value::as_str).unwrap_or_default();
        let (api_version, kind) = (text("apiVersion"), text("kind"));
        if api_version.is_empty() || kind.is_empty() {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                "apiVersion and kind are required",
            ));
        }
        let meta = |key: &str| {
            value
                .pointer(&format!("/metadata/{key}"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let Some(name) = meta("name") else {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!("{kind}: metadata.name is required"),
            ));
        };
        let namespace = meta("namespace");
        Ok(Self {
            kind: kind_ref(api_version, kind),
            name,
            namespace,
            value,
        })
    }

    /// The object's namespace, or the context's default namespace when the YAML has none.
    fn namespace_or<'a>(&'a self, client: &'a kube::Client) -> &'a str {
        self.namespace
            .as_deref()
            .unwrap_or_else(|| client.default_namespace())
    }
}

/// "apps/v1" + "Deployment" → `KindRef { group: "apps", version: "v1", kind: "Deployment" }`; "v1" is the core group.
fn kind_ref(api_version: &str, kind: &str) -> KindRef {
    let (group, version) = api_version.split_once('/').unwrap_or(("", api_version));
    KindRef {
        group: group.to_owned(),
        version: version.to_owned(),
        kind: kind.to_owned(),
    }
}

/// Splits multi-document YAML into objects labelled "document N" (1-based, counting every `---` section) or
/// "document N, item M" for the items of a `List`. Empty documents are skipped.
fn parse_documents(yaml: &str) -> CoreResult<Vec<(String, Document)>> {
    let mut docs = Vec::new();
    for (index, de) in serde_yaml::Deserializer::from_str(yaml).enumerate() {
        let label = format!("document {}", index + 1);
        let value = Value::deserialize(de)
            .map_err(|e| CoreError::new(ErrorCode::Invalid, format!("{label}: {e}")))?;
        if value.is_null() {
            continue;
        }
        let is_list = value
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|k| k.ends_with("List"))
            && value.get("items").is_some_and(Value::is_array);
        if is_list {
            let items = value["items"].as_array().cloned().unwrap_or_default();
            for (i, item) in items.into_iter().enumerate() {
                let label = format!("{label}, item {}", i + 1);
                let doc = Document::from_value(item).map_err(|e| prefixed(&label, e))?;
                docs.push((label, doc));
            }
        } else {
            let doc = Document::from_value(value).map_err(|e| prefixed(&label, e))?;
            docs.push((label, doc));
        }
    }
    Ok(docs)
}

fn prefixed(label: &str, err: CoreError) -> CoreError {
    CoreError::new(err.code, format!("{label}: {}", err.message))
}

/// "document 2 (Deployment web): <reason>".
fn in_document(label: &str, doc: &Document, err: CoreError) -> CoreError {
    prefixed(&format!("{label} ({} {})", doc.kind.kind, doc.name), err)
}

/// "Deployment demo/web", "Namespace demo".
fn describe_ref(r: &ObjectRef) -> String {
    match &r.namespace {
        Some(ns) => format!("{} {ns}/{}", r.kind.kind, r.name),
        None => format!("{} {}", r.kind.kind, r.name),
    }
}

/// The API of the object `r` points to; a namespaced kind without a namespace is `invalid`.
async fn object_api(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
) -> CoreResult<(Api<DynamicObject>, ResolvedKind)> {
    let client = mgr.client(cluster)?;
    let kind = resolve_kind(mgr, cluster, &r.kind).await?;
    if kind.namespaced && r.namespace.as_deref().is_none_or(str::is_empty) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("{} {} needs a namespace", r.kind.kind, r.name),
        ));
    }
    Ok((kind.api(client, r.namespace.as_deref()), kind))
}

fn ensure_kind(r: &ObjectRef, group: &str, kinds: &[&str]) -> CoreResult<()> {
    if r.kind.group == group && kinds.contains(&r.kind.kind.as_str()) {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "this action applies to {} only, not to {}",
                kinds.join(", "),
                r.kind.kind
            ),
        ))
    }
}

fn required_namespace(r: &ObjectRef) -> CoreResult<&str> {
    r.namespace
        .as_deref()
        .filter(|ns| !ns.is_empty())
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::Invalid,
                format!("{} {} needs a namespace", r.kind.kind, r.name),
            )
        })
}

fn restart_patch(at: &str) -> Value {
    json!({
        "spec": { "template": { "metadata": { "annotations": { RESTARTED_AT_ANNOTATION: at } } } }
    })
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// The current time as RFC 3339 in UTC with whole seconds, the format `kubectl rollout restart` writes.
fn now_rfc3339() -> String {
    k8s_openapi::jiff::Timestamp::from_second(unix_seconds())
        .map(|t| t.to_string())
        .unwrap_or_default()
}

/// `<cronjob>-manual-<ts>`, with the CronJob's name shortened so the result fits a Job name.
fn manual_job_name(cronjob: &str, ts: i64) -> String {
    let suffix = format!("-manual-{ts}");
    let room = MAX_JOB_NAME.saturating_sub(suffix.len());
    let base: String = cronjob.chars().take(room).collect();
    format!("{}{suffix}", base.trim_end_matches(['-', '.']))
}

/// A Job built from the CronJob's `jobTemplate`, owned by the CronJob (as `kubectl create job --from` does).
fn job_from_cronjob(cronjob: &CronJob, name: &str) -> Job {
    let template = cronjob.spec.job_template.clone();
    let template_meta = template.metadata.unwrap_or_default();
    let mut annotations: BTreeMap<String, String> = template_meta.annotations.unwrap_or_default();
    annotations.insert(INSTANTIATE_ANNOTATION.to_owned(), "manual".to_owned());
    let owner = match (&cronjob.metadata.name, &cronjob.metadata.uid) {
        (Some(owner_name), Some(uid)) => Some(vec![OwnerReference {
            api_version: "batch/v1".to_owned(),
            kind: "CronJob".to_owned(),
            name: owner_name.clone(),
            uid: uid.clone(),
            controller: Some(true),
            block_owner_deletion: Some(true),
        }]),
        _ => None,
    };
    Job {
        metadata: ObjectMeta {
            name: Some(name.to_owned()),
            namespace: cronjob.metadata.namespace.clone(),
            labels: template_meta.labels,
            annotations: Some(annotations),
            owner_references: owner,
            ..ObjectMeta::default()
        },
        spec: template.spec,
        status: None,
    }
}

/// Pods a drain evicts: all but mirror pods, pods owned by a DaemonSet (its controller would recreate them on the
/// same node at once) and pods already being deleted.
fn pods_to_evict(pods: &[Pod]) -> Vec<&Pod> {
    pods.iter()
        .filter(|pod| {
            let meta = &pod.metadata;
            let mirror = meta
                .annotations
                .as_ref()
                .is_some_and(|a| a.contains_key(MIRROR_ANNOTATION));
            let daemon = meta.owner_references.as_ref().is_some_and(|refs| {
                refs.iter()
                    .any(|o| o.controller == Some(true) && o.kind == "DaemonSet")
            });
            !mirror && !daemon && meta.deletion_timestamp.is_none()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod(name: &str, extra: Value) -> Pod {
        let mut value = json!({ "metadata": { "name": name, "namespace": "ns" } });
        if let (Some(meta), Some(more)) = (
            value["metadata"].as_object_mut(),
            extra.get("metadata").and_then(Value::as_object),
        ) {
            meta.extend(more.clone());
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn drain_skips_daemon_set_mirror_and_terminating_pods() {
        let pods = vec![
            pod("plain", json!({})),
            pod(
                "replica",
                json!({ "metadata": { "ownerReferences": [
                    { "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "rs", "uid": "1", "controller": true }
                ] } }),
            ),
            pod(
                "daemon",
                json!({ "metadata": { "ownerReferences": [
                    { "apiVersion": "apps/v1", "kind": "DaemonSet", "name": "ds", "uid": "2", "controller": true }
                ] } }),
            ),
            pod(
                "mirror",
                json!({ "metadata": { "annotations": { "kubernetes.io/config.mirror": "abc" } } }),
            ),
            pod(
                "leaving",
                json!({ "metadata": { "deletionTimestamp": "2026-10-11T10:00:00Z" } }),
            ),
        ];
        let names: Vec<&str> = pods_to_evict(&pods)
            .iter()
            .filter_map(|p| p.metadata.name.as_deref())
            .collect();
        assert_eq!(names, ["plain", "replica"]);
    }

    #[test]
    fn manual_job_names_fit_63_characters() {
        assert_eq!(
            manual_job_name("hello", 1_760_000_000),
            "hello-manual-1760000000"
        );
        let long = "a".repeat(52);
        let name = manual_job_name(&long, 1_760_000_000);
        assert_eq!(name.len(), 63);
        assert!(name.ends_with("-manual-1760000000"), "{name}");
        // A cut that ends on a dash does not leave a double dash.
        let dashed = format!("{}-{}", "b".repeat(44), "c".repeat(7));
        let name = manual_job_name(&dashed, 1_760_000_000);
        assert!(!name.contains("--"), "{name}");
        assert!(name.len() <= 63);
    }
}
