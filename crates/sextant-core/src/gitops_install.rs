//! Installing Flux and Argo CD from their official `install.yaml`, through the Kubernetes API only.
//!
//! Nothing here touches the network: the caller downloads the manifest (and checks it), [`prepare`] turns its text
//! into an [`InstallPlan`] (Flux as `flux install` does by default, Argo CD into the namespace `argocd`), [`apply`]
//! server-side applies the plan object by object and reports every step, and [`readiness`] tells whether the
//! controllers came up and, when not, why (from their pods). [`installed`] and [`access_check`] answer the questions
//! the preview asks before anything is sent.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};

use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use k8s_openapi::api::core::v1::{Namespace, Pod};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use kube::Api;
use kube::api::{ApiResource, DynamicObject, ListParams, Patch, PatchParams, PostParams};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::kubeconfig::ClusterId;
use crate::resources::{Document, KindRef, STEP_TIMEOUT, parse_documents};

/// A GitOps tool Sextant can install.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum GitopsTool {
    Flux,
    ArgoCd,
}

/// One object of a plan, as the preview lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlannedObject {
    pub kind: String,
    pub name: String,
    /// `None` for a cluster-scoped object.
    pub namespace: Option<String>,
    /// Namespace, CustomResourceDefinition, ClusterRole, ClusterRoleBinding: they change the whole cluster.
    pub cluster_scoped: bool,
}

/// What an install changes, built by [`prepare`]: the objects in the order [`apply`] sends them.
#[derive(Debug, Clone)]
pub struct InstallPlan {
    pub tool: GitopsTool,
    pub version: String,
    /// Where the tool's namespaced objects go: `flux-system` or `argocd`.
    pub namespace: String,
    /// In apply order: the Namespace, the CustomResourceDefinitions, then the rest in the file's order.
    pub objects: Vec<PlannedObject>,
    /// The documents sent, one per object, in the same order.
    documents: Vec<Document>,
}

/// How many objects of one kind a plan has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KindCount {
    pub kind: String,
    pub count: u32,
}

/// The preview of a plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstallSummary {
    pub tool: GitopsTool,
    pub version: String,
    pub namespace: String,
    /// Kinds in the order they first appear in the plan.
    pub kinds: Vec<KindCount>,
    pub objects: Vec<PlannedObject>,
    /// How many of the objects are cluster-scoped.
    pub cluster_scoped: u32,
}

/// One step of [`apply`]: an object applied, or the object whose failure ended the apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum InstallStep {
    Applied {
        kind: String,
        name: String,
    },
    Failed {
        kind: String,
        name: String,
        error: String,
    },
}

/// What [`apply`] did when no object failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyReport {
    /// The objects applied, in order.
    pub applied: Vec<PlannedObject>,
    /// The stop flag of [`apply_until`] ended the apply before the plan's end.
    pub stopped: bool,
}

/// Whether one Deployment or StatefulSet of the installed set is ready, and why not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkloadState {
    pub kind: String,
    pub name: String,
    pub ready: bool,
    /// Why it is not ready: a pod's waiting reason ("pod x: ImagePullBackOff: …"), why a pod is not scheduled, a
    /// failed condition of the workload. `None` when ready.
    pub reason: Option<String>,
}

/// Whether a tool is in the cluster.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledState {
    /// Every CustomResourceDefinition of the tool's standard set exists.
    pub present: bool,
    /// Not present, but its namespace or some of its CustomResourceDefinitions exist: an install updates them.
    pub partial: bool,
}

/// Whether the user may create what an install creates (SelfSubjectAccessReview).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AccessCheck {
    pub can_create_crds: bool,
    pub can_create_cluster_role_bindings: bool,
}

/// Field manager of the apply, the same as every change Sextant makes.
const FIELD_MANAGER: &str = "sextant";
const COMPONENT_LABEL: &str = "app.kubernetes.io/component";
const PART_OF_LABEL: &str = "app.kubernetes.io/part-of";
const CRD_GROUP: &str = "apiextensions.k8s.io";
const RBAC_GROUP: &str = "rbac.authorization.k8s.io";

