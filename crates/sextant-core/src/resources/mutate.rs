//! Changes to objects: replace, server-side apply, patch, delete, scale, restart, node and CronJob actions.
//!
//! Every function changes exactly what its caller names; confirmation is the frontend's job. Errors from the API
//! server keep their code (`forbidden`, `conflict`, `invalid`, …) and the server's own text.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Node, Pod};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};
use kube::Api;
use kube::api::{
    DeleteParams, DynamicObject, EvictParams, ListParams, Patch, PatchParams, PostParams,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::get::{
    ResolvedKind, VALUES_HIDDEN_ANNOTATION, ensure_values_present, resolve_kind, to_json,
};
use super::{DrainOptions, DrainPreview, KindRef, ObjectRef, PatchType, PodRef};
use crate::cluster::{CONNECT_TIMEOUT, ClusterManager};
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
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
/// How long one request of a multi-step change ([`apply_yaml`] of several documents, [`drain`]) may take. The limit
/// is per request, not for the whole change: a drain of many pods may take longer, but a server that stops answering
/// ends it with a `timeout` error that says what was already done and what was not sent.
pub const STEP_TIMEOUT: Duration = Duration::from_secs(30);

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
    let params = post_params();
    let saved = api.replace(&doc.name, &params, &obj).await?;
    to_json(saved, &kind.resource)
}

/// Multi-document server-side apply with field manager `sextant`.
///
/// Every document is parsed and its kind resolved before anything is sent, so a typo in the third document
/// changes nothing. Documents are then applied in order; a failure (also a `timeout` after [`STEP_TIMEOUT`] without
/// an answer) names the document, lists what was already applied and what was not sent. Empty documents are skipped;
/// a `kind: List` is applied item by item.
pub async fn apply_yaml(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    yaml: &str,
) -> CoreResult<Vec<ObjectRef>> {
    apply_yaml_within(mgr, cluster, yaml, STEP_TIMEOUT).await
}

