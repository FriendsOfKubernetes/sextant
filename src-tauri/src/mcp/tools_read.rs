//! Tools that only read: clusters, kinds, objects, events, logs, metrics, Helm releases, one Secret value. Every one
//! checks the cluster's access rules through the call's `Guard` first; Secrets come without values (and Helm releases
//! without values and manifest) unless a rule gives "Secret values".

use std::time::Duration;

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use sextant_core::access::{AccessAction, KindPattern, NamespaceScope};
use sextant_core::error::with_timeout;
use sextant_core::resources::{self, KindRef, ObjectRef, ResourceKind};
use sextant_core::{ClusterId, ClusterManager, ConnectionState, CoreError, CoreResult, ErrorCode};
use sextant_core::{helm, logs, metrics};

use super::guard::CallSummary;
use super::tools::{ToolCall, ToolKind, ToolOutput, ToolResult, ToolSet};

/// A read gives up after this long.
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Objects `list_resources` returns unless asked for another number.
pub const DEFAULT_LIST_LIMIT: u32 = 100;
/// The most objects one `list_resources` returns.
pub const MAX_LIST_LIMIT: u32 = 500;
/// Events `get_events` returns unless asked for another number.
pub const DEFAULT_EVENT_LIMIT: u32 = 50;
/// Log lines `get_logs` returns unless asked for another number.
pub const DEFAULT_LOG_LINES: u32 = 200;

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// Adds the reading tools.
pub fn register_read_tools(tools: &mut ToolSet) {
    tools
        .add(
            "list_clusters",
            "Clusters Sextant knows (from the user's kubeconfig files), with their connection state and the agent's \
             access to each (`off` — every call to that cluster is refused). Use the `id` in other tools.",
            ToolKind::Read,
            list_clusters,
        )
        .add(
            "list_kinds",
            "Resource kinds of a cluster the agent may use (built-in, custom resources such as Flux and Argo CD, and \
             Helm releases), with their apiVersion and whether they live in namespaces.",
            ToolKind::Read,
            list_kinds,
        )
        .add(
            "list_resources",
            "Objects of one kind, in a namespace or in every namespace the agent may read, optionally filtered by \
             label and field selectors. Up to `limit` objects (100 by default, at most 500); `truncated` says there \
             are more. Secrets come without their values.",
            ToolKind::Read,
            list_resources,
        )
        .add(
            "get_resource",
            "One object as JSON (without managedFields). A Secret comes without its values unless the user allowed \
             \"Secret values\".",
            ToolKind::Read,
            get_resource,
        )
        .add(
            "get_events",
            "Kubernetes events, newest first: of one object (kind and name), of a namespace, or of every namespace \
             the agent may read.",
            ToolKind::Read,
            get_events,
        )
        .add(
            "get_logs",
            "The last lines of a pod's container log (200 by default, at most 2000), or of its previous instance.",
            ToolKind::Read,
            get_logs,
        )
        .add(
            "get_metrics",
            "Current CPU (millicores) and memory (bytes) usage of pods or nodes, from metrics-server or Prometheus.",
            ToolKind::Read,
            get_metrics,
        )
        .add(
            "helm_list_releases",
            "Helm releases (latest revision of each): name, namespace, chart, version, status.",
            ToolKind::Read,
            helm_list_releases,
        )
        .add(
            "helm_get_release",
            "One Helm release: status, chart, notes and revision history; its values and rendered manifest only when \
             the user allowed \"Secret values\" for Helm releases.",
            ToolKind::Read,
            helm_get_release,
        )
        .add(
            "get_secret_value",
            "The value of one key of a Secret, decoded as text. Needs the \"Secret values\" permission.",
            ToolKind::Read,
            get_secret_value,
        );
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments

#[derive(Debug, Deserialize, JsonSchema)]
pub struct NoArgs {}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClusterArgs {
    /// Cluster id from list_clusters (its context name works too).
    pub cluster: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// Kind (`Pod`, `Deployment`, `Kustomization`) or its plural (`pods`).
    pub kind: String,
    /// `v1`, `apps/v1`, `kustomize.toolkit.fluxcd.io/v1`; needed only when several API groups serve the kind.
    pub api_version: Option<String>,
    /// Only this namespace; every namespace the agent may read when left out.
    pub namespace: Option<String>,
    /// e.g. `app=web,tier!=cache`
    pub label_selector: Option<String>,
    /// e.g. `status.phase=Running`
    pub field_selector: Option<String>,
    /// How many objects at most (default 100, at most 500).
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// Kind (`Pod`, `Deployment`, …) or its plural.
    pub kind: String,
    /// Needed only when several API groups serve the kind.
    pub api_version: Option<String>,
    /// Namespace of the object (not for cluster-wide kinds such as Node).
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EventArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// Events of this namespace (or of the object in it).
    pub namespace: Option<String>,
    /// With `name`: events of this object only.
    pub kind: Option<String>,
    pub api_version: Option<String>,
    /// With `kind`: events of this object only.
    pub name: Option<String>,
    /// How many events at most (default 50, at most 500).
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    pub pod: String,
    /// The container; the pod's default one when left out.
    pub container: Option<String>,
    /// How many last lines (default 200, at most 2000).
    pub lines: Option<u32>,
    /// The log of the previous instance of the container (after a restart).
    #[serde(default)]
    pub previous: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MetricsOf {
    Pods,
    Nodes,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MetricsArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// `pods` or `nodes`.
    pub of: MetricsOf,
    /// For pods: only this namespace; every namespace the agent may read when left out.
    pub namespace: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HelmListArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    /// Only this namespace; every namespace the agent may read when left out.
    pub namespace: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HelmGetArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    /// Release name.
    pub name: String,
    /// A revision; the latest when left out.
    pub revision: Option<i32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretArgs {
    /// Cluster id from list_clusters.
    pub cluster: String,
    pub namespace: String,
    /// Name of the Secret.
    pub name: String,
    /// Key in its `data`.
    pub key: String,
}

// ---------------------------------------------------------------------------------------------------------------
// Tools

async fn list_clusters(call: ToolCall, _args: NoArgs) -> ToolResult {
    let ctx = call.ctx();
    let settings = ctx.settings.get();
    let clusters: Vec<Value> = ctx
        .cluster_list()
        .into_iter()
        .map(|c| {
            let access = settings
                .clusters
                .get(&c.id.0)
                .map(|s| s.agent_access.preset)
                .unwrap_or_default();
            json!({
                "id": c.id,
                "name": ctx.cluster_name(&c.id),
                "context": c.context,
                "server": c.server,
                "state": state_name(&ctx.clusters.state(&c.id)),
                "access": access,
            })
        })
        .collect();
    Ok(ToolOutput::Json(json!({ "clusters": clusters })))
}

async fn list_kinds(call: ToolCall, args: ClusterArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let access = call.guard.access(&cluster)?;
    let kinds = read("reading the kinds", call.ctx().clusters.kinds(&cluster.id)).await?;
    let mut out: Vec<Value> = kinds
        .iter()
        .filter(|k| sextant_core::access::has_any_permission(&access, &pattern_of(&k.kind_ref)))
        .map(|k| {
            json!({
                "apiVersion": api_version(&k.kind_ref),
                "kind": k.kind_ref.kind,
                "plural": k.plural,
                "namespaced": k.namespaced,
            })
        })
        .collect();
    if sextant_core::access::has_any_permission(&access, &KindPattern::helm_release()) {
        out.push(json!({
            "apiVersion": "helm.sh",
            "kind": "Release",
            "namespaced": true,
            "note": "Helm releases: helm_list_releases, helm_get_release",
        }));
    }
    Ok(ToolOutput::Json(json!({ "kinds": out })))
}

async fn list_resources(call: ToolCall, args: ListArgs) -> ToolResult {
    let limit = args
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let cluster = call.open(&args.cluster).await?;
    let mgr = &call.ctx().clusters;
    let kind = find_kind(mgr, &cluster.id, args.api_version.as_deref(), &args.kind).await?;
    let pattern = pattern_of(&kind.kind_ref);
    let name = &kind.kind_ref.kind;
    let namespace = non_empty(args.namespace.as_deref()).filter(|_| kind.namespaced);
    let cluster_id = &cluster.id;
    let list = |ns: Option<String>, limit: u32| {
        let kind_ref = kind.kind_ref.clone();
        let (labels, fields) = (args.label_selector.clone(), args.field_selector.clone());
        async move {
            read(
                "listing objects",
                resources::list(
                    mgr,
                    cluster_id,
                    &kind_ref,
                    ns.as_deref(),
                    labels.as_deref(),
                    fields.as_deref(),
                    limit,
                ),
            )
            .await
        }
    };

    let scope = match (&namespace, kind.namespaced) {
        (Some(ns), _) => {
            let summary = summary("list_resources", format!("{name} in namespace {ns}"));
            call.guard
                .check(
                    &cluster,
                    &[need(Some(ns), &pattern, AccessAction::Read)],
                    &summary,
                )
                .await?;
            NamespaceScope::Only {
                namespaces: vec![ns.to_string()],
            }
        }
        (None, false) => {
            let summary = summary("list_resources", name.clone());
            call.guard
                .check(
                    &cluster,
                    &[need(None, &pattern, AccessAction::Read)],
                    &summary,
                )
                .await?;
            NamespaceScope::All
        }
        (None, true) => {
            let summary = summary("list_resources", format!("{name} in all namespaces"));
            call.guard
                .allowed_namespaces(&cluster, &pattern, AccessAction::Read, &summary)?
        }
    };

    let (items, truncated, namespaces) = match scope {
        NamespaceScope::All => {
            let page = list(None, limit).await?;
            (page.items, page.truncated, None)
        }
        NamespaceScope::Only { namespaces } => {
            let mut items = Vec::new();
            let mut truncated = false;
            for (i, ns) in namespaces.iter().enumerate() {
                let left = limit - u32::try_from(items.len()).unwrap_or(limit);
                if left == 0 {
                    truncated = i < namespaces.len();
                    break;
                }
                let page = list(Some(ns.clone()), left).await?;
                truncated |= page.truncated;
                items.extend(page.items);
            }
            (items, truncated, Some(namespaces))
        }
    };
    let items: Vec<Value> = items.into_iter().map(compact).collect();
    let mut out = json!({
        "apiVersion": api_version(&kind.kind_ref),
        "kind": name,
        "count": items.len(),
        "truncated": truncated,
        "items": items,
    });
    if let Some(namespaces) = namespaces.filter(|_| namespace.is_none()) {
        out["namespaces"] = json!(namespaces);
        out["note"] = json!("only the namespaces the agent may read");
    }
    Ok(ToolOutput::Json(out))
}

async fn get_resource(call: ToolCall, args: GetArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let mgr = &call.ctx().clusters;
    let kind = find_kind(mgr, &cluster.id, args.api_version.as_deref(), &args.kind).await?;
    let pattern = pattern_of(&kind.kind_ref);
    let object = object_ref(&kind, args.namespace.as_deref(), &args.name)?;
    let summary = summary("get_resource", describe(&object));
    call.guard
        .check(
            &cluster,
            &[need(
                object.namespace.as_deref(),
                &pattern,
                AccessAction::Read,
            )],
            &summary,
        )
        .await?;
    let with_values = is_secret(&kind.kind_ref)
        && call
            .guard
            .allows(
                &cluster,
                object.namespace.as_deref(),
                &pattern,
                AccessAction::SecretValues,
            )
            .await;
    let value = if with_values {
        read(
            "reading the object",
            resources::get_full(mgr, &cluster.id, &object),
        )
        .await?
    } else {
        read(
            "reading the object",
            resources::get(mgr, &cluster.id, &object),
        )
        .await?
    };
    Ok(ToolOutput::Json(compact(value)))
}

async fn get_events(call: ToolCall, args: EventArgs) -> ToolResult {
    let limit = args
        .limit
        .unwrap_or(DEFAULT_EVENT_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let cluster = call.open(&args.cluster).await?;
    let mgr = &call.ctx().clusters;
    let event = KindPattern::new("", "Event");
    let namespace = non_empty(args.namespace.as_deref());

    let involved = match (
        non_empty(args.kind.as_deref()),
        non_empty(args.name.as_deref()),
    ) {
        (Some(kind), Some(name)) => {
            let kind = find_kind(mgr, &cluster.id, args.api_version.as_deref(), kind).await?;
            Some(object_ref(&kind, namespace, name)?)
        }
        (None, None) => None,
        _ => {
            return Err(invalid("pass both kind and name for the events of one object").into());
        }
    };

    let events = match (&involved, namespace) {
        (Some(object), _) => {
            let summary = summary("get_events", format!("events of {}", describe(object)));
            let ns = object.namespace.as_deref();
            call.guard
                .check(&cluster, &[need(ns, &event, AccessAction::Read)], &summary)
                .await?;
            read(
                "reading events",
                resources::events(mgr, &cluster.id, ns, Some(object), limit),
            )
            .await?
        }
        (None, Some(ns)) => {
            let summary = summary("get_events", format!("Event in namespace {ns}"));
            call.guard
                .check(
                    &cluster,
                    &[need(Some(ns), &event, AccessAction::Read)],
                    &summary,
                )
                .await?;
            read(
                "reading events",
                resources::events(mgr, &cluster.id, Some(ns), None, limit),
            )
            .await?
        }
        (None, None) => {
            let summary = summary("get_events", "Event in all namespaces".to_owned());
            match call
                .guard
                .allowed_namespaces(&cluster, &event, AccessAction::Read, &summary)?
            {
                NamespaceScope::All => {
                    read(
                        "reading events",
                        resources::events(mgr, &cluster.id, None, None, limit),
                    )
                    .await?
                }
                NamespaceScope::Only { namespaces } => {
                    let mut all = Vec::new();
                    for ns in &namespaces {
                        all.extend(
                            read(
                                "reading events",
                                resources::events(mgr, &cluster.id, Some(ns), None, limit),
                            )
                            .await?,
                        );
                    }
                    all.sort_by_key(|e| std::cmp::Reverse(last_seen(e)));
                    all.truncate(limit as usize);
                    all
                }
            }
        }
    };
    let events: Vec<Value> = events.iter().map(compact_event).collect();
    Ok(ToolOutput::Json(
        json!({ "count": events.len(), "events": events }),
    ))
}

async fn get_logs(call: ToolCall, args: LogArgs) -> ToolResult {
    let lines = args
        .lines
        .unwrap_or(DEFAULT_LOG_LINES)
        .clamp(1, logs::MAX_TAIL_LINES);
    let cluster = call.open(&args.cluster).await?;
    let pod = ObjectRef {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        },
        namespace: Some(args.namespace.clone()),
        name: args.pod.clone(),
    };
    let summary = summary("get_logs", describe(&pod));
    call.guard
        .check(
            &cluster,
            &[need(
                Some(&args.namespace),
                &KindPattern::new("", "Pod"),
                AccessAction::Logs,
            )],
            &summary,
        )
        .await?;
    let text = read(
        "reading the log",
        logs::tail(
            &call.ctx().clusters,
            &cluster.id,
            &pod,
            args.container.as_deref(),
            lines,
            args.previous,
        ),
    )
    .await?;
    if text.is_empty() {
        return Ok(ToolOutput::Text("(the log is empty)".into()));
    }
    Ok(ToolOutput::Tail(text))
}

async fn get_metrics(call: ToolCall, args: MetricsArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let ctx = call.ctx();
    let settings = ctx
        .settings
        .get()
        .clusters
        .get(&cluster.id.0)
        .cloned()
        .unwrap_or_default();
    match args.of {
        MetricsOf::Nodes => {
            let summary = summary("get_metrics", "Node usage".to_owned());
            call.guard
                .check(
                    &cluster,
                    &[need(
                        None,
                        &KindPattern::new("", "Node"),
                        AccessAction::Read,
                    )],
                    &summary,
                )
                .await?;
            let nodes = read(
                "reading node usage",
                metrics::node_usage(&ctx.clusters, &cluster.id, &settings),
            )
            .await?;
            Ok(ToolOutput::Json(json!({ "nodes": nodes })))
        }
        MetricsOf::Pods => {
            let pod = KindPattern::new("", "Pod");
            let namespaces = match non_empty(args.namespace.as_deref()) {
                Some(ns) => {
                    let summary = summary("get_metrics", format!("Pod usage in namespace {ns}"));
                    call.guard
                        .check(
                            &cluster,
                            &[need(Some(ns), &pod, AccessAction::Read)],
                            &summary,
                        )
                        .await?;
                    Some(vec![ns.to_owned()])
                }
                None => {
                    let summary = summary("get_metrics", "Pod usage in all namespaces".to_owned());
                    match call.guard.allowed_namespaces(
                        &cluster,
                        &pod,
                        AccessAction::Read,
                        &summary,
                    )? {
                        NamespaceScope::All => None,
                        NamespaceScope::Only { namespaces } => Some(namespaces),
                    }
                }
            };
            let pods = read(
                "reading pod usage",
                metrics::pod_usage(&ctx.clusters, &cluster.id, &settings, namespaces),
            )
            .await?;
            Ok(ToolOutput::Json(json!({ "pods": pods })))
        }
    }
}

async fn helm_list_releases(call: ToolCall, args: HelmListArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let release = KindPattern::helm_release();
    let namespaces = match non_empty(args.namespace.as_deref()) {
        Some(ns) => {
            let summary = summary("helm_list_releases", format!("Release in namespace {ns}"));
            call.guard
                .check(
                    &cluster,
                    &[need(Some(ns), &release, AccessAction::Read)],
                    &summary,
                )
                .await?;
            Some(vec![ns.to_owned()])
        }
        None => {
            let summary = summary("helm_list_releases", "Release in all namespaces".to_owned());
            match call
                .guard
                .allowed_namespaces(&cluster, &release, AccessAction::Read, &summary)?
            {
                NamespaceScope::All => None,
                NamespaceScope::Only { namespaces } => Some(namespaces),
            }
        }
    };
    let releases = read(
        "listing Helm releases",
        helm::list_releases(&call.ctx().clusters, &cluster.id, namespaces),
    )
    .await?;
    Ok(ToolOutput::Json(json!({ "releases": releases })))
}

async fn helm_get_release(call: ToolCall, args: HelmGetArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let release = KindPattern::helm_release();
    let summary = summary(
        "helm_get_release",
        format!("Release {}/{}", args.namespace, args.name),
    );
    call.guard
        .check(
            &cluster,
            &[need(Some(&args.namespace), &release, AccessAction::Read)],
            &summary,
        )
        .await?;
    let with_values = call
        .guard
        .allows(
            &cluster,
            Some(&args.namespace),
            &release,
            AccessAction::SecretValues,
        )
        .await;
    let mgr = &call.ctx().clusters;
    let detail = read(
        "reading the Helm release",
        helm::release_detail(mgr, &cluster.id, &args.namespace, &args.name, args.revision),
    )
    .await?;
    let history = read(
        "reading the Helm history",
        helm::release_history(mgr, &cluster.id, &args.namespace, &args.name),
    )
    .await?;
    let mut out = json!({
        "release": detail.release,
        "notes": detail.notes,
        "history": history,
    });
    if with_values {
        out["values"] = json!(detail.values_yaml);
        out["manifest"] = json!(detail.manifest);
    } else {
        out["valuesHidden"] = json!(
            "values and manifest may hold secrets: the user did not allow \"Secret values\" for Helm releases here"
        );
    }
    Ok(ToolOutput::Json(out))
}

async fn get_secret_value(call: ToolCall, args: SecretArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let summary = summary(
        "get_secret_value",
        format!("Secret {}/{} key {}", args.namespace, args.name, args.key),
    );
    call.guard
        .check(
            &cluster,
            &[need(
                Some(&args.namespace),
                &KindPattern::new("", "Secret"),
                AccessAction::SecretValues,
            )],
            &summary,
        )
        .await?;
    let value = read(
        "reading the Secret",
        resources::secret_value(
            &call.ctx().clusters,
            &cluster.id,
            &args.namespace,
            &args.name,
            &args.key,
        ),
    )
    .await?;
    Ok(ToolOutput::Text(value))
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/// The kind the agent named: by kind or plural (any case), in the group of `api_version` when given. A kind several
/// groups serve needs `api_version`, unless the core group is one of them.
pub async fn find_kind(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    wanted_version: Option<&str>,
    kind: &str,
) -> CoreResult<ResourceKind> {
    let wanted = kind.trim();
    let (group, version) = match non_empty(wanted_version) {
        Some(av) => match av.trim().split_once('/') {
            Some((group, version)) => (Some(group.to_owned()), Some(version.to_owned())),
            None => (Some(String::new()), Some(av.trim().to_owned())),
        },
        None => (None, None),
    };
    let kinds = read("reading the kinds", mgr.kinds(cluster)).await?;
    let mut found: Vec<&ResourceKind> = kinds
        .iter()
        .filter(|k| {
            (k.kind_ref.kind.eq_ignore_ascii_case(wanted) || k.plural.eq_ignore_ascii_case(wanted))
                && group.as_ref().is_none_or(|g| &k.kind_ref.group == g)
        })
        .collect();
    if found.len() > 1 && found.iter().any(|k| k.kind_ref.group.is_empty()) {
        found.retain(|k| k.kind_ref.group.is_empty());
    }
    let chosen = match found.as_slice() {
        [one] => *one,
        [] => {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                format!(
                    "the cluster does not serve the kind {wanted:?}; list_kinds lists the kinds"
                ),
            ));
        }
        many => {
            let groups: Vec<String> = many.iter().map(|k| api_version(&k.kind_ref)).collect();
            return Err(invalid(format!(
                "several API groups serve {wanted:?} ({}); pass apiVersion",
                groups.join(", ")
            )));
        }
    };
    let kind_ref = KindRef {
        group: chosen.kind_ref.group.clone(),
        version: version.unwrap_or_else(|| chosen.kind_ref.version.clone()),
        kind: chosen.kind_ref.kind.clone(),
    };
    read(
        "reading the kind",
        resources::resolve(mgr, cluster, &kind_ref),
    )
    .await
}

/// A read with [`READ_TIMEOUT`].
pub async fn read<T>(
    what: &str,
    call: impl std::future::Future<Output = CoreResult<T>>,
) -> CoreResult<T> {
    with_timeout(READ_TIMEOUT, what, call).await
}

/// A requirement for `Guard::check`.
pub fn need(
    namespace: Option<&str>,
    kind: &KindPattern,
    action: AccessAction,
) -> super::guard::Requirement {
    (namespace.map(str::to_owned), kind.clone(), action)
}

pub fn summary(tool: &str, target: String) -> CallSummary {
    CallSummary {
        tool: tool.to_owned(),
        target,
        details: None,
    }
}

/// The rules' name of a kind: group and kind, no version.
pub fn pattern_of(kind: &KindRef) -> KindPattern {
    KindPattern::new(kind.group.clone(), kind.kind.clone())
}

/// `v1`, `apps/v1`.
pub fn api_version(kind: &KindRef) -> String {
    if kind.group.is_empty() {
        kind.version.clone()
    } else {
        format!("{}/{}", kind.group, kind.version)
    }
}

/// The object the agent named; a namespace only for a kind that has them (required then).
pub fn object_ref(
    kind: &ResourceKind,
    namespace: Option<&str>,
    name: &str,
) -> CoreResult<ObjectRef> {
    let namespace =
        if kind.namespaced {
            Some(non_empty(namespace).ok_or_else(|| {
                invalid(format!("{} {name} needs a namespace", kind.kind_ref.kind))
            })?)
        } else {
            None
        };
    Ok(ObjectRef {
        kind: kind.kind_ref.clone(),
        namespace: namespace.map(str::to_owned),
        name: name.to_owned(),
    })
}

/// `Pod team-a/web-1`, `Node worker-1`.
pub fn describe(object: &ObjectRef) -> String {
    match object.namespace.as_deref().filter(|ns| !ns.is_empty()) {
        Some(ns) => format!("{} {ns}/{}", object.kind.kind, object.name),
        None => format!("{} {}", object.kind.kind, object.name),
    }
}

pub fn non_empty(text: Option<&str>) -> Option<&str> {
    text.map(str::trim).filter(|t| !t.is_empty())
}

pub fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

fn is_secret(kind: &KindRef) -> bool {
    kind.group.is_empty() && kind.kind == "Secret"
}

fn state_name(state: &ConnectionState) -> &'static str {
    match state {
        ConnectionState::Disconnected => "disconnected",
        ConnectionState::Connecting => "connecting",
        ConnectionState::Connected => "connected",
        ConnectionState::Error(_) => "error",
    }
}

/// An object without what only takes room: `managedFields` (already gone) and the last-applied manifest.
fn compact(mut value: Value) -> Value {
    if let Some(meta) = value.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
        if let Some(annotations) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
            annotations.remove(LAST_APPLIED);
        }
    }
    value
}

fn last_seen(event: &Value) -> String {
    ["lastTimestamp", "eventTime"]
        .iter()
        .filter_map(|f| event.get(*f).and_then(Value::as_str))
        .chain(
            event
                .pointer("/metadata/creationTimestamp")
                .and_then(Value::as_str),
        )
        .next()
        .unwrap_or_default()
        .to_owned()
}

fn compact_event(event: &Value) -> Value {
    let involved = &event["involvedObject"];
    let object = match involved["namespace"].as_str().filter(|ns| !ns.is_empty()) {
        Some(ns) => format!(
            "{} {ns}/{}",
            involved["kind"].as_str().unwrap_or_default(),
            involved["name"].as_str().unwrap_or_default()
        ),
        None => format!(
            "{} {}",
            involved["kind"].as_str().unwrap_or_default(),
            involved["name"].as_str().unwrap_or_default()
        ),
    };
    json!({
        "type": event["type"],
        "reason": event["reason"],
        "message": event["message"],
        "object": object,
        "count": event["count"],
        "lastSeen": last_seen(event),
    })
}