/// Components of Flux's `install.yaml` that `flux install` leaves out by default (image automation and the source
/// watcher): their documents carry this `app.kubernetes.io/component`.
const FLUX_EXTRA_COMPONENTS: [&str; 3] = [
    "image-reflector-controller",
    "image-automation-controller",
    "source-watcher",
];
/// API groups of those components' CustomResourceDefinitions.
const FLUX_EXTRA_GROUPS: [&str; 2] = ["image.toolkit.fluxcd.io", "source.extensions.fluxcd.io"];

/// The CustomResourceDefinitions every Flux v2 install of the default set has (newer ones, such as
/// `externalartifacts`, are left out so an older Flux still counts as installed).
const FLUX_CRDS: &[&str] = &[
    "gitrepositories.source.toolkit.fluxcd.io",
    "helmrepositories.source.toolkit.fluxcd.io",
    "helmcharts.source.toolkit.fluxcd.io",
    "buckets.source.toolkit.fluxcd.io",
    "ocirepositories.source.toolkit.fluxcd.io",
    "kustomizations.kustomize.toolkit.fluxcd.io",
    "helmreleases.helm.toolkit.fluxcd.io",
    "alerts.notification.toolkit.fluxcd.io",
    "providers.notification.toolkit.fluxcd.io",
    "receivers.notification.toolkit.fluxcd.io",
];
/// Argo CD's CustomResourceDefinitions (other Argo projects share the group `argoproj.io`).
const ARGOCD_CRDS: &[&str] = &[
    "applications.argoproj.io",
    "applicationsets.argoproj.io",
    "appprojects.argoproj.io",
];

/// The kinds the official files use, as (group, kind, plural); a manifest with any other kind is refused. All are
/// built into every API server, so the apply needs no discovery.
const ALLOWED_KINDS: &[(&str, &str, &str)] = &[
    ("", "Namespace", "namespaces"),
    ("", "ResourceQuota", "resourcequotas"),
    ("", "ServiceAccount", "serviceaccounts"),
    ("", "ConfigMap", "configmaps"),
    ("", "Secret", "secrets"),
    ("", "Service", "services"),
    (
        CRD_GROUP,
        "CustomResourceDefinition",
        "customresourcedefinitions",
    ),
    (RBAC_GROUP, "ClusterRole", "clusterroles"),
    (RBAC_GROUP, "ClusterRoleBinding", "clusterrolebindings"),
    (RBAC_GROUP, "Role", "roles"),
    (RBAC_GROUP, "RoleBinding", "rolebindings"),
    ("apps", "Deployment", "deployments"),
    ("apps", "StatefulSet", "statefulsets"),
    ("networking.k8s.io", "NetworkPolicy", "networkpolicies"),
];
/// The allowed kinds without a namespace; every other allowed kind is namespaced.
const CLUSTER_SCOPED_KINDS: &[&str] = &[
    "Namespace",
    "CustomResourceDefinition",
    "ClusterRole",
    "ClusterRoleBinding",
];

impl GitopsTool {
    /// "Flux", "Argo CD".
    pub fn title(self) -> &'static str {
        match self {
            Self::Flux => "Flux",
            Self::ArgoCd => "Argo CD",
        }
    }

    /// The namespace the official manifest is made for (its RBAC names it).
    pub fn namespace(self) -> &'static str {
        match self {
            Self::Flux => "flux-system",
            Self::ArgoCd => "argocd",
        }
    }

    /// `app.kubernetes.io/part-of` of the tool's workloads.
    fn part_of(self) -> &'static str {
        match self {
            Self::Flux => "flux",
            Self::ArgoCd => "argocd",
        }
    }

    fn crds(self) -> &'static [&'static str] {
        match self {
            Self::Flux => FLUX_CRDS,
            Self::ArgoCd => ARGOCD_CRDS,
        }
    }

    /// The CustomResourceDefinition without which a text is not this tool's manifest.
    fn key_crd(self) -> &'static str {
        match self {
            Self::Flux => "kustomizations.kustomize.toolkit.fluxcd.io",
            Self::ArgoCd => "applications.argoproj.io",
        }
    }
}

impl InstallPlan {
    /// The documents [`apply`] sends, in order, one per [`InstallPlan::objects`] entry.
    pub fn documents(&self) -> &[Document] {
        &self.documents
    }

