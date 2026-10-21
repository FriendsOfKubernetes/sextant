//! What the window's diagnostic answers look like, and what the backend does to them before the agent reads them
//! (ADR-0094): an answer is read into its typed shape (unknown fields are dropped, a malformed one is an error), every
//! object it names is checked again against the agent's Read rules (an object outside them is dropped, uncounted),
//! opt-in problem categories stay only while the user has them on, a Secret's recorded changes keep field paths only,
//! and every text is clipped and every list capped ([`finish`]).

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sextant_core::access::{self, AccessAction, ClusterAccess, KindPattern};
use sextant_core::{ClusterId, CoreError, ErrorCode};

use super::audit::clip;
use super::guard::KindLookup;

/// Items of any one list an answer keeps at most.
pub const MAX_ITEMS: usize = 500;
/// Levels of nested chains a traffic diagnosis keeps at most.
pub const MAX_DEPTH: usize = 8;

/// An object an answer names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    /// API group (`""` for the core group).
    #[serde(default)]
    pub group: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub name: String,
}

/// A kind an answer names without an object (the watched kind a problem came from).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindName {
    #[serde(default)]
    pub group: String,
    pub kind: String,
}

/// A list (or one object of it) an answer's finding rests on or names in its words: a kind in a namespace, or (no
/// namespace) in all of them. The agent must be able to read it, or the finding goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRef {
    #[serde(default)]
    pub group: String,
    pub kind: String,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Reads the window's answer into `T`; a shape that does not fit is an error, not a partial answer.
pub fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, CoreError> {
    serde_json::from_value(value).map_err(|e| {
        CoreError::new(
            ErrorCode::Other,
            format!(
                "Sextant's window gave an answer of the wrong shape: {}",
                clip(&e.to_string())
            ),
        )
    })
}

/// Decides whether the agent may read an object, the way `Guard` does: the rules in force for Read, a namespace only
/// for kinds known to have one. A namespaced object without a namespace counts as "in all namespaces", and a kind that
/// cannot be looked up as having none, so both need a rule for all namespaces.
pub struct ReadFilter {
    access: ClusterAccess,
    kinds: Arc<dyn KindLookup>,
    cluster: ClusterId,
    namespaced: HashMap<(String, String), Option<bool>>,
}

impl ReadFilter {
    pub fn new(access: ClusterAccess, kinds: Arc<dyn KindLookup>, cluster: ClusterId) -> Self {
        Self {
            access,
            kinds,
            cluster,
            namespaced: HashMap::new(),
        }
    }

    pub async fn can(&mut self, group: &str, kind: &str, namespace: Option<&str>) -> bool {
        if kind.trim().is_empty() {
            return false;
        }
        let pattern = KindPattern::new(group, kind);
        let key = (group.to_ascii_lowercase(), kind.to_ascii_lowercase());
        let namespaced = match self.namespaced.get(&key) {
            Some(known) => *known,
            None => {
                let found = self.kinds.namespaced(&self.cluster, &pattern).await;
                self.namespaced.insert(key, found);
                found
            }
        };
        let namespace = namespace.filter(|ns| !ns.trim().is_empty());
        let effective = if namespaced == Some(true) {
            namespace
        } else {
            None
        };
        access::decide(&self.access, effective, &pattern, AccessAction::Read).is_allowed()
    }

    pub async fn can_object(&mut self, object: &ObjectRef) -> bool {
        self.can(&object.group, &object.kind, object.namespace.as_deref())
            .await
    }

    /// Whether the agent may read every list (or object) of `refs`.
    pub async fn lists(&mut self, refs: &[ListRef]) -> bool {
        for r in refs {
            if !self.can(&r.group, &r.kind, r.namespace.as_deref()).await {
                return false;
            }
        }
        true
    }

    /// The objects of `list` the agent may read, in order.
    pub async fn objects(&mut self, list: Vec<ObjectRef>) -> Vec<ObjectRef> {
        let mut out = Vec::new();
        for object in list {
            if self.can_object(&object).await {
                out.push(object);
            }
        }
        out
    }
}

