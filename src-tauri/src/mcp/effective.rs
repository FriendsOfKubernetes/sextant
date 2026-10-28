//! `get_permissions` with `mine: true` (#300): what the credentials Sextant connects with may do, as the API server
//! answers it (SelfSubjectRulesReview, `sextant_core::rbac::rules_review`), and only while the user turned on "Let
//! agents see my effective permissions" for the cluster (`ClusterSettings::agent_access_reviews`, off by default).
//! ADR-0071 kept the reviews in the window because they describe the user's own credentials; with the opt-in an agent
//! gets them cut to what its own rules cover:
//! - only namespaces the agent may read in (the asked one, else its rules' namespaces, else — rules for all
//!   namespaces — the context's and the known ones), at most [`MAX_REVIEWS`];
//! - only resources whose kind the agent's rules cover there with some action (a wildcard only under a rule for every
//!   kind), each with the actions Sextant lets the agent take on it; non-resource URLs are left out;
//! - an `incomplete` review (a webhook or another authorizer that cannot list its rules) is said to be one.

use std::collections::HashMap;

use serde_json::{Value, json};
use sextant_core::access::{
    self, AccessAction, ClusterAccess, KindPattern, KindScope, NamespaceScope,
};
use sextant_core::rbac::{self, ReviewResourceRule, RulesReview};
use sextant_core::resources::ResourceKind;
use sextant_core::{CoreError, ErrorCode};

use super::guard::ClusterTarget;
use super::tools::{ToolCall, ToolOutput, ToolResult};
use super::tools_read::summary;

/// The most namespaces one call asks a rules review for.
pub const MAX_REVIEWS: usize = 10;
/// The most resource entries one namespace's answer lists.
pub const MAX_ENTRIES: usize = 300;
/// The longest evaluation error passed on.
const MAX_ERROR_CHARS: usize = 300;

const NOTE: &str = "Asked from the Kubernetes API (SelfSubjectRulesReview) for the credentials Sextant connects \
with, and cut to the kinds the agent's own rules cover: `verbs` — what the cluster lets those credentials do, \
`agentActions` — what Sextant lets the agent do there; a call needs both. Rules of ClusterRoleBindings appear in \
every namespace. `incomplete`: another authorizer (a webhook, Node) could not list its rules, so the credentials may \
be allowed more. Non-resource URLs are left out.";

const NOT_ALLOWED: &str = "The user has not let agents see their effective permissions in this cluster. They can \
allow it in Sextant: the cluster's settings → AI agent access → \"Let agents see my effective permissions\". Without \
it, get_permissions with `subject` or `whoCan` computes permissions from the RBAC objects the agent may read, and \
get_access tells the agent's own rules.";

/// Answers `mine: true` for `namespace` (every namespace the agent may read when `None`).
pub async fn my_permissions(
    call: &ToolCall,
    cluster_arg: &str,
    namespace: Option<String>,
) -> ToolResult {
    let target = match &namespace {
        Some(ns) => format!("the user's effective permissions in namespace {ns}"),
        None => "the user's effective permissions".to_owned(),
    };
    let cluster = call.open(cluster_arg).await?;
    let summary = summary("get_permissions", target);
    call.guard
        .check_reads(&cluster, namespace.as_deref(), &summary)?;
    let ctx = call.ctx();
    let settings = ctx.settings.get();
    let stored = settings.clusters.get(&cluster.id.0);
    if stored.and_then(|s| s.agent_access_reviews) != Some(true) {
        return Err(CoreError::new(ErrorCode::Denied, NOT_ALLOWED).into());
    }
    let access = stored.map(|s| s.agent_access.clone()).unwrap_or_default();
    let (namespaces, more) = match namespace {
        Some(ns) => (vec![ns], false),
        None => review_namespaces(call, &cluster, &access),
    };
    if namespaces.is_empty() {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "no namespace to ask about: pass `namespace` (get_access names the ones the user works in)",
        )
        .into());
    }
    let kinds =
        super::tools_read::read("reading the kinds", ctx.clusters.kinds(&cluster.id)).await?;
    let mut out = Vec::new();
    for ns in &namespaces {
        let review = rbac::rules_review(&ctx.clusters, &cluster.id, ns).await;
        out.push(match review {
            Ok(review) => answer_of(&review, &access, &kinds),
            Err(e) => json!({ "namespace": ns, "error": { "code": e.code, "message": e.message } }),
        });
    }
    let mut result = json!({
        "cluster": cluster.id,
        "namespaces": out,
        "note": NOTE,
    });
    if more {
        result["truncated"] = json!(true);
        result["truncatedNote"] = json!(format!(
            "only the first {MAX_REVIEWS} namespaces; pass `namespace` for another"
        ));
    }
    Ok(ToolOutput::Json(result))
}