    pub fn summary(&self) -> InstallSummary {
        let mut kinds: Vec<KindCount> = Vec::new();
        for object in &self.objects {
            match kinds.iter_mut().find(|k| k.kind == object.kind) {
                Some(count) => count.count += 1,
                None => kinds.push(KindCount {
                    kind: object.kind.clone(),
                    count: 1,
                }),
            }
        }
        InstallSummary {
            tool: self.tool,
            version: self.version.clone(),
            namespace: self.namespace.clone(),
            kinds,
            objects: self.objects.clone(),
            cluster_scoped: self.objects.iter().filter(|o| o.cluster_scoped).count() as u32,
        }
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// `v1.2.3`: the tags both projects release under.
fn is_release_tag(version: &str) -> bool {
    let Some(numbers) = version.strip_prefix('v') else {
        return false;
    };
    let parts: Vec<&str> = numbers.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The plural of an allowed kind; `None` for any other.
fn allowed_plural(kind: &KindRef) -> Option<&'static str> {
    ALLOWED_KINDS
        .iter()
        .find(|(group, name, _)| *group == kind.group && *name == kind.kind)
        .map(|(_, _, plural)| *plural)
}

/// A Flux document of a component `flux install` leaves out.
fn is_extra_flux_component(doc: &Document) -> bool {
    let value = doc.value();
    let component = value
        .pointer("/metadata/labels")
        .and_then(|labels| labels.get(COMPONENT_LABEL))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if FLUX_EXTRA_COMPONENTS.contains(&component) {
        return true;
    }
    doc.kind_ref().kind == "CustomResourceDefinition"
        && value
            .pointer("/spec/group")
            .and_then(Value::as_str)
            .is_some_and(|group| FLUX_EXTRA_GROUPS.contains(&group))
}

/// Removes the left-out components' ServiceAccounts from a binding's subjects, as `flux install` writes the shared
/// bindings for the installed components only. False when no subject is left (the binding is then not installed).
fn keep_flux_subjects(value: &mut Value, namespace: &str) -> bool {
    let Some(subjects) = value.get_mut("subjects").and_then(Value::as_array_mut) else {
        return true;
    };
    if subjects.is_empty() {
        return true;
    }
    subjects.retain(|subject| {
        let text = |key: &str| subject.get(key).and_then(Value::as_str);
        let extra = text("kind") == Some("ServiceAccount")
            && text("name").is_some_and(|name| FLUX_EXTRA_COMPONENTS.contains(&name))
            && text("namespace").is_none_or(|ns| ns == namespace);
        !extra
    });
    !subjects.is_empty()
}

/// Builds the install plan of `tool` from the text of its official `install.yaml` (no network, no cluster).
///
/// Flux: as `flux install` by default — the documents of image-reflector-controller, image-automation-controller
/// and source-watcher (Deployments, ServiceAccounts, Services, CustomResourceDefinitions) are dropped, and the
/// shared bindings stop naming their ServiceAccounts. Argo CD: a Namespace `argocd` comes first and every
/// namespaced document without a namespace gets `argocd`. Objects are ordered Namespace, CustomResourceDefinitions,
/// then the rest in the file's order.
///
/// `invalid` when the version is not a release tag (`v1.2.3`), the text has a document with the hidden-values
/// marker, a kind the official files do not use, a namespaced object outside the tool's namespace, or is not the
/// tool's manifest at all.
pub fn prepare(tool: GitopsTool, version: &str, manifest: &str) -> CoreResult<InstallPlan> {
    if !is_release_tag(version) {
        return Err(invalid(format!(
            "version {version:?} is not a release tag like v1.2.3"
        )));
    }
    let namespace = tool.namespace();
    let mut namespaces: Vec<(Value, PlannedObject)> = Vec::new();
    let mut crds: Vec<(Value, PlannedObject)> = Vec::new();
    let mut rest: Vec<(Value, PlannedObject)> = Vec::new();
    for doc in parse_documents(manifest)? {
        let kind = doc.kind_ref();
        let described = format!("{} ({} {})", doc.label(), kind.kind, doc.name());
        if allowed_plural(kind).is_none() {
            let api_version = if kind.group.is_empty() {
                kind.version.clone()
            } else {
                format!("{}/{}", kind.group, kind.version)
            };
            return Err(invalid(format!(
                "{described}: {api_version} {} is not a kind the official {} manifest uses",
                kind.kind,
                tool.title()
            )));
        }
        if tool == GitopsTool::Flux && is_extra_flux_component(&doc) {
            continue;
        }
        let cluster_scoped = CLUSTER_SCOPED_KINDS.contains(&kind.kind.as_str());
        let mut value = doc.value().clone();
        if cluster_scoped {
            if kind.kind == "Namespace" && doc.name() != namespace {
                return Err(invalid(format!(
                    "{described}: {} is installed into the namespace {namespace}",
                    tool.title()
                )));
            }
        } else {
            match doc.namespace() {
                None => value["metadata"]["namespace"] = json!(namespace),
                Some(ns) if ns == namespace => {}
                Some(other) => {
                    return Err(invalid(format!(
                        "{described}: the namespace {other} is not {namespace}, where {} is installed",
                        tool.title()
                    )));
                }
            }
        }
        if tool == GitopsTool::Flux
            && kind.kind.ends_with("Binding")
            && !keep_flux_subjects(&mut value, namespace)
        {
            continue;
        }
        let object = PlannedObject {
            kind: kind.kind.clone(),
            name: doc.name().to_owned(),
            namespace: (!cluster_scoped).then(|| namespace.to_owned()),
            cluster_scoped,
        };
        match kind.kind.as_str() {
            "Namespace" => namespaces.push((value, object)),
            "CustomResourceDefinition" => crds.push((value, object)),
            _ => rest.push((value, object)),
        }
    }
    let is_tool_manifest = crds.iter().any(|(_, o)| o.name == tool.key_crd())
        && rest.iter().any(|(_, o)| o.kind == "Deployment");
    if !is_tool_manifest {
        return Err(invalid(format!(
            "the text is not the {} install.yaml: it has no CustomResourceDefinition {} or no Deployment",
            tool.title(),
            tool.key_crd()
        )));
    }
    if namespaces.is_empty() {
        namespaces.push((
            json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace}}),
            PlannedObject {
                kind: "Namespace".into(),
                name: namespace.into(),
                namespace: None,
                cluster_scoped: true,
            },
        ));
    }

    let (values, objects): (Vec<Value>, Vec<PlannedObject>) =
        namespaces.into_iter().chain(crds).chain(rest).unzip();
    // The documents are read once more from the changed values, so what is sent went through the same reading
    // (and the same refusals) as any apply.
    let text = values
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()?
        .join("\n---\n");
    let documents = parse_documents(&text)?;
    if documents.len() != objects.len() {
        return Err(CoreError::other(
            "the prepared documents do not match the planned objects",
        ));
    }
    Ok(InstallPlan {
        tool,
        version: version.to_owned(),
        namespace: namespace.to_owned(),
        objects,
        documents,
    })
}