async fn apply_yaml_within(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    yaml: &str,
    step: Duration,
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
        let kind = with_timeout(
            step,
            "looking up the kind (nothing was applied)",
            resolve_kind(mgr, cluster, &doc.kind),
        )
        .await
        .map_err(|e| in_document(&label, &doc, e))?;
        targets.push((label, doc, kind));
    }

    let params = PatchParams::apply(FIELD_MANAGER);
    let mut applied: Vec<ObjectRef> = Vec::with_capacity(targets.len());
    let total = targets.len();
    let mut targets = targets.into_iter();
    while let Some((label, mut doc, kind)) = targets.next() {
        let namespace = kind
            .namespaced
            .then(|| doc.namespace_or(&client).to_owned());
        if let Some(meta) = doc.value.get_mut("metadata").and_then(Value::as_object_mut) {
            // Server-side apply rejects a body that sets managedFields (YAML copied from an editor may have them).
            meta.remove("managedFields");
        }
        let api = kind.api(client.clone(), namespace.as_deref());
        let sent = with_timeout(step, "applying it", async {
            api.patch(&doc.name, &params, &Patch::Apply(&doc.value))
                .await
                .map_err(CoreError::from)
        })
        .await;
        if let Err(err) = sent {
            let mut err = in_document(&label, &doc, err);
            if !applied.is_empty() {
                let done: Vec<String> = applied.iter().map(describe_ref).collect();
                err.message
                    .push_str(&format!(" (already applied: {})", done.join(", ")));
            }
            if applied.len() + 1 < total {
                let rest: Vec<String> = targets
                    .map(|(label, doc, _)| format!("{label} ({} {})", doc.kind.kind, doc.name))
                    .collect();
                err.message
                    .push_str(&format!(" (not sent: {})", rest.join(", ")));
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

/// Patches one object of any kind (an annotation, `spec.suspend`, an operation of a GitOps object), signed by
/// [`FIELD_MANAGER`]; returns the object as saved, through `to_json` (a Secret without its values).
///
/// A merge patch must be an object and a JSON patch a list of operations, otherwise `invalid`. A patch that names
/// `VALUES_HIDDEN_ANNOTATION` is refused: that marker belongs to Secrets sent without their values.
pub async fn patch(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    patch: &Value,
    patch_type: PatchType,
) -> CoreResult<Value> {
    let hidden_path = VALUES_HIDDEN_ANNOTATION.replace('/', "~1");
    let text = patch.to_string();
    if text.contains(VALUES_HIDDEN_ANNOTATION) || text.contains(&hidden_path) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("a patch cannot set the annotation {VALUES_HIDDEN_ANNOTATION}"),
        ));
    }
    let body = match patch_type {
        PatchType::Merge if patch.is_object() => Patch::Merge(patch),
        PatchType::Merge => {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                "a merge patch must be a JSON object",
            ));
        }
        PatchType::Json => Patch::Json(serde_json::from_value(patch.clone()).map_err(|err| {
            CoreError::new(
                ErrorCode::Invalid,
                format!("a JSON patch must be a list of operations: {err}"),
            )
        })?),
    };
    let (api, kind) = object_api(mgr, cluster, r).await?;
    let saved = api.patch(&r.name, &patch_params(), &body).await?;
    to_json(saved, &kind.resource)
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
    api.patch_scale(&r.name, &patch_params(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// Rollout restart: patches `kubectl.kubernetes.io/restartedAt` on the pod template.
pub async fn restart(mgr: &ClusterManager, cluster: &ClusterId, r: &ObjectRef) -> CoreResult<()> {
    ensure_kind(r, "apps", &["Deployment", "StatefulSet", "DaemonSet"])?;
    let (api, _) = object_api(mgr, cluster, r).await?;
    let patch = restart_patch(&now_rfc3339());
    api.patch(&r.name, &patch_params(), &Patch::Merge(&patch))
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
        .patch(node, &patch_params(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

/// What a drain of `node` would do with each of its pods, like `kubectl drain --dry-run`. Changes nothing.
pub async fn drain_preview(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    node: &str,
) -> CoreResult<DrainPreview> {
    let pods = pods_on_node(mgr.client(cluster)?, node).await?;
    Ok(preview_of(&pods))
}

/// Cordon + eviction, like `kubectl drain`: pods of DaemonSets and mirror pods stay; pods without a controller are
/// evicted only with `options.force` (nothing would recreate them), pods with `emptyDir` volumes only with
/// `options.delete_empty_dir_data` (the data is lost). The pods are looked at again here, so a pod that appeared
/// after the preview is never evicted without the option it needs.
///
/// Every pod is tried, also after one fails. Pods left on the node — refused by the server (e.g. "Cannot evict pod
/// as it would violate the pod's disruption budget.") or kept for want of an option — make the drain fail with
/// a message that names each of them and why. The node stays cordoned. Does not wait for the evicted pods to
/// terminate.
///
/// Each request is limited to [`STEP_TIMEOUT`]; an eviction without an answer stops the drain with a `timeout` error
/// that names the pods already evicted and the pods not sent.
pub async fn drain(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    node: &str,
    options: DrainOptions,
) -> CoreResult<()> {
    drain_within(mgr, cluster, node, options, STEP_TIMEOUT).await
}

async fn drain_within(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    node: &str,
    options: DrainOptions,
    step: Duration,
) -> CoreResult<()> {
    with_timeout(
        step,
        &format!("cordoning node {node} (no pod was evicted)"),
        cordon(mgr, cluster, node, true),
    )
    .await?;
    let client = eviction_client(mgr, cluster).await?;
    let pods = with_timeout(
        step,
        &format!("listing the pods of node {node} (it is cordoned, no pod was evicted)"),
        pods_on_node(client.clone(), node),
    )
    .await?;

    let mut failures: Vec<(ErrorCode, String)> = Vec::new();
    let mut kept: Vec<String> = Vec::new();
    let mut evicted: Vec<String> = Vec::new();
    let mut queue = pods.iter().filter_map(drain_class);
    while let Some(pod) = queue.next() {
        let name = format!("{}/{}", pod.pod.namespace, pod.pod.name);
        if pod.daemon_set {
            continue;
        }
        let needs = pod.missing_options(options);
        if !needs.is_empty() {
            kept.push(format!("{name}: {}", needs.join("; ")));
            continue;
        }
        let api: Api<Pod> = Api::namespaced(client.clone(), &pod.pod.namespace);
        let params = EvictParams {
            post_options: post_params(),
            ..EvictParams::default()
        };
        let answer = tokio::time::timeout(step, api.evict(&pod.pod.name, &params)).await;
        let Ok(answer) = answer else {
            // The server stopped answering: the rest is not sent.
            let rest: Vec<String> = queue
                .filter(|p| !p.daemon_set && p.missing_options(options).is_empty())
                .map(|p| format!("{}/{}", p.pod.namespace, p.pod.name))
                .collect();
            let list = |items: &[String]| {
                if items.is_empty() {
                    "none".to_owned()
                } else {
                    items.join(", ")
                }
            };
            let mut message = format!(
                "node {node} is cordoned, but the eviction of {name} got no answer in {} s (it may still happen); \
                 evicted: {}; not sent: {}",
                step.as_secs(),
                list(&evicted),
                list(&rest)
            );
            let earlier: Vec<String> = failures
                .into_iter()
                .map(|(_, text)| text)
                .chain(kept)
                .collect();
            if !earlier.is_empty() {
                message.push_str(&format!("; could not be evicted: {}", earlier.join("; ")));
            }
            return Err(CoreError::new(ErrorCode::Timeout, message));
        };
        match answer {
            Ok(_) => evicted.push(name),
            Err(err) => {
                let err = CoreError::from(err);
                if err.code != ErrorCode::NotFound {
                    failures.push((err.code, format!("{name}: {}", err.message)));
                }
            }
        }
    }
    if failures.is_empty() && kept.is_empty() {
        return Ok(());
    }
    let code = failures.first().map_or(ErrorCode::Other, |(code, _)| *code);
    let count = failures.len() + kept.len();
    let reasons: Vec<String> = failures
        .into_iter()
        .map(|(_, text)| text)
        .chain(kept)
        .collect();
    Err(CoreError::new(
        code,
        format!(
            "node {node} is cordoned, but {count} pod(s) could not be evicted: {}",
            reasons.join("; ")
        ),
    ))
}

/// Creates a Job from the CronJob's template, named `<cronjob>-manual-<unix seconds>`.
pub async fn trigger_cronjob(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
) -> CoreResult<ObjectRef> {
    ensure_kind(r, "batch", &["CronJob"])?;
    let namespace = r.required_namespace()?;
    let client = mgr.client(cluster)?;
    let cronjobs: Api<CronJob> = Api::namespaced(client.clone(), namespace);
    let cronjob = cronjobs.get(&r.name).await?;
    let job = job_from_cronjob(&cronjob, &manual_job_name(&r.name, unix_seconds()));
    let jobs: Api<Job> = Api::namespaced(client, namespace);
    let params = post_params();
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
    let namespace = r.required_namespace()?;
    let cronjobs: Api<CronJob> = Api::namespaced(mgr.client(cluster)?, namespace);
    let patch = json!({ "spec": { "suspend": suspend } });
    cronjobs
        .patch(&r.name, &patch_params(), &Patch::Merge(&patch))
        .await?;
    Ok(())
}

// ---------- helpers ----------

/// Parameters of a merge patch, signed by [`FIELD_MANAGER`].
fn patch_params() -> PatchParams {
    PatchParams {
        field_manager: Some(FIELD_MANAGER.to_owned()),
        ..PatchParams::default()
    }
}

/// Parameters of a create or replace, signed by [`FIELD_MANAGER`].
fn post_params() -> PostParams {
    PostParams {
        field_manager: Some(FIELD_MANAGER.to_owned()),
        ..PostParams::default()
    }
}

/// A client for the cluster that does not retry `429 Too Many Requests`.
///
/// The API server refuses an eviction that a PodDisruptionBudget forbids with 429. The connection's client retries
/// 429 (kube's default: up to 15 times with growing pauses), so a drain would hang for minutes before reporting the
/// budget — and would even report success if the pod disappeared meanwhile. Evictions are therefore sent once.
/// Connecting may take as long as for the connection's client ([`CONNECT_TIMEOUT`]).
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
    config.connect_timeout = Some(CONNECT_TIMEOUT);
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
        ensure_values_present(&value)?;
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
    if kind.namespaced {
        r.required_namespace()?;
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

/// Every pod scheduled to `node`, in every namespace.
async fn pods_on_node(client: kube::Client, node: &str) -> CoreResult<Vec<Pod>> {
    let pods: Api<Pod> = Api::all(client);
    let list = pods
        .list(&ListParams::default().fields(&format!("spec.nodeName={node}")))
        .await?;
    Ok(list.items)
}

/// How a drain treats one pod.
struct DrainPod {
    pod: PodRef,
    /// Owned by a DaemonSet: never evicted (its controller would put it back at once).
    daemon_set: bool,
    /// No controller: nothing recreates it after an eviction.
    unmanaged: bool,
    /// Has an `emptyDir` volume: its data is gone after an eviction.
    empty_dir: bool,
}

impl DrainPod {
    /// Why `options` do not allow evicting this pod; empty when they do.
    fn missing_options(&self, options: DrainOptions) -> Vec<&'static str> {
        let mut needs = Vec::new();
        if self.unmanaged && !options.force {
            needs.push("it has no controller, evicted only with force");
        }
        if self.empty_dir && !options.delete_empty_dir_data {
            needs.push("it has emptyDir data, evicted only with delete emptyDir data");
        }
        needs
    }
}

/// `None` for pods a drain does not touch at all: mirror pods of static pods (evicting them does nothing) and pods
/// already being deleted. Like `kubectl drain`, any controller counts, whatever its kind.
fn drain_class(pod: &Pod) -> Option<DrainPod> {
    let meta = &pod.metadata;
    let mirror = meta
        .annotations
        .as_ref()
        .is_some_and(|a| a.contains_key(MIRROR_ANNOTATION));
    if mirror || meta.deletion_timestamp.is_some() {
        return None;
    }
    let controller = meta
        .owner_references
        .iter()
        .flatten()
        .find(|o| o.controller == Some(true));
    let empty_dir = pod
        .spec
        .as_ref()
        .and_then(|spec| spec.volumes.as_ref())
        .is_some_and(|volumes| volumes.iter().any(|v| v.empty_dir.is_some()));
    Some(DrainPod {
        pod: PodRef {
            namespace: meta.namespace.clone().unwrap_or_default(),
            name: meta.name.clone().unwrap_or_default(),
        },
        daemon_set: controller.is_some_and(|o| o.kind == "DaemonSet"),
        unmanaged: controller.is_none(),
        empty_dir,
    })
}

/// The pods of a node sorted into the lists of [`DrainPreview`]. A pod without a controller that has `emptyDir`
/// data is in both `unmanaged` and `empty_dir`: it needs both options. Each list is sorted by namespace and name.
fn preview_of(pods: &[Pod]) -> DrainPreview {
    let mut preview = DrainPreview::default();
    for pod in pods.iter().filter_map(drain_class) {
        if pod.daemon_set {
            preview.daemon_set.push(pod.pod);
            continue;
        }
        if !pod.unmanaged && !pod.empty_dir {
            preview.evict.push(pod.pod);
            continue;
        }
        if pod.unmanaged {
            preview.unmanaged.push(pod.pod.clone());
        }
        if pod.empty_dir {
            preview.empty_dir.push(pod.pod);
        }
    }
    let by_name = |a: &PodRef, b: &PodRef| (&a.namespace, &a.name).cmp(&(&b.namespace, &b.name));
    for list in [
        &mut preview.evict,
        &mut preview.unmanaged,
        &mut preview.empty_dir,
        &mut preview.daemon_set,
    ] {
        list.sort_by(by_name);
    }
    preview
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::connected_to;

    fn pod(name: &str, extra: Value) -> Pod {
        let mut value = json!({ "metadata": { "name": name, "namespace": "ns" } });
        if let (Some(meta), Some(more)) = (
            value["metadata"].as_object_mut(),
            extra.get("metadata").and_then(Value::as_object),
        ) {
            meta.extend(more.clone());
        }
        if let Some(spec) = extra.get("spec") {
            value["spec"] = spec.clone();
        }
        serde_json::from_value(value).unwrap()
    }

    fn pod_ref(name: &str) -> PodRef {
        PodRef {
            namespace: "ns".into(),
            name: name.into(),
        }
    }

    #[test]
    fn the_preview_sorts_pods_like_kubectl_drain() {
        let controlled = |kind: &str| {
            json!({ "metadata": { "ownerReferences": [
                { "apiVersion": "apps/v1", "kind": kind, "name": "owner", "uid": "1", "controller": true }
            ] } })
        };
        let with_volume = |mut value: Value| {
            value["spec"] =
                json!({ "containers": [], "volumes": [{ "name": "v", "emptyDir": {} }] });
            value
        };
        let pods = vec![
            pod("replica", controlled("ReplicaSet")),
            pod("plain", json!({})),
            pod("daemon", controlled("DaemonSet")),
            pod("cache", with_volume(controlled("StatefulSet"))),
            pod("scratch", with_volume(json!({}))),
            pod(
                "owned-not-controlled",
                json!({ "metadata": { "ownerReferences": [
                    { "apiVersion": "v1", "kind": "ConfigMap", "name": "c", "uid": "3" }
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
        let preview = preview_of(&pods);
        assert_eq!(preview.evict, [pod_ref("replica")]);
        assert_eq!(
            preview.unmanaged,
            [
                pod_ref("owned-not-controlled"),
                pod_ref("plain"),
                pod_ref("scratch")
            ]
        );
        assert_eq!(preview.empty_dir, [pod_ref("cache"), pod_ref("scratch")]);
        assert_eq!(preview.daemon_set, [pod_ref("daemon")]);
    }

    /// A fake API server on localhost (plain HTTP) for the multi-step changes: discovery of pods, nodes and
    /// ConfigMaps; node `n1` with pods `ns/a`, `ns/b`, `ns/c` (all controlled by a ReplicaSet). The eviction of `b`
    /// and the apply of ConfigMap `two` never get an answer. Every request is recorded.
    mod fake {
        use crate::fake_api::{FakeApi, Reply, Request};

        const API_VERSIONS: &str =
            r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
        const CORE_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[
            {"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["get","list","watch"]},
            {"name":"nodes","singularName":"node","namespaced":false,"kind":"Node","verbs":["get","list","patch"]},
            {"name":"configmaps","singularName":"configmap","namespaced":true,"kind":"ConfigMap","verbs":["get","patch"]}]}"#;
        const API_GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#;
        const NODE: &str = r#"{"apiVersion":"v1","kind":"Node","metadata":{"name":"n1"},"spec":{"unschedulable":true}}"#;
        const EVICTED: &str = r#"{"kind":"Status","apiVersion":"v1","status":"Success"}"#;

        fn pod_list() -> String {
            let pod = |name: &str| {
                format!(
                    r#"{{"metadata":{{"name":"{name}","namespace":"ns","uid":"uid-{name}","ownerReferences":[{{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"rs","uid":"rs","controller":true}}]}},"spec":{{"nodeName":"n1","containers":[]}}}}"#
                )
            };
            format!(
                r#"{{"apiVersion":"v1","kind":"PodList","metadata":{{"resourceVersion":"1"}},"items":[{},{},{}]}}"#,
                pod("a"),
                pod("b"),
                pod("c")
            )
        }

        fn config_map(name: &str) -> String {
            format!(
                r#"{{"apiVersion":"v1","kind":"ConfigMap","metadata":{{"name":"{name}","namespace":"ns"}}}}"#
            )
        }

        fn answer(req: &Request) -> Reply {
            match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/api") => Reply::json(200, API_VERSIONS),
                ("GET", "/api/v1") => Reply::json(200, CORE_RESOURCES),
                ("GET", "/apis") => Reply::json(200, API_GROUPS),
                ("PATCH", "/api/v1/nodes/n1") => Reply::json(200, NODE),
                ("GET", "/api/v1/pods") => Reply::json(200, pod_list()),
                ("POST", "/api/v1/namespaces/ns/pods/b/eviction")
                | ("PATCH", "/api/v1/namespaces/ns/configmaps/two") => Reply::hang(),
                ("POST", p) if p.ends_with("/eviction") => Reply::json(201, EVICTED),
                ("PATCH", p) if p.starts_with("/api/v1/namespaces/ns/configmaps/") => {
                    Reply::json(200, config_map(p.rsplit('/').next().unwrap_or_default()))
                }
                _ => Reply::not_found(),
            }
        }

        pub async fn server() -> FakeApi {
            FakeApi::start(answer).await
        }

        /// The request lines so far ("PATCH /api/v1/nodes/n1").
        pub fn lines(api: &FakeApi) -> Vec<String> {
            api.requests().iter().map(Request::line).collect()
        }
    }

    /// Short enough for a test, long enough for a local answer.
    const TEST_STEP: Duration = Duration::from_millis(500);

    #[tokio::test]
    async fn a_drain_cut_by_the_timeout_names_the_evicted_pods_and_the_pods_not_sent() {
        let api = fake::server().await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            drain_within(&mgr, &id, "n1", DrainOptions::default(), TEST_STEP),
        )
        .await
        .expect("the drain hung");
        let err = result.unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout, "{err}");
        assert!(err.message.contains("eviction of ns/b"), "{err}");
        assert!(err.message.contains("evicted: ns/a;"), "{err}");
        assert!(err.message.contains("not sent: ns/c"), "{err}");
        let requests = fake::lines(&api);
        assert!(
            !requests.contains(&"POST /api/v1/namespaces/ns/pods/c/eviction".to_owned()),
            "{requests:?}"
        );
    }

    #[tokio::test]
    async fn an_apply_cut_by_the_timeout_names_what_was_applied_and_what_was_not_sent() {
        let api = fake::server().await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let yaml = ["one", "two", "three"]
            .map(|name| {
                format!(
                    "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {name}\n  namespace: ns\n"
                )
            })
            .join("---\n");
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            apply_yaml_within(&mgr, &id, &yaml, TEST_STEP),
        )
        .await
        .expect("the apply hung");
        let err = result.unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout, "{err}");
        assert!(
            err.message.starts_with("document 2 (ConfigMap two)"),
            "{err}"
        );
        assert!(
            err.message.contains("(already applied: ConfigMap ns/one)"),
            "{err}"
        );
        assert!(
            err.message
                .contains("(not sent: document 3 (ConfigMap three))"),
            "{err}"
        );
        let requests = fake::lines(&api);
        assert!(
            !requests.contains(&"PATCH /api/v1/namespaces/ns/configmaps/three".to_owned()),
            "{requests:?}"
        );
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
