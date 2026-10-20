//! The one place an agent's call is checked against the cluster's access rules (`sextant_core::access`), asked
//! about in the window when a rule wants that, and noted for the journal.
//!
//! Every check reads fresh settings, so a changed rule (or access turned off) applies to the next call without a
//! restart. A namespace counts only for kinds that have one: for a cluster-scoped kind (Node, Namespace, CRD, …), or a
//! kind that cannot be looked up, the check goes as "no namespace", which only rules for all namespaces cover —
//! whatever namespace the agent sent. An empty namespace is no namespace too.

use std::fmt;
use std::sync::{Arc, Mutex};

use sextant_core::access::{
    self, AccessAction, AccessPreset, ClusterAccess, Decision, KindPattern, NamespaceScope,
};
use sextant_core::{ClusterId, ConnectionState, CoreError, ErrorCode};
use tokio_util::sync::CancellationToken;

pub use crate::access_guard::{CallSummary, ClusterKinds, KindLookup, Requirement, action_name};
use crate::access_guard::{effective_namespace, refused_object, stronger};

use super::audit::{AuditDecision, clip};
use super::confirm::{CONFIRM_TIMEOUT, ConfirmOutcome, ConfirmRequest, ConfirmSource};
use super::context::{McpContext, McpEvent};

/// Why a call does not run. Its text goes to the agent as the tool's error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// No rule covers it.
    Denied {
        action: AccessAction,
        /// e.g. `Pod team-a/web-1`, or `Pod in all namespaces`.
        object: String,
        cluster: String,
    },
    /// The user denied it in the window.
    Declined {
        tool: String,
        target: String,
        cluster: String,
    },
    /// Nobody answered in the window.
    TimedOut {
        tool: String,
        target: String,
        cluster: String,
    },
    /// AI agent access to the cluster is Off.
    ClusterOff { cluster: String },
    /// The MCP server stopped (turned off, restarted, window closed) after the call began.
    Stopped,
}

const WHERE_TO_ALLOW: &str =
    "The user can allow it in Sextant → cluster settings → AI agent access.";

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::Denied {
                action,
                object,
                cluster,
            } => write!(
                f,
                "Sextant denied {} on {object} in cluster {cluster}. {WHERE_TO_ALLOW}",
                action_name(*action)
            ),
            Refusal::Declined {
                tool,
                target,
                cluster,
            } => write!(
                f,
                "The user declined {tool} on {} in cluster {cluster}.",
                or_cluster(target)
            ),
            Refusal::TimedOut {
                tool,
                target,
                cluster,
            } => write!(
                f,
                "No answer from the user in {} s: {tool} on {} in cluster {cluster} was not run.",
                CONFIRM_TIMEOUT.as_secs(),
                or_cluster(target)
            ),
            Refusal::Stopped => f.write_str(
                "Sextant's MCP server stopped (turned off, restarted or closed) while this call was waiting; nothing \
                 was run.",
            ),
            Refusal::ClusterOff { cluster } => write!(
                f,
                "Sextant denied access to cluster {cluster}: AI agent access to it is off. {WHERE_TO_ALLOW}"
            ),
        }
    }
}

fn or_cluster(target: &str) -> &str {
    if target.is_empty() {
        "the cluster"
    } else {
        target
    }
}

/// A cluster a call works with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClusterTarget {
    pub id: ClusterId,
    /// The name the user sees.
    pub name: String,
}

/// What the journal learns about a call while it runs.
#[derive(Debug, Clone, Default)]
pub struct CallRecord {
    pub cluster: Option<ClusterTarget>,
    pub target: String,
    pub decision: Option<AuditDecision>,
    /// A check let the call act: from then on a stop does not undo the decision, and the call may have run.
    pub passed: bool,
    /// A passed check was for more than reading (Read, Logs): a stop from then on may leave a change half done.
    pub changes: bool,
    /// The call was a dry run ([`Guard::check_dry_run`]): journaled as `<tool> (dry run)`.
    pub dry_run: bool,
}

/// Checks one call. Made per call with the client's name; [`Guard::record`] gives what it learned.
pub struct Guard {
    ctx: Arc<McpContext>,
    kinds: Arc<dyn KindLookup>,
    /// Cancelled when the server the call came through stops: from then on every check refuses.
    stopped: CancellationToken,
    client: String,
    /// The MCP session the call came through (its client's name when not known): the diagnostic tools' waiting cap
    /// is per session.
    session: String,
    tool: String,
    record: Arc<Mutex<CallRecord>>,
}

/// Why a cluster cannot be used.
#[derive(Debug, Clone, PartialEq)]
pub enum OpenError {
    Refused(Refusal),
    Failed(CoreError),
}

