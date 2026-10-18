//! Upgrade readiness (#142): the facts the "Upgrade readiness" page needs to say which deprecated or removed API
//! versions a cluster still uses before it is upgraded. The table of deprecations lives in the frontend
//! (`src/features/upgrade/deprecations.json`); the caller passes the group/version/kinds it cares about ([`ScanApi`])
//! and [`scan`] reports, read-only and bounded:
//!
//! - the server version (`/version`);
//! - which of those API versions the cluster still serves (`/api`, `/apis` and the resource list of each such group
//!   version: discovery keeps only the preferred version of a group, so it cannot tell);
//! - live objects of those kinds whose `kubectl.kubernetes.io/last-applied-configuration` or `managedFields[]` name one
//!   of those versions: the apiVersion a client last used (metadata-only lists, at most [`MAX_OBJECTS_PER_KIND`]);
//! - Helm releases whose stored manifest (the latest revision of at most [`MAX_HELM_RELEASES`] releases, each Secret
//!   decoded once and within `helm::MAX_RELEASE_BYTES`) has a document of one of those versions: only apiVersion,
//!   kind, name and namespace leave the core, never the manifest or a value;
//! - Argo CD Applications (`status.resources[]`) and Flux Kustomizations (`status.inventory.entries[]`) that manage an
//!   object in one of those versions — what the cluster already knows, no Git access;
//! - kubelet versions of the nodes and versions of the control-plane pods in `kube-system` (kubeadm-style static pods
//!   labelled `tier=control-plane`; a managed control plane shows none), for the version skew rules.
//!
//! Each source reports how it went ([`SourceReport`]): a source the user may not read or a tool that is not installed
//! does not fail the scan. Every request is limited to [`STEP_TIMEOUT`]. A window command only: neither agents nor
//! extensions get it.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use futures::StreamExt;
use k8s_openapi::api::core::v1::{Namespace, Node, Pod};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::Api;
use kube::api::{ApiResource, DynamicObject, ListParams};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::helm;
use crate::kubeconfig::ClusterId;
use crate::resources::{KindRef, ResourceKind, STEP_TIMEOUT};

/// At most this many API versions per [`scan`].
pub const MAX_APIS: usize = 256;
/// At most this many objects of one kind are looked at.
pub const MAX_OBJECTS_PER_KIND: usize = 2000;
/// At most this many Helm releases are read.
pub const MAX_HELM_RELEASES: usize = 300;
/// At most this many Argo CD Applications or Flux Kustomizations are read.
pub const MAX_GITOPS_OBJECTS: usize = 1000;
/// At most this many nodes are listed.
pub const MAX_NODES: usize = 5000;
/// At most this many usages are reported; `usages_truncated` says more were found.
pub const MAX_USAGES: usize = 5000;
/// Objects per list request.
const PAGE: u32 = 500;
/// Full GitOps objects (with their status) per list request: they can be large.
const GITOPS_PAGE: u32 = 100;
/// Requests of one source sent at the same time.
const PARALLEL: usize = 4;
/// At most this many namespaces are listed one by one for Helm releases (when the user may not list Secrets across
/// the cluster).
pub const MAX_HELM_NAMESPACES: usize = 500;

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";
const ARGO_GROUP: &str = "argoproj.io";
const FLUX_KUSTOMIZE_GROUP: &str = "kustomize.toolkit.fluxcd.io";

/// One deprecated API version to look for, and what replaces it (its group tells where the live objects of the kind
/// are listed when the deprecated version is no longer served).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanApi {
    pub api: KindRef,
    #[serde(default)]
    pub replacement: Option<KindRef>,
}

/// The API server's `/version`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerVersion {
    /// `v1.31.4`, `v1.30.5-gke.1014001`, …
    pub git_version: String,
    pub major: String,
    /// May carry a `+` (`31+`) on managed clusters.
    pub minor: String,
    pub platform: String,
}

/// Where a usage of an API version was seen.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum UsageOrigin {
    /// The object's `kubectl.kubernetes.io/last-applied-configuration`: the last `kubectl apply` used this version.
    LastApplied,
    /// An entry of the object's `managedFields`: this field manager last wrote it in this version.
    #[serde(rename_all = "camelCase")]
    ManagedFields { manager: String },
    /// A document of the Helm release's stored manifest (its latest readable revision).
    #[serde(rename_all = "camelCase")]
    Helm {
        release: String,
        namespace: String,
        revision: i32,
    },
    /// A resource an Argo CD Application manages (`status.resources[]`).
    #[serde(rename_all = "camelCase")]
    ArgoCd {
        application: String,
        namespace: String,
    },
    /// An entry of a Flux Kustomization's inventory (`status.inventory.entries[]`).
    #[serde(rename_all = "camelCase")]
    Flux {
        kustomization: String,
        namespace: String,
    },
}

/// One object (or manifest document) that uses a deprecated API version.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApiUsage {
    /// The version used.
    pub api: KindRef,
    pub namespace: Option<String>,
    pub name: String,
    pub origin: UsageOrigin,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NodeVersion {
    pub name: String,
    /// `v1.31.4`; empty when the node has not reported it.
    pub kubelet_version: String,
    /// Empty when the node does not report it (deprecated in the API since 1.31).
    pub kube_proxy_version: String,
    /// Labelled `node-role.kubernetes.io/control-plane` (or `…/master`).
    pub control_plane: bool,
}