/// [`apply_until`] without a stop flag.
pub async fn apply(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    plan: &InstallPlan,
    on_step: impl FnMut(InstallStep),
) -> CoreResult<ApplyReport> {
    apply_until(mgr, cluster, plan, &AtomicBool::new(false), on_step).await
}

/// Server-side applies the plan (field manager `sextant`) object by object, in the plan's order: the Namespace, the
/// CustomResourceDefinitions, then [`ClusterManager::refresh_kinds`] and the rest. Each request is limited to
/// [`STEP_TIMEOUT`]; every object applied is reported to `on_step` as it is done.
///
/// The apply forces its ownership of conflicting fields, as `flux install` and `kubectl apply --server-side
/// --force-conflicts` do: an install over an existing or partial one (made by `kubectl` or by another tool) updates
/// the objects instead of stopping at the first field another manager owns. The preview warns about that.
///
/// `stop` is read before each object: once it is set, the apply ends after the object being sent and the report
/// says `stopped`. The first failure is reported as [`InstallStep::Failed`] and ends the apply with that error (its
/// code kept), naming the object and how many objects were applied before it; nothing after it is sent.
pub async fn apply_until(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    plan: &InstallPlan,
    stop: &AtomicBool,
    mut on_step: impl FnMut(InstallStep),
) -> CoreResult<ApplyReport> {
    let client = mgr.client(cluster)?;
    let total = plan.objects.len();
    let mut applied: Vec<PlannedObject> = Vec::with_capacity(total);
    let mut refresh_due = false;
    let mut stopped = false;
    let mut failure = None;
    for (object, doc) in plan.objects.iter().zip(&plan.documents) {
        if stop.load(Ordering::SeqCst) {
            stopped = true;
            break;
        }
        let early = object.kind == "Namespace" || object.kind == "CustomResourceDefinition";
        if refresh_due && !early {
            // The new kinds become visible without reconnecting; the rest of the plan uses only built-in kinds.
            mgr.refresh_kinds(cluster);
            refresh_due = false;
        }
        match apply_one(&client, object, doc).await {
            Ok(()) => {
                refresh_due |= object.kind == "CustomResourceDefinition";
                on_step(InstallStep::Applied {
                    kind: object.kind.clone(),
                    name: object.name.clone(),
                });
                applied.push(object.clone());
            }
            Err(err) => {
                failure = Some((object, err));
                break;
            }
        }
    }
    if refresh_due {
        mgr.refresh_kinds(cluster);
    }
    if let Some((object, err)) = failure {
        let reason = err.message;
        on_step(InstallStep::Failed {
            kind: object.kind.clone(),
            name: object.name.clone(),
            error: reason.clone(),
        });
        let name = match &object.namespace {
            Some(ns) => format!("{ns}/{}", object.name),
            None => object.name.clone(),
        };
        return Err(CoreError::new(
            err.code,
            format!(
                "{} {name}: {reason} ({} of {total} objects were applied before it; the rest were not sent)",
                object.kind,
                applied.len()
            ),
        ));
    }
    Ok(ApplyReport { applied, stopped })
}

