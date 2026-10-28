//! Tools that only read: clusters, kinds, objects, events, logs, metrics, Helm releases, one Secret value. Every one
//! checks the cluster's access rules through the call's `Guard` first; Secrets come without values (and Helm releases
//! without values and manifest) unless a rule gives "Secret values".

use std::time::Duration;

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use sextant_core::access::{self, AccessAction, KindPattern, KindScope, NamespaceScope};
use sextant_core::error::with_timeout;
use sextant_core::resources::{self, KindRef, ObjectRef, ResourceKind, inline_secrets};
use sextant_core::{ClusterId, ClusterManager, ConnectionState, CoreError, CoreResult, ErrorCode};
use sextant_core::{helm, logs, metrics};

use super::guard::{CallSummary, ClusterTarget};
use super::projection;
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
            "get_access",
            "What the user allows the agent on one cluster, from Sextant's settings (no request to the cluster): the \
             rules in force — namespaces, kinds and actions, and whether the user is asked first — and the \
             namespaces the user is known to work in (the kubeconfig context's and the ones the user keeps in \
             Sextant), as hints of where to look when the cluster refuses lists over all namespaces. The \
             Kubernetes API may still refuse what a rule allows: the rules never widen the user's own RBAC.",
            ToolKind::Read,
            get_access,
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
             are more. When the cluster refuses the list over all namespaces, the namespaces the user is known to \
             work in are listed instead (`namespaces`, `refused`; see get_access). `fields` or `summary: true` \
             return a few fields of each object instead of the whole object, many times shorter. Secrets come without their values, and fields that hold secrets inline (a Route's TLS key, \
             a BuildConfig's webhook secrets, a HelmChart's values, an InstallPlan's manifests, a k3s/RKE2 node's \
             arguments) come empty.",
            ToolKind::Read,
            list_resources,
        )
        .add(
            "get_resource",
            "One object as JSON (without managedFields). A Secret comes without its values, and fields that hold \
             secrets inline (a Route's TLS key, a BuildConfig's webhook secrets, a HelmChart's values, an \
             InstallPlan's manifests, a k3s/RKE2 node's arguments) come empty, unless the user allowed \"Secret \
             values\".",
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
    /// Instead of whole objects, only these fields of each (at most 20), as `{namespace, name, values}`: paths such
    /// as `.status.phase`, `.spec.containers[0].image`, `.metadata.labels["app"]` (no wildcards or filters).
    pub fields: Option<Vec<String>>,
    /// Instead of whole objects, a short summary of each: phase, ready containers, restarts and node of a Pod,
    /// replicas of a workload, status of a Job, Node, Service, claim or Event, the conditions of other kinds.
    #[serde(default)]
    pub summary: bool,
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

async fn get_access(call: ToolCall, args: ClusterArgs) -> ToolResult {
    let cluster = call.target(
        &args.cluster,
        &summary("get_access", "agent access rules".to_owned()),
    )?;
    let ctx = call.ctx();
    let settings = ctx.settings.get();
    let stored = settings.clusters.get(&cluster.id.0);
    let access = stored.map(|s| s.agent_access.clone()).unwrap_or_default();
    let rules: Vec<Value> = access::rules_in_force(&access)
        .iter()
        .map(|rule| {
            json!({
                "namespaces": match &rule.namespaces {
                    NamespaceScope::All => json!("all"),
                    NamespaceScope::Only { namespaces } => json!(namespaces),
                },
                "kinds": match &rule.kinds {
                    KindScope::All => json!("all"),
                    KindScope::Only { kinds } => json!(kinds
                        .iter()
                        .map(|k| json!({ "apiGroup": k.group, "kind": k.kind }))
                        .collect::<Vec<_>>()),
                },
                "actions": rule.actions,
                "askFirst": rule.confirm
                    && rule.actions.iter().any(|a| a.can_ask()),
            })
        })
        .collect();
    // Hints only where the agent may read something: a namespace outside its rules is not named.
    let readable = |ns: &str| access::allows_somewhere(&access, Some(ns), AccessAction::Read);
    let context_namespace = ctx
        .cluster_list()
        .into_iter()
        .find(|c| c.id == cluster.id)
        .and_then(|c| c.namespace)
        .filter(|ns| readable(ns));
    let known: Vec<String> = stored
        .and_then(|s| s.known_namespaces.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|ns| readable(ns))
        .collect();
    Ok(ToolOutput::Json(json!({
        "cluster": cluster.id,
        "preset": access.preset,
        "rules": rules,
        "contextNamespace": context_namespace,
        "knownNamespaces": known,
        "note": "An action is allowed on an object when a rule covers its namespace (\"all\" also covers objects \
                 without a namespace, such as Nodes), its kind and the action. \"secretValues\" — values of Secrets \
                 and of Helm releases — comes only from a rule that names it. Rules with askFirst wait for the \
                 user's approval.",
    })))
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
    let fields = match (&args.fields, args.summary) {
        (Some(_), true) => return Err(invalid("give `fields` or `summary`, not both").into()),
        (Some(fields), false) => Some(projection::parse_fields(
            &kind.kind_ref.group,
            name,
            fields,
        )?),
        (None, _) => None,
    };
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

    let asked = namespace.is_some();
    let (items, truncated, over) = match scope {
        NamespaceScope::All => match list(None, limit).await {
            Ok(page) => (page.items, page.truncated, None),
            Err(e) if is_forbidden(&e) => {
                let tried = fallback_namespaces(&call, &cluster, &pattern, e)?;
                let each = list_each(&tried, limit as usize, false, |ns, left| {
                    let page = list(Some(ns), u32::try_from(left).unwrap_or(limit));
                    async move { page.await.map(|p| (p.items, p.truncated)) }
                })
                .await?;
                (
                    each.items,
                    each.truncated,
                    Some((tried, each.refused, true)),
                )
            }
            Err(e) => return Err(e.into()),
        },
        NamespaceScope::Only { namespaces } => {
            let each = list_each(&namespaces, limit as usize, asked, |ns, left| {
                let page = list(Some(ns), u32::try_from(left).unwrap_or(limit));
                async move { page.await.map(|p| (p.items, p.truncated)) }
            })
            .await?;
            (
                each.items,
                each.truncated,
                Some((namespaces, each.refused, false)),
            )
        }
    };
    // A projection reads the object as the agent would get it whole: after `compact`.
    let items: Vec<Value> = items
        .into_iter()
        .map(compact)
        .map(|obj| match &fields {
            Some(fields) => projection::project(&obj, fields),
            None if args.summary => projection::summarize(&kind.kind_ref.group, name, &obj),
            None => obj,
        })
        .collect();
    let mut out = json!({
        "apiVersion": api_version(&kind.kind_ref),
        "kind": name,
        "count": items.len(),
        "truncated": truncated,
        "items": items,
    });
    if let Some((namespaces, refused, fallback)) = over.filter(|_| !asked) {
        tell_namespaces(&mut out, namespaces, refused, fallback);
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
    // A Secret's values, and secret material other kinds hold inline (ADR-0120, ADR-0121, ADR-0123), only with
    // "Secret values".
    let holds_values = is_secret(&kind.kind_ref)
        || inline_secrets::has_inline_secrets(&kind.kind_ref.group, &kind.kind_ref.kind);
    let with_values = holds_values
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
    Ok(ToolOutput::Json(if with_values {
        compact_with_values(value)
    } else {
        compact(value)
    }))
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

    // Over all namespaces read one by one: which, which the cluster refused, and whether in place of a refused
    // cluster-wide list.
    let mut over: Option<(Vec<String>, Vec<String>, bool)> = None;
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
            let scope =
                call.guard
                    .allowed_namespaces(&cluster, &event, AccessAction::Read, &summary)?;
            // The cluster-wide answer, or the namespaces to read one by one instead.
            let (namespaces, cluster_wide) = match scope {
                NamespaceScope::All => {
                    match read(
                        "reading events",
                        resources::events(mgr, &cluster.id, None, None, limit),
                    )
                    .await
                    {
                        Ok(events) => (None, events),
                        Err(e) if is_forbidden(&e) => (
                            Some((fallback_namespaces(&call, &cluster, &event, e)?, true)),
                            Vec::new(),
                        ),
                        Err(e) => return Err(e.into()),
                    }
                }
                NamespaceScope::Only { namespaces } => (Some((namespaces, false)), Vec::new()),
            };
            match namespaces {
                None => cluster_wide,
                Some((namespaces, fallback)) => {
                    // Each namespace's newest `limit`, then the newest `limit` of them all.
                    let id = &cluster.id;
                    let each = list_each(&namespaces, usize::MAX, false, |ns, _| async move {
                        read(
                            "reading events",
                            resources::events(mgr, id, Some(&ns), None, limit),
                        )
                        .await
                        .map(|events| (events, false))
                    })
                    .await?;
                    let mut all = each.items;
                    all.sort_by_key(|e| std::cmp::Reverse(last_seen(e)));
                    all.truncate(limit as usize);
                    over = Some((namespaces, each.refused, fallback));
                    all
                }
            }
        }
    };
    let events: Vec<Value> = events.iter().map(compact_event).collect();
    let mut out = json!({ "count": events.len(), "events": events });
    if let Some((namespaces, refused, fallback)) = over {
        tell_namespaces(&mut out, namespaces, refused, fallback);
    }
    Ok(ToolOutput::Json(out))
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
            let usage = |namespaces: Option<Vec<String>>| {
                read(
                    "reading pod usage",
                    metrics::pod_usage(&ctx.clusters, &cluster.id, &settings, namespaces),
                )
            };
            let (asked, scope) = match non_empty(args.namespace.as_deref()) {
                Some(ns) => {
                    let summary = summary("get_metrics", format!("Pod usage in namespace {ns}"));
                    call.guard
                        .check(
                            &cluster,
                            &[need(Some(ns), &pod, AccessAction::Read)],
                            &summary,
                        )
                        .await?;
                    (
                        true,
                        NamespaceScope::Only {
                            namespaces: vec![ns.to_owned()],
                        },
                    )
                }
                None => {
                    let summary = summary("get_metrics", "Pod usage in all namespaces".to_owned());
                    let scope = call.guard.allowed_namespaces(
                        &cluster,
                        &pod,
                        AccessAction::Read,
                        &summary,
                    )?;
                    (false, scope)
                }
            };
            let (namespaces, fallback) = match scope {
                NamespaceScope::All => match usage(None).await {
                    Ok(pods) => return Ok(ToolOutput::Json(json!({ "pods": pods }))),
                    Err(e) if is_forbidden(&e) => {
                        (fallback_namespaces(&call, &cluster, &pod, e)?, true)
                    }
                    Err(e) => return Err(e.into()),
                },
                NamespaceScope::Only { namespaces } => (namespaces, false),
            };
            let each = list_each(&namespaces, usize::MAX, asked, |ns, _| {
                let read = usage(Some(vec![ns]));
                async move { read.await.map(|pods| (pods, false)) }
            })
            .await?;
            let mut out = json!({ "pods": each.items });
            if !asked {
                tell_namespaces(&mut out, namespaces, each.refused, fallback);
            }
            Ok(ToolOutput::Json(out))
        }
    }
}