/// A control-plane pod in `kube-system` (kubeadm-style static pods).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ComponentVersion {
    /// `kube-apiserver`, `kube-controller-manager`, `kube-scheduler`, `etcd`, …
    pub component: String,
    pub pod: String,
    pub node: String,
    /// The image tag (`v1.31.4`); empty when the image has none.
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ScanSource {
    Version,
    Served,
    Live,
    Helm,
    ArgoCd,
    Flux,
    Nodes,
    ControlPlane,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SourceOutcome {
    /// Read (perhaps partly: see `skipped` and `truncated`).
    Done,
    /// The cluster does not serve the tool's kinds (Argo CD, Flux not installed).
    NotInstalled,
    /// Could not be read at all; `error` says why.
    Failed,
}

/// How one source of the scan went.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceReport {
    pub source: ScanSource,
    pub outcome: SourceOutcome,
    /// Why it failed, or the first error of a part that was skipped.
    pub error: Option<CoreError>,
    /// Objects, releases or group versions looked at.
    pub scanned: u32,
    /// A cap was reached: more exist than were looked at.
    pub truncated: bool,
    /// What could not be read: kinds (live objects), group versions (served; `kind` empty) or Helm releases (`group`
    /// the namespace, `kind` the release name).
    pub skipped: Vec<KindRef>,
}

impl SourceReport {
    fn new(source: ScanSource) -> Self {
        Self {
            source,
            outcome: SourceOutcome::Done,
            error: None,
            scanned: 0,
            truncated: false,
            skipped: Vec::new(),
        }
    }

    fn failed(source: ScanSource, error: CoreError) -> Self {
        Self {
            outcome: SourceOutcome::Failed,
            error: Some(error),
            ..Self::new(source)
        }
    }

    fn not_installed(source: ScanSource) -> Self {
        Self {
            outcome: SourceOutcome::NotInstalled,
            ..Self::new(source)
        }
    }