/// One forced server-side apply of an allowed (built-in) kind, at the document's own version.
async fn apply_one(
    client: &kube::Client,
    object: &PlannedObject,
    doc: &Document,
) -> CoreResult<()> {
    let kind = doc.kind_ref();
    let plural = allowed_plural(kind)
        .ok_or_else(|| invalid(format!("{} is not a kind an install applies", kind.kind)))?;
    let resource = ApiResource {
        group: kind.group.clone(),
        version: kind.version.clone(),
        api_version: if kind.group.is_empty() {
            kind.version.clone()
        } else {
            format!("{}/{}", kind.group, kind.version)
        },
        kind: kind.kind.clone(),
        plural: plural.to_owned(),
    };
    let api: Api<DynamicObject> = match &object.namespace {
        Some(ns) => Api::namespaced_with(client.clone(), ns, &resource),
        None => Api::all_with(client.clone(), &resource),
    };
    let params = PatchParams::apply(FIELD_MANAGER).force();
    with_timeout(STEP_TIMEOUT, "applying it", async {
        api.patch(&object.name, &params, &Patch::Apply(doc.value()))
            .await
            .map(drop)
            .map_err(CoreError::from)
    })
    .await
}

/// A Deployment or StatefulSet as [`readiness`] reads it.
struct Workload {
    kind: &'static str,
    name: String,
    labels: BTreeMap<String, String>,
    ready: bool,
    selector: Option<LabelSelector>,
    /// Why not ready when no pod says more (a failed condition).
    condition: Option<String>,
}

