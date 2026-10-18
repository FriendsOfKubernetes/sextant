//! Change timeline (#145): what the window cannot see in its watches. Watches and `resource_get` strip
//! `metadata.managedFields`, so the window asks here, read-only and bounded:
//!
//! - [`managers`]: the field managers of a few objects (a metadata-only GET each, at most [`MAX_REFS`]), so a change
//!   the window recorded can name who made it (the entries whose `time` moved);
//! - [`history`]: the partial history of namespaces before Sextant was running — the last change of each field
//!   manager of each object (metadata-only lists), the revisions of Deployments (ReplicaSets) and of StatefulSets and
//!   DaemonSets (ControllerRevisions), and Helm release revisions (the release Secrets' metadata, never their data);
//! - [`object_history`]: the same for one object (its managers, its rollout revisions, its Helm release).
//!
//! What this returns is metadata only: names, managers, operations, times, revision numbers. No object body, no Secret
//! data, no manifest. Every request is limited to [`STEP_TIMEOUT`]; a list or a source that cannot be read is in the
//! answer's reports, not a failure.
//!
//! [`save`] and [`load`] keep the window's recorded timeline of one cluster in a file of its own when the user turned
//! persistence on (off by default): at most [`MAX_SAVED_BYTES`], written atomically, with any value of a Secret's
//! keys removed before writing even though the window never records one.
//!
//! A window command only: neither agents nor extensions get any of it.

use std::cmp::Reverse;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use futures::StreamExt;
use k8s_openapi::api::apps::v1::ControllerRevision;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};
use k8s_openapi::jiff::Timestamp;
use kube::Api;
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::helm;
use crate::kubeconfig::ClusterId;
use crate::resources::resolve_kind;
use crate::resources::rollouts::{self, CHANGE_CAUSE_ANNOTATION, REVISION_ANNOTATION};
use crate::resources::{KindRef, ObjectRef, STEP_TIMEOUT};

/// At most this many objects per [`managers`] call.
pub const MAX_REFS: usize = 50;
/// At most this many namespaces per [`history`] call.
pub const MAX_NAMESPACES: usize = 10;
/// At most this many kinds per [`history`] call.
pub const MAX_KINDS: usize = 32;
/// At most this many objects of one kind in one namespace are looked at.
pub const MAX_OBJECTS_PER_LIST: usize = 1000;
/// At most this many entries are returned, the newest first; `truncated` says more were found.
pub const MAX_ENTRIES: usize = 5000;
/// A saved timeline is at most this big.
pub const MAX_SAVED_BYTES: usize = 8 * 1024 * 1024;
/// The format of a saved timeline.
pub const SAVED_VERSION: u64 = 1;
/// Objects per list request.
const PAGE: u32 = 500;
/// Requests sent at the same time.
const PARALLEL: usize = 6;

/// Helm's pseudo-kind of a release, as the agent access model names it.
const HELM_GROUP: &str = "helm.sh";
const HELM_RELEASE_ANNOTATION: &str = "meta.helm.sh/release-name";
const HELM_NAMESPACE_ANNOTATION: &str = "meta.helm.sh/release-namespace";

/// One entry of an object's `metadata.managedFields`, without the fields themselves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FieldManager {
    /// The field manager (`kubectl-client-side-apply`, `helm`, `kustomize-controller`, `sextant`, …).
    pub manager: String,
    /// `Apply` or `Update`.
    pub operation: String,
    /// `status`, `scale`, … when the manager wrote through a subresource.
    pub subresource: Option<String>,
    /// When the manager last changed what it owns (RFC 3339, the cluster's clock).
    pub time: Option<String>,
}

/// The field managers of one object as [`managers`] read them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ObjectManagers {
    pub object: ObjectRef,
    pub uid: Option<String>,
    pub resource_version: Option<String>,
    pub managers: Vec<FieldManager>,
    /// The object could not be read (gone, forbidden, …); `managers` is empty then.
    pub error: Option<CoreError>,
}

/// Where an entry of the partial history comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum HistorySource {
    /// The last change of one field manager of an object (`managedFields[].time`).
    FieldManager,
    /// A rollout revision: a Deployment's ReplicaSet or a StatefulSet's or DaemonSet's ControllerRevision.
    Revision,
    /// A revision of a Helm release.
    HelmRevision,
}