    fn skip(&mut self, what: KindRef, error: CoreError) {
        self.skipped.push(what);
        self.error.get_or_insert(error);
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpgradeScan {
    pub version: Option<ServerVersion>,
    /// The requested API versions the cluster still serves.
    pub served: Vec<KindRef>,
    pub usages: Vec<ApiUsage>,
    /// More than [`MAX_USAGES`] usages were found.
    pub usages_truncated: bool,
    pub nodes: Vec<NodeVersion>,
    pub components: Vec<ComponentVersion>,
    pub sources: Vec<SourceReport>,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// A name part of an API version: letters, digits, `.` and `-` (a group may be empty).
fn plain(part: &str) -> bool {
    part.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

fn check_kind(kind: &KindRef) -> CoreResult<()> {
    let ok = plain(&kind.group)
        && !kind.version.is_empty()
        && plain(&kind.version)
        && !kind.kind.is_empty()
        && plain(&kind.kind);
    if ok {
        Ok(())
    } else {
        Err(invalid(format!(
            "{:?} is not an API group, version and kind",
            api_version(kind)
        )))
    }
}

/// Checks the request before anything is sent.
pub fn check_apis(apis: &[ScanApi]) -> CoreResult<()> {
    if apis.len() > MAX_APIS {
        return Err(invalid(format!("at most {MAX_APIS} API versions at once")));
    }
    for api in apis {
        check_kind(&api.api)?;
        if let Some(replacement) = &api.replacement {
            check_kind(replacement)?;
        }
    }
    Ok(())
}

/// `group/version`, or `version` for the core group.
fn api_version(kind: &KindRef) -> String {
    group_version(&kind.group, &kind.version)
}

fn group_version(group: &str, version: &str) -> String {
    if group.is_empty() {
        version.to_owned()
    } else {
        format!("{group}/{version}")
    }
}

/// `apps/v1` → (`apps`, `v1`); `v1` → (``, `v1`).
fn split_api_version(api_version: &str) -> (&str, &str) {
    api_version.split_once('/').unwrap_or(("", api_version))
}

/// The requested API versions, by kind name: what a usage of a kind is matched against.
struct Wanted {
    set: HashSet<(String, String, String)>,
}

impl Wanted {
    fn new(apis: &[ScanApi]) -> Self {
        Self {
            set: apis
                .iter()
                .map(|a| {
                    (
                        a.api.group.clone(),
                        a.api.version.clone(),
                        a.api.kind.clone(),
                    )
                })
                .collect(),
        }
    }

    /// The API version `api_version` of `kind`, when it is one of the requested ones.
    fn matching(&self, api_version: &str, kind: &str) -> Option<KindRef> {
        let (group, version) = split_api_version(api_version.trim());
        self.contains(group, version, kind).then(|| KindRef {
            group: group.to_owned(),
            version: version.to_owned(),
            kind: kind.to_owned(),
        })
    }

    fn contains(&self, group: &str, version: &str, kind: &str) -> bool {
        self.set
            .contains(&(group.to_owned(), version.to_owned(), kind.to_owned()))
    }
}

/// Usages found so far, each once, at most [`MAX_USAGES`].
#[derive(Default)]
struct Usages {
    seen: HashSet<ApiUsage>,
    list: Vec<ApiUsage>,
    truncated: bool,
}

impl Usages {
    fn push(&mut self, usage: ApiUsage) {
        if self.seen.contains(&usage) {
            return;
        }
        if self.list.len() >= MAX_USAGES {
            self.truncated = true;
            return;
        }
        self.seen.insert(usage.clone());
        self.list.push(usage);
    }

    fn extend(&mut self, usages: impl IntoIterator<Item = ApiUsage>) {
        for usage in usages {
            self.push(usage);
        }
    }
}

/// Upgrade-readiness facts of the cluster for the API versions in `apis` (see the module docs). The request is
/// checked before anything is sent (`invalid`); a cluster that is not connected is `notFound`; anything a source
/// cannot read is in its [`SourceReport`].
pub async fn scan(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    apis: Vec<ScanApi>,
) -> CoreResult<UpgradeScan> {
    check_apis(&apis)?;
    let client = mgr.client(cluster)?;
    let wanted = Wanted::new(&apis);

    let kinds = async {
        with_timeout(
            STEP_TIMEOUT,
            "reading the cluster's kinds",
            mgr.kinds(cluster),
        )
        .await
    };
    let (version, served, nodes, components, kinds) = futures::join!(
        server_version(&client),
        served(&client, &apis),
        nodes(&client),
        control_plane(&client),
        kinds,
    );
    let (live, helm, argo, flux) = futures::join!(
        live(&client, kinds.as_ref(), &apis, &wanted),
        helm_usages(mgr, cluster, &client, kinds.as_ref(), &wanted),
        argo_usages(&client, kinds.as_ref(), &wanted),
        flux_usages(&client, kinds.as_ref(), &wanted),
    );

    let mut scan = UpgradeScan::default();
    let mut usages = Usages::default();
    let mut sources = Vec::new();
    match version {
        Ok(v) => {
            scan.version = Some(v);
            sources.push(SourceReport::new(ScanSource::Version));
        }
        Err(e) => sources.push(SourceReport::failed(ScanSource::Version, e)),
    }
    let (report, found) = served;
    scan.served = found;
    sources.push(report);
    for (report, found) in [live, helm, argo, flux] {
        usages.extend(found);
        sources.push(report);
    }
    let (report, found) = nodes;
    scan.nodes = found;
    sources.push(report);
    let (report, found) = components;
    scan.components = found;
    sources.push(report);

    scan.usages = usages.list;
    scan.usages_truncated = usages.truncated;
    scan.usages.sort_by(|a, b| {
        (
            &a.namespace,
            &a.name,
            &a.api.kind,
            &a.api.group,
            &a.api.version,
        )
            .cmp(&(
                &b.namespace,
                &b.name,
                &b.api.kind,
                &b.api.group,
                &b.api.version,
            ))
    });
    scan.sources = sources;
    Ok(scan)
}

async fn server_version(client: &kube::Client) -> CoreResult<ServerVersion> {
    let info = with_timeout(STEP_TIMEOUT, "reading the server version", async {
        client.apiserver_version().await.map_err(CoreError::from)
    })
    .await?;
    Ok(ServerVersion {
        git_version: info.git_version,
        major: info.major,
        minor: info.minor,
        platform: info.platform,
    })
}

/// The requested API versions the cluster serves: `/api` and `/apis` name the served group versions (every version,
/// not only the preferred one), and the resource list of each requested group version names its kinds.
async fn served(client: &kube::Client, apis: &[ScanApi]) -> (SourceReport, Vec<KindRef>) {
    let mut report = SourceReport::new(ScanSource::Served);
    let lists = with_timeout(STEP_TIMEOUT, "reading the API groups", async {
        let (core, groups) =
            futures::join!(client.list_core_api_versions(), client.list_api_groups());
        Ok((core?, groups?))
    })
    .await;
    let (core, groups) = match lists {
        Ok(lists) => lists,
        Err(e) => return (SourceReport::failed(ScanSource::Served, e), Vec::new()),
    };
    let mut served_versions: HashSet<String> = core.versions.into_iter().collect();
    for group in groups.groups {
        served_versions.extend(group.versions.into_iter().map(|v| v.group_version));
    }
    let asked: BTreeSet<String> = apis
        .iter()
        .map(|a| api_version(&a.api))
        .filter(|gv| served_versions.contains(gv))
        .collect();
    report.scanned = asked.len() as u32;
    let answers: Vec<(String, CoreResult<Vec<String>>)> = futures::stream::iter(asked)
        .map(|gv| async move {
            let kinds = with_timeout(STEP_TIMEOUT, "reading a group version", async {
                let list = if gv.contains('/') {
                    client.list_api_group_resources(&gv).await?
                } else {
                    client.list_core_api_resources(&gv).await?
                };
                Ok(list
                    .resources
                    .into_iter()
                    .filter(|r| !r.name.contains('/'))
                    .map(|r| r.kind)
                    .collect())
            })
            .await;
            (gv, kinds)
        })
        .buffer_unordered(PARALLEL)
        .collect()
        .await;
    let mut served = Vec::new();
    for (gv, kinds) in answers {
        let (group, version) = split_api_version(&gv);
        match kinds {
            Ok(kinds) => served.extend(
                apis.iter()
                    .filter(|a| {
                        a.api.group == group
                            && a.api.version == version
                            && kinds.contains(&a.api.kind)
                    })
                    .map(|a| a.api.clone()),
            ),
            Err(e) => report.skip(
                KindRef {
                    group: group.to_owned(),
                    version: version.to_owned(),
                    kind: String::new(),
                },
                e,
            ),
        }
    }
    served.sort_by(|a, b| (&a.group, &a.version, &a.kind).cmp(&(&b.group, &b.version, &b.kind)));
    served.dedup();
    (report, served)
}

fn api_resource(kind: &ResourceKind) -> ApiResource {
    ApiResource {
        group: kind.kind_ref.group.clone(),
        version: kind.kind_ref.version.clone(),
        api_version: api_version(&kind.kind_ref),
        kind: kind.kind_ref.kind.clone(),
        plural: kind.plural.clone(),
    }
}

fn listable(kind: &ResourceKind) -> bool {
    kind.verbs.iter().any(|v| v == "list")
}

/// Where the live objects of each requested kind are listed: the served kind of the replacement's group first (the
/// objects are the same whatever version is asked), else of the deprecated version's group. Kinds the cluster does
/// not serve at all, or that cannot be listed (TokenReview, …), have no live objects.
fn live_targets(kinds: &[ResourceKind], apis: &[ScanApi]) -> Vec<ResourceKind> {
    let mut groups: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for api in apis {
        let entry = groups.entry(api.api.kind.as_str()).or_default();
        if let Some(replacement) = &api.replacement
            && replacement.kind == api.api.kind
        {
            entry.insert(0, replacement.group.as_str());
        }
        entry.push(api.api.group.as_str());
    }
    groups
        .into_iter()
        .filter_map(|(kind, candidates)| {
            candidates.iter().find_map(|group| {
                kinds
                    .iter()
                    .find(|k| k.kind_ref.group == *group && k.kind_ref.kind == kind && listable(k))
                    .cloned()
            })
        })
        .collect()
}

/// The usages one object's metadata records: its last applied configuration and its field managers.
fn usages_of_meta(
    meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta,
    kind: &str,
    wanted: &Wanted,
) -> Vec<ApiUsage> {
    let name = meta.name.clone().unwrap_or_default();
    let namespace = meta.namespace.clone();
    let usage = |api: KindRef, origin: UsageOrigin| ApiUsage {
        api,
        namespace: namespace.clone(),
        name: name.clone(),
        origin,
    };
    let mut out = Vec::new();
    let applied = meta
        .annotations
        .as_ref()
        .and_then(|a| a.get(LAST_APPLIED))
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    if let Some(applied) = applied
        && let Some(found) = applied
            .get("apiVersion")
            .and_then(Value::as_str)
            .and_then(|v| wanted.matching(v, kind))
    {
        out.push(usage(found, UsageOrigin::LastApplied));
    }
    for entry in meta.managed_fields.iter().flatten() {
        let Some(found) = entry
            .api_version
            .as_deref()
            .and_then(|v| wanted.matching(v, kind))
        else {
            continue;
        };
        out.push(usage(
            found,
            UsageOrigin::ManagedFields {
                manager: entry.manager.clone().unwrap_or_default(),
            },
        ));
    }
    out
}

/// What [`list_kind`] found: the usages, how many objects were looked at and whether there were more.
type KindListing = (Vec<ApiUsage>, u32, bool);

/// One kind's objects, by metadata only, page by page, at most [`MAX_OBJECTS_PER_KIND`]; returns the usages, how many
/// objects were looked at and whether there were more.
async fn list_kind(
    client: kube::Client,
    kind: ResourceKind,
    wanted: &Wanted,
) -> CoreResult<KindListing> {
    let api: Api<DynamicObject> = Api::all_with(client, &api_resource(&kind));
    let mut usages = Vec::new();
    let mut seen = 0usize;
    let mut token: Option<String> = None;
    loop {
        let mut params = ListParams::default().limit(PAGE);
        if let Some(t) = token.take() {
            params = params.continue_token(&t);
        }
        let list = with_timeout(STEP_TIMEOUT, "listing objects", async {
            api.list_metadata(&params).await.map_err(CoreError::from)
        })
        .await?;
        let next = list.metadata.continue_.clone().filter(|t| !t.is_empty());
        for item in list.items {
            if seen == MAX_OBJECTS_PER_KIND {
                return Ok((usages, seen as u32, true));
            }
            seen += 1;
            usages.extend(usages_of_meta(&item.metadata, &kind.kind_ref.kind, wanted));
        }
        match next {
            None => return Ok((usages, seen as u32, false)),
            Some(_) if seen == MAX_OBJECTS_PER_KIND => return Ok((usages, seen as u32, true)),
            Some(t) => token = Some(t),
        }
    }
}

async fn live(
    client: &kube::Client,
    kinds: Result<&Vec<ResourceKind>, &CoreError>,
    apis: &[ScanApi],
    wanted: &Wanted,
) -> (SourceReport, Vec<ApiUsage>) {
    let kinds = match kinds {
        Ok(kinds) => kinds,
        Err(e) => {
            return (
                SourceReport::failed(ScanSource::Live, e.clone()),
                Vec::new(),
            );
        }
    };
    let mut report = SourceReport::new(ScanSource::Live);
    let results: Vec<(KindRef, CoreResult<KindListing>)> =
        futures::stream::iter(live_targets(kinds, apis))
            .map(|kind| async move {
                let kind_ref = kind.kind_ref.clone();
                (kind_ref, list_kind(client.clone(), kind, wanted).await)
            })
            .buffer_unordered(PARALLEL)
            .collect()
            .await;
    let mut usages = Vec::new();
    for (kind, result) in results {
        match result {
            Ok((found, seen, truncated)) => {
                usages.extend(found);
                report.scanned += seen;
                report.truncated |= truncated;
            }
            Err(e) => report.skip(kind, e),
        }
    }
    (report, usages)
}

#[derive(Deserialize)]
struct ManifestDoc {
    #[serde(rename = "apiVersion", default)]
    api_version: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    metadata: ManifestMeta,
}

#[derive(Default, Deserialize)]
struct ManifestMeta {
    #[serde(default)]
    name: String,
    #[serde(default)]
    namespace: Option<String>,
}

/// The documents of a rendered manifest that use a requested API version, as (version, namespace, name). A document
/// that does not parse is skipped; nothing else of it is kept. A namespaced document without a namespace is in
/// `default_namespace` (Helm installs it into the release's namespace); `cluster_scoped` names kinds without one.
fn manifest_usages(
    manifest: &str,
    wanted: &Wanted,
    default_namespace: &str,
    cluster_scoped: &HashSet<String>,
) -> Vec<(KindRef, Option<String>, String)> {
    let mut out = Vec::new();
    for text in yaml_documents(manifest) {
        let Ok(Some(doc)) = serde_yaml::from_str::<Option<ManifestDoc>>(text) else {
            continue;
        };
        let Some(api) = wanted.matching(&doc.api_version, &doc.kind) else {
            continue;
        };
        let namespace = doc
            .metadata
            .namespace
            .filter(|ns| !ns.is_empty())
            .or_else(|| {
                (!cluster_scoped.contains(&doc.kind)).then(|| default_namespace.to_owned())
            });
        out.push((api, namespace, doc.metadata.name));
    }
    out
}

/// The documents of a multi-document YAML text, split at `---` lines. Each is parsed on its own, so one that does
/// not parse is skipped alone (serde_yaml's multi-document reader does not get past a syntax error).
fn yaml_documents(text: &str) -> Vec<&str> {
    let mut docs = Vec::new();
    let mut start = 0;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end();
        if bare == "---" || bare.starts_with("--- ") {
            docs.push(&text[start..offset]);
            start = offset + line.len();
        }
        offset += line.len();
    }
    docs.push(&text[start..]);
    docs.retain(|d| !d.trim().is_empty());
    docs
}

/// Kinds that are cluster-scoped whatever the cluster serves: those of the deprecation table (and of their
/// replacements) that a cluster may no longer serve, so discovery cannot say (a PodSecurityPolicy in an old Helm
/// manifest has no namespace).
const KNOWN_CLUSTER_SCOPED: &[&str] = &[
    "APIService",
    "CertificateSigningRequest",
    "ClusterRole",
    "ClusterRoleBinding",
    "CSIDriver",
    "CSINode",
    "CustomResourceDefinition",
    "FlowSchema",
    "IngressClass",
    "MutatingWebhookConfiguration",
    "Namespace",
    "Node",
    "PersistentVolume",
    "PodSecurityPolicy",
    "PriorityClass",
    "PriorityLevelConfiguration",
    "RuntimeClass",
    "SelfSubjectAccessReview",
    "StorageClass",
    "SubjectAccessReview",
    "TokenReview",
    "ValidatingWebhookConfiguration",
    "VolumeAttachment",
];

/// Kind names that are cluster-scoped: [`KNOWN_CLUSTER_SCOPED`] and those the cluster serves only cluster-scoped.
fn cluster_scoped(kinds: &[ResourceKind]) -> HashSet<String> {
    let namespaced: HashSet<&str> = kinds
        .iter()
        .filter(|k| k.namespaced)
        .map(|k| k.kind_ref.kind.as_str())
        .collect();
    kinds
        .iter()
        .filter(|k| !k.namespaced && !namespaced.contains(k.kind_ref.kind.as_str()))
        .map(|k| k.kind_ref.kind.clone())
        .chain(KNOWN_CLUSTER_SCOPED.iter().map(|k| (*k).to_owned()))
        .collect()
}

/// A Helm release to read: the latest revision of a release that is not uninstalled.
struct HelmTarget {
    namespace: String,
    name: String,
    revision: i32,
}

/// The metadata of every release Secret: one list of all namespaces, or, when the user may not list Secrets across
/// the cluster, one list per namespace (at most [`MAX_HELM_NAMESPACES`]), where a namespace that cannot be listed is
/// skipped (`group` the namespace, `kind` empty) and the others are kept. Each request is limited to [`STEP_TIMEOUT`].
async fn helm_metadata(
    client: &kube::Client,
    report: &mut SourceReport,
) -> CoreResult<Vec<ObjectMeta>> {
    let all = with_timeout(
        STEP_TIMEOUT,
        "listing Helm releases",
        helm::list_revision_metadata(client, None),
    )
    .await;
    let refused = match all {
        Ok(found) => return Ok(found),
        Err(e) if e.code == ErrorCode::Forbidden => e,
        Err(e) => return Err(e),
    };
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let listed = with_timeout(STEP_TIMEOUT, "listing namespaces", async {
        namespaces
            .list_metadata(&ListParams::default())
            .await
            .map_err(CoreError::from)
    })
    .await;
    let Ok(listed) = listed else {
        return Err(refused);
    };
    let mut names: Vec<String> = listed
        .items
        .into_iter()
        .filter_map(|n| n.metadata.name)
        .collect();
    names.sort();
    if names.len() > MAX_HELM_NAMESPACES {
        names.truncate(MAX_HELM_NAMESPACES);
        report.truncated = true;
    }
    let results: Vec<(String, CoreResult<Vec<ObjectMeta>>)> = futures::stream::iter(names)
        .map(|ns| async move {
            let found = with_timeout(
                STEP_TIMEOUT,
                "listing Helm releases",
                helm::list_revision_metadata(client, Some(&ns)),
            )
            .await;
            (ns, found)
        })
        .buffer_unordered(PARALLEL)
        .collect()
        .await;
    let mut metadata = Vec::new();
    let mut any = false;
    for (ns, found) in results {
        match found {
            Ok(found) => {
                any = true;
                metadata.extend(found);
            }
            Err(e) => report.skip(
                KindRef {
                    group: ns,
                    version: String::new(),
                    kind: String::new(),
                },
                e,
            ),
        }
    }
    if any { Ok(metadata) } else { Err(refused) }
}

/// The latest revision of each release, by namespace and name, without uninstalled ones (kept with
/// `--keep-history`); found from the labels or names of the release Secrets, nothing decoded.
fn helm_targets(metadata: Vec<ObjectMeta>) -> Vec<HelmTarget> {
    let mut latest: BTreeMap<(String, String), (i32, bool)> = BTreeMap::new();
    for meta in &metadata {
        let (Some(ns), Some((name, revision))) = (meta.namespace.clone(), helm::release_of(meta))
        else {
            continue;
        };
        let uninstalled = helm::label(meta, "status") == Some("uninstalled");
        let entry = latest.entry((ns, name)).or_insert((revision, uninstalled));
        if revision > entry.0 {
            *entry = (revision, uninstalled);
        }
    }
    latest
        .into_iter()
        .filter(|(_, (_, uninstalled))| !uninstalled)
        .map(|((namespace, name), (revision, _))| HelmTarget {
            namespace,
            name,
            revision,
        })
        .collect()
}

/// Reads the latest revision of each release (at most [`MAX_HELM_RELEASES`], each Secret fetched and decoded once,
/// within [`helm::MAX_RELEASE_BYTES`]) and keeps the documents of its manifest in a requested version. A release that
/// cannot be read is skipped (`group` the namespace, `kind` the release); the others are kept.
async fn helm_usages(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    client: &kube::Client,
    kinds: Result<&Vec<ResourceKind>, &CoreError>,
    wanted: &Wanted,
) -> (SourceReport, Vec<ApiUsage>) {
    let scoped = cluster_scoped(kinds.map(|k| k.as_slice()).unwrap_or_default());
    let mut report = SourceReport::new(ScanSource::Helm);
    let metadata = match helm_metadata(client, &mut report).await {
        Ok(metadata) => metadata,
        Err(e) => return (SourceReport::failed(ScanSource::Helm, e), Vec::new()),
    };
    let mut targets = helm_targets(metadata);
    if targets.len() > MAX_HELM_RELEASES {
        targets.truncate(MAX_HELM_RELEASES);
        report.truncated = true;
    }
    report.scanned = targets.len() as u32;
    let scoped = &scoped;
    let results: Vec<(HelmTarget, CoreResult<Vec<ApiUsage>>)> = futures::stream::iter(targets)
        .map(|release| async move {
            let read = with_timeout(
                STEP_TIMEOUT,
                "reading a Helm release",
                helm::stored_release(
                    mgr,
                    cluster,
                    &release.namespace,
                    &release.name,
                    Some(release.revision),
                ),
            )
            .await
            .map(|stored| {
                manifest_usages(&stored.manifest, wanted, &release.namespace, scoped)
                    .into_iter()
                    .map(|(api, namespace, name)| ApiUsage {
                        api,
                        namespace,
                        name,
                        origin: UsageOrigin::Helm {
                            release: release.name.clone(),
                            namespace: release.namespace.clone(),
                            revision: release.revision,
                        },
                    })
                    .collect()
            });
            (release, read)
        })
        .buffer_unordered(PARALLEL * 2)
        .collect()
        .await;
    let mut usages = Vec::new();
    for (release, result) in results {
        match result {
            Ok(found) => usages.extend(found),
            Err(e) => report.skip(
                KindRef {
                    group: release.namespace,
                    version: String::new(),
                    kind: release.name,
                },
                e,
            ),
        }
    }
    (report, usages)
}

/// Lists a GitOps kind page by page (whole objects: the status is needed), at most [`MAX_GITOPS_OBJECTS`], handing
/// each object to `each`; returns how many were seen and whether there were more.
async fn list_gitops(
    client: &kube::Client,
    kind: &ResourceKind,
    mut each: impl FnMut(&DynamicObject),
) -> CoreResult<(u32, bool)> {
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &api_resource(kind));
    let mut seen = 0usize;
    let mut token: Option<String> = None;
    loop {
        let mut params = ListParams::default().limit(GITOPS_PAGE);
        if let Some(t) = token.take() {
            params = params.continue_token(&t);
        }
        let list = with_timeout(STEP_TIMEOUT, "listing GitOps objects", async {
            api.list(&params).await.map_err(CoreError::from)
        })
        .await?;
        let next = list.metadata.continue_.clone().filter(|t| !t.is_empty());
        for item in &list.items {
            if seen == MAX_GITOPS_OBJECTS {
                return Ok((seen as u32, true));
            }
            seen += 1;
            each(item);
        }
        match next {
            None => return Ok((seen as u32, false)),
            Some(_) if seen == MAX_GITOPS_OBJECTS => return Ok((seen as u32, true)),
            Some(t) => token = Some(t),
        }
    }
}

fn find_kind<'a>(kinds: &'a [ResourceKind], group: &str, kind: &str) -> Option<&'a ResourceKind> {
    kinds
        .iter()
        .find(|k| k.kind_ref.group == group && k.kind_ref.kind == kind && listable(k))
}

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The resources an Argo CD Application manages (`status.resources[]`) in a requested version.
fn argo_usages_of(app: &DynamicObject, wanted: &Wanted) -> Vec<ApiUsage> {
    let application = app.metadata.name.clone().unwrap_or_default();
    let app_namespace = app.metadata.namespace.clone().unwrap_or_default();
    let resources = app
        .data
        .pointer("/status/resources")
        .and_then(Value::as_array);
    resources
        .into_iter()
        .flatten()
        .filter_map(|res| {
            let (group, version, kind) = (
                str_field(res, "group"),
                str_field(res, "version"),
                str_field(res, "kind"),
            );
            if !wanted.contains(group, version, kind) {
                return None;
            }
            let namespace = str_field(res, "namespace");
            Some(ApiUsage {
                api: KindRef {
                    group: group.to_owned(),
                    version: version.to_owned(),
                    kind: kind.to_owned(),
                },
                namespace: (!namespace.is_empty()).then(|| namespace.to_owned()),
                name: str_field(res, "name").to_owned(),
                origin: UsageOrigin::ArgoCd {
                    application: application.clone(),
                    namespace: app_namespace.clone(),
                },
            })
        })
        .collect()
}