/// The state of the tool's Deployments and StatefulSets (`app.kubernetes.io/part-of` `flux` / `argocd`) in
/// `namespace`, in the order the API lists them (Deployments first). For Flux, the components `flux install` leaves
/// out are not part of the installed set and are not listed. A workload is ready when its controller has seen its
/// last change and all wanted replicas are updated and available (ready for a StatefulSet); the reason of one that
/// is not comes from its pods (a container's waiting reason such as `ImagePullBackOff`, an unscheduled pod's
/// message), else from its failed condition. Empty when none exists.
pub async fn readiness(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    tool: GitopsTool,
    namespace: &str,
) -> CoreResult<Vec<WorkloadState>> {
    let client = mgr.client(cluster)?;
    let params = ListParams::default().labels(&format!("{PART_OF_LABEL}={}", tool.part_of()));
    let deployments = with_timeout(STEP_TIMEOUT, "listing the Deployments", async {
        Api::<Deployment>::namespaced(client.clone(), namespace)
            .list(&params)
            .await
            .map_err(CoreError::from)
    })
    .await?;
    let stateful_sets = with_timeout(STEP_TIMEOUT, "listing the StatefulSets", async {
        Api::<StatefulSet>::namespaced(client.clone(), namespace)
            .list(&params)
            .await
            .map_err(CoreError::from)
    })
    .await?;

    let workloads: Vec<Workload> = deployments
        .items
        .iter()
        .map(deployment_workload)
        .chain(stateful_sets.items.iter().map(stateful_set_workload))
        .filter(|w| {
            tool != GitopsTool::Flux
                || !w
                    .labels
                    .get(COMPONENT_LABEL)
                    .is_some_and(|c| FLUX_EXTRA_COMPONENTS.contains(&c.as_str()))
        })
        .collect();

    let pods = if workloads.iter().all(|w| w.ready) {
        Vec::new()
    } else {
        with_timeout(STEP_TIMEOUT, "listing the pods", async {
            Api::<Pod>::namespaced(client.clone(), namespace)
                .list(&ListParams::default())
                .await
                .map_err(CoreError::from)
        })
        .await?
        .items
    };

    Ok(workloads
        .into_iter()
        .map(|w| {
            let reason = (!w.ready).then(|| {
                pods.iter()
                    .filter(|pod| selects(w.selector.as_ref(), pod))
                    .find_map(pod_problem)
                    .or(w.condition.clone())
                    .unwrap_or_else(|| "waiting for its pods".to_owned())
            });
            WorkloadState {
                kind: w.kind.to_owned(),
                name: w.name,
                ready: w.ready,
                reason,
            }
        })
        .collect())
}

/// Whether the workload's controller has seen its last change.
fn observed(generation: Option<i64>, observed: Option<i64>) -> bool {
    match (generation, observed) {
        (Some(generation), Some(observed)) => observed >= generation,
        (Some(_), None) => false,
        (None, _) => true,
    }
}

fn deployment_workload(d: &Deployment) -> Workload {
    let wanted = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let status = d.status.clone().unwrap_or_default();
    let ready = observed(d.metadata.generation, status.observed_generation)
        && status.updated_replicas.unwrap_or(0) >= wanted
        && status.available_replicas.unwrap_or(0) >= wanted;
    let conditions = status.conditions.unwrap_or_default();
    let failed = |kind: &str, bad: &str| {
        conditions
            .iter()
            .find(|c| c.type_ == kind && c.status == bad)
            .and_then(|c| c.message.clone().or(c.reason.clone()))
    };
    Workload {
        kind: "Deployment",
        name: d.metadata.name.clone().unwrap_or_default(),
        labels: d.metadata.labels.clone().unwrap_or_default(),
        ready,
        selector: d.spec.as_ref().map(|s| s.selector.clone()),
        condition: failed("ReplicaFailure", "True")
            .or_else(|| failed("Progressing", "False"))
            .or_else(|| failed("Available", "False")),
    }
}

fn stateful_set_workload(s: &StatefulSet) -> Workload {
    let wanted = s.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let status = s.status.clone().unwrap_or_default();
    let updated = match (&status.current_revision, &status.update_revision) {
        (Some(current), Some(update)) => current == update,
        _ => true,
    };
    let ready = observed(s.metadata.generation, status.observed_generation)
        && status.ready_replicas.unwrap_or(0) >= wanted
        && updated;
    Workload {
        kind: "StatefulSet",
        name: s.metadata.name.clone().unwrap_or_default(),
        labels: s.metadata.labels.clone().unwrap_or_default(),
        ready,
        selector: s.spec.as_ref().map(|s| s.selector.clone()),
        condition: None,
    }
}

/// Whether the selector's `matchLabels` pick the pod (the official manifests use nothing else); an empty selector
/// picks nothing.
fn selects(selector: Option<&LabelSelector>, pod: &Pod) -> bool {
    let Some(wanted) = selector
        .and_then(|s| s.match_labels.as_ref())
        .filter(|m| !m.is_empty())
    else {
        return false;
    };
    let labels = pod.metadata.labels.as_ref();
    wanted
        .iter()
        .all(|(key, value)| labels.and_then(|l| l.get(key)) == Some(value))
}