/// One thing the cluster still remembers about a past change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryEntry {
    pub source: HistorySource,
    /// The object that changed: the managed object, the ReplicaSet or ControllerRevision of a revision, or the Helm
    /// release (kind `helm.sh/v3/Release`).
    pub object: ObjectRef,
    pub uid: Option<String>,
    /// RFC 3339, the cluster's clock.
    pub time: String,
    /// `FieldManager`: the manager, its operation and subresource.
    pub manager: Option<String>,
    pub operation: Option<String>,
    pub subresource: Option<String>,
    /// `Revision`: the workload the revision belongs to (its controller).
    pub owner: Option<ObjectRef>,
    /// `Revision`, `HelmRevision`: the revision number.
    pub revision: Option<i64>,
    /// `HelmRevision`: the release status of that revision (`deployed`, `superseded`, `failed`, …).
    pub status: Option<String>,
    /// `Revision`: `kubernetes.io/change-cause`, when set.
    pub change_cause: Option<String>,
}

/// How one list or source went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryReport {
    /// The kind listed (`apps/Deployment`), or `helm` for release revisions, or `rollout` for an object's revisions.
    pub what: String,
    /// The namespace, if the list was of one.
    pub namespace: Option<String>,
    /// Why it could not be read; `None` when it was.
    pub error: Option<CoreError>,
    /// More objects than [`MAX_OBJECTS_PER_LIST`].
    pub truncated: bool,
}

/// What the cluster tells about changes made before Sextant was watching: partial by nature.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PartialHistory {
    /// Newest first.
    pub entries: Vec<HistoryEntry>,
    /// More than [`MAX_ENTRIES`] were found; the oldest were left out.
    pub truncated: bool,
    pub reports: Vec<HistoryReport>,
}

/// A DNS-1123 name: lowercase letters, digits and `-` (and `.` when `dots`), alphanumeric at both ends.
fn is_dns_name(text: &str, max: usize, dots: bool) -> bool {
    let bytes = text.as_bytes();
    let alnum = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= max
        && bytes.first().is_some_and(alnum)
        && bytes.last().is_some_and(alnum)
        && bytes
            .iter()
            .all(|b| alnum(b) || *b == b'-' || (dots && *b == b'.'))
}

/// Namespaces.
fn is_dns_label(text: &str) -> bool {
    is_dns_name(text, 63, false)
}

