//! What AI agents (the MCP server, `crate::mcp::guard`) and extensions (`crate::extensions::api`) share when their
//! calls are checked against access rules: the confirmation dialog with one pending map ([`confirm`]), the journals
//! ([`audit`]), and the pieces of a check — requirements, kind lookups, the namespace the rules see, refusal wording.
//!
//! The rules themselves differ (a cluster's `agentAccess` for agents, what was granted at install for an extension),
//! and so do the texts of refusals; each guard keeps its own.

pub mod audit;
pub mod confirm;

use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::Value;
use sextant_core::access::{AccessAction, KindPattern};
use sextant_core::error::with_timeout;
use sextant_core::node_shell;
use sextant_core::resources::{self, KindRef, ObjectRef};
use sextant_core::{ClusterId, ClusterManager, CoreError, CoreResult, ErrorCode};

use audit::AuditDecision;

/// What a call needs: (namespace, kind, action). `None` (or `""`) — no namespace, or all namespaces at once.
pub type Requirement = (Option<String>, KindPattern, AccessAction);

/// What a call is about, for the confirmation dialog, the journal and refusals.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallSummary {
    /// The tool (`delete_resource`) or the extension's method (`resources.delete`).
    pub tool: String,
    /// What it acts on, e.g. `Pod team-a/web-1`, `Pod in namespace team-a`, `Node worker-1`.
    pub target: String,
    /// Shown in the confirmation dialog only: YAML, a command, a port.
    pub details: Option<String>,
}

/// The action as refusals name it.
pub fn action_name(action: AccessAction) -> &'static str {
    match action {
        AccessAction::Read => "read",
        AccessAction::Modify => "modify",
        AccessAction::Delete => "delete",
        AccessAction::Logs => "logs",
        AccessAction::Exec => "exec",
        AccessAction::PortForward => "port forward",
        AccessAction::SecretValues => "secret values",
    }
}

/// Whether objects of a kind have a namespace; `None` when the kind cannot be looked up.
pub trait KindLookup: Send + Sync + 'static {
    fn namespaced<'a>(
        &'a self,
        cluster: &'a ClusterId,
        kind: &'a KindPattern,
    ) -> BoxFuture<'a, Option<bool>>;
}

/// The kinds the cluster really serves (`resources::resolve`); Helm releases live in namespaces.
pub struct ClusterKinds(pub ClusterManager);

impl KindLookup for ClusterKinds {
    fn namespaced<'a>(
        &'a self,
        cluster: &'a ClusterId,
        kind: &'a KindPattern,
    ) -> BoxFuture<'a, Option<bool>> {
        Box::pin(async move {
            if kind == &KindPattern::helm_release() {
                return Some(true);
            }
            let kind_ref = KindRef {
                group: kind.group.clone(),
                version: String::new(),
                kind: kind.kind.clone(),
            };
            resources::resolve(&self.0, cluster, &kind_ref)
                .await
                .ok()
                .map(|k| k.namespaced)
        })
    }
}

/// The namespace the rules see: only for a kind known to have namespaces, never `""`. A cluster-scoped kind, or one
/// that cannot be looked up, goes as "no namespace", which only rules for all namespaces cover — whatever namespace
/// the caller sent.
pub async fn effective_namespace(
    kinds: &dyn KindLookup,
    cluster: &ClusterId,
    namespace: Option<&str>,
    kind: &KindPattern,
) -> Option<String> {
    let namespace = namespace.filter(|ns| !ns.is_empty())?;
    match kinds.namespaced(cluster, kind).await {
        Some(true) => Some(namespace.to_owned()),
        _ => None,
    }
}

/// What a refusal names: the call's target when it is about this kind, else the kind and where.
pub fn refused_object(target: &str, namespace: Option<&str>, kind: &KindPattern) -> String {
    let about_kind = target
        .split_whitespace()
        .next()
        .is_some_and(|first| first.eq_ignore_ascii_case(&kind.kind));
    if about_kind {
        return target.to_owned();
    }
    match namespace {
        Some(ns) => format!("{} in namespace {ns}", kind.kind),
        None => format!("{} in all namespaces", kind.kind),
    }
}

/// The decision a journal keeps for a call: a refusal over an approval over a plain allow.
pub fn stronger(old: Option<AuditDecision>, new: AuditDecision) -> AuditDecision {
    let rank = |d: AuditDecision| match d {
        AuditDecision::Allowed => 0,
        AuditDecision::Approved => 1,
        AuditDecision::Denied | AuditDecision::Declined | AuditDecision::TimedOut => 2,
    };
    match old {
        Some(old) if rank(old) > rank(new) => old,
        _ => new,
    }
}

/// How long reading a pod to make sure it is not a node shell may take.
pub const NODE_SHELL_READ_TIMEOUT: Duration = Duration::from_secs(30);

fn is_pod(kind: &KindRef) -> bool {
    kind.group.is_empty() && kind.kind.eq_ignore_ascii_case("Pod")
}

/// Before the access check: a pod named like a node shell (`sextant-node-shell-…` in `kube-system`; a name cannot
/// change) or, for an apply, a pod document that is one ([`node_shell::is_node_shell_object`]). Refused (`denied`,
/// with `refusal` as the text) without asking the user and without reading the cluster. Other kinds pass.
pub fn refuse_named_node_shell(
    object: &ObjectRef,
    document: Option<&Value>,
    refusal: &str,
) -> CoreResult<()> {
    if !is_pod(&object.kind) {
        return Ok(());
    }
    let named = node_shell::is_node_shell_name(object.namespace.as_deref(), &object.name);
    if named || document.is_some_and(node_shell::is_node_shell_object) {
        return Err(CoreError::new(ErrorCode::Denied, refusal));
    }
    Ok(())
}

/// After the access check, right before acting on a pod: the pod as the cluster has it now. A node shell (by name or
/// by any of its labels) is refused with `refusal`; so is a pod that cannot be read (fail closed) — except, for an
/// apply (`creates`), one that does not exist yet: it is made from the document [`refuse_named_node_shell`] checked.
/// Read after the check, so a caller learns nothing about pods the rules keep from it. Other kinds pass.
pub async fn refuse_live_node_shell(
    clusters: &ClusterManager,
    cluster: &ClusterId,
    object: &ObjectRef,
    creates: bool,
    refusal: &str,
) -> CoreResult<()> {
    if !is_pod(&object.kind) {
        return Ok(());
    }
    let live = with_timeout(
        NODE_SHELL_READ_TIMEOUT,
        "reading the pod",
        resources::get(clusters, cluster, object),
    )
    .await;
    match live {
        Ok(pod) if node_shell::is_node_shell_object(&pod) => {
            Err(CoreError::new(ErrorCode::Denied, refusal))
        }
        Ok(_) => Ok(()),
        Err(e) if creates && e.code == ErrorCode::NotFound => Ok(()),
        Err(e) => {
            let what = match object.namespace.as_deref().filter(|ns| !ns.is_empty()) {
                Some(ns) => format!("{} {ns}/{}", object.kind.kind, object.name),
                None => format!("{} {}", object.kind.kind, object.name),
            };
            Err(CoreError::new(
                e.code,
                format!(
                    "Sextant could not read {what} to make sure it is not a node shell, so nothing was done: {}",
                    e.message
                ),
            ))
        }
    }
}

/// Milliseconds since the Unix epoch, for journal entries.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}