/// Why a pod is not running ready: a container's waiting reason, a failed container, an unscheduled pod, a
/// container that is not ready. `None` when nothing is wrong.
fn pod_problem(pod: &Pod) -> Option<String> {
    let name = pod.metadata.name.as_deref().unwrap_or_default();
    let status = pod.status.as_ref()?;
    let said = |reason: &str, message: Option<&str>| match message.filter(|m| !m.is_empty()) {
        Some(message) => format!("pod {name}: {reason}: {message}"),
        None => format!("pod {name}: {reason}"),
    };
    let init = status.init_container_statuses.iter().flatten();
    let main = status.container_statuses.iter().flatten();
    for container in init.clone().chain(main.clone()) {
        let state = container.state.as_ref();
        if let Some(waiting) = state.and_then(|s| s.waiting.as_ref())
            && let Some(reason) = waiting.reason.as_deref().filter(|r| !r.is_empty())
        {
            return Some(said(reason, waiting.message.as_deref()));
        }
        if let Some(done) = state.and_then(|s| s.terminated.as_ref())
            && done.exit_code != 0
        {
            let reason = done.reason.as_deref().unwrap_or("Error");
            return Some(said(reason, done.message.as_deref()));
        }
    }
    if let Some(unscheduled) = status
        .conditions
        .iter()
        .flatten()
        .find(|c| c.type_ == "PodScheduled" && c.status == "False")
    {
        let reason = unscheduled.reason.as_deref().unwrap_or("Unschedulable");
        return Some(said(reason, unscheduled.message.as_deref()));
    }
    if let Some(container) = main.clone().find(|c| !c.ready) {
        return Some(format!(
            "pod {name}: container {} is not ready",
            container.name
        ));
    }
    match status.phase.as_deref() {
        Some("Running" | "Succeeded") | None => None,
        Some(phase) => Some(format!("pod {name}: {phase}")),
    }
}

/// Whether the tool is in the cluster: present when every CustomResourceDefinition of its standard set exists;
/// partial when not, but its namespace or some of those definitions exist (an install then updates them). Read from
/// the cluster, not from the cached discovery.
pub async fn installed(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    tool: GitopsTool,
) -> CoreResult<InstalledState> {
    let client = mgr.client(cluster)?;
    let crds = with_timeout(
        STEP_TIMEOUT,
        "listing the CustomResourceDefinitions",
        async {
            Api::<CustomResourceDefinition>::all(client.clone())
                .list_metadata(&ListParams::default())
                .await
                .map_err(CoreError::from)
        },
    )
    .await?;
    let existing: BTreeSet<String> = crds
        .items
        .into_iter()
        .filter_map(|crd| crd.metadata.name)
        .collect();
    let found = tool
        .crds()
        .iter()
        .filter(|name| existing.contains(**name))
        .count();
    if found == tool.crds().len() {
        return Ok(InstalledState {
            present: true,
            partial: false,
        });
    }
    let namespace = with_timeout(STEP_TIMEOUT, "reading the namespace", async {
        Api::<Namespace>::all(client.clone())
            .get_metadata_opt(tool.namespace())
            .await
            .map_err(CoreError::from)
    })
    .await?;
    Ok(InstalledState {
        present: false,
        partial: found > 0 || namespace.is_some(),
    })
}

/// Whether the user may create CustomResourceDefinitions and ClusterRoleBindings, as the API server answers a
/// SelfSubjectAccessReview for each. Both are needed by either install; the preview warns when one is missing.
pub async fn access_check(mgr: &ClusterManager, cluster: &ClusterId) -> CoreResult<AccessCheck> {
    let client = mgr.client(cluster)?;
    let can_create_crds = can_create(&client, CRD_GROUP, "customresourcedefinitions").await?;
    let can_create_cluster_role_bindings =
        can_create(&client, RBAC_GROUP, "clusterrolebindings").await?;
    Ok(AccessCheck {
        can_create_crds,
        can_create_cluster_role_bindings,
    })
}

async fn can_create(client: &kube::Client, group: &str, resource: &str) -> CoreResult<bool> {
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                verb: Some("create".to_owned()),
                group: Some(group.to_owned()),
                resource: Some(resource.to_owned()),
                ..Default::default()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let answered = with_timeout(STEP_TIMEOUT, "checking access", async {
        Api::<SelfSubjectAccessReview>::all(client.clone())
            .create(&PostParams::default(), &review)
            .await
            .map_err(CoreError::from)
    })
    .await?;
    Ok(answered.status.is_some_and(|s| s.allowed))
}

#[cfg(test)]
mod tests;