/// The namespaces to review for a call over all of them: the agent's rules' own namespaces, and under a rule for
/// all namespaces the context's and the known ones; each one the agent may read in. `true`: more were left out.
fn review_namespaces(
    call: &ToolCall,
    cluster: &ClusterTarget,
    access: &ClusterAccess,
) -> (Vec<String>, bool) {
    let ctx = call.ctx();
    let settings = ctx.settings.get();
    let rules = access::rules_with(access, AccessAction::Read);
    let mut candidates: Vec<String> = Vec::new();
    if rules.iter().any(|r| r.namespaces == NamespaceScope::All) {
        let context = ctx
            .cluster_list()
            .into_iter()
            .find(|c| c.id == cluster.id)
            .and_then(|c| c.namespace);
        let known = settings
            .clusters
            .get(&cluster.id.0)
            .and_then(|s| s.known_namespaces.clone())
            .unwrap_or_default();
        candidates.extend(context.into_iter().chain(known));
    }
    for rule in &rules {
        if let NamespaceScope::Only { namespaces } = &rule.namespaces {
            candidates.extend(namespaces.iter().cloned());
        }
    }
    let mut out: Vec<String> = Vec::new();
    for ns in candidates {
        let ns = ns.trim().to_owned();
        if !ns.is_empty()
            && !out.contains(&ns)
            && access::allows_somewhere(access, Some(&ns), AccessAction::Read)
        {
            out.push(ns);
        }
    }
    let more = out.len() > MAX_REVIEWS;
    out.truncate(MAX_REVIEWS);
    (out, more)
}

/// The actions the agent's rules allow on `kind` (`None`: every kind, for a wildcard) in `namespace` (`None`: a
/// cluster-scoped kind).
fn agent_actions(
    access: &ClusterAccess,
    namespace: Option<&str>,
    kind: Option<&KindPattern>,
) -> Vec<AccessAction> {
    match kind {
        Some(kind) => AccessAction::ALL
            .into_iter()
            .filter(|a| access::decide(access, namespace, kind, *a).is_allowed())
            .collect(),
        // A wildcard resource or group stands for every kind: only rules for every kind (in this namespace) cover it.
        None => {
            let rules = access::rules_in_force(access);
            AccessAction::ALL
                .into_iter()
                .filter(|a| {
                    rules.iter().any(|r| {
                        r.kinds == KindScope::All
                            && r.actions.contains(a)
                            && match (&r.namespaces, namespace) {
                                (NamespaceScope::All, _) => true,
                                (NamespaceScope::Only { namespaces }, Some(ns)) => {
                                    namespaces.iter().any(|n| n == ns)
                                }
                                (NamespaceScope::Only { .. }, None) => false,
                            }
                    })
                })
                .collect()
        }
    }
}

/// One namespace's review, cut to what the agent's rules cover.
pub fn answer_of(review: &RulesReview, access: &ClusterAccess, kinds: &[ResourceKind]) -> Value {
    let by_plural: HashMap<(String, String), &ResourceKind> = kinds
        .iter()
        .map(|k| {
            (
                (
                    k.kind_ref.group.to_ascii_lowercase(),
                    k.plural.to_ascii_lowercase(),
                ),
                k,
            )
        })
        .collect();
    let ns = review.namespace.as_str();
    let mut entries: Vec<Value> = Vec::new();
    let mut truncated = false;
    'rules: for rule in &review.resource_rules {
        for group in &rule.api_groups {
            for resource in &rule.resources {
                if let Some(entry) = entry_of(rule, group, resource, ns, access, &by_plural) {
                    if entries.len() == MAX_ENTRIES {
                        truncated = true;
                        break 'rules;
                    }
                    entries.push(entry);
                }
            }
        }
    }
    let mut out = json!({
        "namespace": ns,
        "rules": entries,
        "incomplete": review.incomplete,
    });
    if truncated {
        out["truncated"] = json!(true);
    }
    if !review.evaluation_error.trim().is_empty() {
        out["evaluationError"] = json!(
            review
                .evaluation_error
                .chars()
                .take(MAX_ERROR_CHARS)
                .collect::<String>()
        );
    }
    out
}

