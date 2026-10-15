//! Tools that change a cluster: apply, patch, delete, scale, restart, node and CronJob actions, GitOps actions, Helm,
//! a command in a container and port forwards. Every one checks the cluster's access rules through the call's `Guard`
//! right before it acts (`Guard::check` also waits for "Allow" in the window when a rule asks for it, and refuses once
//! the server has stopped); what the agent named is checked for sense before that, so the user is not asked about a
//! call that cannot run. The details shown in the dialog (YAML, a command, a port) never reach the journal.
//!
//! What each tool needs (spec "Decisions", table of actions):
//!
//! | tool | needs |
//! |---|---|
//! | `apply_yaml` | Modify on the kind of every document, in its namespace (all checked before anything is sent) |
//! | `patch_resource`, `scale`, `restart`, `trigger_cronjob`, `suspend_cronjob`, `gitops_action`, `cordon_node` | Modify on the kind |
//! | `delete_resource` | Delete on the kind |
//! | `drain_node` | Modify on `Node` and Delete on `Pod` in all namespaces |
//! | `exec_command` | Exec on `Pod` |
//! | `port_forward_start` | Port forward on `Pod` / `Service`; list and stop see only the agents' own forwards |
//! | `helm_install`, `helm_upgrade` (5 min), `helm_rollback`, `helm_uninstall` (2 min) | Modify on `helm.sh/Release`; `helm_uninstall` — Delete |
//!
//! Whatever the rules say, an agent never runs a command in a node shell pod, changes one or deletes one
//! (`exec_command`, `patch_resource`, `apply_yaml`, `delete_resource`; see [`refuse_named_node_shell`] and
//! [`refuse_live_node_shell`]): a command there runs on the node itself. `drain_node` leaves node shell pods on the
//! node (`DrainOptions::keep_node_shells`), and `port_forward_start` never reaches a pod that is a node shell or uses
//! the node's network (`spec.hostNetwork`), its ports being the node's own: such a pod target is refused, and a service
//! forward skips such pods whenever it picks one (`PodFilter::NoNodeAccess`) and is refused when they are all the
//! service has. A Helm call past its time limit, or whose server stops, has its `helm` killed (`helm repo list`, which
//! only reads, has 30 s).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use sextant_core::access::{AccessAction, KindPattern};
use sextant_core::error::with_timeout;
use sextant_core::exec;
use sextant_core::helm::cli::{self as helm_cli, HelmCli};
use sextant_core::portforward::{ForwardTarget, PodFilter};
use sextant_core::resources::{self, KindRef, ObjectRef, PatchType};
use sextant_core::{ClusterId, CoreError, CoreResult, DrainOptions, ErrorCode};

use super::confirm::first_lines;
use super::context::McpContext;
use super::guard::{CallSummary, Requirement};
use super::tools::{ToolCall, ToolKind, ToolOutput, ToolResult, ToolSet};
use super::tools_read::{
    describe, find_kind, invalid, need, non_empty, object_ref, pattern_of, read,
};
use crate::commands::actions::CHANGE_TIMEOUT;

/// `exec_command` runs this long unless asked for another number of seconds.
pub const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(30);
/// At most this much of stdout and of stderr of `exec_command` comes back.
pub const MAX_EXEC_OUTPUT: usize = 64 * 1024;