/// The answer as the agent gets it: every string clipped ([`clip`]), every list cut to [`MAX_ITEMS`].
pub fn finish(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(clip(&text)),
        Value::Array(items) => {
            Value::Array(items.into_iter().take(MAX_ITEMS).map(finish).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key, finish(value)))
                .collect(),
        ),
        other => other,
    }
}

/// `value` as JSON for [`finish`].
pub fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// A status word of the traffic diagnosis; anything else reads as `unknown`.
fn status_word(word: &str) -> String {
    match word {
        "ok" | "warn" | "broken" | "unknown" => word.to_owned(),
        _ => "unknown".to_owned(),
    }
}

/// A verdict word of the connectivity check; anything else reads as `unknown`.
fn verdict_word(word: &str) -> String {
    match word {
        "allowed" | "denied" | "unknown" | "partial" => word.to_owned(),
        _ => "unknown".to_owned(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// get_problems

/// The problem categories of the problems screen, in its order (`PROBLEM_CATEGORIES` in
/// `src/features/problems/model.ts`; a test keeps them equal).
pub const PROBLEM_CATEGORIES: &[&str] = &[
    "nodes",
    "pods",
    "workloads",
    "jobs",
    "volumes",
    "certificates",
    "flux",
    "argocd",
    "rollouts",
    "workflows",
    "gateway",
    "mesh",
    "traefik",
    "contour",
    "knative",
    "crossplane",
    "policies",
    "externalSecrets",
    "cnpg",
    "strimzi",
    "prometheusOperator",
    "security",
    "practices",
    "credentials",
    "disk",
    "events",
];
/// Categories that count only while the user turned them on (`OPT_IN_CATEGORIES` there).
pub const OPT_IN_CATEGORIES: [&str; 7] = [
    "security",
    "credentials",
    "disk",
    "practices",
    "policies",
    "prometheusOperator",
    "traefik",
];
/// Never given to agents: expiring kubeconfig credentials are the app user's, not the cluster's (ADR-0084).
/// Knative, Crossplane and Kyverno policy problems (#213) are window views of this build: agents get nothing new.
/// So are External Secrets, CloudNativePG, Strimzi and Prometheus Operator problems (#213).
/// And Argo Rollouts and Argo Workflows problems (#213, ADR-0097).
pub const NEVER_FOR_AGENTS: &[&str] = &[
    "rollouts",
    "workflows",
    "credentials",
    // Traefik references (#232): a window view of 0.20.0.
    "traefik",
    // Contour proxies (#233): a window view of 0.20.0.
    "contour",
    "knative",
    "crossplane",
    "policies",
    "externalSecrets",
    "cnpg",
    "strimzi",
    "prometheusOperator",
];

/// Whether an agent may get problems of `category` now (`enabled`: `notifications.enabledCategories`).
pub fn category_for_agents(category: &str, enabled: &[String]) -> bool {
    PROBLEM_CATEGORIES.contains(&category)
        && !NEVER_FOR_AGENTS.contains(&category)
        && (!OPT_IN_CATEGORIES.contains(&category) || enabled.iter().any(|c| c == category))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub category: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub object: ObjectRef,
    /// The watched kind it was found in (a Warning event's problem names the event's object).
    pub source: KindName,
    /// When the state began (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    /// It would notify (a crash loop, a failed Job, a node not ready), not just show on the screen.
    #[serde(default)]
    pub needs_attention: bool,
    /// The lists the finding was judged against and the objects its words name (a DestinationRule, another
    /// VirtualService, the Nodes): every one must be readable for the agent. Not shown to it.
    #[serde(default, skip_serializing)]
    pub refs: Vec<ListRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemsAnswer {
    pub problems: Vec<Problem>,
    /// The categories looked at.
    #[serde(default)]
    pub categories: Vec<String>,
    /// Categories whose objects were still being listed when the window answered.
    #[serde(default)]
    pub loading: Vec<String>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub incomplete: bool,
    /// Categories that could not be looked at with what the agent may read (disk without Read on claims and Nodes
    /// in all namespaces, …).
    #[serde(default)]
    pub not_checked: Vec<String>,
}

/// The problems the agent may see: known categories it may get, in `namespace` when given, objects (and the kinds
/// they were found in) it may read; at most `limit`.
pub async fn problems(
    answer: ProblemsAnswer,
    filter: &mut ReadFilter,
    enabled: &[String],
    namespace: Option<&str>,
    limit: usize,
) -> ProblemsAnswer {
    let mut kept = Vec::new();
    let mut truncated = answer.truncated;
    for p in answer.problems {
        if !category_for_agents(&p.category, enabled) {
            continue;
        }
        if namespace.is_some_and(|ns| p.object.namespace.as_deref() != Some(ns)) {
            continue;
        }
        let ns = p.object.namespace.clone();
        if !filter.can_object(&p.object).await
            || !filter
                .can(&p.source.group, &p.source.kind, ns.as_deref())
                .await
            || !filter.lists(&p.refs).await
        {
            continue;
        }
        if kept.len() >= limit {
            truncated = true;
            break;
        }
        kept.push(p);
    }
    let known = |list: Vec<String>| -> Vec<String> {
        list.into_iter()
            .filter(|c| category_for_agents(c, enabled))
            .collect()
    };
    ProblemsAnswer {
        problems: kept,
        categories: known(answer.categories),
        loading: known(answer.loading),
        truncated,
        incomplete: answer.incomplete,
        not_checked: known(answer.not_checked),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// diagnose_service

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// What was checked (`service.selector`, `ingress.class`, …).
    pub id: String,
    pub status: String,
    pub text: String,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default)]
    pub objects: Vec<ObjectRef>,
    /// The network policy evaluation behind a policy finding, in words.
    #[serde(default)]
    pub policies: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chain {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object: Option<ObjectRef>,
    #[serde(default)]
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub chains: Vec<Chain>,
    /// A link broke: the checks after it were not run.
    #[serde(default)]
    pub stopped: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnoseAnswer {
    /// The worst link: ok, warn, broken or unknown.
    pub status: String,
    /// The first broken link, in words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub chain: Chain,
    #[serde(default)]
    pub incomplete: bool,
}

/// A chain with only objects the agent may read: a branch about another object is dropped whole, a finding keeps its
/// words but loses the objects it may not name; levels below [`MAX_DEPTH`] go.
fn chain<'a>(
    mut c: Chain,
    filter: &'a mut ReadFilter,
    depth: usize,
) -> futures::future::BoxFuture<'a, Option<Chain>> {
    Box::pin(async move {
        if let Some(object) = &c.object
            && !filter.can_object(object).await
        {
            return None;
        }
        let mut findings = Vec::new();
        for mut f in c.findings {
            f.status = status_word(&f.status);
            f.objects = filter.objects(f.objects).await;
            findings.push(f);
        }
        c.findings = findings;
        let mut chains = Vec::new();
        if depth < MAX_DEPTH {
            for sub in c.chains {
                if let Some(sub) = chain(sub, filter, depth + 1).await {
                    chains.push(sub);
                }
            }
        }
        c.chains = chains;
        Some(c)
    })
}

/// Said instead of a TLS step's result when the agent may not have certificates read ([`diagnosis`]).
pub const CERTIFICATE_NOT_CHECKED: &str = "Not checked: a certificate's names and dates are read from the TLS \
Secret's tls.crt, a Secret value, so checking it needs the \"Secret values\" permission on Secrets in this namespace.";

/// The id prefix of a traffic diagnosis's TLS steps (`ingress.tls.<n>`, `src/features/diagnose/tls.ts`).
const TLS_STEP: &str = "ingress.tls.";

/// Makes every TLS step of `c` "unknown — not checked" (the agent may not have certificates read).
fn without_certificates(c: &mut Chain) {
    for f in &mut c.findings {
        if f.id.starts_with(TLS_STEP) {
            f.status = "unknown".to_owned();
            f.text = CERTIFICATE_NOT_CHECKED.to_owned();
            f.notes.clear();
        }
    }
    for sub in &mut c.chains {
        without_certificates(sub);
    }
}

fn rank(status: &str) -> u8 {
    match status {
        "ok" => 0,
        "unknown" => 1,
        "warn" => 2,
        _ => 3,
    }
}

/// The worst status of a chain, its branches included (`chainStatus` in `src/features/diagnose/model.ts`).
pub fn chain_status(c: &Chain) -> String {
    let mut worst = "ok".to_owned();
    let all = c
        .findings
        .iter()
        .map(|f| f.status.clone())
        .chain(c.chains.iter().map(chain_status));
    for status in all {
        if rank(&status) > rank(&worst) {
            worst = status;
        }
    }
    worst
}

/// The first broken finding, depth first (`firstBroken` there).
pub fn first_broken(c: &Chain) -> Option<&Finding> {
    c.findings
        .iter()
        .find(|f| f.status == "broken")
        .or_else(|| c.chains.iter().find_map(first_broken))
}

/// The diagnosis the agent may see; the root is `checked`, the object the call was checked for, whatever the window
/// named. Without `certificates` (the agent lacks "Secret values" on Secrets there) every TLS step is unknown, not
/// checked. The status and the summary are those of what is left, never of what was dropped.
pub async fn diagnosis(
    answer: DiagnoseAnswer,
    filter: &mut ReadFilter,
    checked: ObjectRef,
    certificates: bool,
) -> DiagnoseAnswer {
    let mut root = answer.chain;
    root.object = None;
    let mut root = chain(root, filter, 0).await.unwrap_or(Chain {
        title: None,
        object: None,
        findings: Vec::new(),
        chains: Vec::new(),
        stopped: false,
    });
    if !certificates {
        without_certificates(&mut root);
    }
    root.object = Some(checked);
    DiagnoseAnswer {
        status: chain_status(&root),
        summary: first_broken(&root).map(|f| f.text.clone()),
        chain: root,
        incomplete: answer.incomplete,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// check_connectivity

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyMatch {
    pub policy: ObjectRef,
    /// The rule, peer and port that matched, in words.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleCheck {
    /// "Ingress rule 2".
    pub rule: String,
    /// yes, no or maybe.
    pub result: String,
    #[serde(default)]
    pub why: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyCheck {
    pub policy: ObjectRef,
    #[serde(default)]
    pub rules: Vec<RuleCheck>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    /// egress or ingress.
    pub direction: String,
    pub verdict: String,
    pub why: String,
    #[serde(default)]
    pub allowed_by: Vec<PolicyMatch>,
    #[serde(default)]
    pub denied_by: Vec<PolicyMatch>,
    /// Why it cannot be told, in words.
    #[serde(default)]
    pub unknown: Vec<String>,
    /// Every policy that selects the pod for this direction, rule by rule.
    #[serde(default)]
    pub policies: Vec<PolicyCheck>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backend {
    pub pod: ObjectRef,
    /// The pod port the Service port reaches; none when a named target port is not on the pod.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dns {
    pub udp: String,
    pub tcp: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityAnswer {
    /// allowed, denied, unknown, or partial (a Service's pods disagree).
    pub verdict: String,
    pub summary: String,
    /// The pod whose two sides are shown, for a Service destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shown_backend: Option<ObjectRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub egress: Option<Side>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingress: Option<Side>,
    #[serde(default)]
    pub backends: Vec<Backend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dns: Option<Dns>,
    #[serde(default)]
    pub notes: Vec<String>,
    /// Why the check could not be run (a pod that is gone, a port that is not there).
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub incomplete: bool,
}

/// Said instead of a verdict that rested on a policy the agent may not read.
pub const HIDDEN_POLICY: &str =
    "A policy the agent may not read takes part in this answer, so it is reported as unknown.";

/// A side with only policies the agent may read; `false` when a deciding policy had to go (the side is then unknown).
async fn side(s: &mut Side, filter: &mut ReadFilter) -> bool {
    s.verdict = verdict_word(&s.verdict);
    let mut intact = true;
    for list in [&mut s.allowed_by, &mut s.denied_by] {
        let mut kept = Vec::new();
        for m in list.drain(..) {
            if filter.can_object(&m.policy).await {
                kept.push(m);
            } else {
                intact = false;
            }
        }
        *list = kept;
    }
    let mut policies = Vec::new();
    for p in s.policies.drain(..) {
        if filter.can_object(&p.policy).await {
            policies.push(p);
        } else {
            intact = false;
        }
    }
    s.policies = policies;
    if !intact {
        s.verdict = "unknown".to_owned();
        s.unknown.push(HIDDEN_POLICY.to_owned());
    }
    intact
}

/// The connectivity answer the agent may see.
pub async fn connectivity(
    mut a: ConnectivityAnswer,
    filter: &mut ReadFilter,
) -> ConnectivityAnswer {
    a.verdict = verdict_word(&a.verdict);
    let mut intact = true;
    if let Some(pod) = &a.shown_backend
        && !filter.can_object(pod).await
    {
        a.shown_backend = None;
        a.egress = None;
        a.ingress = None;
    }
    for s in [&mut a.egress, &mut a.ingress].into_iter().flatten() {
        intact &= side(s, filter).await;
    }
    let mut backends = Vec::new();
    for mut b in std::mem::take(&mut a.backends) {
        if filter.can_object(&b.pod).await {
            b.verdict = b.verdict.map(|v| verdict_word(&v));
            backends.push(b);
        }
    }
    a.backends = backends;
    if !intact {
        a.verdict = "unknown".to_owned();
        a.notes.push(HIDDEN_POLICY.to_owned());
    }
    a
}

// ---------------------------------------------------------------------------------------------------------------
// get_permissions

pub const RBAC_GROUP: &str = "rbac.authorization.k8s.io";

/// What every permissions answer says about itself.
pub const COMPUTED: &str = "Computed from Roles, ClusterRoles and their bindings that the agent may read. Other \
authorizers (Node, webhooks), the group system:masters and admission are not part of it, so the API server may \
decide differently.";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    #[serde(default)]
    pub verbs: Vec<String>,
    #[serde(default)]
    pub api_groups: Vec<String>,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub resource_names: Vec<String>,
    #[serde(default, rename = "nonResourceURLs")]
    pub non_resource_urls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RbacRef {
    /// Role, ClusterRole, RoleBinding or ClusterRoleBinding.
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub rule: PolicyRule,
    pub role: RbacRef,
    pub binding: RbacRef,
    /// The only namespace it applies in; none for a ClusterRoleBinding (everywhere).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// The ClusterRole an aggregated rule came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    /// Aggregated but not stored in the role yet.
    #[serde(default)]
    pub pending: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    /// User, Group or ServiceAccount.
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoCanAnswer {
    pub subject: Subject,
    pub rule: PolicyRule,
    pub role: RbacRef,
    pub binding: RbacRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// The grant covers only these objects.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub only_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingRole {
    pub binding: RbacRef,
    pub role: RbacRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsAnswer {
    /// Set by the backend: what the answer is computed from.
    #[serde(default)]
    pub computed: String,
    #[serde(default)]
    pub grants: Vec<Grant>,
    #[serde(default)]
    pub answers: Vec<WhoCanAnswer>,
    /// Bindings whose role does not exist (they grant nothing).
    #[serde(default)]
    pub missing_roles: Vec<MissingRole>,
    /// RBAC lists that could not be read: permissions they hold are missing from the answer.
    #[serde(default)]
    pub unreadable: Vec<String>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub incomplete: bool,
}

/// Whether the agent may read an RBAC object: one of the four kinds, a namespace only for Role and RoleBinding.
async fn rbac_object(r: &RbacRef, filter: &mut ReadFilter) -> bool {
    let namespaced = match r.kind.as_str() {
        "Role" | "RoleBinding" => true,
        "ClusterRole" | "ClusterRoleBinding" => false,
        _ => return false,
    };
    let namespace = if namespaced {
        r.namespace.as_deref()
    } else {
        None
    };
    if namespaced && namespace.is_none_or(|ns| ns.trim().is_empty()) {
        return false;
    }
    filter.can(RBAC_GROUP, &r.kind, namespace).await
}

/// The permissions the agent may see: grants and answers whose binding and role it may read, in `namespace` (or
/// cluster-wide) when one is given.
pub async fn permissions(
    a: PermissionsAnswer,
    filter: &mut ReadFilter,
    namespace: Option<&str>,
) -> PermissionsAnswer {
    let in_scope = |scope: &Option<String>| match (namespace, scope) {
        (Some(ns), Some(s)) => s == ns,
        _ => true,
    };
    let mut grants = Vec::new();
    for g in a.grants {
        if in_scope(&g.scope)
            && rbac_object(&g.binding, filter).await
            && rbac_object(&g.role, filter).await
        {
            grants.push(g);
        }
    }
    let mut answers = Vec::new();
    for w in a.answers {
        if in_scope(&w.scope)
            && rbac_object(&w.binding, filter).await
            && rbac_object(&w.role, filter).await
        {
            answers.push(w);
        }
    }
    let mut missing_roles = Vec::new();
    for m in a.missing_roles {
        if rbac_object(&m.binding, filter).await {
            missing_roles.push(m);
        }
    }
    PermissionsAnswer {
        computed: COMPUTED.to_owned(),
        grants,
        answers,
        missing_roles,
        unreadable: a.unreadable,
        truncated: a.truncated,
        incomplete: a.incomplete,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// get_recent_changes

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldChange {
    /// `spec.replicas`, `spec.template.spec.containers[web].image`, …
    pub path: String,
    /// added, removed or changed.
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    /// A value was too long to keep: only that it changed is known.
    #[serde(default)]
    pub long: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoonAfter {
    /// problem or warning (a Warning event).
    #[serde(rename = "type")]
    pub kind: String,
    pub reason: String,
    pub object: ObjectRef,
    /// From the change to it (may be a little below zero: two clocks).
    pub after_seconds: i64,
    /// same (the changed object) or dependent (something it owns or names).
    pub via: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// When Sextant saw it (RFC 3339, this machine's clock).
    pub at: String,
    /// Seen in a fresh list after nothing watched the object for a while: made some time before `at`.
    #[serde(default)]
    pub late: bool,
    /// created, updated or deleted.
    pub action: String,
    pub object: ObjectRef,
    #[serde(default)]
    pub changes: Vec<FieldChange>,
    /// Changes left out beyond the recorder's cap.
    #[serde(default)]
    pub more: u32,
    /// Only that it changed is known (the earlier text was kept as a hash).
    #[serde(default)]
    pub summary_only: bool,
    /// The field managers behind it, as people call them.
    #[serde(default)]
    pub who: Vec<String>,
    /// `who` is the most recent managers, a likely guess rather than known.
    #[serde(default)]
    pub who_is_a_guess: bool,
    #[serde(default)]
    pub soon_after: Vec<SoonAfter>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesAnswer {
    pub changes: Vec<Change>,
    /// More changes matched than were returned.
    #[serde(default)]
    pub truncated: bool,
}

/// Whether `object` is a core Secret, whose recorded values never leave the backend.
pub fn is_secret(object: &ObjectRef) -> bool {
    object.group.is_empty() && object.kind == "Secret"
}

/// The changes the agent may see: of objects it may read (in `namespace` when given), a Secret's without values, the
/// "soon after" signals of objects it may read; at most `limit`.
pub async fn changes(
    a: ChangesAnswer,
    filter: &mut ReadFilter,
    namespace: Option<&str>,
    limit: usize,
) -> ChangesAnswer {
    let mut kept = Vec::new();
    let mut truncated = a.truncated;
    for mut c in a.changes {
        if namespace.is_some_and(|ns| c.object.namespace.as_deref() != Some(ns))
            || !filter.can_object(&c.object).await
        {
            continue;
        }
        if kept.len() >= limit {
            truncated = true;
            break;
        }
        if is_secret(&c.object) {
            for f in &mut c.changes {
                f.before = None;
                f.after = None;
            }
        }
        let mut signals = Vec::new();
        for s in c.soon_after {
            if filter.can_object(&s.object).await {
                signals.push(s);
            }
        }
        c.soon_after = signals;
        kept.push(c);
    }
    ChangesAnswer {
        changes: kept,
        truncated,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// get_autoscaling_status

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    /// "Resource cpu", "Pods requests_per_second (web)", …
    pub metric: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Replicas this metric alone asks for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposes: Option<f64>,
    #[serde(default)]
    pub within_tolerance: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// What it means, in plain words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub wanted: f64,
    pub replicas: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limited_by: Option<String>,
    #[serde(default)]
    pub held_by_missing_metric: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hpa {
    pub object: ObjectRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ObjectRef>,
    pub min: f64,
    pub max: f64,
    pub current: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desired: Option<f64>,
    /// Why it is where it is, in one sentence.
    pub verdict: String,
    #[serde(default)]
    pub causes: Vec<String>,
    #[serde(default)]
    pub metrics: Vec<Metric>,
    /// The controller's formula applied to the reported values: an estimate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate: Option<Estimate>,
    #[serde(default)]
    pub conditions: Vec<Condition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaledObject {
    pub object: ObjectRef,
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub fallback: bool,
    /// The state in plain words, most important first.
    #[serde(default)]
    pub state: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerReason {
    /// Nodes it applies to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nodes: Option<f64>,
    /// insufficient, taint, nodeAffinity, … (`other` for a reason Sextant does not classify).
    pub code: String,
    /// The reason as the scheduler wrote it.
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPod {
    pub object: ObjectRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(default)]
    pub reasons: Vec<SchedulerReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nodes_total: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoscalingAnswer {
    #[serde(default)]
    pub hpas: Vec<Hpa>,
    #[serde(default)]
    pub scaled_objects: Vec<ScaledObject>,
    #[serde(default)]
    pub pending_pods: Vec<PendingPod>,
    #[serde(default)]
    pub incomplete: bool,
}

/// The autoscaling answer the agent may see: objects of `namespace` it may read; an HPA's target only when readable.
pub async fn autoscaling(
    a: AutoscalingAnswer,
    filter: &mut ReadFilter,
    namespace: &str,
) -> AutoscalingAnswer {
    let here = |o: &ObjectRef| o.namespace.as_deref() == Some(namespace);
    let mut hpas = Vec::new();
    for mut h in a.hpas {
        if !here(&h.object) || !filter.can_object(&h.object).await {
            continue;
        }
        if let Some(target) = &h.target
            && (!here(target) || !filter.can_object(target).await)
        {
            h.target = None;
        }
        hpas.push(h);
    }
    let mut scaled_objects = Vec::new();
    for s in a.scaled_objects {
        if here(&s.object) && filter.can_object(&s.object).await {
            scaled_objects.push(s);
        }
    }
    let mut pending_pods = Vec::new();
    for p in a.pending_pods {
        if here(&p.object) && filter.can_object(&p.object).await {
            pending_pods.push(p);
        }
    }
    AutoscalingAnswer {
        hpas,
        scaled_objects,
        pending_pods,
        incomplete: a.incomplete,
    }
}