/// One group × resource of a rule, when the agent's rules cover its kind with some action.
fn entry_of(
    rule: &ReviewResourceRule,
    group: &str,
    resource: &str,
    namespace: &str,
    access: &ClusterAccess,
    by_plural: &HashMap<(String, String), &ResourceKind>,
) -> Option<Value> {
    // `pods/log` is the Pod's subresource: judged by the Pod.
    let base = resource.split('/').next().unwrap_or(resource);
    let (kind, actions) = if group == "*" || base == "*" {
        (None, agent_actions(access, Some(namespace), None))
    } else {
        let found = by_plural.get(&(group.to_ascii_lowercase(), base.to_ascii_lowercase()))?;
        let pattern = KindPattern::new(found.kind_ref.group.clone(), found.kind_ref.kind.clone());
        let where_ = found.namespaced.then_some(namespace);
        let actions = agent_actions(access, where_, Some(&pattern));
        (Some(found.kind_ref.kind.clone()), actions)
    };
    if actions.is_empty() {
        return None;
    }
    let mut entry = json!({
        "apiGroup": group,
        "resource": resource,
        "verbs": rule.verbs,
        "agentActions": actions,
    });
    if let Some(kind) = kind {
        entry["kind"] = json!(kind);
    }
    if !rule.resource_names.is_empty() {
        entry["resourceNames"] = json!(rule.resource_names);
    }
    Some(entry)
}

#[cfg(test)]
mod tests {
    use sextant_core::access::{AccessPreset, AccessRule};
    use sextant_core::rbac::ReviewNonResourceRule;
    use sextant_core::resources::KindRef;

    use super::*;

    fn kind(group: &str, kind: &str, plural: &str, namespaced: bool) -> ResourceKind {
        ResourceKind {
            kind_ref: KindRef {
                group: group.to_owned(),
                version: "v1".to_owned(),
                kind: kind.to_owned(),
            },
            plural: plural.to_owned(),
            namespaced,
            verbs: vec!["list".to_owned()],
            printer_columns: Vec::new(),
        }
    }

    fn rule(verbs: &[&str], groups: &[&str], resources: &[&str]) -> ReviewResourceRule {
        let owned = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect();
        ReviewResourceRule {
            verbs: owned(verbs),
            api_groups: owned(groups),
            resources: owned(resources),
            resource_names: Vec::new(),
        }
    }

    #[test]
    fn a_review_is_cut_to_the_kinds_the_agents_rules_cover() {
        let kinds = [
            kind("", "Pod", "pods", true),
            kind("", "Secret", "secrets", true),
            kind("apps", "Deployment", "deployments", true),
            kind("", "Node", "nodes", false),
        ];
        let review = RulesReview {
            namespace: "team-a".to_owned(),
            resource_rules: vec![
                rule(&["get", "list"], &[""], &["pods", "pods/log", "secrets"]),
                rule(&["patch"], &["apps"], &["deployments"]),
                rule(&["get"], &[""], &["nodes"]),
                rule(&["*"], &["*"], &["*"]),
                rule(&["list"], &["example.com"], &["unknowns"]),
            ],
            non_resource_rules: vec![ReviewNonResourceRule {
                verbs: vec!["get".to_owned()],
                non_resource_urls: vec!["/healthz".to_owned()],
            }],
            incomplete: true,
            evaluation_error: String::new(),
        };
        // Pods (read, logs) and Deployments (modify) in team-a; nothing on Secrets, Nodes or every kind.
        let access = ClusterAccess {
            preset: AccessPreset::Custom,
            rules: vec![
                AccessRule {
                    namespaces: NamespaceScope::Only {
                        namespaces: vec!["team-a".to_owned()],
                    },
                    kinds: KindScope::Only {
                        kinds: vec![KindPattern::new("", "Pod")],
                    },
                    actions: vec![AccessAction::Read, AccessAction::Logs],
                    confirm: false,
                },
                AccessRule {
                    namespaces: NamespaceScope::Only {
                        namespaces: vec!["team-a".to_owned()],
                    },
                    kinds: KindScope::Only {
                        kinds: vec![KindPattern::new("apps", "Deployment")],
                    },
                    actions: vec![AccessAction::Modify],
                    confirm: true,
                },
            ],
        };
        let out = answer_of(&review, &access, &kinds);
        let listed: Vec<String> = out["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| format!("{} {} {}", e["resource"], e["verbs"], e["agentActions"]))
            .collect();
        assert_eq!(
            listed,
            [
                r#""pods" ["get","list"] ["read","logs"]"#,
                r#""pods/log" ["get","list"] ["read","logs"]"#,
                r#""deployments" ["patch"] ["modify"]"#,
            ]
        );
        assert_eq!(out["incomplete"], true);
        assert!(!out.to_string().contains("healthz"));
        assert!(!out.to_string().contains("secrets"));

        // Read-only everywhere: every kind, so the wildcard and cluster-scoped Nodes too.
        let everywhere = ClusterAccess {
            preset: AccessPreset::ReadOnly,
            rules: Vec::new(),
        };
        let out = answer_of(&review, &everywhere, &kinds);
        let resources: Vec<&str> = out["rules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["resource"].as_str().unwrap())
            .collect();
        assert_eq!(
            resources,
            ["pods", "pods/log", "secrets", "deployments", "nodes", "*"]
        );
    }
}