/// Helm release names.
fn is_dns_subdomain(text: &str) -> bool {
    is_dns_name(text, 253, true)
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// Group, version and kind of plain characters (no path separators or query characters).
fn plain(part: &str) -> bool {
    part.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

fn check_kind(kind: &KindRef) -> CoreResult<()> {
    if kind.version.is_empty()
        || kind.kind.is_empty()
        || !plain(&kind.group)
        || !plain(&kind.version)
        || !plain(&kind.kind)
    {
        return Err(invalid(format!(
            "not a kind: {}/{}/{}",
            kind.group, kind.version, kind.kind
        )));
    }
    Ok(())
}

fn check_ref(r: &ObjectRef) -> CoreResult<()> {
    check_kind(&r.kind)?;
    if r.name.is_empty() || r.name.len() > 253 || r.name.contains('/') {
        return Err(invalid(format!("not an object name: {}", r.name)));
    }
    if let Some(ns) = r.namespace.as_deref().filter(|ns| !ns.is_empty()) {
        check_namespace(ns)?;
    }
    Ok(())
}

fn check_namespace(namespace: &str) -> CoreResult<()> {
    if is_dns_label(namespace) {
        Ok(())
    } else {
        Err(invalid(
            "a namespace is a DNS-1123 label (lowercase letters, digits and '-')",
        ))
    }
}

/// Checks the arguments of [`managers`] before anything is sent.
pub fn check_refs(refs: &[ObjectRef]) -> CoreResult<()> {
    if refs.len() > MAX_REFS {
        return Err(invalid(format!("at most {MAX_REFS} objects at once")));
    }
    refs.iter().try_for_each(check_ref)
}

/// Checks the arguments of [`history`] before anything is sent.
pub fn check_history_request(namespaces: &[String], kinds: &[KindRef]) -> CoreResult<()> {
    if namespaces.is_empty() || namespaces.len() > MAX_NAMESPACES {
        return Err(invalid(format!("1 to {MAX_NAMESPACES} namespaces")));
    }
    namespaces.iter().try_for_each(|ns| check_namespace(ns))?;
    if kinds.len() > MAX_KINDS {
        return Err(invalid(format!("at most {MAX_KINDS} kinds")));
    }
    kinds.iter().try_for_each(check_kind)
}

fn time_text(t: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Time) -> String {
    t.0.to_string()
}

/// The field managers of `meta`, without the fields.
fn field_managers(meta: &ObjectMeta) -> Vec<FieldManager> {
    meta.managed_fields
        .iter()
        .flatten()
        .map(|entry| FieldManager {
            manager: entry.manager.clone().unwrap_or_default(),
            operation: entry.operation.clone().unwrap_or_default(),
            subresource: entry.subresource.clone().filter(|s| !s.is_empty()),
            time: entry.time.as_ref().map(time_text),
        })
        .collect()
}

fn ref_of(kind: &KindRef, meta: &ObjectMeta) -> ObjectRef {
    ObjectRef {
        kind: kind.clone(),
        namespace: meta.namespace.clone(),
        name: meta.name.clone().unwrap_or_default(),
    }
}

/// The last change of each manager of an object, as history entries. Writes through `status` are left out: they
/// are a controller reporting, not a change of what the object asks for.
fn manager_entries(kind: &KindRef, meta: &ObjectMeta) -> Vec<HistoryEntry> {
    field_managers(meta)
        .into_iter()
        .filter(|m| m.subresource.as_deref() != Some("status"))
        .filter_map(|m| {
            Some(HistoryEntry {
                source: HistorySource::FieldManager,
                object: ref_of(kind, meta),
                uid: meta.uid.clone(),
                time: m.time?,
                manager: Some(m.manager),
                operation: Some(m.operation),
                subresource: m.subresource,
                owner: None,
                revision: None,
                status: None,
                change_cause: None,
            })
        })
        .collect()
}

/// The controller of an object as a reference in the object's namespace.
fn controller_of(meta: &ObjectMeta) -> Option<ObjectRef> {
    let owner: &OwnerReference = meta
        .owner_references
        .iter()
        .flatten()
        .find(|o| o.controller == Some(true))?;
    let (group, version) = match owner.api_version.split_once('/') {
        Some((group, version)) => (group.to_owned(), version.to_owned()),
        None => (String::new(), owner.api_version.clone()),
    };
    Some(ObjectRef {
        kind: KindRef {
            group,
            version,
            kind: owner.kind.clone(),
        },
        namespace: meta.namespace.clone(),
        name: owner.name.clone(),
    })
}

fn annotation<'a>(meta: &'a ObjectMeta, key: &str) -> Option<&'a str> {
    meta.annotations
        .as_ref()
        .and_then(|a| a.get(key))
        .map(String::as_str)
}

fn label<'a>(meta: &'a ObjectMeta, key: &str) -> Option<&'a str> {
    meta.labels
        .as_ref()
        .and_then(|a| a.get(key))
        .map(String::as_str)
}

/// A ReplicaSet's revision (the Deployment controller's annotation).
fn replica_set_revision(kind: &KindRef, meta: &ObjectMeta) -> Option<HistoryEntry> {
    let revision = annotation(meta, REVISION_ANNOTATION)?.parse::<i64>().ok()?;
    Some(HistoryEntry {
        source: HistorySource::Revision,
        object: ref_of(kind, meta),
        uid: meta.uid.clone(),
        time: meta.creation_timestamp.as_ref().map(time_text)?,
        manager: None,
        operation: None,
        subresource: None,
        owner: controller_of(meta),
        revision: Some(revision),
        status: None,
        change_cause: annotation(meta, CHANGE_CAUSE_ANNOTATION).map(str::to_owned),
    })
}

fn controller_revision(revision: &ControllerRevision) -> Option<HistoryEntry> {
    let meta = &revision.metadata;
    let kind = KindRef {
        group: "apps".to_owned(),
        version: "v1".to_owned(),
        kind: "ControllerRevision".to_owned(),
    };
    Some(HistoryEntry {
        source: HistorySource::Revision,
        object: ref_of(&kind, meta),
        uid: meta.uid.clone(),
        time: meta.creation_timestamp.as_ref().map(time_text)?,
        manager: None,
        operation: None,
        subresource: None,
        owner: controller_of(meta),
        revision: Some(revision.revision),
        status: None,
        change_cause: annotation(meta, CHANGE_CAUSE_ANNOTATION).map(str::to_owned),
    })
}