impl Guard {
    /// `stopped` — the token of the server the call came through; `client` is cut to [`MAX_TEXT_CHARS`].
    pub fn new(
        ctx: Arc<McpContext>,
        kinds: Arc<dyn KindLookup>,
        stopped: CancellationToken,
        client: impl Into<String>,
        tool: impl Into<String>,
    ) -> Self {
        let client = clip(&client.into());
        Self {
            ctx,
            kinds,
            stopped,
            session: client.clone(),
            client,
            tool: tool.into(),
            record: Arc::new(Mutex::new(CallRecord::default())),
        }
    }

    /// The call came through MCP session `session`.
    pub fn in_session(mut self, session: impl Into<String>) -> Self {
        self.session = session.into();
        self
    }

    pub fn client(&self) -> &str {
        &self.client
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    pub fn context(&self) -> &Arc<McpContext> {
        &self.ctx
    }

    /// What the journal should say about this call so far.
    pub fn record(&self) -> CallRecord {
        self.lock().clone()
    }

    /// The record itself, readable after the guard is gone (the call that owned it ended).
    pub fn record_handle(&self) -> Arc<Mutex<CallRecord>> {
        Arc::clone(&self.record)
    }

    /// Finds the cluster the agent named (id, context or display name), refuses it when access is Off and connects
    /// it when it is not connected (like the Connect button).
    pub async fn open(&self, cluster: &str) -> Result<ClusterTarget, OpenError> {
        let target = self.find(cluster).map_err(OpenError::Failed)?;
        self.lock().cluster = Some(target.clone());
        self.access(&target).map_err(OpenError::Refused)?;
        let connected = matches!(
            self.ctx.clusters.state(&target.id),
            ConnectionState::Connected
        );
        if !connected {
            self.ctx
                .clusters
                .connect(&target.id)
                .await
                .map_err(OpenError::Failed)?;
        }
        self.running().map_err(OpenError::Refused)?;
        Ok(target)
    }

    /// The cluster's access rules from fresh settings; Off is refused. Notes the call as allowed unless a check
    /// already decided otherwise.
    pub fn access(&self, cluster: &ClusterTarget) -> Result<ClusterAccess, Refusal> {
        self.running()?;
        let access = self.read_access(&cluster.id);
        if access.preset == AccessPreset::Off {
            self.decide(AuditDecision::Denied);
            return Err(Refusal::ClusterOff {
                cluster: cluster.name.clone(),
            });
        }
        self.decide(AuditDecision::Allowed);
        Ok(access)
    }

    /// Checks every requirement of a call (all must be allowed) and, when any covering rule asks for it, waits for
    /// the user's answer in the window.
    pub async fn check(
        &self,
        cluster: &ClusterTarget,
        requirements: &[Requirement],
        summary: &CallSummary,
    ) -> Result<(), Refusal> {
        let target = clip(&summary.target);
        self.lock().target = target.clone();
        let confirm = self.decide_all(cluster, requirements, summary).await?;
        let changes = requirements
            .iter()
            .any(|(_, _, action)| !reads_only(*action));
        if !confirm {
            self.pass(changes);
            return Ok(());
        }
        let request = ConfirmRequest {
            id: String::new(),
            source: ConfirmSource::Agent,
            principal: self.client.clone(),
            client: self.client.clone(),
            cluster_id: cluster.id.clone(),
            cluster_name: cluster.name.clone(),
            tool: summary.tool.clone(),
            target: target.clone(),
            details: summary.details.clone(),
        };
        let ctx = Arc::clone(&self.ctx);
        let outcome = self
            .ctx
            .confirmations
            .ask(request, move |r| ctx.emit(McpEvent::Confirm(r.clone())))
            .await;
        // Stopped while the dialog was open (it was declined then) or right after the answer.
        self.running()?;
        let refused = |decision| {
            self.decide(decision);
            (summary.tool.clone(), target.clone(), cluster.name.clone())
        };
        match outcome {
            ConfirmOutcome::Approved => {
                self.decide(AuditDecision::Approved);
                self.pass(changes);
                Ok(())
            }
            ConfirmOutcome::Declined => {
                let (tool, target, cluster) = refused(AuditDecision::Declined);
                Err(Refusal::Declined {
                    tool,
                    target,
                    cluster,
                })
            }
            ConfirmOutcome::TimedOut => {
                let (tool, target, cluster) = refused(AuditDecision::TimedOut);
                Err(Refusal::TimedOut {
                    tool,
                    target,
                    cluster,
                })
            }
        }
    }

    /// The check of a dry run (`dryRun: true` of `apply_yaml` and `patch_resource`, #141): the same requirements as
    /// the real call and the same rules, but never a question in the window — nothing is changed, so a rule that asks
    /// before the change still lets its dry run through. The journal names the call as a dry run.
    pub async fn check_dry_run(
        &self,
        cluster: &ClusterTarget,
        requirements: &[Requirement],
        summary: &CallSummary,
    ) -> Result<(), Refusal> {
        {
            let mut record = self.lock();
            record.target = clip(&summary.target);
            record.dry_run = true;
        }
        self.decide_all(cluster, requirements, summary).await?;
        // Only reads the cluster: a stop from now on leaves nothing half done.
        self.pass(false);
        Ok(())
    }

    /// Checks every requirement against fresh rules; whether any covering rule asks the user. A refusal is journaled.
    async fn decide_all(
        &self,
        cluster: &ClusterTarget,
        requirements: &[Requirement],
        summary: &CallSummary,
    ) -> Result<bool, Refusal> {
        let access = self.access(cluster)?;
        let mut confirm = false;
        for (namespace, kind, action) in requirements {
            let namespace = self.effective_namespace(cluster, namespace, kind).await;
            match access::decide(&access, namespace.as_deref(), kind, *action) {
                Decision::Allowed { confirm: ask } => confirm |= ask,
                Decision::Denied => {
                    self.decide(AuditDecision::Denied);
                    return Err(Refusal::Denied {
                        action: *action,
                        object: object(summary, namespace.as_deref(), kind),
                        cluster: cluster.name.clone(),
                    });
                }
            }
        }
        // The kind lookup may have waited: the server may have stopped meanwhile.
        self.running()?;
        Ok(confirm)
    }

    /// Whether the rules allow `action` without asking anything — for optional extras of a call (the values of a
    /// Secret the agent reads anyway); never asks the user and never refuses the call.
    pub async fn allows(
        &self,
        cluster: &ClusterTarget,
        namespace: Option<&str>,
        kind: &KindPattern,
        action: AccessAction,
    ) -> bool {
        if self.stopped.is_cancelled() {
            return false;
        }
        let access = self.read_access(&cluster.id);
        let namespace = self
            .effective_namespace(cluster, &namespace.map(str::to_owned), kind)
            .await;
        access::decide(&access, namespace.as_deref(), kind, action)
            == Decision::Allowed { confirm: false }
    }

    /// Namespaces where `action` on `kind` is allowed, for a call over all namespaces (list, events, metrics): `All`,
    /// or the namespaces of the covering rules. Nowhere is a refusal. A call narrowed to some namespaces is
    /// journaled with them (`Pod in namespaces a, b`), not as "in all namespaces".
    pub fn allowed_namespaces(
        &self,
        cluster: &ClusterTarget,
        kind: &KindPattern,
        action: AccessAction,
        summary: &CallSummary,
    ) -> Result<NamespaceScope, Refusal> {
        self.lock().target = clip(&summary.target);
        let access = self.access(cluster)?;
        let scope = access::allowed_namespaces(&access, kind, action);
        if matches!(&scope, NamespaceScope::Only { namespaces } if namespaces.is_empty()) {
            self.decide(AuditDecision::Denied);
            return Err(Refusal::Denied {
                action,
                object: object(summary, None, kind),
                cluster: cluster.name.clone(),
            });
        }
        if let NamespaceScope::Only { namespaces } = &scope {
            self.lock().target = clip(&narrowed_target(&summary.target, kind, namespaces));
        }
        self.pass(!reads_only(action));
        Ok(scope)
    }

    /// The check of a diagnostic tool over a namespace or the whole cluster (ADR-0094): some Read rule must cover
    /// `namespace` (for `None`, any Read rule at all), else the call is refused. Gives the Read rules in force, which
    /// tell the window what it may feed its engines; the answer is filtered again object by object.
    pub fn check_reads(
        &self,
        cluster: &ClusterTarget,
        namespace: Option<&str>,
        summary: &CallSummary,
    ) -> Result<Vec<access::AccessRule>, Refusal> {
        self.lock().target = clip(&summary.target);
        let access = self.access(cluster)?;
        let namespace = namespace.filter(|ns| !ns.trim().is_empty());
        if !access::allows_somewhere(&access, namespace, AccessAction::Read) {
            self.decide(AuditDecision::Denied);
            return Err(Refusal::Denied {
                action: AccessAction::Read,
                object: match namespace {
                    Some(ns) => format!("objects in namespace {ns}"),
                    None => "objects of any kind".to_owned(),
                },
                cluster: cluster.name.clone(),
            });
        }
        self.pass(false);
        Ok(access::rules_with(&access, AccessAction::Read))
    }

    /// How the call looks up whether a kind has namespaces (for filtering objects by the rules).
    pub fn kinds(&self) -> Arc<dyn KindLookup> {
        Arc::clone(&self.kinds)
    }

    /// A check let the call act; `changes` — for more than reading.
    fn pass(&self, changes: bool) {
        let mut record = self.lock();
        record.passed = true;
        record.changes |= changes;
    }

    fn find(&self, cluster: &str) -> Result<ClusterTarget, CoreError> {
        let clusters = self.ctx.cluster_list();
        let wanted = cluster.trim();
        let by_id = clusters.iter().find(|c| c.id.0 == wanted);
        let found = match by_id {
            Some(c) => c.id.clone(),
            None => {
                let named: Vec<&ClusterId> = clusters
                    .iter()
                    .filter(|c| c.context == wanted || self.ctx.cluster_name(&c.id) == wanted)
                    .map(|c| &c.id)
                    .collect();
                match named.as_slice() {
                    [one] => (*one).clone(),
                    [] => {
                        return Err(CoreError::new(
                            ErrorCode::NotFound,
                            format!("no cluster {wanted:?}; list_clusters gives the ids"),
                        ));
                    }
                    _ => {
                        return Err(CoreError::new(
                            ErrorCode::Invalid,
                            format!(
                                "several clusters are called {wanted:?}; pass the id from list_clusters"
                            ),
                        ));
                    }
                }
            }
        };
        Ok(ClusterTarget {
            name: self.ctx.cluster_name(&found),
            id: found,
        })
    }

    /// Refuses once the server the call came through has stopped; the journal says denied unless an earlier check
    /// of the call already let it act.
    fn running(&self) -> Result<(), Refusal> {
        if self.stopped.is_cancelled() {
            if !self.lock().passed {
                self.decide(AuditDecision::Denied);
            }
            return Err(Refusal::Stopped);
        }
        Ok(())
    }

    fn read_access(&self, cluster: &ClusterId) -> ClusterAccess {
        self.ctx
            .settings
            .get()
            .clusters
            .get(&cluster.0)
            .map(|c| c.agent_access.clone())
            .unwrap_or_default()
    }

    /// The namespace the rules see: only for a kind known to have namespaces, never `""`.
    async fn effective_namespace(
        &self,
        cluster: &ClusterTarget,
        namespace: &Option<String>,
        kind: &KindPattern,
    ) -> Option<String> {
        effective_namespace(&*self.kinds, &cluster.id, namespace.as_deref(), kind).await
    }

    /// Keeps the strongest decision of the call: a refusal over an approval over a plain allow.
    fn decide(&self, decision: AuditDecision) {
        let mut record = self.lock();
        record.decision = Some(stronger(record.decision, decision));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CallRecord> {
        self.record.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The tool this guard checks.
    pub fn tool(&self) -> &str {
        &self.tool
    }
}

/// Whether an action only reads: a call stopped after such a check changed nothing.
fn reads_only(action: AccessAction) -> bool {
    matches!(action, AccessAction::Read | AccessAction::Logs)
}

/// The target of a call over all namespaces once it is narrowed to `namespaces`: `Pod in all namespaces` becomes
/// `Pod in namespaces a, b` (a target without that ending starts with the kind). Not clipped.
pub fn narrowed_target(target: &str, kind: &KindPattern, namespaces: &[String]) -> String {
    let what = target
        .strip_suffix(" in all namespaces")
        .unwrap_or(&kind.kind);
    format!("{what} in namespaces {}", namespaces.join(", "))
}

/// What a refusal names: the call's target when it is about this kind, else the kind and where.
fn object(summary: &CallSummary, namespace: Option<&str>, kind: &KindPattern) -> String {
    refused_object(&summary.target, namespace, kind)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::RwLock;

    use futures::future::BoxFuture;
    use sextant_core::ClusterManager;
    use sextant_core::access::{AccessRule, KindScope};
    use sextant_core::kubeconfig::KubeconfigEnv;
    use sextant_core::portforward::PortForwarder;
    use sextant_core::{ClusterSettings, KubeconfigRegistry, SettingsStore};

    use super::*;

    /// Kinds as a test cluster serves them: `Node` without namespaces, everything else with.
    struct FakeKinds(HashMap<String, bool>);

    impl FakeKinds {
        fn standard() -> Arc<Self> {
            Arc::new(Self(
                [("Node", false), ("Namespace", false), ("Pod", true)]
                    .into_iter()
                    .map(|(k, n)| (k.to_owned(), n))
                    .collect(),
            ))
        }
    }

    impl KindLookup for FakeKinds {
        fn namespaced<'a>(
            &'a self,
            _cluster: &'a ClusterId,
            kind: &'a KindPattern,
        ) -> BoxFuture<'a, Option<bool>> {
            Box::pin(async move { self.0.get(&kind.kind).copied() })
        }
    }

    pub(crate) fn context_in(dir: &Path) -> Arc<McpContext> {
        let settings = Arc::new(SettingsStore::open(dir.join("config/settings.json")));
        let mut registry = KubeconfigRegistry::new(Vec::new(), dir.join("data/kubeconfigs"));
        registry.set_env(KubeconfigEnv {
            kubeconfig: None,
            home: Some(dir.join("home")),
        });
        let registry = Arc::new(RwLock::new(registry));
        Arc::new(McpContext::new(
            Arc::clone(&registry),
            ClusterManager::new(registry),
            Arc::new(PortForwarder::new()),
            settings,
            &dir.join("config"),
            &dir.join("data"),
        ))
    }

    fn set_access(ctx: &McpContext, cluster: &ClusterTarget, access: ClusterAccess) {
        ctx.settings
            .update(|s| {
                s.clusters.insert(
                    cluster.id.0.clone(),
                    ClusterSettings {
                        agent_access: access,
                        ..ClusterSettings::default()
                    },
                );
            })
            .unwrap();
    }

    fn rule(namespaces: &[&str], actions: &[AccessAction], confirm: bool) -> AccessRule {
        AccessRule {
            namespaces: if namespaces.is_empty() {
                NamespaceScope::All
            } else {
                NamespaceScope::Only {
                    namespaces: namespaces.iter().map(|s| s.to_string()).collect(),
                }
            },
            kinds: KindScope::All,
            actions: actions.to_vec(),
            confirm,
        }
    }

    fn custom(rules: Vec<AccessRule>) -> ClusterAccess {
        ClusterAccess {
            preset: AccessPreset::Custom,
            rules,
        }
    }

    fn cluster() -> ClusterTarget {
        ClusterTarget {
            id: ClusterId::from("c1"),
            name: "kind-test".into(),
        }
    }

    fn guard(ctx: &Arc<McpContext>) -> Guard {
        Guard::new(
            Arc::clone(ctx),
            FakeKinds::standard(),
            CancellationToken::new(),
            "claude-code",
            "tool",
        )
    }

    fn summary(tool: &str, target: &str) -> CallSummary {
        CallSummary {
            tool: tool.into(),
            target: target.into(),
            details: None,
        }
    }

    fn need(ns: Option<&str>, kind: &str, action: AccessAction) -> Requirement {
        (ns.map(str::to_owned), KindPattern::new("", kind), action)
    }

    #[tokio::test]
    async fn a_namespace_rule_does_not_cover_a_kind_without_namespaces() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        set_access(
            &ctx,
            &cluster(),
            custom(vec![rule(&["team-a"], &[AccessAction::Delete], false)]),
        );

        let g = guard(&ctx);
        let refused = g
            .check(
                &cluster(),
                &[need(Some("team-a"), "Node", AccessAction::Delete)],
                &summary("delete_resource", "Node worker-1"),
            )
            .await
            .unwrap_err();
        assert_eq!(
            refused.to_string(),
            "Sextant denied delete on Node worker-1 in cluster kind-test. The user can allow it in Sextant → \
             cluster settings → AI agent access."
        );
        assert_eq!(g.record().decision, Some(AuditDecision::Denied));

        // The same rule allows a Pod in team-a, but not in another namespace, and an empty namespace is none.
        let pod = |ns: &str| need(Some(ns), "Pod", AccessAction::Delete);
        let target = summary("delete_resource", "Pod team-a/web");
        assert_eq!(
            guard(&ctx)
                .check(&cluster(), &[pod("team-a")], &target)
                .await,
            Ok(())
        );
        assert!(
            guard(&ctx)
                .check(&cluster(), &[pod("team-b")], &target)
                .await
                .is_err()
        );
        assert!(
            guard(&ctx)
                .check(&cluster(), &[pod("")], &target)
                .await
                .is_err()
        );
        // A kind that cannot be looked up counts as having no namespace.
        let unknown = need(Some("team-a"), "Mystery", AccessAction::Delete);
        assert!(
            guard(&ctx)
                .check(&cluster(), &[unknown], &target)
                .await
                .is_err()
        );
    }