/// Flux asks its controllers to reconcile through this annotation.
pub const FLUX_REQUESTED_AT: &str = "reconcile.fluxcd.io/requestedAt";
/// Argo CD refreshes an Application when this annotation appears.
pub const ARGO_REFRESH: &str = "argocd.argoproj.io/refresh";
/// Who started a sync, in the Application's operation (as the application does it).
pub const SYNC_INITIATOR: &str = "sextant";

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// Adds the changing tools.
pub fn register_write_tools(tools: &mut ToolSet) {
    tools
        .add(
            "apply_yaml",
            "Server-side apply of one or more YAML documents (separated by ---), like `kubectl apply --server-side`. \
             Every document is checked against the user's rules before anything is sent; a document without a \
             namespace goes to the context's default namespace.",
            ToolKind::Destructive,
            apply_yaml,
        )
        .add(
            "patch_resource",
            "Merge patch (a JSON object, the default) or JSON patch (a list of operations) of one object; returns the \
             object as saved (a Secret without its values).",
            ToolKind::Destructive,
            patch_resource,
        )
        .add(
            "delete_resource",
            "Deletes one object; its dependents (a Deployment's ReplicaSets and pods) go in the background.",
            ToolKind::Destructive,
            delete_resource,
        )
        .add(
            "scale",
            "Sets the replica count of a Deployment, StatefulSet, ReplicaSet or another kind with a scale subresource.",
            ToolKind::Destructive,
            scale,
        )
        .add(
            "restart",
            "Rollout restart of a Deployment, StatefulSet or DaemonSet (like `kubectl rollout restart`).",
            ToolKind::Change,
            restart,
        )
        .add(
            "cordon_node",
            "Marks a node unschedulable (`unschedulable`: true, the default) or schedulable again (false).",
            ToolKind::Change,
            cordon_node,
        )
        .add(
            "drain_node",
            "Cordons a node and evicts its pods like `kubectl drain`: DaemonSet and mirror pods stay; pods without a \
             controller go only with `force`, pods with emptyDir data only with `deleteEmptyDirData`; Sextant node \
             shell pods always stay (the result names them).",
            ToolKind::Destructive,
            drain_node,
        )
        .add(
            "trigger_cronjob",
            "Starts a Job from a CronJob's template now; returns the Job.",
            ToolKind::Change,
            trigger_cronjob,
        )
        .add(
            "suspend_cronjob",
            "Suspends a CronJob (`suspend`: true, the default) or resumes it (false).",
            ToolKind::Change,
            suspend_cronjob,
        )
        .add(
            "gitops_action",
            "Flux (any *.toolkit.fluxcd.io kind): `reconcile`, `suspend`, `resume`. Argo CD Application: `sync` \
             (optional `revision`, `prune`), `refresh`, `hardRefresh`. Done through the Kubernetes API, as Sextant's \
             own buttons do it.",
            ToolKind::Change,
            gitops_action,
        )
        .add(
            "helm_install",
            "Installs a chart from a repository connected in Sextant (`<repository>/<chart>`), optionally a version \
             and values YAML; the namespace is created when missing.",
            ToolKind::Change,
            helm_install,
        )
        .add(
            "helm_upgrade",
            "Upgrades a release with new values YAML, keeping its chart and chart version; the values replace the \
             release's previous user values. `chart` (`<repository>/<chart>`) is needed only for charts with \
             dependencies.",
            ToolKind::Destructive,
            helm_upgrade,
        )
        .add(
            "helm_rollback",
            "Rolls a release back to an earlier revision (helm_get_release lists them).",
            ToolKind::Destructive,
            helm_rollback,
        )
        .add(
            "helm_uninstall",
            "Uninstalls a release and removes what it installed.",
            ToolKind::Destructive,
            helm_uninstall,
        )
        .add(
            "exec_command",
            "Runs a command in a container without a terminal and without stdin, e.g. [\"ls\", \"/\"] or \
             [\"sh\", \"-c\", \"…\"]; returns stdout and stderr (each cut at 64 KB) and the exit code. Gives up after \
             `timeoutSeconds` (30 by default, at most 60); the process may go on running in the container.",
            ToolKind::Destructive,
            exec_command,
        )
        .add(
            "port_forward_start",
            "Forwards a local port on 127.0.0.1 (`localPort`, or a free one) to a port of a pod or service. The \
             forward shows in Sextant's Port forwarding and closes with the cluster or the application.",
            ToolKind::Change,
            port_forward_start,
        )
        .add(
            "port_forward_list",
            "The port forwards agents started (not the user's own).",
            ToolKind::Read,
            port_forward_list,
        )
        .add(
            "port_forward_stop",
            "Stops a port forward an agent started (its `id` from port_forward_start or port_forward_list).",
            ToolKind::Change,
            port_forward_stop,
        );
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApplyArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// One or more YAML documents separated by `---`; a `kind: List` is applied item by item.
    pub yaml: String,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PatchKind {
    /// RFC 7386 merge patch: a JSON object.
    #[default]
    Merge,
    /// RFC 6902 JSON patch: a list of operations.
    Json,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PatchArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// Kind (`Deployment`, `ConfigMap`, …) or its plural.
    pub kind: String,
    /// Needed only when several API groups serve the kind.
    pub api_version: Option<String>,
    /// Namespace of the object (not for cluster-wide kinds such as Node).
    pub namespace: Option<String>,
    pub name: String,
    /// The patch: an object for `merge`, a list of operations for `json`.
    pub patch: Value,
    /// `merge` (default) or `json`.
    #[serde(default)]
    pub patch_type: PatchKind,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ObjectArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// Kind (`Deployment`, `Pod`, …) or its plural.
    pub kind: String,
    /// Needed only when several API groups serve the kind.
    pub api_version: Option<String>,
    /// Namespace of the object (not for cluster-wide kinds such as Node).
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScaleArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// `Deployment`, `StatefulSet`, `ReplicaSet`, or another kind with a scale subresource.
    pub kind: String,
    pub api_version: Option<String>,
    pub namespace: String,
    pub name: String,
    /// The new number of replicas (0 or more).
    pub replicas: i32,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CordonArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// Node name.
    pub name: String,
    /// true (default) — cordon; false — uncordon.
    pub unschedulable: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DrainArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// Node name.
    pub name: String,
    /// Also evict pods without a controller (nothing recreates them).
    #[serde(default)]
    pub force: bool,
    /// Also evict pods with emptyDir volumes (their data is lost).
    #[serde(default)]
    pub delete_empty_dir_data: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CronJobArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    /// CronJob name.
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SuspendCronJobArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    /// CronJob name.
    pub name: String,
    /// true (default) — suspend; false — resume.
    pub suspend: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GitopsAction {
    /// Flux: reconcile now.
    Reconcile,
    /// Flux: `spec.suspend: true`.
    Suspend,
    /// Flux: `spec.suspend: false`.
    Resume,
    /// Argo CD Application: start a sync.
    Sync,
    /// Argo CD Application: refresh from the repository.
    Refresh,
    /// Argo CD Application: refresh, regenerating manifests (no cache).
    HardRefresh,
}

impl GitopsAction {
    fn name(self) -> &'static str {
        match self {
            GitopsAction::Reconcile => "reconcile",
            GitopsAction::Suspend => "suspend",
            GitopsAction::Resume => "resume",
            GitopsAction::Sync => "sync",
            GitopsAction::Refresh => "refresh",
            GitopsAction::HardRefresh => "hard refresh",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitopsArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// A Flux kind (`Kustomization`, `HelmRelease`, `GitRepository`, …) or `Application` (Argo CD).
    pub kind: String,
    /// Needed only when several API groups serve the kind.
    pub api_version: Option<String>,
    pub namespace: String,
    pub name: String,
    /// `reconcile`, `suspend`, `resume` (Flux); `sync`, `refresh`, `hardRefresh` (Argo CD).
    pub action: GitopsAction,
    /// `sync`: the revision to sync to; each source's own targetRevision when left out.
    pub revision: Option<String>,
    /// `sync`: also delete resources no longer in Git.
    #[serde(default)]
    pub prune: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HelmInstallArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    /// Release name.
    pub release: String,
    /// `<repository>/<chart>` from a repository connected in Sextant.
    pub chart: String,
    /// Chart version; the latest when left out.
    pub version: Option<String>,
    /// Values YAML; the chart's defaults when left out.
    pub values: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HelmUpgradeArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    /// Release name.
    pub release: String,
    /// The new user values YAML (they replace the previous ones; empty — the chart's defaults).
    #[serde(default)]
    pub values: String,
    /// `<repository>/<chart>`, only for a chart with dependencies; the chart stored in the release otherwise.
    pub chart: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HelmRollbackArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    /// Release name.
    pub release: String,
    /// The revision to go back to (0 — the previous one).
    pub revision: i32,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HelmReleaseArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    /// Release name.
    pub release: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    pub pod: String,
    /// The container; the pod's default one when left out.
    pub container: Option<String>,
    /// Program and arguments, no shell: `["ls", "-l", "/"]`; for a shell line `["sh", "-c", "…"]`.
    pub command: Vec<String>,
    /// Seconds to wait for the command (default 30, at most 60).
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    Pod,
    Service,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStartArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    /// `pod` or `service`.
    pub target: ForwardKind,
    /// Pod or service name.
    pub name: String,
    /// Port of the pod (or of the service).
    pub remote_port: u16,
    /// Local port on 127.0.0.1; a free one when left out.
    pub local_port: Option<u16>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardListArgs {
    /// Only the forwards of this cluster.
    pub cluster: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStopArgs {
    /// The forward's id (`pf-…`).
    pub id: String,
}

// ---------------------------------------------------------------------------------------------------------------
// Tools

async fn apply_yaml(call: ToolCall, args: ApplyArgs) -> ToolResult {
    // The core's own reading of the text: what is checked below is what is applied. A Secret loaded without its
    // values is refused here, before anyone is asked.
    let docs = resources::parse_documents(&args.yaml)?;
    if docs.is_empty() {
        return Err(invalid("the text has no objects to apply").into());
    }
    let cluster = call.open(&args.cluster).await?;
    let mgr = &call.ctx().clusters;
    // Each lookup is limited by the core (`STEP_TIMEOUT`); nothing is sent.
    let targets = resources::plan_apply(mgr, &cluster.id, docs).await?;
    for target in &targets {
        refuse_named_node_shell(target.object(), Some(target.document().value()))?;
    }
    let objects: Vec<ObjectRef> = targets.iter().map(|t| t.object().clone()).collect();
    let requirements: Vec<Requirement> = objects.iter().map(modify).collect();
    let summary = CallSummary {
        tool: "apply_yaml".into(),
        target: targets_text(&objects),
        details: Some(apply_details(&objects, &args.yaml)),
    };
    call.guard.check(&cluster, &requirements, &summary).await?;
    for object in &objects {
        refuse_live_node_shell(&call, &cluster.id, object, true).await?;
    }
    // Each request is limited by the core (`STEP_TIMEOUT`), not the whole apply.
    let applied = resources::apply_planned(mgr, &cluster.id, targets).await?;
    let applied: Vec<String> = applied.iter().map(describe).collect();
    Ok(ToolOutput::Json(json!({ "applied": applied })))
}

async fn patch_resource(call: ToolCall, args: PatchArgs) -> ToolResult {
    let patch_type = match args.patch_type {
        PatchKind::Merge if args.patch.is_object() => PatchType::Merge,
        PatchKind::Json if args.patch.is_array() => PatchType::Json,
        PatchKind::Merge => {
            return Err(invalid("a merge patch is a JSON object").into());
        }
        PatchKind::Json => {
            return Err(invalid("a JSON patch is a list of operations").into());
        }
    };
    if patch_type == PatchType::Json {
        check_json_patch(&args.patch)?;
    }
    let cluster = call.open(&args.cluster).await?;
    let mgr = &call.ctx().clusters;
    let kind = find_kind(mgr, &cluster.id, args.api_version.as_deref(), &args.kind).await?;
    let object = object_ref(&kind, args.namespace.as_deref(), &args.name)?;
    refuse_named_node_shell(&object, None)?;
    let shown = serde_json::to_string_pretty(&args.patch).unwrap_or_default();
    let summary = CallSummary {
        tool: "patch_resource".into(),
        target: describe(&object),
        details: Some(first_lines(&shown)),
    };
    let mut requirements = vec![modify(&object)];
    // On a Secret, a JSON patch other than add/replace/remove may read its values: only with "Secret values".
    if is_core_secret(&object.kind)
        && patch_type == PatchType::Json
        && reads_secret_values(&args.patch)
    {
        requirements.push(need(
            object.namespace.as_deref(),
            &pattern_of(&object.kind),
            AccessAction::SecretValues,
        ));
    }
    call.guard.check(&cluster, &requirements, &summary).await?;
    refuse_live_node_shell(&call, &cluster.id, &object, false).await?;
    let saved = change(
        "patching the object",
        resources::patch(mgr, &cluster.id, &object, &args.patch, patch_type),
    )
    .await?;
    Ok(ToolOutput::Json(compact(saved)))
}

async fn delete_resource(call: ToolCall, args: ObjectArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let mgr = &call.ctx().clusters;
    let kind = find_kind(mgr, &cluster.id, args.api_version.as_deref(), &args.kind).await?;
    let object = object_ref(&kind, args.namespace.as_deref(), &args.name)?;
    refuse_named_node_shell(&object, None)?;
    let summary = plain("delete_resource", describe(&object), None);
    let requirement = need(
        object.namespace.as_deref(),
        &pattern_of(&object.kind),
        AccessAction::Delete,
    );
    call.guard.check(&cluster, &[requirement], &summary).await?;
    refuse_live_node_shell(&call, &cluster.id, &object, false).await?;
    change("deleting", resources::delete(mgr, &cluster.id, &object)).await?;
    Ok(ToolOutput::Text(format!("deleted {}", describe(&object))))
}

async fn scale(call: ToolCall, args: ScaleArgs) -> ToolResult {
    if args.replicas < 0 {
        return Err(invalid(format!(
            "the number of replicas cannot be negative ({})",
            args.replicas
        ))
        .into());
    }
    let cluster = call.open(&args.cluster).await?;
    let mgr = &call.ctx().clusters;
    let kind = find_kind(mgr, &cluster.id, args.api_version.as_deref(), &args.kind).await?;
    let object = object_ref(&kind, Some(&args.namespace), &args.name)?;
    let summary = plain(
        "scale",
        describe(&object),
        Some(format!("replicas: {}", args.replicas)),
    );
    call.guard
        .check(&cluster, &[modify(&object)], &summary)
        .await?;
    change(
        "scaling",
        resources::scale(mgr, &cluster.id, &object, args.replicas),
    )
    .await?;
    Ok(ToolOutput::Text(format!(
        "scaled {} to {} replicas",
        describe(&object),
        args.replicas
    )))
}

async fn restart(call: ToolCall, args: ObjectArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let mgr = &call.ctx().clusters;
    let kind = find_kind(mgr, &cluster.id, args.api_version.as_deref(), &args.kind).await?;
    let restartable = kind.kind_ref.group == "apps"
        && ["Deployment", "StatefulSet", "DaemonSet"].contains(&kind.kind_ref.kind.as_str());
    if !restartable {
        return Err(invalid(format!(
            "only a Deployment, StatefulSet or DaemonSet can be restarted, not {}",
            kind.kind_ref.kind
        ))
        .into());
    }
    let object = object_ref(&kind, args.namespace.as_deref(), &args.name)?;
    let summary = plain("restart", describe(&object), None);
    call.guard
        .check(&cluster, &[modify(&object)], &summary)
        .await?;
    change("the restart", resources::restart(mgr, &cluster.id, &object)).await?;
    Ok(ToolOutput::Text(format!("restarted {}", describe(&object))))
}

async fn cordon_node(call: ToolCall, args: CordonArgs) -> ToolResult {
    let unschedulable = args.unschedulable.unwrap_or(true);
    let cluster = call.open(&args.cluster).await?;
    let what = if unschedulable { "cordon" } else { "uncordon" };
    let summary = plain(
        "cordon_node",
        format!("Node {}", args.name),
        Some(what.to_owned()),
    );
    call.guard
        .check(
            &cluster,
            &[need(None, &node_kind(), AccessAction::Modify)],
            &summary,
        )
        .await?;
    change(
        "changing the node",
        resources::cordon(&call.ctx().clusters, &cluster.id, &args.name, unschedulable),
    )
    .await?;
    Ok(ToolOutput::Text(format!("{what}ed node {}", args.name)))
}

async fn drain_node(call: ToolCall, args: DrainArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let mut details = "cordon the node and evict its pods".to_owned();
    if args.force {
        details.push_str("\nforce: also pods without a controller");
    }
    if args.delete_empty_dir_data {
        details.push_str("\ndeleteEmptyDirData: also pods with emptyDir data (it is lost)");
    }
    let summary = plain("drain_node", format!("Node {}", args.name), Some(details));
    call.guard
        .check(&cluster, &drain_requirements(), &summary)
        .await?;
    // One request per pod: the core limits each one (`STEP_TIMEOUT`), not the whole drain.
    resources::drain(
        &call.ctx().clusters,
        &cluster.id,
        &args.name,
        DrainOptions {
            force: args.force,
            delete_empty_dir_data: args.delete_empty_dir_data,
            // An agent never evicts a node shell pod (it may not delete one); the drain names it as left.
            keep_node_shells: true,
        },
    )
    .await?;
    Ok(ToolOutput::Text(format!("drained node {}", args.name)))
}

async fn trigger_cronjob(call: ToolCall, args: CronJobArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let cronjob = cronjob_ref(&args.namespace, &args.name)?;
    let summary = plain(
        "trigger_cronjob",
        describe(&cronjob),
        Some("start a Job now".to_owned()),
    );
    call.guard
        .check(&cluster, &[modify(&cronjob)], &summary)
        .await?;
    let job = change(
        "starting the Job",
        resources::trigger_cronjob(&call.ctx().clusters, &cluster.id, &cronjob),
    )
    .await?;
    Ok(ToolOutput::Json(json!({ "job": describe(&job) })))
}

async fn suspend_cronjob(call: ToolCall, args: SuspendCronJobArgs) -> ToolResult {
    let suspend = args.suspend.unwrap_or(true);
    let cluster = call.open(&args.cluster).await?;
    let cronjob = cronjob_ref(&args.namespace, &args.name)?;
    let what = if suspend { "suspend" } else { "resume" };
    let summary = plain("suspend_cronjob", describe(&cronjob), Some(what.to_owned()));
    call.guard
        .check(&cluster, &[modify(&cronjob)], &summary)
        .await?;
    change(
        "changing the CronJob",
        resources::suspend_cronjob(&call.ctx().clusters, &cluster.id, &cronjob, suspend),
    )
    .await?;
    let done = if suspend { "suspended" } else { "resumed" };
    Ok(ToolOutput::Text(format!("{done} {}", describe(&cronjob))))
}

async fn gitops_action(call: ToolCall, args: GitopsArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let mgr = &call.ctx().clusters;
    let kind = find_kind(mgr, &cluster.id, args.api_version.as_deref(), &args.kind).await?;
    gitops_supports(&kind.kind_ref, args.action)?;
    let object = object_ref(&kind, Some(&args.namespace), &args.name)?;
    let mut details = args.action.name().to_owned();
    if args.action == GitopsAction::Sync {
        if let Some(revision) = non_empty(args.revision.as_deref()) {
            details.push_str(&format!("\nrevision: {revision}"));
        }
        if args.prune {
            details.push_str("\nprune: delete resources no longer in Git");
        }
    }
    let summary = plain("gitops_action", describe(&object), Some(details));
    call.guard
        .check(&cluster, &[modify(&object)], &summary)
        .await?;
    // A sync carries the Application's own sync options and retry policy, as the application's button does.
    let app = if args.action == GitopsAction::Sync {
        read(
            "reading the Application",
            resources::get(mgr, &cluster.id, &object),
        )
        .await?
    } else {
        Value::Null
    };
    let patch = gitops_patch(
        args.action,
        &app,
        non_empty(args.revision.as_deref()),
        args.prune,
        &rfc3339(now_secs()),
    );
    change(
        "patching the object",
        resources::patch(mgr, &cluster.id, &object, &patch, PatchType::Merge),
    )
    .await?;
    Ok(ToolOutput::Text(format!(
        "requested {} of {}",
        args.action.name(),
        describe(&object)
    )))
}

async fn helm_install(call: ToolCall, args: HelmInstallArgs) -> ToolResult {
    let namespace = helm_namespace(&args.namespace)?;
    let release = helm_release_name(&args.release)?;
    let chart = args.chart.trim();
    chart_repository(chart)?;
    let version = helm_version(args.version.as_deref())?;
    let cluster = call.open(&args.cluster).await?;
    let ctx = call.ctx();
    let cli = helm_of(ctx);
    with_timeout(
        HELM_READ_LIMIT,
        "helm repo list",
        ensure_connected_chart(&cli, chart),
    )
    .await?;
    let values = args.values.as_deref().unwrap_or_default();
    let mut details = format!("chart: {chart}");
    if let Some(version) = version {
        details.push_str(&format!("\nversion: {version}"));
    }
    if !values.trim().is_empty() {
        details.push_str(&format!("\nvalues:\n{values}"));
    }
    let summary = plain(
        "helm_install",
        format!("Release {namespace}/{release}"),
        Some(first_lines(&details)),
    );
    call.guard
        .check(
            &cluster,
            &[release_need(namespace, AccessAction::Modify)],
            &summary,
        )
        .await?;
    helm_change(
        HELM_INSTALL_LIMIT,
        "helm install",
        helm_cli::install_chart(
            &cli,
            &ctx.clusters,
            &cluster.id,
            namespace,
            release,
            chart,
            version,
            values,
        ),
    )
    .await?;
    Ok(ToolOutput::Text(format!(
        "installed {chart} as release {namespace}/{release}"
    )))
}

async fn helm_upgrade(call: ToolCall, args: HelmUpgradeArgs) -> ToolResult {
    let namespace = helm_namespace(&args.namespace)?;
    let release = helm_release_name(&args.release)?;
    let chart = non_empty(args.chart.as_deref()).unwrap_or_default();
    if !chart.is_empty() {
        chart_repository(chart)?;
    }
    let cluster = call.open(&args.cluster).await?;
    let ctx = call.ctx();
    let cli = helm_of(ctx);
    if !chart.is_empty() {
        with_timeout(
            HELM_READ_LIMIT,
            "helm repo list",
            ensure_connected_chart(&cli, chart),
        )
        .await?;
    }
    let mut details = String::new();
    if !chart.is_empty() {
        details.push_str(&format!("chart: {chart}\n"));
    }
    if args.values.trim().is_empty() {
        details.push_str("values: the chart's defaults");
    } else {
        details.push_str(&format!("values:\n{}", args.values));
    }
    let summary = plain(
        "helm_upgrade",
        format!("Release {namespace}/{release}"),
        Some(first_lines(&details)),
    );
    call.guard
        .check(
            &cluster,
            &[release_need(namespace, AccessAction::Modify)],
            &summary,
        )
        .await?;
    helm_change(
        HELM_INSTALL_LIMIT,
        "helm upgrade",
        helm_cli::upgrade_release(
            &cli,
            &ctx.clusters,
            &cluster.id,
            namespace,
            release,
            chart,
            &args.values,
        ),
    )
    .await?;
    Ok(ToolOutput::Text(format!(
        "upgraded release {namespace}/{release}"
    )))
}

async fn helm_rollback(call: ToolCall, args: HelmRollbackArgs) -> ToolResult {
    let namespace = helm_namespace(&args.namespace)?;
    let release = helm_release_name(&args.release)?;
    if args.revision < 0 {
        return Err(invalid(format!("no revision {}", args.revision)).into());
    }
    let cluster = call.open(&args.cluster).await?;
    let ctx = call.ctx();
    let summary = plain(
        "helm_rollback",
        format!("Release {namespace}/{release}"),
        Some(format!("roll back to revision {}", args.revision)),
    );
    call.guard
        .check(
            &cluster,
            &[release_need(namespace, AccessAction::Modify)],
            &summary,
        )
        .await?;
    let target = helm_cli::kube_target(&ctx.clusters, &cluster.id)?;
    helm_change(
        HELM_ROLLBACK_LIMIT,
        "helm rollback",
        helm_of(ctx).rollback(
            &target.kubeconfig,
            &target.context,
            namespace,
            release,
            args.revision,
        ),
    )
    .await?;
    Ok(ToolOutput::Text(format!(
        "rolled release {namespace}/{release} back to revision {}",
        args.revision
    )))
}

async fn helm_uninstall(call: ToolCall, args: HelmReleaseArgs) -> ToolResult {
    let namespace = helm_namespace(&args.namespace)?;
    let release = helm_release_name(&args.release)?;
    let cluster = call.open(&args.cluster).await?;
    let ctx = call.ctx();
    let summary = plain(
        "helm_uninstall",
        format!("Release {namespace}/{release}"),
        None,
    );
    call.guard
        .check(
            &cluster,
            &[release_need(namespace, AccessAction::Delete)],
            &summary,
        )
        .await?;
    let target = helm_cli::kube_target(&ctx.clusters, &cluster.id)?;
    helm_change(
        HELM_ROLLBACK_LIMIT,
        "helm uninstall",
        helm_of(ctx).uninstall(&target.kubeconfig, &target.context, namespace, release),
    )
    .await?;
    Ok(ToolOutput::Text(format!(
        "uninstalled release {namespace}/{release}"
    )))
}

async fn exec_command(call: ToolCall, args: ExecArgs) -> ToolResult {
    if args.command.first().is_none_or(|p| p.trim().is_empty()) {
        return Err(invalid("the command is empty").into());
    }
    let timeout = args
        .timeout_seconds
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_EXEC_TIMEOUT)
        .clamp(Duration::from_secs(1), exec::MAX_COMMAND_TIMEOUT);
    let cluster = call.open(&args.cluster).await?;
    let pod = pod_ref(&args.namespace, &args.pod)?;
    let container = non_empty(args.container.as_deref());
    let mut details = format!("command: {}", command_line(&args.command));
    if let Some(container) = container {
        details.push_str(&format!("\ncontainer: {container}"));
    }
    let summary = plain("exec_command", describe(&pod), Some(first_lines(&details)));
    refuse_named_node_shell(&pod, None)?;
    call.guard
        .check(
            &cluster,
            // The namespace the pod is taken from, not the text the agent sent.
            &[need(
                pod.namespace.as_deref(),
                &KindPattern::new("", "Pod"),
                AccessAction::Exec,
            )],
            &summary,
        )
        .await?;
    refuse_live_node_shell(&call, &cluster.id, &pod, false).await?;
    let output = exec::run_command(
        &call.ctx().clusters,
        &cluster.id,
        &pod,
        container,
        &args.command,
        timeout,
        MAX_EXEC_OUTPUT,
    )
    .await?;
    Ok(ToolOutput::Json(json!({
        "exitCode": output.exit_code,
        "stdout": output.stdout,
        "stderr": output.stderr,
        "truncated": output.truncated,
        "timedOut": output.timed_out,
    })))
}

const NODE_SHELL_REFUSAL: &str = "Sextant does not let agents use node shells";

/// Before the access check: a pod named like a node shell, or a pod document that is one (the shared
/// [`crate::access_guard::refuse_named_node_shell`] with the agents' text).
fn refuse_named_node_shell(object: &ObjectRef, document: Option<&Value>) -> CoreResult<()> {
    crate::access_guard::refuse_named_node_shell(object, document, NODE_SHELL_REFUSAL)
}

/// After the access check, right before acting on a pod: the pod as the cluster has it now, failing closed (the
/// shared [`crate::access_guard::refuse_live_node_shell`] with the agents' text).
async fn refuse_live_node_shell(
    call: &ToolCall,
    cluster: &ClusterId,
    object: &ObjectRef,
    creates: bool,
) -> CoreResult<()> {
    crate::access_guard::refuse_live_node_shell(
        &call.ctx().clusters,
        cluster,
        object,
        creates,
        NODE_SHELL_REFUSAL,
    )
    .await
}

/// What an agent is told when its forward would reach a pod whose ports are the node's own.
const NODE_ACCESS_REFUSAL: &str = "Sextant does not let agents forward ports of node shells or of pods that use the node's network";

/// How many port forwards the agents of one MCP server may keep at once (each is a listener and a monitor task).
const MAX_AGENT_FORWARDS: usize = 32;

/// The refusal for an agent that already keeps `live` forwards; `None` while there is room for another.
fn forward_cap_refusal(live: usize) -> Option<CoreError> {
    (live >= MAX_AGENT_FORWARDS).then(|| {
        CoreError::new(
            ErrorCode::Invalid,
            format!(
                "{live} port forwards started by agents are still open (the limit is {MAX_AGENT_FORWARDS}); \
                 stop some with port_forward_stop (port_forward_list shows them) and try again"
            ),
        )
    })
}

async fn port_forward_start(call: ToolCall, args: ForwardStartArgs) -> ToolResult {
    if args.remote_port == 0 {
        return Err(invalid("remotePort must be 1–65535").into());
    }
    let namespace = required("namespace", &args.namespace)?.to_owned();
    let name = required("name", &args.name)?.to_owned();
    let cluster = call.open(&args.cluster).await?;
    let pod = match args.target {
        ForwardKind::Pod => Some(pod_ref(&namespace, &name)?),
        ForwardKind::Service => None,
    };
    let (kind, target) = match args.target {
        ForwardKind::Pod => ("Pod", ForwardTarget::Pod { namespace, name }),
        ForwardKind::Service => ("Service", ForwardTarget::Service { namespace, name }),
    };
    let local = match args.local_port {
        Some(port) if port != 0 => format!("local port {port}"),
        _ => "a free local port".to_owned(),
    };
    let summary = plain(
        "port_forward_start",
        format!("{kind} {}/{}", args.namespace.trim(), args.name.trim()),
        Some(format!(
            "{local} on 127.0.0.1 → port {} of the {}",
            args.remote_port,
            kind.to_lowercase()
        )),
    );
    if let Some(pod) = &pod {
        refuse_named_node_shell(pod, None)?;
    }
    call.guard
        .check(
            &cluster,
            &[need(
                Some(args.namespace.trim()),
                &KindPattern::new("", kind),
                AccessAction::PortForward,
            )],
            &summary,
        )
        .await?;
    // After the access check, the forwarder reads the pod (for a service, its pods; again whenever it moves to
    // another pod) and never goes to a node shell or a pod on the node's network: one read of the pod covers both.
    let ctx = call.ctx();
    // `agent_forwards` forgets the forwards that ended, so only the ones still holding a listener count.
    if let Some(refusal) = forward_cap_refusal(agent_forwards(ctx).len()) {
        return Err(refusal.into());
    }
    let info = with_timeout(
        CHANGE_TIMEOUT,
        "starting the port forward",
        ctx.forwarder.start(
            &ctx.clusters,
            &cluster.id,
            target,
            args.remote_port,
            args.local_port.filter(|p| *p != 0),
            PodFilter::NoNodeAccess,
        ),
    )
    .await
    .map_err(|e| match e.code {
        ErrorCode::Denied => CoreError::new(
            ErrorCode::Denied,
            format!("{NODE_ACCESS_REFUSAL}: {}", e.message),
        ),
        _ => e,
    })?;
    lock(&ctx.agent_forwards).insert(info.id.clone());
    let mut out = serde_json::to_value(&info).unwrap_or(Value::Null);
    out["address"] = json!(format!("127.0.0.1:{}", info.local_port));
    Ok(ToolOutput::Json(out))
}

async fn port_forward_list(call: ToolCall, args: ForwardListArgs) -> ToolResult {
    let cluster = match non_empty(args.cluster.as_deref()) {
        Some(cluster) => Some(call.open(cluster).await?),
        None => None,
    };
    let ctx = call.ctx();
    let forwards: Vec<Value> = agent_forwards(ctx)
        .into_iter()
        .filter(|f| cluster.as_ref().is_none_or(|c| c.id == f.cluster))
        .map(|f| serde_json::to_value(&f).unwrap_or(Value::Null))
        .collect();
    Ok(ToolOutput::Json(json!({ "forwards": forwards })))
}

async fn port_forward_stop(call: ToolCall, args: ForwardStopArgs) -> ToolResult {
    let ctx = call.ctx();
    let id = args.id.trim();
    let mine = agent_forwards(ctx).into_iter().any(|f| f.id == id);
    if !mine {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            format!("no port forward {id} started by an agent; port_forward_list lists them"),
        )
        .into());
    }
    ctx.forwarder.stop(id).await?;
    lock(&ctx.agent_forwards).remove(id);
    Ok(ToolOutput::Text(format!("stopped port forward {id}")))
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/// What `drain_node` needs: Modify on the node and Delete on pods in all namespaces (the node's pods may be anywhere).
pub fn drain_requirements() -> Vec<Requirement> {
    vec![
        need(None, &node_kind(), AccessAction::Modify),
        need(None, &KindPattern::new("", "Pod"), AccessAction::Delete),
    ]
}

/// Whether `action` applies to objects of `kind`: Flux actions to the kinds of `*.toolkit.fluxcd.io`, Argo CD ones
/// to `argoproj.io/Application`.
pub fn gitops_supports(kind: &KindRef, action: GitopsAction) -> CoreResult<()> {
    let flux = kind.group.ends_with(".toolkit.fluxcd.io");
    let argo = kind.group == "argoproj.io" && kind.kind == "Application";
    let fits = match action {
        GitopsAction::Reconcile | GitopsAction::Suspend | GitopsAction::Resume => flux,
        GitopsAction::Sync | GitopsAction::Refresh | GitopsAction::HardRefresh => argo,
    };
    if fits {
        return Ok(());
    }
    Err(invalid(format!(
        "{} does not apply to {}: reconcile, suspend and resume are for Flux kinds, sync, refresh and hardRefresh for \
         Argo CD Applications",
        args_name(action),
        kind.kind
    )))
}

fn args_name(action: GitopsAction) -> &'static str {
    match action {
        GitopsAction::HardRefresh => "hardRefresh",
        other => other.name(),
    }
}

/// The merge patch of a GitOps action, as the application's buttons send it. `app` — the Argo CD Application (for
/// `sync`: its sync options and retry policy go into the operation); `now` — RFC 3339 time for Flux.
pub fn gitops_patch(
    action: GitopsAction,
    app: &Value,
    revision: Option<&str>,
    prune: bool,
    now: &str,
) -> Value {
    match action {
        GitopsAction::Reconcile => {
            json!({ "metadata": { "annotations": { FLUX_REQUESTED_AT: now } } })
        }
        GitopsAction::Suspend => json!({ "spec": { "suspend": true } }),
        GitopsAction::Resume => json!({ "spec": { "suspend": false } }),
        GitopsAction::Refresh => {
            json!({ "metadata": { "annotations": { ARGO_REFRESH: "normal" } } })
        }
        GitopsAction::HardRefresh => {
            json!({ "metadata": { "annotations": { ARGO_REFRESH: "hard" } } })
        }
        GitopsAction::Sync => {
            let mut sync = json!({ "prune": prune, "dryRun": false });
            if let Some(revision) = revision {
                sync["revision"] = json!(revision);
            }
            if let Some(options) = app
                .pointer("/spec/syncPolicy/syncOptions")
                .and_then(Value::as_array)
                .filter(|o| !o.is_empty())
            {
                sync["syncOptions"] = json!(options);
            }
            let mut operation = json!({
                "initiatedBy": { "username": SYNC_INITIATOR },
                "sync": sync,
            });
            if let Some(retry) = app
                .pointer("/spec/syncPolicy/retry")
                .filter(|r| r.is_object())
            {
                operation["retry"] = retry.clone();
            }
            json!({ "operation": operation })
        }
    }
}

/// Whether a JSON patch may read a Secret's values into what the agent then sees (an annotation, a label) or tell
/// them apart (`test`): anything but `add`, `replace` and `remove`, wherever it points. Those three only write what
/// the agent sends; a merge patch reads nothing either.
pub fn reads_secret_values(patch: &Value) -> bool {
    let Some(operations) = patch.as_array() else {
        return false;
    };
    operations.iter().any(|op| {
        let name = op.get("op").and_then(Value::as_str).unwrap_or_default();
        !matches!(name, "add" | "replace" | "remove")
    })
}

/// Every `path` and `from` of a JSON patch is a pointer starting with `/` (and every operation has a `path`): the
/// server reads `x/data/key` as `/data/key`, which a check of the text would not see.
pub fn check_json_patch(patch: &Value) -> CoreResult<()> {
    let operations = patch
        .as_array()
        .ok_or_else(|| invalid("a JSON patch is a list of operations"))?;
    for (i, op) in operations.iter().enumerate() {
        let n = i + 1;
        if !op.is_object() {
            return Err(invalid(format!("operation {n} is not an object")));
        }
        for field in ["path", "from"] {
            let pointer = match op.get(field) {
                None if field == "from" => continue,
                None => return Err(invalid(format!("operation {n} has no path"))),
                Some(pointer) => pointer,
            };
            if !pointer.as_str().is_some_and(|p| p.starts_with('/')) {
                return Err(invalid(format!(
                    "operation {n}: {field} must start with / (a JSON pointer such as /metadata/labels/app)"
                )));
            }
        }
    }
    Ok(())
}

fn is_core_secret(kind: &KindRef) -> bool {
    kind.group.is_empty() && kind.kind == "Secret"
}

/// A command as a shell would show it: arguments with spaces or special characters in single quotes.
pub fn command_line(command: &[String]) -> String {
    command
        .iter()
        .map(|arg| {
            let plain = !arg.is_empty()
                && arg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_./=:,@%+".contains(c));
            if plain {
                arg.clone()
            } else {
                format!("'{}'", arg.replace('\'', r"'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The repository of `<repository>/<chart>`; anything else (a path, a URL, an archive) is `invalid`.
pub fn chart_repository(chart: &str) -> CoreResult<&str> {
    let chart = chart.trim();
    let bad = || {
        invalid(format!(
            "chart {chart:?}: pass <repository>/<chart> from a repository connected in Sextant"
        ))
    };
    let (repo, name) = chart.split_once('/').ok_or_else(bad)?;
    let odd = |part: &str| {
        part.is_empty()
            || part.starts_with('.')
            || part.starts_with('~')
            || part.starts_with('-')
            || part.contains(['/', '\\', ':'])
    };
    if odd(repo) || odd(name) {
        return Err(bad());
    }
    Ok(repo)
}

/// `secs` since the Unix epoch as `YYYY-MM-DDTHH:MM:SSZ`.
pub fn rfc3339(secs: u64) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rest = secs % 86_400;
    // Days to a civil date (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A change with [`CHANGE_TIMEOUT`], as the application's own actions.
async fn change<T>(
    what: &str,
    call: impl std::future::Future<Output = CoreResult<T>>,
) -> CoreResult<T> {
    with_timeout(CHANGE_TIMEOUT, what, call).await
}

fn plain(tool: &str, target: String, details: Option<String>) -> CallSummary {
    CallSummary {
        tool: tool.to_owned(),
        target,
        details,
    }
}

fn modify(object: &ObjectRef) -> Requirement {
    need(
        object.namespace.as_deref(),
        &pattern_of(&object.kind),
        AccessAction::Modify,
    )
}

fn release_need(namespace: &str, action: AccessAction) -> Requirement {
    need(Some(namespace), &KindPattern::helm_release(), action)
}

fn node_kind() -> KindPattern {
    KindPattern::new("", "Node")
}

/// A namespace for `helm`: a DNS-1123 label (≤ 63), so it cannot pass for a flag of its command line.
fn helm_namespace(namespace: &str) -> CoreResult<&str> {
    let namespace = required("namespace", namespace)?;
    if namespace.len() > 63 || !dns_label(namespace) {
        return Err(invalid(format!(
            "namespace {namespace:?} is not a valid namespace name (lowercase letters, digits and '-', at most 63)"
        )));
    }
    Ok(namespace)
}

/// A Helm release name: DNS-1123 subdomain of at most 53 characters (Helm's own rule), so it cannot pass for a flag.
fn helm_release_name(release: &str) -> CoreResult<&str> {
    let release = required("release", release)?;
    if release.len() > 53 || !release.split('.').all(dns_label) {
        return Err(invalid(format!(
            "release {release:?} is not a valid release name (lowercase letters, digits, '-' and '.', at most 53)"
        )));
    }
    Ok(release)
}

/// A chart version (or constraint) that cannot pass for a flag of the `helm` command line.
fn helm_version(version: Option<&str>) -> CoreResult<Option<&str>> {
    match non_empty(version) {
        Some(v) if v.starts_with('-') || v.chars().any(char::is_control) => {
            Err(invalid(format!("version {v:?} is not a chart version")))
        }
        other => Ok(other),
    }
}

/// `[a-z0-9]([-a-z0-9]*[a-z0-9])?`
fn dns_label(label: &str) -> bool {
    let edge = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    edge(label.chars().next())
        && edge(label.chars().last())
        && label
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn required<'a>(field: &str, value: &'a str) -> CoreResult<&'a str> {
    non_empty(Some(value)).ok_or_else(|| invalid(format!("{field} is required")))
}

fn cronjob_ref(namespace: &str, name: &str) -> CoreResult<ObjectRef> {
    Ok(ObjectRef {
        kind: KindRef {
            group: "batch".into(),
            version: "v1".into(),
            kind: "CronJob".into(),
        },
        namespace: Some(required("namespace", namespace)?.to_owned()),
        name: required("name", name)?.to_owned(),
    })
}

fn pod_ref(namespace: &str, name: &str) -> CoreResult<ObjectRef> {
    Ok(ObjectRef {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        },
        namespace: Some(required("namespace", namespace)?.to_owned()),
        name: required("pod", name)?.to_owned(),
    })
}

/// `ConfigMap team-a/web`, or `3 objects: …`.
fn targets_text(objects: &[ObjectRef]) -> String {
    match objects {
        [one] => describe(one),
        many => format!(
            "{} objects: {}",
            many.len(),
            many.iter().map(describe).collect::<Vec<_>>().join(", ")
        ),
    }
}

/// What the confirmation of an apply shows: every object in full (the target is cut, and so is the YAML), then the
/// first lines of the YAML.
fn apply_details(objects: &[ObjectRef], yaml: &str) -> String {
    let count = match objects.len() {
        1 => "1 object".to_owned(),
        n => format!("{n} objects"),
    };
    let list: Vec<String> = objects.iter().map(describe).collect();
    format!("{count}:\n{}\n\n{}", list.join("\n"), first_lines(yaml))
}

/// How long `helm_install` and `helm_upgrade` may take.
pub const HELM_INSTALL_LIMIT: Duration = Duration::from_secs(5 * 60);
/// How long `helm_rollback` and `helm_uninstall` may take.
pub const HELM_ROLLBACK_LIMIT: Duration = Duration::from_secs(2 * 60);
/// How long a `helm` call that only reads (`helm repo list`) may take.
pub const HELM_READ_LIMIT: Duration = Duration::from_secs(30);

/// A Helm call of an agent within `limit`. When the limit passes the call is dropped, and with it the `helm` it runs
/// is killed (the core kills a `helm` whose call is dropped — also when the MCP server stops and drops its calls).
async fn helm_change<T>(
    limit: Duration,
    what: &str,
    call: impl std::future::Future<Output = CoreResult<T>>,
) -> CoreResult<T> {
    match tokio::time::timeout(limit, call).await {
        Ok(result) => result,
        Err(_) => {
            let secs = limit.as_secs();
            let shown = if secs >= 60 && secs.is_multiple_of(60) {
                format!("{} min", secs / 60)
            } else {
                format!("{secs} s")
            };
            Err(CoreError::new(
                ErrorCode::Timeout,
                format!(
                    "{what} did not finish in {shown} and was stopped; the release may be left mid-change \
                     (pending): check it with helm_get_release before repeating"
                ),
            ))
        }
    }
}

/// The `helm` the application uses: from `PATH`, or the one chosen in Settings.
fn helm_of(ctx: &McpContext) -> HelmCli {
    let cli = HelmCli::default();
    match ctx
        .settings
        .get()
        .helm_path
        .filter(|path| !path.trim().is_empty())
    {
        Some(path) => cli.with_binary(path.trim()),
        None => cli,
    }
}

/// `<repository>/<chart>` whose repository is connected (`helm repo list`).
async fn ensure_connected_chart(cli: &HelmCli, chart: &str) -> CoreResult<()> {
    let repo = chart_repository(chart)?;
    let repos = cli.repos().await?;
    if repos.iter().any(|r| r.name == repo) {
        return Ok(());
    }
    Err(invalid(format!(
        "chart repository {repo:?} is not connected in Sextant (connected: {})",
        if repos.is_empty() {
            "none".to_owned()
        } else {
            repos
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        }
    )))
}

/// The agents' forwards that still run; forgets the ones that ended (stopped by the user, the cluster closed).
fn agent_forwards(ctx: &McpContext) -> Vec<sextant_core::portforward::ForwardInfo> {
    let all = ctx.forwarder.list();
    let mut ids = lock(&ctx.agent_forwards);
    ids.retain(|id| all.iter().any(|f| &f.id == id));
    all.into_iter().filter(|f| ids.contains(&f.id)).collect()
}

/// An object without what only takes room: `managedFields` and the last-applied manifest.
fn compact(mut value: Value) -> Value {
    if let Some(meta) = value.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
        if let Some(annotations) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
            annotations.remove(LAST_APPLIED);
        }
    }
    value
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    //! Without a cluster: the tool set, the mapping helpers and refusals that need no cluster. Against the kind test
    //! cluster (`SEXTANT_TEST_KUBECONFIG`, skipped without it), each test in its own namespace `sextant-mcp-write-*`:
    //! denied, asked (declined, no window, approved) and allowed changes.

    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use sextant_core::access::{
        AccessPreset, AccessRule, ClusterAccess, KindScope, NamespaceScope,
    };
    use sextant_core::kubeconfig::KubeconfigEnv;
    use sextant_core::portforward::ForwardTarget;
    use sextant_core::{ClusterId, ClusterSettings};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::super::audit::AuditDecision;
    use super::super::confirm::ConfirmRequest;
    use super::super::context::McpEvent;
    use super::super::server::all_tools;
    use super::super::tools::to_call_result;
    use super::*;
    use crate::state::AppState;

    const WRITE_TOOLS: [&str; 18] = [
        "apply_yaml",
        "patch_resource",
        "delete_resource",
        "scale",
        "restart",
        "cordon_node",
        "drain_node",
        "trigger_cronjob",
        "suspend_cronjob",
        "gitops_action",
        "helm_install",
        "helm_upgrade",
        "helm_rollback",
        "helm_uninstall",
        "exec_command",
        "port_forward_start",
        "port_forward_list",
        "port_forward_stop",
    ];

    /// How the "window" answers confirmation requests.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Answer {
        Allow,
        Deny,
        /// No window to ask in.
        NoWindow,
    }

    #[derive(Clone)]
    struct Window {
        answer: Arc<Mutex<Answer>>,
        asked: Arc<Mutex<Vec<ConfirmRequest>>>,
    }

    impl Window {
        fn answer(&self, answer: Answer) {
            *self.answer.lock().unwrap() = answer;
        }

        fn last(&self) -> ConfirmRequest {
            self.asked
                .lock()
                .unwrap()
                .last()
                .cloned()
                .expect("nothing was asked")
        }

        fn count(&self) -> usize {
            self.asked.lock().unwrap().len()
        }
    }

    /// Application state whose clusters come from `kubeconfig` (a cluster nobody listens on when `None`), with a
    /// window that answers as told (Deny at first).
    fn state_in(dir: &Path, kubeconfig: Option<std::ffi::OsString>) -> (AppState, Window) {
        let state = AppState::new(&dir.join("config"), &dir.join("data"));
        let kubeconfig = kubeconfig.unwrap_or_else(|| {
            let path = dir.join("kubeconfig");
            std::fs::write(
                &path,
                "apiVersion: v1\nkind: Config\nclusters:\n- name: test\n  cluster:\n    server: https://127.0.0.1:1\n\
                 contexts:\n- name: test\n  context:\n    cluster: test\n    user: test\n\
                 users:\n- name: test\n  user: {}\ncurrent-context: test\n",
            )
            .unwrap();
            path.into_os_string()
        });
        state.registry.write().unwrap().set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig),
            home: Some(dir.join("home")),
        });
        let window = Window {
            answer: Arc::new(Mutex::new(Answer::Deny)),
            asked: Arc::new(Mutex::new(Vec::new())),
        };
        let (seen, weak) = (window.clone(), Arc::downgrade(state.mcp.context()));
        state.mcp.set_emitter(Arc::new(move |event| {
            let McpEvent::Confirm(request) = event else {
                return true;
            };
            let answer = *seen.answer.lock().unwrap();
            if answer == Answer::NoWindow {
                return false;
            }
            seen.asked.lock().unwrap().push(request.clone());
            if let Some(ctx) = weak.upgrade() {
                let _ = ctx
                    .confirmations
                    .answer(&request.id, answer == Answer::Allow);
            }
            true
        }));
        (state, window)
    }

    fn first_cluster(state: &AppState) -> ClusterId {
        state.registry.read().unwrap().clusters().unwrap()[0]
            .id
            .clone()
    }

    fn set_rules(state: &AppState, cluster: &ClusterId, rules: Vec<AccessRule>) {
        state
            .settings
            .update(|s| {
                s.clusters.insert(
                    cluster.0.clone(),
                    ClusterSettings {
                        agent_access: ClusterAccess {
                            preset: AccessPreset::Custom,
                            rules,
                        },
                        ..ClusterSettings::default()
                    },
                );
            })
            .unwrap();
    }

    fn rule(
        namespaces: &[&str],
        kinds: &[(&str, &str)],
        actions: &[AccessAction],
        confirm: bool,
    ) -> AccessRule {
        AccessRule {
            namespaces: if namespaces.is_empty() {
                NamespaceScope::All
            } else {
                NamespaceScope::Only {
                    namespaces: namespaces.iter().map(|s| s.to_string()).collect(),
                }
            },
            kinds: if kinds.is_empty() {
                KindScope::All
            } else {
                KindScope::Only {
                    kinds: kinds
                        .iter()
                        .map(|(g, k)| KindPattern::new(*g, *k))
                        .collect(),
                }
            },
            actions: actions.to_vec(),
            confirm,
        }
    }

    /// Calls a tool as an agent; the text of an error, or the JSON (or text) of a result.
    async fn tool(state: &AppState, name: &str, args: Value) -> Result<Value, String> {
        let Value::Object(args) = args else {
            unreachable!()
        };
        let result = state.mcp.handler().call("test", name, args).await;
        let rendered = to_call_result(&result);
        let text = rendered.content[0]
            .as_text()
            .map(|t| t.text.clone())
            .unwrap_or_default();
        if rendered.is_error == Some(true) {
            Err(text)
        } else {
            Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)))
        }
    }

    // -------------------------------------------------------------------------------------------------------------
    // Without a cluster

    #[test]
    fn every_write_tool_is_offered_with_its_hints() {
        let tools = all_tools();
        let names = tools.names();
        for name in WRITE_TOOLS {
            assert!(names.iter().any(|n| n == name), "{name} is missing");
        }
        let hints = |name: &str| {
            let tool = tools.find(name).unwrap().tool.clone();
            let a = tool.annotations.unwrap();
            (a.read_only_hint, a.destructive_hint)
        };
        assert_eq!(hints("delete_resource"), (Some(false), Some(true)));
        assert_eq!(hints("helm_uninstall"), (Some(false), Some(true)));
        assert_eq!(hints("restart"), (Some(false), Some(false)));
        assert_eq!(hints("port_forward_list"), (Some(true), Some(false)));
    }

    #[test]
    fn a_drain_needs_the_node_and_pods_in_every_namespace() {
        assert_eq!(
            drain_requirements(),
            vec![
                (None, KindPattern::new("", "Node"), AccessAction::Modify),
                (None, KindPattern::new("", "Pod"), AccessAction::Delete),
            ]
        );
    }

    #[test]
    fn gitops_actions_patch_like_the_application() {
        let kustomization = KindRef {
            group: "kustomize.toolkit.fluxcd.io".into(),
            version: "v1".into(),
            kind: "Kustomization".into(),
        };
        let application = KindRef {
            group: "argoproj.io".into(),
            version: "v1alpha1".into(),
            kind: "Application".into(),
        };
        assert!(gitops_supports(&kustomization, GitopsAction::Reconcile).is_ok());
        assert!(gitops_supports(&application, GitopsAction::Sync).is_ok());
        assert_eq!(
            gitops_supports(&kustomization, GitopsAction::Sync)
                .unwrap_err()
                .code,
            ErrorCode::Invalid
        );
        assert!(gitops_supports(&application, GitopsAction::Suspend).is_err());
        let deployment = KindRef {
            group: "apps".into(),
            version: "v1".into(),
            kind: "Deployment".into(),
        };
        assert!(gitops_supports(&deployment, GitopsAction::Reconcile).is_err());

        let now = "2026-10-13T10:00:00Z";
        assert_eq!(
            gitops_patch(GitopsAction::Reconcile, &Value::Null, None, false, now),
            json!({ "metadata": { "annotations": { "reconcile.fluxcd.io/requestedAt": now } } })
        );
        assert_eq!(
            gitops_patch(GitopsAction::Resume, &Value::Null, None, false, now),
            json!({ "spec": { "suspend": false } })
        );
        assert_eq!(
            gitops_patch(GitopsAction::HardRefresh, &Value::Null, None, false, now),
            json!({ "metadata": { "annotations": { "argocd.argoproj.io/refresh": "hard" } } })
        );
        let app = json!({ "spec": { "syncPolicy": {
            "syncOptions": ["CreateNamespace=true"],
            "retry": { "limit": 2 },
        } } });
        assert_eq!(
            gitops_patch(GitopsAction::Sync, &app, Some("main"), true, now),
            json!({ "operation": {
                "initiatedBy": { "username": "sextant" },
                "sync": { "prune": true, "dryRun": false, "revision": "main", "syncOptions": ["CreateNamespace=true"] },
                "retry": { "limit": 2 },
            } })
        );
        assert_eq!(
            gitops_patch(GitopsAction::Sync, &json!({}), None, false, now),
            json!({ "operation": {
                "initiatedBy": { "username": "sextant" },
                "sync": { "prune": false, "dryRun": false },
            } })
        );
    }

    #[test]
    fn commands_charts_and_times_are_shown_and_checked() {
        let command: Vec<String> = ["sh", "-c", "echo it's done", "a=b"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(command_line(&command), r"sh -c 'echo it'\''s done' a=b");
        assert_eq!(command_line(&["".to_owned()]), "''");

        assert_eq!(chart_repository("bitnami/nginx").unwrap(), "bitnami");
        for bad in [
            "nginx",
            "/tmp/chart",
            "./charts/x",
            "../x/y",
            "~/x",
            "oci://registry/x",
            "https://example.com/x.tgz",
            "a/b/c",
            "a\\b/c",
        ] {
            assert_eq!(
                chart_repository(bad).unwrap_err().code,
                ErrorCode::Invalid,
                "{bad}"
            );
        }

        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn on_a_secret_only_add_replace_and_remove_go_without_secret_values() {
        let reads = |ops: Value| reads_secret_values(&ops);
        for op in [
            json!({ "op": "copy", "from": "/metadata/name", "path": "/metadata/annotations/x" }),
            json!({ "op": "move", "from": "/metadata/labels", "path": "/metadata/annotations" }),
            json!({ "op": "test", "path": "/metadata/name", "value": "creds" }),
            json!({ "op": "copy", "from": "x/data/password", "path": "/metadata/annotations/x" }),
            json!({ "op": "test", "path": "zz/data/password", "value": "guess" }),
            json!({ "op": "unknown", "path": "/x" }),
            json!("not an operation"),
        ] {
            assert!(reads(json!([op])), "{op}");
        }
        assert!(!reads(json!([
            { "op": "add", "path": "/data/new", "value": "eA==" },
            { "op": "replace", "path": "/data/password", "value": "eA==" },
            { "op": "remove", "path": "/stringData" },
        ])));
        assert!(!reads(json!({ "data": { "password": "eA==" } })));
    }

    #[test]
    fn json_patch_pointers_must_start_with_a_slash() {
        assert!(
            check_json_patch(&json!([
                { "op": "add", "path": "/data/x", "value": "eA==" },
                { "op": "copy", "from": "/metadata/name", "path": "/metadata/labels/name" },
            ]))
            .is_ok()
        );
        for op in [
            json!({ "op": "copy", "from": "x/data/password", "path": "/metadata/annotations/x" }),
            json!({ "op": "move", "from": "data/data/password", "path": "/metadata/labels" }),
            json!({ "op": "test", "path": "zz/data/password", "value": "guess" }),
            json!({ "op": "add", "path": "data/x", "value": "eA==" }),
            json!({ "op": "remove", "path": "" }),
            json!({ "op": "copy", "from": 7, "path": "/x" }),
            json!({ "op": "remove" }),
            json!("not an operation"),
        ] {
            assert_eq!(
                check_json_patch(&json!([op])).unwrap_err().code,
                ErrorCode::Invalid,
                "{op}"
            );
        }
    }

    #[test]
    fn helm_arguments_cannot_pass_for_flags() {
        assert_eq!(helm_release_name("web.v2").unwrap(), "web.v2");
        assert_eq!(helm_namespace(" team-a ").unwrap(), "team-a");
        for bad in [
            "--post-renderer=/bin/x",
            "-n",
            "Web",
            "web_1",
            "web-",
            "a..b",
            &"r".repeat(54),
        ] {
            assert_eq!(
                helm_release_name(bad).unwrap_err().code,
                ErrorCode::Invalid,
                "{bad}"
            );
        }
        assert!(helm_release_name(&"r".repeat(53)).is_ok());
        for bad in ["--kube-context=prod", "-n", "Team", "a.b", &"n".repeat(64)] {
            assert_eq!(
                helm_namespace(bad).unwrap_err().code,
                ErrorCode::Invalid,
                "{bad}"
            );
        }
        assert_eq!(helm_version(Some(" >=1.2 <2 ")).unwrap(), Some(">=1.2 <2"));
        assert_eq!(helm_version(None).unwrap(), None);
        assert!(helm_version(Some("--post-renderer=x")).is_err());
        assert!(chart_repository("-x/chart").is_err());
        assert!(chart_repository("repo/--post-renderer=x").is_err());
    }

    #[tokio::test]
    async fn helm_arguments_that_look_like_flags_are_invalid_before_any_check() {
        let dir = tempfile::tempdir().unwrap();
        let (state, window) = state_in(dir.path(), None);
        window.answer(Answer::Allow);
        let c = first_cluster(&state).0;
        for (name, args) in [
            (
                "helm_uninstall",
                json!({ "cluster": c, "namespace": "a", "release": "--post-renderer=/bin/x" }),
            ),
            (
                "helm_rollback",
                json!({ "cluster": c, "namespace": "--kube-context=prod", "release": "r", "revision": 1 }),
            ),
            (
                "helm_upgrade",
                json!({ "cluster": c, "namespace": "a", "release": "-r" }),
            ),
            (
                "helm_install",
                json!({ "cluster": c, "namespace": "a", "release": "r", "chart": "repo/chart", "version": "--devel" }),
            ),
        ] {
            let refused = tool(&state, name, args).await.unwrap_err();
            // Access to the cluster is off: the arguments were refused before the rules were looked at.
            assert!(refused.contains("is not a"), "{name}: {refused}");
        }
        assert!(
            state
                .mcp
                .context()
                .audit
                .list(None)
                .iter()
                .all(|e| e.cluster_id.is_none())
        );
    }

    #[tokio::test]
    async fn a_cluster_with_access_off_refuses_every_change_without_asking() {
        let dir = tempfile::tempdir().unwrap();
        let (state, window) = state_in(dir.path(), None);
        window.answer(Answer::Allow);
        let id = first_cluster(&state);
        let c = id.0.as_str();
        let object = json!({ "cluster": c, "kind": "ConfigMap", "namespace": "a", "name": "b" });
        let calls = [
            (
                "apply_yaml",
                json!({ "cluster": c, "yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: a}\n" }),
            ),
            (
                "patch_resource",
                json!({ "cluster": c, "kind": "ConfigMap", "namespace": "a", "name": "b", "patch": {} }),
            ),
            ("delete_resource", object.clone()),
            (
                "scale",
                json!({ "cluster": c, "kind": "Deployment", "namespace": "a", "name": "b", "replicas": 1 }),
            ),
            ("restart", object),
            ("cordon_node", json!({ "cluster": c, "name": "n" })),
            ("drain_node", json!({ "cluster": c, "name": "n" })),
            (
                "trigger_cronjob",
                json!({ "cluster": c, "namespace": "a", "name": "b" }),
            ),
            (
                "suspend_cronjob",
                json!({ "cluster": c, "namespace": "a", "name": "b" }),
            ),
            (
                "gitops_action",
                json!({ "cluster": c, "kind": "Kustomization", "namespace": "a", "name": "b", "action": "reconcile" }),
            ),
            (
                "helm_install",
                json!({ "cluster": c, "namespace": "a", "release": "r", "chart": "repo/chart" }),
            ),
            (
                "helm_upgrade",
                json!({ "cluster": c, "namespace": "a", "release": "r" }),
            ),
            (
                "helm_rollback",
                json!({ "cluster": c, "namespace": "a", "release": "r", "revision": 1 }),
            ),
            (
                "helm_uninstall",
                json!({ "cluster": c, "namespace": "a", "release": "r" }),
            ),
            (
                "exec_command",
                json!({ "cluster": c, "namespace": "a", "pod": "p", "command": ["ls"] }),
            ),
            (
                "port_forward_start",
                json!({ "cluster": c, "namespace": "a", "target": "pod", "name": "p", "remotePort": 80 }),
            ),
            ("port_forward_list", json!({ "cluster": c })),
        ];
        for (name, args) in calls {
            let refused = tool(&state, name, args).await.unwrap_err();
            assert!(
                refused.starts_with(
                    "Sextant denied access to cluster test: AI agent access to it is off."
                ),
                "{name}: {refused}"
            );
        }
        assert_eq!(window.count(), 0);
        assert!(matches!(
            state.clusters.state(&id),
            sextant_core::ConnectionState::Disconnected
        ));
        let journal = state.mcp.context().audit.list(None);
        assert_eq!(journal.len(), 17);
        assert!(journal.iter().all(|e| e.decision == AuditDecision::Denied));
    }

    #[tokio::test]
    async fn an_agent_stops_only_the_forwards_it_started() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _) = state_in(dir.path(), None);
        let listed = tool(&state, "port_forward_list", json!({})).await.unwrap();
        assert_eq!(listed, json!({ "forwards": [] }));
        let stopped = tool(&state, "port_forward_stop", json!({ "id": "pf-1" }))
            .await
            .unwrap_err();
        assert_eq!(
            stopped,
            "no port forward pf-1 started by an agent; port_forward_list lists them"
        );
    }

    #[tokio::test]
    async fn a_document_with_hidden_values_is_refused_before_anything_is_asked() {
        let dir = tempfile::tempdir().unwrap();
        let (state, window) = state_in(dir.path(), None);
        window.answer(Answer::Allow);
        let id = first_cluster(&state);
        set_rules(
            &state,
            &id,
            vec![rule(&[], &[], &[AccessAction::Modify], true)],
        );
        let yaml = format!(
            "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\n  namespace: a\n  annotations:\n    \
             {}: \"true\"\ndata: {{password: \"\"}}\n",
            "sextant.dev/values-hidden"
        );
        let refused = tool(
            &state,
            "apply_yaml",
            json!({ "cluster": id.0.as_str(), "yaml": yaml }),
        )
        .await
        .unwrap_err();
        assert!(refused.contains("loaded without its values"), "{refused}");
        assert_eq!(window.count(), 0, "the user was asked about it");
    }

    /// A fake `helm` in `dir` that writes its PID to `dir/pid` and then sleeps for 30 s (as the same process).
    #[cfg(unix)]
    fn sleeping_helm(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let pid = dir.join("pid");
        let fake = dir.join("helm");
        std::fs::write(
            &fake,
            format!("#!/bin/sh\necho $$ > '{}'\nexec sleep 30\n", pid.display()),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        (fake, pid)
    }

    /// The PID the fake `helm` wrote, once it runs.
    #[cfg(unix)]
    async fn started(pid_file: &Path) -> String {
        for _ in 0..500 {
            let pid = std::fs::read_to_string(pid_file).unwrap_or_default();
            if !pid.trim().is_empty() {
                return pid.trim().to_owned();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("helm did not start in 10 s");
    }

    /// Waits up to 5 s for the process to be gone; kills it and fails when it is not.
    #[cfg(unix)]
    async fn assert_gone(pid: &str) {
        let alive = || {
            std::process::Command::new("kill")
                .args(["-0", pid])
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        for _ in 0..250 {
            if !alive() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _ = std::process::Command::new("kill")
            .args(["-9", pid])
            .status();
        panic!("helm {pid} is still running");
    }

    #[test]
    fn agent_helm_changes_have_time_limits() {
        assert_eq!(HELM_INSTALL_LIMIT, Duration::from_secs(5 * 60));
        assert_eq!(HELM_ROLLBACK_LIMIT, Duration::from_secs(2 * 60));
        assert_eq!(HELM_READ_LIMIT, Duration::from_secs(30));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_helm_change_past_its_time_limit_is_stopped_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let (fake, pid_file) = sleeping_helm(dir.path());
        let cli = HelmCli::default().with_binary(fake);
        let started_at = std::time::Instant::now();
        let call = tokio::spawn(async move {
            helm_change(
                Duration::from_millis(500),
                "helm uninstall",
                cli.uninstall(Path::new("/nonexistent"), "ctx", "ns", "web"),
            )
            .await
        });
        let pid = started(&pid_file).await;
        let err = call.await.unwrap().unwrap_err();
        assert!(started_at.elapsed() < Duration::from_secs(10));
        assert_eq!(err.code, ErrorCode::Timeout, "{err}");
        assert!(
            err.message.starts_with("helm uninstall did not finish"),
            "{err}"
        );
        assert!(err.message.contains("helm_get_release"), "{err}");
        assert_gone(&pid).await;
    }

    // -------------------------------------------------------------------------------------------------------------
    // Against the kind test cluster

    /// State with the test cluster (not yet connected) and its window, or `None` (skipped) without
    /// `SEXTANT_TEST_KUBECONFIG`.
    fn cluster_state(dir: &Path) -> Option<(AppState, ClusterId, Window)> {
        let Some(kubeconfig) =
            std::env::var_os("SEXTANT_TEST_KUBECONFIG").filter(|v| !v.is_empty())
        else {
            eprintln!("skipped: SEXTANT_TEST_KUBECONFIG is not set (see scripts/test-cluster.sh)");
            return None;
        };
        let (state, window) = state_in(dir, Some(kubeconfig));
        let id = first_cluster(&state);
        Some((state, id, window))
    }

    fn kind(group: &str, version: &str, kind: &str) -> KindRef {
        KindRef {
            group: group.into(),
            version: version.into(),
            kind: kind.into(),
        }
    }

    fn object(kind: KindRef, namespace: Option<&str>, name: &str) -> ObjectRef {
        ObjectRef {
            kind,
            namespace: namespace.map(str::to_owned),
            name: name.into(),
        }
    }

    fn config_map(namespace: &str, name: &str) -> ObjectRef {
        object(kind("", "v1", "ConfigMap"), Some(namespace), name)
    }

    async fn get(state: &AppState, id: &ClusterId, o: &ObjectRef) -> Option<Value> {
        match resources::get(&state.clusters, id, o).await {
            Ok(value) => Some(value),
            Err(e) if e.code == ErrorCode::NotFound => None,
            Err(e) => panic!("reading {}: {e:?}", describe(o)),
        }
    }

    async fn wait_until<F, Fut>(what: &str, mut done: F)
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        for _ in 0..240 {
            if done().await {
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        panic!("{what}: not in 120 s");
    }

    /// Connects and makes a fresh namespace `ns` with a ConfigMap `settings` (color: blue); with `workloads`, also a
    /// Deployment `web` (nginx, 1 replica) and a suspended CronJob `tick`.
    async fn namespace(state: &AppState, id: &ClusterId, ns: &str, workloads: bool) {
        state.clusters.connect(id).await.unwrap();
        let namespace = object(kind("", "v1", "Namespace"), None, ns);
        if get(state, id, &namespace).await.is_some() {
            let _ = resources::delete(&state.clusters, id, &namespace).await;
            wait_until("the old namespace goes", || async {
                get(state, id, &namespace).await.is_none()
            })
            .await;
        }
        let mut yaml = format!(
            "apiVersion: v1\nkind: Namespace\nmetadata: {{name: {ns}}}\n---\n\
             apiVersion: v1\nkind: ConfigMap\nmetadata: {{name: settings, namespace: {ns}}}\ndata: {{color: blue}}\n"
        );
        if workloads {
            yaml.push_str(&format!(
                "---
apiVersion: apps/v1
kind: Deployment
metadata: {{name: web, namespace: {ns}}}
spec:
  replicas: 1
  selector: {{matchLabels: {{app: web}}}}
  template:
    metadata: {{labels: {{app: web}}}}
    spec:
      terminationGracePeriodSeconds: 0
      containers:
      - name: web
        image: nginx:stable-alpine
        imagePullPolicy: IfNotPresent
        ports: [{{containerPort: 80}}]
---
apiVersion: batch/v1
kind: CronJob
metadata: {{name: tick, namespace: {ns}}}
spec:
  schedule: \"0 0 1 1 *\"
  suspend: true
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
          - name: tick
            image: busybox:stable
            imagePullPolicy: IfNotPresent
            command: [\"true\"]
"
            ));
        }
        resources::apply_yaml(&state.clusters, id, &yaml)
            .await
            .unwrap();
    }

    async fn remove_namespace(state: &AppState, id: &ClusterId, ns: &str) {
        let namespace = object(kind("", "v1", "Namespace"), None, ns);
        let _ = resources::delete(&state.clusters, id, &namespace).await;
    }

    async fn first_node(state: &AppState, id: &ClusterId) -> String {
        let nodes = resources::list(
            &state.clusters,
            id,
            &kind("", "v1", "Node"),
            None,
            None,
            None,
            1,
        )
        .await
        .unwrap();
        nodes.items[0]["metadata"]["name"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn node_cordoned(state: &AppState, id: &ClusterId, node: &str) -> bool {
        let node = get(state, id, &object(kind("", "v1", "Node"), None, node))
            .await
            .unwrap();
        node["spec"]["unschedulable"] == true
    }

    /// A running, ready, not terminating pod of the Deployment `web`.
    async fn web_pod(state: &AppState, id: &ClusterId, ns: &str) -> String {
        for _ in 0..240 {
            let pods = resources::list(
                &state.clusters,
                id,
                &kind("", "v1", "Pod"),
                Some(ns),
                Some("app=web"),
                None,
                10,
            )
            .await
            .unwrap();
            let ready = pods
                .items
                .iter()
                .find(|p| {
                    p["status"]["phase"] == "Running"
                        && p["metadata"].get("deletionTimestamp").is_none()
                        && p["status"]["containerStatuses"][0]["ready"] == true
                })
                .and_then(|p| p["metadata"]["name"].as_str());
            if let Some(name) = ready {
                return name.to_owned();
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        panic!("no running pod of web in 120 s");
    }

    #[tokio::test]
    async fn changes_the_rules_do_not_cover_are_refused_and_send_nothing() {
        const NS: &str = "sextant-mcp-write-denied";
        let dir = tempfile::tempdir().unwrap();
        let Some((state, id, window)) = cluster_state(dir.path()) else {
            return;
        };
        window.answer(Answer::Allow);
        namespace(&state, &id, NS, false).await;
        let c = id.0.as_str();
        set_rules(
            &state,
            &id,
            vec![
                rule(
                    &[NS],
                    &[("", "ConfigMap"), ("", "Namespace")],
                    &[AccessAction::Read, AccessAction::Modify],
                    false,
                ),
                // Drain: the node may be changed, but pods may be deleted only in NS.
                rule(&[], &[("", "Node")], &[AccessAction::Modify], false),
                rule(&[NS], &[("", "Pod")], &[AccessAction::Delete], false),
                // Exec only in a namespace written with spaces: it must not reach the pods of NS.
                rule(
                    &[&format!("  {NS} ")],
                    &[("", "Pod")],
                    &[AccessAction::Exec],
                    false,
                ),
            ],
        );

        // One document the rules do not cover: nothing is applied, not even the allowed one before it.
        let yaml = format!(
            "apiVersion: v1\nkind: ConfigMap\nmetadata: {{name: first, namespace: {NS}}}\n---\n\
             apiVersion: v1\nkind: Secret\nmetadata: {{name: second, namespace: {NS}}}\nstringData: {{key: not-a-real-value}}\n"
        );
        let refused = tool(&state, "apply_yaml", json!({ "cluster": c, "yaml": yaml }))
            .await
            .unwrap_err();
        assert!(
            refused.starts_with(&format!(
                "Sextant denied modify on Secret in namespace {NS} in cluster "
            )),
            "{refused}"
        );
        assert!(get(&state, &id, &config_map(NS, "first")).await.is_none());

        // A document without a namespace goes to the context's default namespace, which no rule covers.
        let refused = tool(
            &state,
            "apply_yaml",
            json!({ "cluster": c, "yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: nowhere}\n" }),
        )
        .await
        .unwrap_err();
        assert!(
            refused.starts_with("Sextant denied modify on ConfigMap default/nowhere"),
            "{refused}"
        );

        let refused = tool(
            &state,
            "delete_resource",
            json!({ "cluster": c, "kind": "ConfigMap", "namespace": NS, "name": "settings" }),
        )
        .await
        .unwrap_err();
        assert!(
            refused.starts_with(&format!("Sextant denied delete on ConfigMap {NS}/settings")),
            "{refused}"
        );
        assert!(
            get(&state, &id, &config_map(NS, "settings"))
                .await
                .is_some()
        );

        // A cluster-wide kind is covered only by rules for all namespaces, whatever namespace the agent sends.
        let refused = tool(
            &state,
            "patch_resource",
            json!({ "cluster": c, "kind": "Namespace", "namespace": NS, "name": NS,
                    "patch": { "metadata": { "labels": { "touched": "yes" } } } }),
        )
        .await
        .unwrap_err();
        assert!(
            refused.starts_with(&format!("Sextant denied modify on Namespace {NS}")),
            "{refused}"
        );

        let node = first_node(&state, &id).await;
        let refused = tool(&state, "drain_node", json!({ "cluster": c, "name": node }))
            .await
            .unwrap_err();
        assert!(
            refused.starts_with("Sextant denied delete on Pod in all namespaces"),
            "{refused}"
        );
        assert!(!node_cordoned(&state, &id, &node).await);

        for (name, args, start) in [
            (
                "exec_command",
                json!({ "cluster": c, "namespace": NS, "pod": "p", "command": ["ls"] }),
                format!("Sextant denied exec on Pod {NS}/p"),
            ),
            (
                "port_forward_start",
                json!({ "cluster": c, "namespace": NS, "target": "service", "name": "s", "remotePort": 80 }),
                format!("Sextant denied port forward on Service {NS}/s"),
            ),
            (
                "scale",
                json!({ "cluster": c, "kind": "Deployment", "namespace": NS, "name": "web", "replicas": 0 }),
                format!("Sextant denied modify on Deployment {NS}/web"),
            ),
            (
                "helm_uninstall",
                json!({ "cluster": c, "namespace": NS, "release": "r" }),
                format!("Sextant denied delete on Release {NS}/r"),
            ),
            (
                "helm_rollback",
                json!({ "cluster": c, "namespace": NS, "release": "r", "revision": 1 }),
                format!("Sextant denied modify on Release {NS}/r"),
            ),
        ] {
            let refused = tool(&state, name, args).await.unwrap_err();
            assert!(refused.starts_with(&start), "{name}: {refused}");
        }

        // The rules see the namespace the pod is taken from (NS), not the agent's text around it.
        let refused = tool(
            &state,
            "exec_command",
            json!({ "cluster": c, "namespace": format!("  {NS} "), "pod": "web-1", "command": ["true"] }),
        )
        .await
        .unwrap_err();
        assert!(
            refused.starts_with(&format!("Sextant denied exec on Pod {NS}/web-1")),
            "{refused}"
        );

        // What cannot run is not asked about: a chart that is not `<repository>/<chart>`.
        let refused = tool(
            &state,
            "helm_install",
            json!({ "cluster": c, "namespace": NS, "release": "r", "chart": "/tmp/chart" }),
        )
        .await
        .unwrap_err();
        assert!(refused.contains("pass <repository>/<chart>"), "{refused}");

        assert_eq!(window.count(), 0, "a refused call was asked about");
        let journal = state.mcp.context().audit.list(None);
        assert!(
            journal
                .iter()
                .all(|e| !e.target.contains("not-a-real-value"))
        );
        assert!(
            journal
                .iter()
                .filter(|e| e.tool != "helm_install")
                .all(|e| e.decision == AuditDecision::Denied)
        );
        remove_namespace(&state, &id, NS).await;
        state.close_all();
    }

    #[tokio::test]
    async fn the_confirmation_of_a_long_apply_names_every_object() {
        // Nothing is applied (the window denies), so the namespace need not exist.
        const NS: &str = "sextant-mcp-write-many";
        let dir = tempfile::tempdir().unwrap();
        let Some((state, id, window)) = cluster_state(dir.path()) else {
            return;
        };
        set_rules(
            &state,
            &id,
            vec![rule(&[NS], &[], &[AccessAction::Modify], true)],
        );
        // 30 objects of 8 lines: the target and the first 200 lines of YAML both miss the last one.
        let yaml: String = (1..=30)
            .map(|n| {
                format!(
                    "---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings-number-{n:02}\n  \
                     namespace: {NS}\ndata:\n  color: green\n"
                )
            })
            .collect();
        window.answer(Answer::Deny);
        let declined = tool(
            &state,
            "apply_yaml",
            json!({ "cluster": id.0.as_str(), "yaml": yaml }),
        )
        .await
        .unwrap_err();
        assert!(
            declined.starts_with("The user declined apply_yaml"),
            "{declined}"
        );
        let asked = window.last();
        let shown = format!("{}\n{}", asked.target, asked.details.unwrap_or_default());
        for n in 1..=30 {
            let object = format!("ConfigMap {NS}/settings-number-{n:02}");
            assert!(shown.contains(&object), "{object} is not shown:\n{shown}");
        }
        state.close_all();
    }

    #[tokio::test]
    async fn changes_that_ask_run_only_when_the_user_allows_them() {
        const NS: &str = "sextant-mcp-write-asked";
        let dir = tempfile::tempdir().unwrap();
        let Some((state, id, window)) = cluster_state(dir.path()) else {
            return;
        };
        namespace(&state, &id, NS, false).await;
        let c = id.0.as_str();
        use AccessAction::{Delete, Exec, Modify, PortForward, Read};
        set_rules(
            &state,
            &id,
            vec![
                rule(&[NS], &[], &[Read, Modify, Delete, Exec, PortForward], true),
                rule(&[], &[("", "Node")], &[Modify], true),
                rule(&[], &[("", "Pod")], &[Delete], true),
            ],
        );
        let yaml = format!(
            "apiVersion: v1\nkind: ConfigMap\nmetadata: {{name: asked, namespace: {NS}}}\ndata: {{color: green}}\n"
        );
        let apply = json!({ "cluster": c, "yaml": yaml });

        // Denied in the window: nothing changes.
        window.answer(Answer::Deny);
        let declined = tool(&state, "apply_yaml", apply.clone()).await.unwrap_err();
        assert!(
            declined.starts_with(&format!(
                "The user declined apply_yaml on ConfigMap {NS}/asked in cluster "
            )),
            "{declined}"
        );
        let asked = window.last();
        assert_eq!(
            (asked.client.as_str(), asked.tool.as_str()),
            ("test", "apply_yaml")
        );
        assert_eq!(asked.target, format!("ConfigMap {NS}/asked"));
        assert_eq!(
            asked.details,
            Some(format!("1 object:\nConfigMap {NS}/asked\n\n{yaml}"))
        );
        assert!(get(&state, &id, &config_map(NS, "asked")).await.is_none());

        let declined = tool(
            &state,
            "delete_resource",
            json!({ "cluster": c, "kind": "ConfigMap", "namespace": NS, "name": "settings" }),
        )
        .await
        .unwrap_err();
        assert!(
            declined.starts_with("The user declined delete_resource"),
            "{declined}"
        );
        assert!(
            get(&state, &id, &config_map(NS, "settings"))
                .await
                .is_some()
        );

        let node = first_node(&state, &id).await;
        let declined = tool(&state, "drain_node", json!({ "cluster": c, "name": node }))
            .await
            .unwrap_err();
        assert!(
            declined.starts_with("The user declined drain_node"),
            "{declined}"
        );
        assert_eq!(window.last().target, format!("Node {node}"));
        assert!(!node_cordoned(&state, &id, &node).await);

        let declined = tool(
            &state,
            "exec_command",
            json!({ "cluster": c, "namespace": NS, "pod": "web-1", "command": ["sh", "-c", "echo hi"] }),
        )
        .await
        .unwrap_err();
        assert!(
            declined.starts_with("The user declined exec_command"),
            "{declined}"
        );
        assert_eq!(
            window.last().details.as_deref(),
            Some("command: sh -c 'echo hi'")
        );

        // The rules see the namespace the pod is taken from, not the agent's text around it.
        let declined = tool(
            &state,
            "exec_command",
            json!({ "cluster": c, "namespace": format!("  {NS} "), "pod": "web-1", "command": ["true"] }),
        )
        .await
        .unwrap_err();
        assert!(
            declined.starts_with("The user declined exec_command"),
            "{declined}"
        );
        assert_eq!(window.last().target, format!("Pod {NS}/web-1"));

        let declined = tool(
            &state,
            "port_forward_start",
            json!({ "cluster": c, "namespace": NS, "target": "pod", "name": "web-1", "remotePort": 8080 }),
        )
        .await
        .unwrap_err();
        assert!(
            declined.starts_with("The user declined port_forward_start"),
            "{declined}"
        );
        assert!(
            window
                .last()
                .details
                .unwrap()
                .contains("port 8080 of the pod")
        );
        assert!(state.forwarder.list().is_empty());

        // No window to ask in: declined as well.
        window.answer(Answer::NoWindow);
        let asked_before = window.count();
        let declined = tool(
            &state,
            "patch_resource",
            json!({ "cluster": c, "kind": "ConfigMap", "namespace": NS, "name": "settings",
                    "patch": { "data": { "color": "red" } } }),
        )
        .await
        .unwrap_err();
        assert!(
            declined.starts_with("The user declined patch_resource"),
            "{declined}"
        );
        assert_eq!(window.count(), asked_before);
        let settings = get(&state, &id, &config_map(NS, "settings")).await.unwrap();
        assert_eq!(settings["data"]["color"], "blue");

        // Allowed in the window: done.
        window.answer(Answer::Allow);
        let applied = tool(&state, "apply_yaml", apply).await.unwrap();
        assert_eq!(
            applied,
            json!({ "applied": [format!("ConfigMap {NS}/asked")] })
        );
        assert!(get(&state, &id, &config_map(NS, "asked")).await.is_some());
        let deleted = tool(
            &state,
            "delete_resource",
            json!({ "cluster": c, "kind": "ConfigMap", "namespace": NS, "name": "asked" }),
        )
        .await
        .unwrap();
        assert_eq!(
            deleted,
            Value::String(format!("deleted ConfigMap {NS}/asked"))
        );

        // The journal has the answers and only a short target: no YAML, no command.
        let journal = state.mcp.context().audit.list(None);
        let decisions: Vec<AuditDecision> = journal.iter().map(|e| e.decision).collect();
        assert!(decisions.contains(&AuditDecision::Declined));
        assert!(decisions.contains(&AuditDecision::Approved));
        assert!(
            journal
                .iter()
                .all(|e| !e.target.contains('\n') && !e.target.contains("echo hi"))
        );
        remove_namespace(&state, &id, NS).await;
        state.close_all();
    }

    #[tokio::test]
    async fn an_agent_never_runs_commands_in_a_node_shell_pod_whatever_the_rules() {
        const NS: &str = "sextant-mcp-node-shell";
        const REFUSAL: &str = "Sextant does not let agents use node shells";
        let dir = tempfile::tempdir().unwrap();
        let Some((state, id, window)) = cluster_state(dir.path()) else {
            return;
        };
        namespace(&state, &id, NS, false).await;
        let pod_yaml = |labels: &str| {
            format!(
                "apiVersion: v1\nkind: Pod\nmetadata:\n  name: shell\n  namespace: {NS}\n  labels: {{{labels}}}\n\
                 spec:\n  terminationGracePeriodSeconds: 0\n  containers:\n  \
                 - name: shell\n    image: busybox:stable\n    imagePullPolicy: IfNotPresent\n    \
                 command: [sleep, \"600\"]\n"
            )
        };
        resources::apply_yaml(
            &state.clusters,
            &id,
            &pod_yaml("sextant.dev/node-shell: \"true\""),
        )
        .await
        .unwrap();
        use AccessAction::{Delete, Exec, Modify, Read};
        // Rules that allow everything but ask first, and a user who allows: only Sextant's own refusal stops a call.
        set_rules(
            &state,
            &id,
            vec![rule(&[], &[], &[Read, Modify, Delete, Exec], true)],
        );
        window.answer(Answer::Allow);
        let c = id.0.as_str();
        let shell = object(kind("", "v1", "Pod"), Some(NS), "shell");

        // A node shell by its label is known only from the pod itself, read after the user allowed the call.
        let refused = tool(
            &state,
            "exec_command",
            json!({ "cluster": c, "namespace": NS, "pod": "shell", "command": ["hostname"] }),
        )
        .await
        .unwrap_err();
        assert!(refused.contains(REFUSAL), "{refused}");
        assert_eq!(window.count(), 1, "the allowed call was not asked about");

        // The label cannot be taken off — by a merge patch, a JSON patch or an apply — and the pod cannot be deleted.
        let attempts = [
            (
                "patch_resource",
                json!({ "cluster": c, "kind": "Pod", "namespace": NS, "name": "shell",
                        "patch": { "metadata": { "labels": { "sextant.dev/node-shell": null } } } }),
            ),
            (
                "patch_resource",
                json!({ "cluster": c, "kind": "Pod", "namespace": NS, "name": "shell", "patchType": "json",
                        "patch": [{ "op": "remove", "path": "/metadata/labels/sextant.dev~1node-shell" }] }),
            ),
            (
                "apply_yaml",
                json!({ "cluster": c, "yaml": pod_yaml("app: shell") }),
            ),
            (
                "delete_resource",
                json!({ "cluster": c, "kind": "Pod", "namespace": NS, "name": "shell" }),
            ),
        ];
        for (name, args) in attempts {
            let asked = window.count();
            let refused = tool(&state, name, args).await.unwrap_err();
            assert!(refused.contains(REFUSAL), "{name}: {refused}");
            assert_eq!(window.count(), asked + 1, "{name} was not asked about");
        }
        let live = get(&state, &id, &shell).await.expect("the pod is gone");
        assert_eq!(live["metadata"]["labels"]["sextant.dev/node-shell"], "true");
        assert!(live["metadata"].get("deletionTimestamp").is_none());

        // A pod named like a node shell in kube-system is one, whatever its labels: refused without reading it (there
        // is no such pod) and without asking.
        let named = "sextant-node-shell-mcp-test-x";
        let by_name = [
            (
                "exec_command",
                json!({ "cluster": c, "namespace": "kube-system", "pod": named, "command": ["id"] }),
            ),
            (
                "patch_resource",
                json!({ "cluster": c, "kind": "Pod", "namespace": "kube-system", "name": named,
                        "patch": { "metadata": { "labels": { "a": "b" } } } }),
            ),
            (
                "delete_resource",
                json!({ "cluster": c, "kind": "Pod", "namespace": "kube-system", "name": named }),
            ),
            // No containers: the server would refuse it anyway, so nothing is made in kube-system whatever happens.
            (
                "apply_yaml",
                json!({ "cluster": c, "yaml": format!(
                    "apiVersion: v1\nkind: Pod\nmetadata: {{name: {named}, namespace: kube-system}}\nspec: {{containers: []}}\n") }),
            ),
            // A new pod carrying a node shell label is not made either.
            (
                "apply_yaml",
                json!({ "cluster": c, "yaml": format!(
                    "apiVersion: v1\nkind: Pod\nmetadata:\n  name: lookalike\n  namespace: {NS}\n  labels: {{sextant.dev/owner: x}}\n\
                     spec: {{containers: []}}\n") }),
            ),
        ];
        let asked = window.count();
        for (name, args) in by_name {
            let refused = tool(&state, name, args).await.unwrap_err();
            assert!(refused.contains(REFUSAL), "{name}: {refused}");
        }
        assert_eq!(
            window.count(),
            asked,
            "a call refused by name was asked about"
        );
        remove_namespace(&state, &id, NS).await;
        state.close_all();
    }

    #[tokio::test]
    async fn an_agent_forwards_no_port_of_a_node_shell_or_a_pod_on_the_node_network() {
        const NS: &str = "sextant-mcp-forward-node";
        const BY_NAME: &str = "Sextant does not let agents use node shells";
        const REFUSAL: &str = "Sextant does not let agents forward ports of node shells or of pods that use the node's network";
        let dir = tempfile::tempdir().unwrap();
        let Some((state, id, window)) = cluster_state(dir.path()) else {
            return;
        };
        namespace(&state, &id, NS, false).await;
        let pod_yaml = |name: &str, labels: &str, host_network: bool| {
            format!(
                "apiVersion: v1\nkind: Pod\nmetadata:\n  name: {name}\n  namespace: {NS}\n  labels: {{{labels}}}\n\
                 spec:\n  hostNetwork: {host_network}\n  terminationGracePeriodSeconds: 0\n  containers:\n  \
                 - name: main\n    image: busybox:stable\n    imagePullPolicy: IfNotPresent\n    \
                 command: [sleep, \"600\"]\n"
            )
        };
        // A service that selects only those two pods.
        let yaml = [
            pod_yaml(
                "shell",
                "sextant.dev/node-shell: \"true\", app: node",
                false,
            ),
            pod_yaml("host", "app: node", true),
            format!(
                "apiVersion: v1\nkind: Service\nmetadata: {{name: node, namespace: {NS}}}\n\
                 spec: {{selector: {{app: node}}, ports: [{{port: 22}}]}}\n"
            ),
        ]
        .join("---\n");
        resources::apply_yaml(&state.clusters, &id, &yaml)
            .await
            .unwrap();
        for name in ["shell", "host"] {
            let pod = object(kind("", "v1", "Pod"), Some(NS), name);
            wait_until(&format!("pod {name} is ready"), || async {
                get(&state, &id, &pod).await.is_some_and(|p| {
                    p["status"]["conditions"].as_array().is_some_and(|c| {
                        c.iter()
                            .any(|c| c["type"] == "Ready" && c["status"] == "True")
                    })
                })
            })
            .await;
        }
        // Rules that allow forwards but ask first, and a user who allows: only Sextant's own refusal stops a call.
        set_rules(
            &state,
            &id,
            vec![rule(
                &[],
                &[],
                &[AccessAction::Read, AccessAction::PortForward],
                true,
            )],
        );
        window.answer(Answer::Allow);
        let c = id.0.as_str();
        let forward = |target: &str, namespace: &str, name: &str| json!({ "cluster": c, "namespace": namespace, "target": target, "name": name, "remotePort": 22 });
        // (call, its refusal, whether the user is asked first)
        let cases = [
            // Named like a node shell in kube-system: refused before asking and without reading it (there is no
            // such pod).
            (
                forward("pod", "kube-system", "sextant-node-shell-mcp-test-x"),
                BY_NAME,
                false,
            ),
            // Known only from the pod: refused after the user allowed the call, before anything is forwarded.
            (forward("pod", NS, "shell"), "is a node shell", true),
            (forward("pod", NS, "host"), "uses the node's network", true),
            // A service whose pods are all such pods is refused at once (not left waiting for a pod).
            (
                forward("service", NS, "node"),
                "has no ready pods this port forward may go to",
                true,
            ),
        ];
        for (args, refusal, asks) in cases {
            let asked = window.count();
            let refused = tool(&state, "port_forward_start", args.clone())
                .await
                .unwrap_err();
            assert!(refused.contains(refusal), "{args}: {refused}");
            if asks {
                assert!(refused.starts_with(REFUSAL), "{args}: {refused}");
            }
            assert_eq!(window.count(), asked + usize::from(asks), "{args}");
        }
        assert!(state.forwarder.list().is_empty());
        remove_namespace(&state, &id, NS).await;
        state.close_all();
    }

    /// A kubeconfig for the test cluster's admin acting as the ServiceAccount `namespace/name` (impersonation).
    fn kubeconfig_as(
        dir: &Path,
        admin: &std::ffi::OsStr,
        namespace: &str,
        name: &str,
    ) -> std::ffi::OsString {
        let text = std::fs::read_to_string(admin).unwrap();
        let mut config: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
        for user in config["users"].as_sequence_mut().unwrap() {
            user["user"]["as"] = format!("system:serviceaccount:{namespace}:{name}").into();
        }
        let path = dir.join("kubeconfig-as");
        std::fs::write(&path, serde_yaml::to_string(&config).unwrap()).unwrap();
        path.into_os_string()
    }

    #[tokio::test]
    async fn a_pod_sextant_cannot_read_gets_no_command() {
        const NS: &str = "sextant-mcp-exec-unread";
        let dir = tempfile::tempdir().unwrap();
        let Some((admin, id, _)) = cluster_state(dir.path()) else {
            return;
        };
        namespace(&admin, &id, NS, true).await;
        let pod = web_pod(&admin, &id, NS).await;
        // The cluster lets `exec-only` run commands in pods but not read them.
        let rbac = format!(
            "apiVersion: v1\nkind: ServiceAccount\nmetadata: {{name: exec-only, namespace: {NS}}}\n---\n\
             apiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata: {{name: exec-only, namespace: {NS}}}\n\
             rules:\n- apiGroups: [\"\"]\n  resources: [pods/exec]\n  verbs: [create, get]\n---\n\
             apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata: {{name: exec-only, namespace: {NS}}}\n\
             roleRef: {{apiGroup: rbac.authorization.k8s.io, kind: Role, name: exec-only}}\n\
             subjects:\n- {{kind: ServiceAccount, name: exec-only, namespace: {NS}}}\n"
        );
        resources::apply_yaml(&admin.clusters, &id, &rbac)
            .await
            .unwrap();

        let as_dir = tempfile::tempdir().unwrap();
        let admin_kubeconfig = std::env::var_os("SEXTANT_TEST_KUBECONFIG").unwrap();
        let kubeconfig = kubeconfig_as(as_dir.path(), &admin_kubeconfig, NS, "exec-only");
        let (state, window) = state_in(as_dir.path(), Some(kubeconfig));
        let exec_id = first_cluster(&state);
        set_rules(
            &state,
            &exec_id,
            vec![rule(&[], &[], &[AccessAction::Exec], false)],
        );
        let refused = tool(
            &state,
            "exec_command",
            // The container is named, so running the command needs no read of the pod.
            json!({ "cluster": exec_id.0.as_str(), "namespace": NS, "pod": pod, "container": "web",
                    "command": ["true"] }),
        )
        .await
        .unwrap_err();
        assert!(refused.contains("is not a node shell"), "{refused}");
        assert_eq!(window.count(), 0);
        state.close_all();
        remove_namespace(&admin, &id, NS).await;
        admin.close_all();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_the_server_kills_an_agents_helm() {
        let dir = tempfile::tempdir().unwrap();
        let Some((state, id, _)) = cluster_state(dir.path()) else {
            return;
        };
        let (fake, pid_file) = sleeping_helm(dir.path());
        state
            .settings
            .update(|s| s.helm_path = Some(fake.display().to_string()))
            .unwrap();
        set_rules(
            &state,
            &id,
            vec![AccessRule {
                kinds: KindScope::Only {
                    kinds: vec![KindPattern::helm_release()],
                },
                ..rule(
                    &["sextant-mcp-helm-stop"],
                    &[],
                    &[AccessAction::Delete],
                    false,
                )
            }],
        );
        let handler = state.mcp.handler();
        let args = json!({ "cluster": id.0.as_str(), "namespace": "sextant-mcp-helm-stop", "release": "web" });
        let Value::Object(args) = args else {
            unreachable!()
        };
        let call = tokio::spawn(async move { handler.call("test", "helm_uninstall", args).await });
        let pid = started(&pid_file).await;
        state.mcp.stop();
        let result = tokio::time::timeout(Duration::from_secs(10), call)
            .await
            .expect("the call outlived the server")
            .unwrap();
        assert!(result.is_err(), "{result:?}");
        assert_gone(&pid).await;
        state.close_all();
    }

    #[test]
    fn the_agent_forward_cap_leaves_room_for_exactly_the_limit() {
        assert!(forward_cap_refusal(0).is_none());
        assert!(forward_cap_refusal(MAX_AGENT_FORWARDS - 1).is_none());
        let refusal = forward_cap_refusal(MAX_AGENT_FORWARDS).expect("the cap is reached");
        assert!(
            refusal.message.contains("port_forward_stop"),
            "{}",
            refusal.message
        );
        assert!(forward_cap_refusal(MAX_AGENT_FORWARDS + 1).is_some());
    }

    #[tokio::test]
    async fn an_agent_cannot_keep_more_than_the_cap_of_port_forwards() {
        const NS: &str = "sextant-mcp-forward-cap";
        let dir = tempfile::tempdir().unwrap();
        let Some((state, id, _window)) = cluster_state(dir.path()) else {
            return;
        };
        namespace(&state, &id, NS, true).await;
        let c = id.0.as_str();
        set_rules(
            &state,
            &id,
            vec![rule(
                &[NS],
                &[],
                &[AccessAction::Read, AccessAction::PortForward],
                false,
            )],
        );
        let pod = web_pod(&state, &id, NS).await;
        let args = json!({ "cluster": c, "namespace": NS, "target": "pod", "name": pod, "remotePort": 80 });
        let mut ids = Vec::new();
        for _ in 0..MAX_AGENT_FORWARDS {
            let started = tool(&state, "port_forward_start", args.clone())
                .await
                .unwrap();
            ids.push(started["id"].as_str().unwrap().to_owned());
        }
        let refused = tool(&state, "port_forward_start", args.clone())
            .await
            .unwrap_err();
        assert!(refused.contains("port_forward_stop"), "{refused}");
        assert_eq!(state.forwarder.list().len(), MAX_AGENT_FORWARDS);

        // One the user closed in the application no longer counts: its room is free again.
        state.forwarder.stop(&ids[0]).await.unwrap();
        tool(&state, "port_forward_start", args.clone())
            .await
            .unwrap();
        assert!(
            tool(&state, "port_forward_start", args.clone())
                .await
                .is_err()
        );
        // One the agent stopped does too.
        tool(&state, "port_forward_stop", json!({ "id": ids[1] }))
            .await
            .unwrap();
        tool(&state, "port_forward_start", args).await.unwrap();
        state.close_all();
    }

    #[tokio::test]
    async fn allowed_changes_work_and_agent_forwards_stay_the_agents() {
        const NS: &str = "sextant-mcp-write-allowed";
        let dir = tempfile::tempdir().unwrap();
        let Some((state, id, window)) = cluster_state(dir.path()) else {
            return;
        };
        namespace(&state, &id, NS, true).await;
        let c = id.0.as_str();
        use AccessAction::{Delete, Exec, Modify, PortForward, Read};
        set_rules(
            &state,
            &id,
            vec![rule(
                &[NS],
                &[],
                &[Read, Modify, Delete, Exec, PortForward],
                false,
            )],
        );

        // A command in the container.
        let pod = web_pod(&state, &id, NS).await;
        let ran = tool(
            &state,
            "exec_command",
            json!({ "cluster": c, "namespace": NS, "pod": pod,
                    "command": ["sh", "-c", "echo out; echo err >&2; exit 3"] }),
        )
        .await
        .unwrap();
        assert_eq!(
            ran,
            json!({ "exitCode": 3, "stdout": "out\n", "stderr": "err\n", "truncated": false, "timedOut": false })
        );

        // Port forwards: the agent's own, visible in the application, closed with the cluster.
        let started = tool(
            &state,
            "port_forward_start",
            json!({ "cluster": c, "namespace": NS, "target": "pod", "name": pod, "remotePort": 80 }),
        )
        .await
        .unwrap();
        let forward_id = started["id"].as_str().unwrap().to_owned();
        let local_port = u16::try_from(started["localPort"].as_u64().unwrap()).unwrap();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", local_port))
            .await
            .unwrap();
        stream
            .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut reply = vec![0u8; 12];
        tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&reply, b"HTTP/1.1 200");
        assert!(state.forwarder.list().iter().any(|f| f.id == forward_id));

        let users = state
            .forwarder
            .start(
                &state.clusters,
                &id,
                ForwardTarget::Pod {
                    namespace: NS.into(),
                    name: pod.clone(),
                },
                80,
                None,
                PodFilter::Any,
            )
            .await
            .unwrap();
        let listed = tool(&state, "port_forward_list", json!({ "cluster": c }))
            .await
            .unwrap();
        let ids: Vec<&str> = listed["forwards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec![forward_id.as_str()]);
        let refused = tool(&state, "port_forward_stop", json!({ "id": users.id }))
            .await
            .unwrap_err();
        assert!(refused.starts_with("no port forward"), "{refused}");
        assert!(state.forwarder.list().iter().any(|f| f.id == users.id));
        tool(&state, "port_forward_stop", json!({ "id": forward_id }))
            .await
            .unwrap();
        assert_eq!(
            state
                .forwarder
                .list()
                .iter()
                .map(|f| f.id.clone())
                .collect::<Vec<_>>(),
            vec![users.id.clone()]
        );
        tool(
            &state,
            "port_forward_start",
            json!({ "cluster": c, "namespace": NS, "target": "pod", "name": pod, "remotePort": 80 }),
        )
        .await
        .unwrap();
        state.close_cluster(&id);
        assert!(state.forwarder.list().is_empty());
        let listed = tool(&state, "port_forward_list", json!({})).await.unwrap();
        assert_eq!(listed, json!({ "forwards": [] }));

        // Patches.
        let cm = |patch: Value, patch_type: &str| {
            json!({ "cluster": c, "kind": "configmaps", "namespace": NS, "name": "settings",
                    "patch": patch, "patchType": patch_type })
        };
        let saved = tool(
            &state,
            "patch_resource",
            cm(json!({ "data": { "color": "green" } }), "merge"),
        )
        .await
        .unwrap();
        assert_eq!(saved["data"]["color"], "green");
        assert!(saved["metadata"].get("managedFields").is_none());
        let saved = tool(
            &state,
            "patch_resource",
            cm(
                json!([{ "op": "replace", "path": "/data/color", "value": "teal" }]),
                "json",
            ),
        )
        .await
        .unwrap();
        assert_eq!(saved["data"]["color"], "teal");
        let wrong = tool(
            &state,
            "patch_resource",
            cm(
                json!([{ "op": "replace", "path": "data/color", "value": "red" }]),
                "json",
            ),
        )
        .await
        .unwrap_err();
        assert!(wrong.contains("must start with /"), "{wrong}");
        let wrong = tool(&state, "patch_resource", cm(json!([]), "merge"))
            .await
            .unwrap_err();
        assert_eq!(wrong, "a merge patch is a JSON object");

        // A Secret may be written, but a JSON patch must not copy (or test) its values where the agent reads.
        resources::apply_yaml(
            &state.clusters,
            &id,
            &format!(
                "apiVersion: v1\nkind: Secret\nmetadata: {{name: creds, namespace: {NS}}}\n\
                 stringData: {{password: not-a-real-value}}\n"
            ),
        )
        .await
        .unwrap();
        let creds = object(kind("", "v1", "Secret"), Some(NS), "creds");
        let secret = |patch: Value, patch_type: &str| {
            json!({ "cluster": c, "kind": "Secret", "namespace": NS, "name": "creds",
                    "patch": patch, "patchType": patch_type })
        };
        // A pointer the server reads past its first segment (`x/data/password`) is refused for every kind.
        for patch in [
            json!([{ "op": "copy", "from": "x/data/password", "path": "/metadata/annotations/leak" }]),
            json!([{ "op": "move", "from": "data/data/password", "path": "/metadata/annotations/leak" }]),
            json!([{ "op": "test", "path": "zz/data/password", "value": "bm90LWEtcmVhbC12YWx1ZQ==" }]),
        ] {
            let refused = tool(&state, "patch_resource", secret(patch, "json"))
                .await
                .unwrap_err();
            assert!(refused.contains("must start with /"), "{refused}");
        }
        // Copy, move and test read what they name: on a Secret only with "Secret values", wherever they point.
        for patch in [
            json!([{ "op": "copy", "from": "/metadata/name", "path": "/metadata/annotations/leak" }]),
            json!([{ "op": "move", "from": "/metadata/name", "path": "/metadata/annotations/leak" }]),
            json!([{ "op": "test", "path": "/metadata/name", "value": "creds" }]),
        ] {
            let refused = tool(&state, "patch_resource", secret(patch, "json"))
                .await
                .unwrap_err();
            assert!(
                refused.starts_with(&format!(
                    "Sextant denied secret values on Secret {NS}/creds"
                )),
                "{refused}"
            );
        }
        let saved = get(&state, &id, &creds).await.unwrap();
        assert!(saved["metadata"]["annotations"].get("leak").is_none());
        assert!(!saved.to_string().contains("not-a-real-value"));
        // Writing needs only Modify.
        let written = tool(
            &state,
            "patch_resource",
            secret(
                json!([
                    { "op": "add", "path": "/data/extra", "value": "eA==" },
                    { "op": "replace", "path": "/data/password", "value": "eA==" },
                    { "op": "remove", "path": "/data/extra" },
                ]),
                "json",
            ),
        )
        .await
        .unwrap();
        assert!(
            written["data"]["password"] == "",
            "a Secret value came back"
        );
        assert!(written["data"].get("extra").is_none());
        let written = tool(
            &state,
            "patch_resource",
            secret(
                json!({ "stringData": { "other": "also-not-real" } }),
                "merge",
            ),
        )
        .await
        .unwrap();
        assert!(written["data"]["other"] == "", "a Secret value came back");
        assert!(!written.to_string().contains("not-a-real-value"));

        // Workloads.
        let web = object(kind("apps", "v1", "Deployment"), Some(NS), "web");
        tool(
            &state,
            "scale",
            json!({ "cluster": c, "kind": "Deployment", "namespace": NS, "name": "web", "replicas": 2 }),
        )
        .await
        .unwrap();
        assert_eq!(get(&state, &id, &web).await.unwrap()["spec"]["replicas"], 2);
        tool(
            &state,
            "restart",
            json!({ "cluster": c, "kind": "Deployment", "namespace": NS, "name": "web" }),
        )
        .await
        .unwrap();
        let restarted = get(&state, &id, &web).await.unwrap();
        assert!(
            restarted["spec"]["template"]["metadata"]["annotations"]
                ["kubectl.kubernetes.io/restartedAt"]
                .is_string()
        );
        let wrong = tool(
            &state,
            "restart",
            json!({ "cluster": c, "kind": "ConfigMap", "namespace": NS, "name": "settings" }),
        )
        .await
        .unwrap_err();
        assert!(wrong.starts_with("only a Deployment"), "{wrong}");

        // CronJob.
        let tick = object(kind("batch", "v1", "CronJob"), Some(NS), "tick");
        tool(
            &state,
            "suspend_cronjob",
            json!({ "cluster": c, "namespace": NS, "name": "tick", "suspend": false }),
        )
        .await
        .unwrap();
        assert_eq!(
            get(&state, &id, &tick).await.unwrap()["spec"]["suspend"],
            false
        );
        tool(
            &state,
            "suspend_cronjob",
            json!({ "cluster": c, "namespace": NS, "name": "tick" }),
        )
        .await
        .unwrap();
        assert_eq!(
            get(&state, &id, &tick).await.unwrap()["spec"]["suspend"],
            true
        );
        let triggered = tool(
            &state,
            "trigger_cronjob",
            json!({ "cluster": c, "namespace": NS, "name": "tick" }),
        )
        .await
        .unwrap();
        let job = triggered["job"].as_str().unwrap();
        let job_name = job.rsplit('/').next().unwrap();
        assert!(job.starts_with(&format!("Job {NS}/tick-manual-")), "{job}");
        assert!(
            get(
                &state,
                &id,
                &object(kind("batch", "v1", "Job"), Some(NS), job_name)
            )
            .await
            .is_some()
        );

        // Flux, when the cluster has it (`scripts/test-cluster.sh up --gitops`).
        let flux = state.clusters.kinds(&id).await.unwrap().iter().any(|k| {
            k.kind_ref.group == "source.toolkit.fluxcd.io" && k.kind_ref.kind == "GitRepository"
        });
        if flux {
            resources::apply_yaml(
                &state.clusters,
                &id,
                &format!(
                    "apiVersion: source.toolkit.fluxcd.io/v1\nkind: GitRepository\n\
                     metadata: {{name: repo, namespace: {NS}}}\n\
                     spec: {{url: https://example.invalid/sextant.git, interval: 60m, suspend: true}}\n"
                ),
            )
            .await
            .unwrap();
            let repo = object(
                kind("source.toolkit.fluxcd.io", "v1", "GitRepository"),
                Some(NS),
                "repo",
            );
            let action = |action: &str| json!({ "cluster": c, "kind": "GitRepository", "namespace": NS, "name": "repo", "action": action });
            tool(&state, "gitops_action", action("reconcile"))
                .await
                .unwrap();
            let saved = get(&state, &id, &repo).await.unwrap();
            assert!(saved["metadata"]["annotations"][FLUX_REQUESTED_AT].is_string());
            tool(&state, "gitops_action", action("resume"))
                .await
                .unwrap();
            assert_eq!(
                get(&state, &id, &repo).await.unwrap()["spec"]["suspend"],
                false
            );
            tool(&state, "gitops_action", action("suspend"))
                .await
                .unwrap();
            assert_eq!(
                get(&state, &id, &repo).await.unwrap()["spec"]["suspend"],
                true
            );
            let wrong = tool(&state, "gitops_action", action("sync"))
                .await
                .unwrap_err();
            assert!(
                wrong.starts_with("sync does not apply to GitRepository"),
                "{wrong}"
            );
        }

        // Helm runs (against the test cluster) once the rules allow it: a missing release is helm's error.
        let failed = tool(
            &state,
            "helm_rollback",
            json!({ "cluster": c, "namespace": NS, "release": "missing", "revision": 1 }),
        )
        .await
        .unwrap_err();
        assert!(!failed.starts_with("Sextant denied"), "{failed}");

        let deleted = tool(
            &state,
            "delete_resource",
            json!({ "cluster": c, "kind": "ConfigMap", "namespace": NS, "name": "settings" }),
        )
        .await;
        assert!(deleted.is_ok(), "{deleted:?}");
        assert!(
            get(&state, &id, &config_map(NS, "settings"))
                .await
                .is_none()
        );

        assert_eq!(
            window.count(),
            0,
            "a call without \"Ask before running\" was asked about"
        );
        remove_namespace(&state, &id, NS).await;
        state.close_all();
    }
}