fn helm_release_kind() -> KindRef {
    KindRef {
        group: HELM_GROUP.to_owned(),
        version: "v3".to_owned(),
        kind: "Release".to_owned(),
    }
}

/// A Helm release revision from its Secret's labels (`name`, `version`, `status`, `modifiedAt`): the time is when
/// the revision was last modified, else when its Secret was created.
fn helm_revision(meta: &ObjectMeta) -> Option<HistoryEntry> {
    let release = label(meta, "name")?;
    let revision = label(meta, "version")?.parse::<i64>().ok()?;
    let modified = label(meta, "modifiedAt")
        .and_then(|s| s.parse::<i64>().ok())
        .and_then(|secs| Timestamp::from_second(secs).ok())
        .map(|t| t.to_string());
    let time = modified.or_else(|| meta.creation_timestamp.as_ref().map(time_text))?;
    Some(HistoryEntry {
        source: HistorySource::HelmRevision,
        object: ObjectRef {
            kind: helm_release_kind(),
            namespace: meta.namespace.clone(),
            name: release.to_owned(),
        },
        uid: None,
        time,
        manager: None,
        operation: None,
        subresource: None,
        owner: None,
        revision: Some(revision),
        status: label(meta, "status").map(str::to_owned),
        change_cause: None,
    })
}

fn report(what: &str, namespace: Option<&str>) -> HistoryReport {
    HistoryReport {
        what: what.to_owned(),
        namespace: namespace.map(str::to_owned),
        error: None,
        truncated: false,
    }
}

fn kind_label(kind: &KindRef) -> String {
    if kind.group.is_empty() {
        kind.kind.clone()
    } else {
        format!("{}/{}", kind.group, kind.kind)
    }
}

fn is(kind: &KindRef, group: &str, name: &str) -> bool {
    kind.group == group && kind.kind == name
}

/// The field managers of `refs` (a metadata-only GET each, [`PARALLEL`] at a time), in the order asked. An object
/// that cannot be read carries its error. The request is checked before anything is sent (`invalid`); a cluster that
/// is not connected is `notFound`.
pub async fn managers(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    refs: Vec<ObjectRef>,
) -> CoreResult<Vec<ObjectManagers>> {
    check_refs(&refs)?;
    let client = mgr.client(cluster)?;
    let read = |r: ObjectRef| {
        let client = client.clone();
        async move {
            let got = with_timeout(STEP_TIMEOUT, "reading an object's field managers", async {
                let kind = resolve_kind(mgr, cluster, &r.kind).await?;
                if kind.namespaced {
                    r.required_namespace()?;
                }
                let api = kind.api(client, r.namespace.as_deref());
                api.get_metadata(&r.name).await.map_err(CoreError::from)
            })
            .await;
            match got {
                Ok(found) => ObjectManagers {
                    managers: field_managers(&found.metadata),
                    uid: found.metadata.uid.clone(),
                    resource_version: found.metadata.resource_version.clone(),
                    object: r,
                    error: None,
                },
                Err(error) => ObjectManagers {
                    object: r,
                    uid: None,
                    resource_version: None,
                    managers: Vec::new(),
                    error: Some(error),
                },
            }
        }
    };
    Ok(futures::stream::iter(refs)
        .map(read)
        .buffered(PARALLEL)
        .collect()
        .await)
}

/// Lists `kind` in `namespace` (`None`: everywhere) by metadata only, page by page, at most
/// [`MAX_OBJECTS_PER_LIST`]; whether more were left.
async fn list_metadata(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    client: &kube::Client,
    kind: &KindRef,
    namespace: Option<&str>,
) -> CoreResult<(Vec<ObjectMeta>, bool)> {
    let resolved = with_timeout(STEP_TIMEOUT, "reading the cluster's kinds", async {
        resolve_kind(mgr, cluster, kind).await
    })
    .await?;
    let api = resolved.api(client.clone(), namespace);
    let mut items = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut params = ListParams::default().limit(PAGE);
        if let Some(t) = &token {
            params = params.continue_token(t);
        }
        let list = with_timeout(STEP_TIMEOUT, "listing objects", async {
            api.list_metadata(&params).await.map_err(CoreError::from)
        })
        .await?;
        let next = list.metadata.continue_.clone().filter(|t| !t.is_empty());
        items.extend(list.items.into_iter().map(|item| item.metadata));
        if items.len() >= MAX_OBJECTS_PER_LIST {
            let more = items.len() > MAX_OBJECTS_PER_LIST || next.is_some();
            items.truncate(MAX_OBJECTS_PER_LIST);
            return Ok((items, more));
        }
        match next {
            Some(t) => token = Some(t),
            None => return Ok((items, false)),
        }
    }
}