async fn helm_list_releases(call: ToolCall, args: HelmListArgs) -> ToolResult {
    let cluster = call.open(&args.cluster).await?;
    let release = KindPattern::helm_release();
    let mgr = &call.ctx().clusters;
    let releases = |namespaces: Option<Vec<String>>| {
        read(
            "listing Helm releases",
            helm::list_releases(mgr, &cluster.id, namespaces),
        )
    };
    let (asked, scope) = match non_empty(args.namespace.as_deref()) {
        Some(ns) => {
            let summary = summary("helm_list_releases", format!("Release in namespace {ns}"));
            call.guard
                .check(
                    &cluster,
                    &[need(Some(ns), &release, AccessAction::Read)],
                    &summary,
                )
                .await?;
            (
                true,
                NamespaceScope::Only {
                    namespaces: vec![ns.to_owned()],
                },
            )
        }
        None => {
            let summary = summary("helm_list_releases", "Release in all namespaces".to_owned());
            let scope =
                call.guard
                    .allowed_namespaces(&cluster, &release, AccessAction::Read, &summary)?;
            (false, scope)
        }
    };
    let (namespaces, fallback) = match scope {
        NamespaceScope::All => match releases(None).await {
            Ok(list) => return Ok(ToolOutput::Json(json!({ "releases": list }))),
            Err(e) if is_forbidden(&e) => {
                (fallback_namespaces(&call, &cluster, &release, e)?, true)
            }
            Err(e) => return Err(e.into()),
        },
        NamespaceScope::Only { namespaces } => (namespaces, false),
    };
    let each = list_each(&namespaces, usize::MAX, asked, |ns, _| {
        let read = releases(Some(vec![ns]));
        async move { read.await.map(|list| (list, false)) }
    })
    .await?;
    let mut out = json!({ "releases": each.items });
    if !asked {
        tell_namespaces(&mut out, namespaces, each.refused, fallback);
    }
    Ok(ToolOutput::Json(out))
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
/// The most namespaces a call over all namespaces lists one by one when the cluster-wide list is refused.
pub const MAX_FALLBACK_NAMESPACES: usize = 20;

/// Whether the API server refused a request for lack of permission.
fn is_forbidden(error: &CoreError) -> bool {
    error.code == ErrorCode::Forbidden
}

/// The namespaces to list one by one when the API server refuses a list over all namespaces (the user may not list
/// at cluster scope, ADR-0124): the kubeconfig context's namespace, then the known namespaces of the cluster settings,
/// each one the agent may read `pattern` in, at most [`MAX_FALLBACK_NAMESPACES`]. None: the refusal, with where to
/// go from there.
fn fallback_namespaces(
    call: &ToolCall,
    cluster: &ClusterTarget,
    pattern: &KindPattern,
    refusal: CoreError,
) -> Result<Vec<String>, CoreError> {
    let ctx = call.ctx();
    let settings = ctx.settings.get();
    let stored = settings.clusters.get(&cluster.id.0);
    let access = stored.map(|s| s.agent_access.clone()).unwrap_or_default();
    let context = ctx
        .cluster_list()
        .into_iter()
        .find(|c| c.id == cluster.id)
        .and_then(|c| c.namespace);
    let known = stored
        .and_then(|s| s.known_namespaces.clone())
        .unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for ns in context.into_iter().chain(known) {
        let ns = ns.trim().to_owned();
        if ns.is_empty() || out.contains(&ns) {
            continue;
        }
        if access::decide(&access, Some(&ns), pattern, AccessAction::Read).is_allowed() {
            out.push(ns);
        }
        if out.len() == MAX_FALLBACK_NAMESPACES {
            break;
        }
    }
    if out.is_empty() {
        return Err(CoreError::new(
            refusal.code,
            format!(
                "{} — the user may not list it over all namespaces, and Sextant knows no namespace to list instead. \
                 Pass a namespace; get_access names the ones the user works in, and the user can add them in Sextant \
                 (the cluster's settings → Connection → Accessible namespaces).",
                refusal.message
            ),
        ));
    }
    Ok(out)
}

/// What [`list_each`] read.
struct Each<T> {
    items: Vec<T>,
    truncated: bool,
    /// The namespaces the API server refused.
    refused: Vec<String>,
}

/// Lists `namespaces` one by one, up to `limit` items in all (`list` gets the namespace and how many are still
/// wanted, and returns the items and whether it left some out). A namespace the API server refuses goes to `refused`
/// and the others are still read, unless `strict` (the agent asked for that namespace by name): then the refusal
/// is the answer.
async fn list_each<T, F, Fut>(
    namespaces: &[String],
    limit: usize,
    strict: bool,
    mut list: F,
) -> CoreResult<Each<T>>
where
    F: FnMut(String, usize) -> Fut,
    Fut: std::future::Future<Output = CoreResult<(Vec<T>, bool)>>,
{
    let mut each = Each {
        items: Vec::new(),
        truncated: false,
        refused: Vec::new(),
    };
    for (i, ns) in namespaces.iter().enumerate() {
        let left = limit.saturating_sub(each.items.len());
        if left == 0 {
            each.truncated = i < namespaces.len();
            break;
        }
        match list(ns.clone(), left).await {
            Ok((items, truncated)) => {
                each.truncated |= truncated;
                each.items.extend(items);
            }
            Err(e) if !strict && is_forbidden(&e) => each.refused.push(ns.clone()),
            Err(e) => return Err(e),
        }
    }
    Ok(each)
}

/// Says over which namespaces a call over all of them read: the ones of the agent's rules, or (`fallback`) the ones
/// listed because the cluster-wide list was refused; `refused` — the API server refused these too.
fn tell_namespaces(out: &mut Value, namespaces: Vec<String>, refused: Vec<String>, fallback: bool) {
    let read: Vec<&String> = namespaces
        .iter()
        .filter(|ns| !refused.contains(ns))
        .collect();
    out["namespaces"] = json!(read);
    if !refused.is_empty() {
        out["refused"] = json!(refused);
    }
    out["note"] = json!(if fallback {
        "The cluster refused the list over all namespaces (the user may not list at cluster scope); listed instead \
         in the namespaces Sextant knows the user works in (the context's and the known ones). Other namespaces \
         may hold more. `refused`: the cluster refused these too."
    } else if refused.is_empty() {
        "only the namespaces the agent may read"
    } else {
        "only the namespaces the agent may read; `refused`: the cluster refused these (the user's own permissions)"
    });
}

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

/// An object as an agent gets it without "Secret values": [`compact_with_values`], and the secret material its kind
/// holds inline emptied ([`inline_secrets::hide_inline_secrets`]; a Secret's values are already gone in the core).
pub(super) fn compact(value: Value) -> Value {
    let mut value = compact_with_values(value);
    inline_secrets::hide_inline_secrets(&mut value);
    value
}

/// An object without what only takes room: `managedFields` (already gone) and the last-applied manifest.
fn compact_with_values(mut value: Value) -> Value {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> Value {
        json!({
            "apiVersion": "v1", "kind": "Node",
            "metadata": { "name": "server-0", "managedFields": [{}], "annotations": {
                "k3s.io/node-args": "[\"server\",\"--token\",\"K10s3cret\"]",
                LAST_APPLIED: "{}",
                "k3s.io/node-config-hash": "ABC",
            } },
        })
    }

    #[test]
    fn an_agent_gets_inline_secret_material_only_with_secret_values() {
        let hidden = compact(node());
        assert!(!hidden.to_string().contains("s3cret"), "{hidden}");
        let annotations = &hidden["metadata"]["annotations"];
        assert_eq!(annotations["k3s.io/node-args"], "");
        assert_eq!(annotations["k3s.io/node-config-hash"], "ABC");
        assert!(annotations.get(LAST_APPLIED).is_none());
        assert!(hidden["metadata"].get("managedFields").is_none());

        let kept = compact_with_values(node());
        assert!(kept.to_string().contains("s3cret"));
        assert!(kept["metadata"]["annotations"].get(LAST_APPLIED).is_none());
        assert!(kept["metadata"].get("managedFields").is_none());
    }
}