/// The entries of a Flux Kustomization's inventory (`status.inventory.entries[]`: `id` is
/// `<namespace>_<name>_<group>_<kind>`, `v` the version) in a requested version.
fn flux_usages_of(kustomization: &DynamicObject, wanted: &Wanted) -> Vec<ApiUsage> {
    let name = kustomization.metadata.name.clone().unwrap_or_default();
    let namespace = kustomization.metadata.namespace.clone().unwrap_or_default();
    let entries = kustomization
        .data
        .pointer("/status/inventory/entries")
        .and_then(Value::as_array);
    entries
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let mut parts = str_field(entry, "id").splitn(4, '_');
            let (ns, object, group, kind) =
                (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
            let version = str_field(entry, "v");
            if !wanted.contains(group, version, kind) {
                return None;
            }
            Some(ApiUsage {
                api: KindRef {
                    group: group.to_owned(),
                    version: version.to_owned(),
                    kind: kind.to_owned(),
                },
                namespace: (!ns.is_empty()).then(|| ns.to_owned()),
                name: object.to_owned(),
                origin: UsageOrigin::Flux {
                    kustomization: name.clone(),
                    namespace: namespace.clone(),
                },
            })
        })
        .collect()
}

async fn gitops_usages(
    source: ScanSource,
    client: &kube::Client,
    kinds: Result<&Vec<ResourceKind>, &CoreError>,
    (group, kind): (&str, &str),
    wanted: &Wanted,
    usages_of: fn(&DynamicObject, &Wanted) -> Vec<ApiUsage>,
) -> (SourceReport, Vec<ApiUsage>) {
    let kinds = match kinds {
        Ok(kinds) => kinds,
        Err(e) => return (SourceReport::failed(source, e.clone()), Vec::new()),
    };
    let Some(kind) = find_kind(kinds, group, kind) else {
        return (SourceReport::not_installed(source), Vec::new());
    };
    let mut usages = Vec::new();
    match list_gitops(client, kind, |obj| usages.extend(usages_of(obj, wanted))).await {
        Ok((scanned, truncated)) => (
            SourceReport {
                scanned,
                truncated,
                ..SourceReport::new(source)
            },
            usages,
        ),
        Err(e) => (SourceReport::failed(source, e), Vec::new()),
    }
}