/// One namespace's ControllerRevisions (full objects: the revision number is not metadata), at most
/// [`MAX_OBJECTS_PER_LIST`]; their `data` is dropped at once.
async fn list_controller_revisions(
    client: &kube::Client,
    namespace: &str,
) -> CoreResult<(Vec<HistoryEntry>, bool)> {
    let api: Api<ControllerRevision> = Api::namespaced(client.clone(), namespace);
    let mut entries = Vec::new();
    let mut seen = 0usize;
    let mut token: Option<String> = None;
    loop {
        let mut params = ListParams::default().limit(100);
        if let Some(t) = &token {
            params = params.continue_token(t);
        }
        let list = with_timeout(STEP_TIMEOUT, "listing controller revisions", async {
            api.list(&params).await.map_err(CoreError::from)
        })
        .await?;
        let next = list.metadata.continue_.clone().filter(|t| !t.is_empty());
        for revision in list.items {
            seen += 1;
            if seen > MAX_OBJECTS_PER_LIST {
                return Ok((entries, true));
            }
            entries.extend(controller_revision(&revision));
        }
        match next {
            Some(t) => token = Some(t),
            None => return Ok((entries, false)),
        }
    }
}

/// Sorts newest first and keeps at most [`MAX_ENTRIES`].
fn finish(mut entries: Vec<HistoryEntry>, reports: Vec<HistoryReport>) -> PartialHistory {
    let key = |e: &HistoryEntry| e.time.parse::<Timestamp>().ok();
    entries.sort_by_key(|e| Reverse(key(e)));
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    PartialHistory {
        entries,
        truncated,
        reports,
    }
}

/// What one list of `kind` in `namespace` tells: the managers of each object, and a ReplicaSet's revision.
fn entries_of(kind: &KindRef, items: &[ObjectMeta]) -> Vec<HistoryEntry> {
    let replica_sets = is(kind, "apps", "ReplicaSet");
    let mut out = Vec::new();
    for meta in items {
        if replica_sets {
            // A ReplicaSet's own managers are its controller's bookkeeping; its revision is what tells.
            out.extend(replica_set_revision(kind, meta));
        } else {
            out.extend(manager_entries(kind, meta));
        }
    }
    out
}

/// The partial history of `namespaces` (see the module docs): for each of `kinds` the last change of each field
/// manager of each object (a ReplicaSet gives its revision instead, a ControllerRevision its revision), and, with
/// `helm`, the revisions of the Helm releases there. Cluster-scoped kinds are listed once. The request is checked
/// before anything is sent (`invalid`); a cluster that is not connected is `notFound`.
pub async fn history(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespaces: Vec<String>,
    kinds: Vec<KindRef>,
    helm: bool,
) -> CoreResult<PartialHistory> {
    check_history_request(&namespaces, &kinds)?;
    let client = mgr.client(cluster)?;

    /// One list to make.
    struct Job {
        kind: KindRef,
        namespace: Option<String>,
        helm: bool,
    }
    let mut jobs = Vec::new();
    for kind in &kinds {
        let scoped = resolve_kind(mgr, cluster, kind)
            .await
            .map(|k| k.namespaced)
            .unwrap_or(true);
        if scoped {
            for ns in &namespaces {
                jobs.push(Job {
                    kind: kind.clone(),
                    namespace: Some(ns.clone()),
                    helm: false,
                });
            }
        } else {
            jobs.push(Job {
                kind: kind.clone(),
                namespace: None,
                helm: false,
            });
        }
    }
    if helm {
        for ns in &namespaces {
            jobs.push(Job {
                kind: helm_release_kind(),
                namespace: Some(ns.clone()),
                helm: true,
            });
        }
    }

    let run = |job: Job| {
        let client = client.clone();
        async move {
            let ns = job.namespace.as_deref();
            if job.helm {
                let mut rep = report("helm", ns);
                let found = with_timeout(STEP_TIMEOUT, "listing Helm release revisions", async {
                    helm::list_revision_metadata(&client, ns).await
                })
                .await;
                return match found {
                    Ok(metas) => (metas.iter().filter_map(helm_revision).collect(), rep),
                    Err(e) => {
                        rep.error = Some(e);
                        (Vec::new(), rep)
                    }
                };
            }
            let mut rep = report(&kind_label(&job.kind), ns);
            if is(&job.kind, "apps", "ControllerRevision") {
                let Some(ns) = ns else {
                    return (Vec::new(), rep);
                };
                return match list_controller_revisions(&client, ns).await {
                    Ok((entries, more)) => {
                        rep.truncated = more;
                        (entries, rep)
                    }
                    Err(e) => {
                        rep.error = Some(e);
                        (Vec::new(), rep)
                    }
                };
            }
            match list_metadata(mgr, cluster, &client, &job.kind, ns).await {
                Ok((items, more)) => {
                    rep.truncated = more;
                    (entries_of(&job.kind, &items), rep)
                }
                Err(e) => {
                    rep.error = Some(e);
                    (Vec::new(), rep)
                }
            }
        }
    };
    let results: Vec<(Vec<HistoryEntry>, HistoryReport)> = futures::stream::iter(jobs)
        .map(run)
        .buffered(PARALLEL)
        .collect()
        .await;
    let mut entries = Vec::new();
    let mut reports = Vec::new();
    for (found, rep) in results {
        entries.extend(found);
        reports.push(rep);
    }
    Ok(finish(entries, reports))
}