    /// A dry run is decided by the same rules as the change, but never waits for the window: a rule that asks before
    /// the change lets its dry run through at once, and the journal names it as a dry run.
    #[tokio::test]
    async fn a_dry_run_follows_the_rules_without_asking_and_is_journaled_as_one() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        let modify = [need(Some("team-a"), "Pod", AccessAction::Modify)];
        let target = summary("apply_yaml", "Pod team-a/web");

        // Access off and no covering rule refuse a dry run like the change.
        let g = guard(&ctx);
        assert!(g.check_dry_run(&cluster(), &modify, &target).await.is_err());
        assert_eq!(g.record().decision, Some(AuditDecision::Denied));
        set_access(
            &ctx,
            &cluster(),
            custom(vec![rule(&["team-b"], &[AccessAction::Modify], false)]),
        );
        let g = guard(&ctx);
        let refused = g
            .check_dry_run(&cluster(), &modify, &target)
            .await
            .unwrap_err();
        assert!(matches!(refused, Refusal::Denied { .. }), "{refused}");
        assert!(g.record().dry_run);

        // A rule that asks first: the dry run passes without a question.
        set_access(
            &ctx,
            &cluster(),
            custom(vec![rule(&["team-a"], &[AccessAction::Modify], true)]),
        );
        let g = guard(&ctx);
        let checked = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            g.check_dry_run(&cluster(), &modify, &target),
        )
        .await
        .expect("a dry run waited for the window");
        assert_eq!(checked, Ok(()));
        assert_eq!(ctx.confirmations.pending(), 0);
        let record = g.record();
        assert_eq!(record.decision, Some(AuditDecision::Allowed));
        assert!(record.dry_run && record.passed && !record.changes);
        assert_eq!(record.target, "Pod team-a/web");

        // A stopped server refuses it.
        let stopped = CancellationToken::new();
        stopped.cancel();
        let g = Guard::new(
            Arc::clone(&ctx),
            FakeKinds::standard(),
            stopped,
            "claude-code",
            "apply_yaml",
        );
        assert_eq!(
            g.check_dry_run(&cluster(), &modify, &target).await,
            Err(Refusal::Stopped)
        );
    }

    #[tokio::test]
    async fn access_off_refuses_the_cluster_and_changes_apply_to_the_next_call() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        let read = [need(Some("default"), "Pod", AccessAction::Read)];
        let target = summary("get_resource", "Pod default/web");

        let g = guard(&ctx);
        let refused = g.check(&cluster(), &read, &target).await.unwrap_err();
        assert_eq!(
            refused,
            Refusal::ClusterOff {
                cluster: "kind-test".into()
            }
        );
        assert!(refused.to_string().contains("AI agent access"), "{refused}");
        assert_eq!(g.record().decision, Some(AuditDecision::Denied));

        set_access(
            &ctx,
            &cluster(),
            ClusterAccess {
                preset: AccessPreset::ReadOnly,
                rules: Vec::new(),
            },
        );
        let g = guard(&ctx);
        assert_eq!(g.check(&cluster(), &read, &target).await, Ok(()));
        assert_eq!(g.record().decision, Some(AuditDecision::Allowed));
        assert_eq!(g.record().target, "Pod default/web");

        set_access(&ctx, &cluster(), ClusterAccess::default());
        assert!(guard(&ctx).check(&cluster(), &read, &target).await.is_err());
    }

    #[tokio::test]
    async fn every_requirement_must_be_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        set_access(
            &ctx,
            &cluster(),
            custom(vec![rule(&[], &[AccessAction::Modify], false)]),
        );
        let refused = guard(&ctx)
            .check(
                &cluster(),
                &[
                    need(None, "Node", AccessAction::Modify),
                    need(None, "Pod", AccessAction::Delete),
                ],
                &summary("drain_node", "Node worker-1"),
            )
            .await
            .unwrap_err();
        assert_eq!(
            refused.to_string(),
            "Sextant denied delete on Pod in all namespaces in cluster kind-test. The user can allow it in \
             Sextant → cluster settings → AI agent access."
        );
    }

    /// Answers every `mcp-confirm` with `approved` and remembers the requests.
    fn answer_with(ctx: &Arc<McpContext>, approved: bool) -> Arc<Mutex<Vec<ConfirmRequest>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (seen_in, weak) = (Arc::clone(&seen), Arc::downgrade(ctx));
        ctx.set_emitter(Arc::new(move |event| {
            if let McpEvent::Confirm(request) = event {
                seen_in.lock().unwrap().push(request.clone());
                let ctx = weak.upgrade().unwrap();
                tokio::spawn(async move {
                    ctx.confirmations.answer(&request.id, approved).unwrap();
                });
            }
            true
        }));
        seen
    }

    #[tokio::test]
    async fn a_rule_that_asks_waits_for_the_window() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        set_access(
            &ctx,
            &cluster(),
            ClusterAccess {
                preset: AccessPreset::ReadWrite,
                rules: Vec::new(),
            },
        );
        let modify = [need(Some("team-a"), "Pod", AccessAction::Modify)];
        let target = CallSummary {
            tool: "patch_resource".into(),
            target: "Pod team-a/web".into(),
            details: Some("metadata: {}".into()),
        };

        let seen = answer_with(&ctx, true);
        let g = guard(&ctx);
        assert_eq!(g.check(&cluster(), &modify, &target).await, Ok(()));
        assert_eq!(g.record().decision, Some(AuditDecision::Approved));
        let shown = seen.lock().unwrap()[0].clone();
        assert_eq!(
            (
                shown.client.as_str(),
                shown.cluster_name.as_str(),
                shown.tool.as_str()
            ),
            ("claude-code", "kind-test", "patch_resource")
        );
        assert_eq!(shown.target, "Pod team-a/web");
        assert_eq!(shown.details.as_deref(), Some("metadata: {}"));

        answer_with(&ctx, false);
        let g = guard(&ctx);
        let refused = g.check(&cluster(), &modify, &target).await.unwrap_err();
        assert_eq!(
            refused.to_string(),
            "The user declined patch_resource on Pod team-a/web in cluster kind-test."
        );
        assert_eq!(g.record().decision, Some(AuditDecision::Declined));

        // Reads are never asked about.
        let read = [need(Some("team-a"), "Pod", AccessAction::Read)];
        let seen = answer_with(&ctx, false);
        assert_eq!(guard(&ctx).check(&cluster(), &read, &target).await, Ok(()));
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn without_a_window_a_call_that_asks_is_declined() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        set_access(
            &ctx,
            &cluster(),
            ClusterAccess {
                preset: AccessPreset::Full,
                rules: Vec::new(),
            },
        );
        let refused = guard(&ctx)
            .check(
                &cluster(),
                &[need(Some("team-a"), "Pod", AccessAction::Delete)],
                &summary("delete_resource", "Pod team-a/web"),
            )
            .await
            .unwrap_err();
        assert!(matches!(refused, Refusal::Declined { .. }), "{refused:?}");
    }

    #[tokio::test]
    async fn after_the_server_stopped_nothing_is_allowed_or_asked() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        set_access(
            &ctx,
            &cluster(),
            ClusterAccess {
                preset: AccessPreset::Full,
                rules: Vec::new(),
            },
        );
        let seen = answer_with(&ctx, true);
        let stopped = CancellationToken::new();
        let g = Guard::new(
            Arc::clone(&ctx),
            FakeKinds::standard(),
            stopped.clone(),
            "c",
            "t",
        );
        stopped.cancel();
        let modify = [need(Some("team-a"), "Pod", AccessAction::Modify)];
        let target = summary("patch_resource", "Pod team-a/web");
        assert_eq!(
            g.check(&cluster(), &modify, &target).await,
            Err(Refusal::Stopped)
        );
        let read = [need(Some("team-a"), "Pod", AccessAction::Read)];
        assert_eq!(
            g.check(&cluster(), &read, &target).await,
            Err(Refusal::Stopped)
        );
        assert!(seen.lock().unwrap().is_empty(), "asked after the stop");
        assert_eq!(g.record().decision, Some(AuditDecision::Denied));
    }

    #[test]
    fn timeout_text() {
        let refused = Refusal::TimedOut {
            tool: "exec_command".into(),
            target: "Pod team-a/web".into(),
            cluster: "kind-test".into(),
        };
        assert_eq!(
            refused.to_string(),
            "No answer from the user in 120 s: exec_command on Pod team-a/web in cluster kind-test was not run."
        );
    }

    #[tokio::test]
    async fn namespaces_for_a_call_over_all_of_them() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        set_access(
            &ctx,
            &cluster(),
            custom(vec![
                rule(&["team-b", "team-a"], &[AccessAction::Read], false),
                rule(&["team-c"], &[AccessAction::Logs], false),
            ]),
        );
        let pods = KindPattern::new("", "Pod");
        let list = summary("list_resources", "Pod in all namespaces");
        assert_eq!(
            guard(&ctx).allowed_namespaces(&cluster(), &pods, AccessAction::Read, &list),
            Ok(NamespaceScope::Only {
                namespaces: vec!["team-a".into(), "team-b".into()]
            })
        );
        let g = guard(&ctx);
        let refused = g
            .allowed_namespaces(&cluster(), &pods, AccessAction::Exec, &list)
            .unwrap_err();
        assert!(matches!(refused, Refusal::Denied { .. }));
        assert_eq!(g.record().decision, Some(AuditDecision::Denied));
    }

    #[tokio::test]
    async fn a_call_narrowed_to_some_namespaces_names_them_in_the_journal() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        let pods = KindPattern::new("", "Pod");
        let list = summary("list_resources", "Pod in all namespaces");
        set_access(
            &ctx,
            &cluster(),
            custom(vec![rule(
                &["team-b", "team-a"],
                &[AccessAction::Read],
                false,
            )]),
        );
        let g = guard(&ctx);
        g.allowed_namespaces(&cluster(), &pods, AccessAction::Read, &list)
            .unwrap();
        assert_eq!(g.record().target, "Pod in namespaces team-a, team-b");
        // Other wordings of "all namespaces" keep their start.
        let g = guard(&ctx);
        let usage = summary("get_metrics", "Pod usage in all namespaces");
        g.allowed_namespaces(&cluster(), &pods, AccessAction::Read, &usage)
            .unwrap();
        assert_eq!(g.record().target, "Pod usage in namespaces team-a, team-b");

        // Very many namespaces are cut like any target.
        let many: Vec<String> = (0..200).map(|i| format!("team-{i:03}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        set_access(
            &ctx,
            &cluster(),
            custom(vec![rule(&many, &[AccessAction::Read], false)]),
        );
        let g = guard(&ctx);
        g.allowed_namespaces(&cluster(), &pods, AccessAction::Read, &list)
            .unwrap();
        let target = g.record().target;
        assert!(
            target.starts_with("Pod in namespaces team-000, team-001"),
            "{target}"
        );
        assert!(target.ends_with("[cut]"), "{target}");

        // A grant over all namespaces, and a refusal, still say "all namespaces".
        set_access(
            &ctx,
            &cluster(),
            custom(vec![rule(&[], &[AccessAction::Read], false)]),
        );
        let g = guard(&ctx);
        g.allowed_namespaces(&cluster(), &pods, AccessAction::Read, &list)
            .unwrap();
        assert_eq!(g.record().target, "Pod in all namespaces");
        let g = guard(&ctx);
        let refused = g
            .allowed_namespaces(&cluster(), &pods, AccessAction::Exec, &list)
            .unwrap_err();
        assert!(
            refused.to_string().contains("on Pod in all namespaces"),
            "{refused}"
        );
        assert_eq!(g.record().target, "Pod in all namespaces");
    }

    #[tokio::test]
    async fn a_stop_after_a_read_passed_records_no_change() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        set_access(
            &ctx,
            &cluster(),
            custom(vec![rule(
                &["team-a"],
                &[AccessAction::Read, AccessAction::Logs, AccessAction::Delete],
                false,
            )]),
        );
        let pod = |action| need(Some("team-a"), "Pod", action);
        let target = summary("tool", "Pod team-a/web");
        let g = guard(&ctx);
        g.check(
            &cluster(),
            &[pod(AccessAction::Read), pod(AccessAction::Logs)],
            &target,
        )
        .await
        .unwrap();
        assert!(g.record().passed);
        assert!(!g.record().changes);
        let g = guard(&ctx);
        g.allowed_namespaces(
            &cluster(),
            &KindPattern::new("", "Pod"),
            AccessAction::Read,
            &summary("list_resources", "Pod in all namespaces"),
        )
        .unwrap();
        assert!(g.record().passed && !g.record().changes);
        let g = guard(&ctx);
        g.check(
            &cluster(),
            &[pod(AccessAction::Read), pod(AccessAction::Delete)],
            &target,
        )
        .await
        .unwrap();
        assert!(g.record().passed && g.record().changes);
    }

    #[tokio::test]
    async fn optional_extras_are_allowed_only_by_a_rule() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context_in(dir.path());
        let secret = KindPattern::new("", "Secret");
        set_access(
            &ctx,
            &cluster(),
            ClusterAccess {
                preset: AccessPreset::Full,
                rules: Vec::new(),
            },
        );
        let g = guard(&ctx);
        assert!(
            !g.allows(
                &cluster(),
                Some("team-a"),
                &secret,
                AccessAction::SecretValues
            )
            .await
        );
        set_access(
            &ctx,
            &cluster(),
            custom(vec![rule(
                &["team-a"],
                &[AccessAction::SecretValues],
                false,
            )]),
        );
        let fake = Arc::new(FakeKinds(
            [("Secret".to_owned(), true)].into_iter().collect(),
        ));
        let g = Guard::new(
            Arc::clone(&ctx),
            fake,
            CancellationToken::new(),
            "c",
            "get_resource",
        );
        assert!(
            g.allows(
                &cluster(),
                Some("team-a"),
                &secret,
                AccessAction::SecretValues
            )
            .await
        );
        assert!(
            !g.allows(
                &cluster(),
                Some("team-b"),
                &secret,
                AccessAction::SecretValues
            )
            .await
        );
    }
}