async fn argo_usages(
    client: &kube::Client,
    kinds: Result<&Vec<ResourceKind>, &CoreError>,
    wanted: &Wanted,
) -> (SourceReport, Vec<ApiUsage>) {
    gitops_usages(
        ScanSource::ArgoCd,
        client,
        kinds,
        (ARGO_GROUP, "Application"),
        wanted,
        argo_usages_of,
    )
    .await
}

async fn flux_usages(
    client: &kube::Client,
    kinds: Result<&Vec<ResourceKind>, &CoreError>,
    wanted: &Wanted,
) -> (SourceReport, Vec<ApiUsage>) {
    gitops_usages(
        ScanSource::Flux,
        client,
        kinds,
        (FLUX_KUSTOMIZE_GROUP, "Kustomization"),
        wanted,
        flux_usages_of,
    )
    .await
}

fn has_label(meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta, key: &str) -> bool {
    meta.labels.as_ref().is_some_and(|l| l.contains_key(key))
}

fn node_version(node: Node) -> NodeVersion {
    let info = node.status.and_then(|s| s.node_info);
    NodeVersion {
        control_plane: has_label(&node.metadata, "node-role.kubernetes.io/control-plane")
            || has_label(&node.metadata, "node-role.kubernetes.io/master"),
        name: node.metadata.name.unwrap_or_default(),
        kubelet_version: info
            .as_ref()
            .map(|i| i.kubelet_version.clone())
            .unwrap_or_default(),
        #[allow(deprecated)]
        kube_proxy_version: info
            .as_ref()
            .map(|i| i.kube_proxy_version.clone())
            .unwrap_or_default(),
    }
}