/// The partial history of one object: the last change of each of its field managers, its rollout revisions (a
/// Deployment, StatefulSet or DaemonSet) and the revisions of the Helm release that manages it (its
/// `meta.helm.sh/release-*` annotations). The object itself must be readable; the rest is reported.
pub async fn object_history(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    object: ObjectRef,
) -> CoreResult<PartialHistory> {
    check_ref(&object)?;
    let client = mgr.client(cluster)?;
    let meta = with_timeout(STEP_TIMEOUT, "reading an object's field managers", async {
        let kind = resolve_kind(mgr, cluster, &object.kind).await?;
        if kind.namespaced {
            object.required_namespace()?;
        }
        let api = kind.api(client.clone(), object.namespace.as_deref());
        api.get_metadata(&object.name)
            .await
            .map(|m| m.metadata)
            .map_err(CoreError::from)
    })
    .await?;

    let mut entries = manager_entries(&object.kind, &meta);
    let mut reports = Vec::new();

    let workload = ["Deployment", "StatefulSet", "DaemonSet"]
        .iter()
        .any(|k| is(&object.kind, "apps", k));
    if workload {
        let mut rep = report("rollout", object.namespace.as_deref());
        match with_timeout(STEP_TIMEOUT, "reading the rollout history", async {
            rollouts::history(mgr, cluster, &object).await
        })
        .await
        {
            Ok(revisions) => {
                let (group, kind) = if object.kind.kind == "Deployment" {
                    ("apps", "ReplicaSet")
                } else {
                    ("apps", "ControllerRevision")
                };
                for revision in revisions {
                    let Some(time) = revision.created else {
                        continue;
                    };
                    entries.push(HistoryEntry {
                        source: HistorySource::Revision,
                        object: ObjectRef {
                            kind: KindRef {
                                group: group.to_owned(),
                                version: "v1".to_owned(),
                                kind: kind.to_owned(),
                            },
                            namespace: object.namespace.clone(),
                            name: revision.name,
                        },
                        uid: None,
                        time,
                        manager: None,
                        operation: None,
                        subresource: None,
                        owner: Some(object.clone()),
                        revision: Some(revision.revision),
                        status: None,
                        change_cause: revision.change_cause,
                    });
                }
            }
            Err(e) => rep.error = Some(e),
        }
        reports.push(rep);
    }

    let release = annotation(&meta, HELM_RELEASE_ANNOTATION);
    let release_ns = annotation(&meta, HELM_NAMESPACE_ANNOTATION).or(meta.namespace.as_deref());
    if let (Some(release), Some(release_ns)) = (release, release_ns)
        && is_dns_label(release_ns)
        && is_dns_subdomain(release)
    {
        let mut rep = report("helm", Some(release_ns));
        match with_timeout(STEP_TIMEOUT, "listing Helm release revisions", async {
            helm::list_revision_metadata(&client, Some(release_ns)).await
        })
        .await
        {
            Ok(metas) => entries.extend(
                metas
                    .iter()
                    .filter(|m| label(m, "name") == Some(release))
                    .filter_map(helm_revision),
            ),
            Err(e) => rep.error = Some(e),
        }
        reports.push(rep);
    }
    Ok(finish(entries, reports))
}