async fn nodes(client: &kube::Client) -> (SourceReport, Vec<NodeVersion>) {
    let api: Api<Node> = Api::all(client.clone());
    let mut report = SourceReport::new(ScanSource::Nodes);
    let mut out = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut params = ListParams::default().limit(PAGE);
        if let Some(t) = token.take() {
            params = params.continue_token(&t);
        }
        let list = match with_timeout(STEP_TIMEOUT, "listing nodes", async {
            api.list(&params).await.map_err(CoreError::from)
        })
        .await
        {
            Ok(list) => list,
            Err(e) => return (SourceReport::failed(ScanSource::Nodes, e), Vec::new()),
        };
        let next = list.metadata.continue_.clone().filter(|t| !t.is_empty());
        for node in list.items {
            if out.len() == MAX_NODES {
                report.truncated = true;
                break;
            }
            out.push(node_version(node));
        }
        match next {
            Some(t) if !report.truncated && out.len() < MAX_NODES => token = Some(t),
            Some(_) => {
                report.truncated = true;
                break;
            }
            None => break,
        }
    }
    report.scanned = out.len() as u32;
    out.sort_by(|a, b| a.name.cmp(&b.name));
    (report, out)
}

/// The tag of an image reference (`registry.k8s.io/kube-apiserver:v1.31.4@sha256:…` → `v1.31.4`); empty without one.
fn image_tag(image: &str) -> String {
    let without_digest = image.split('@').next().unwrap_or_default();
    let last = without_digest.rsplit('/').next().unwrap_or_default();
    last.split_once(':')
        .map(|(_, tag)| tag.to_owned())
        .unwrap_or_default()
}

fn component_version(pod: Pod) -> ComponentVersion {
    let labels = pod.metadata.labels.clone().unwrap_or_default();
    let container = pod.spec.as_ref().and_then(|s| s.containers.first());
    ComponentVersion {
        component: labels
            .get("component")
            .cloned()
            .or_else(|| container.map(|c| c.name.clone()))
            .unwrap_or_default(),
        pod: pod.metadata.name.clone().unwrap_or_default(),
        node: pod
            .spec
            .as_ref()
            .and_then(|s| s.node_name.clone())
            .unwrap_or_default(),
        version: container
            .and_then(|c| c.image.as_deref())
            .map(image_tag)
            .unwrap_or_default(),
    }
}

async fn control_plane(client: &kube::Client) -> (SourceReport, Vec<ComponentVersion>) {
    let api: Api<Pod> = Api::namespaced(client.clone(), "kube-system");
    let params = ListParams::default()
        .labels("tier=control-plane")
        .limit(PAGE);
    match with_timeout(STEP_TIMEOUT, "listing control-plane pods", async {
        api.list(&params).await.map_err(CoreError::from)
    })
    .await
    {
        Ok(list) => {
            let mut out: Vec<ComponentVersion> =
                list.items.into_iter().map(component_version).collect();
            out.sort_by(|a, b| (&a.component, &a.pod).cmp(&(&b.component, &b.pod)));
            (
                SourceReport {
                    scanned: out.len() as u32,
                    ..SourceReport::new(ScanSource::ControlPlane)
                },
                out,
            )
        }
        Err(e) => (
            SourceReport::failed(ScanSource::ControlPlane, e),
            Vec::new(),
        ),
    }
}

#[cfg(test)]
mod tests;