// ---------------------------------------------------------------------------------------------------------------
// The saved timeline

/// The file of `cluster`'s saved timeline under `dir`: the cluster id is hashed, so it never shapes a path.
pub fn saved_path(dir: &Path, cluster: &ClusterId) -> PathBuf {
    let digest = Sha256::digest(cluster.0.as_bytes());
    let name: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{name}.json"))
}

/// Removes every value of a Secret's keys from the recorded changes: the window never records one, and a file must
/// not hold one even if a bug made it.
fn scrub_secret_values(doc: &mut Value) {
    let Some(entries) = doc.get_mut("entries").and_then(Value::as_array_mut) else {
        return;
    };
    for entry in entries {
        let secret = entry.pointer("/kind/kind").and_then(Value::as_str) == Some("Secret")
            && entry
                .pointer("/kind/group")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty);
        if !secret {
            continue;
        }
        if let Some(changes) = entry.get_mut("changes").and_then(Value::as_array_mut) {
            for change in changes {
                if let Some(change) = change.as_object_mut() {
                    change.remove("before");
                    change.remove("after");
                }
            }
        }
    }
}

/// Saves `cluster`'s recorded timeline (`text`: a JSON object `{"version": 1, "cluster": <id>, "entries": […]}`) under
/// `dir`, replacing the file at once (a temporary file, then a rename). `None` removes the file. Anything bigger than
/// [`MAX_SAVED_BYTES`], not of that shape or of another cluster is `invalid` and leaves the file as it was.
pub fn save(dir: &Path, cluster: &ClusterId, text: Option<&str>) -> CoreResult<()> {
    let path = saved_path(dir, cluster);
    let Some(text) = text else {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        };
    };
    if text.len() > MAX_SAVED_BYTES {
        return Err(invalid(format!(
            "a saved timeline holds at most {} MB",
            MAX_SAVED_BYTES / (1024 * 1024)
        )));
    }
    let mut doc: Value =
        serde_json::from_str(text).map_err(|e| invalid(format!("not a timeline: {e}")))?;
    let shaped = doc.get("version").and_then(Value::as_u64) == Some(SAVED_VERSION)
        && doc.get("cluster").and_then(Value::as_str) == Some(cluster.0.as_str())
        && doc.get("entries").is_some_and(Value::is_array);
    if !shaped {
        return Err(invalid("not a timeline of this cluster"));
    }
    scrub_secret_values(&mut doc);
    let bytes = serde_json::to_vec(&doc).map_err(|e| CoreError::other(e.to_string()))?;
    std::fs::create_dir_all(dir)?;
    // Unique per write: two saves of one cluster never share a temporary file.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "json.tmp-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &path)
    })();
    if let Err(err) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

/// Removes every saved timeline under `dir` (and temporary files a stopped write left), of any cluster: what turning
/// persistence off asks for. Only files this module writes are touched; a missing directory is nothing to do.
pub fn remove_all(dir: &Path) -> CoreResult<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ours = name.ends_with(".json") || name.contains(".json.tmp-");
        if ours && entry.file_type()?.is_file() {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// The saved timeline of `cluster` under `dir`, `None` when there is none. A file that is too big, does not parse
/// or belongs to another cluster reads as none (and stays until the next save replaces it).
pub fn load(dir: &Path, cluster: &ClusterId) -> CoreResult<Option<String>> {
    let path = saved_path(dir, cluster);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if bytes.len() > MAX_SAVED_BYTES {
        return Ok(None);
    }
    let Ok(mut doc) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(None);
    };
    if doc.get("cluster").and_then(Value::as_str) != Some(cluster.0.as_str())
        || doc.get("version").and_then(Value::as_u64) != Some(SAVED_VERSION)
    {
        return Ok(None);
    }
    scrub_secret_values(&mut doc);
    Ok(Some(doc.to_string()))
}

#[cfg(test)]
mod tests;
