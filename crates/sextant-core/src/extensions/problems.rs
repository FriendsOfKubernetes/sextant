//! Problem rules of an extension (`contributes.problems`, ADR-0137): what a rule is, what reading a manifest checks
//! beyond its schema, and where a rule may run.
//!
//! The window evaluates the rules (`src/extensions/problemRules.ts`) on the problems store's watches; no extension
//! code runs for them. Here: the paths of a rule are field paths of the custom columns' grammar (ADR-0099) and never
//! read a core Secret's values or an inline secret field of the rule's kind (ADR-0120); a message has at most
//! [`MAX_PLACEHOLDERS`] placeholders; conditions nest at most [`MAX_DEPTH`] deep, [`MAX_CONDITIONS`] per rule.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::manifest::{ExtensionManifest, ManifestError};
use super::permissions::ExtensionPermissions;
use super::schema::JsonPath;
use crate::access::{self, AccessAction, AccessPreset, ClusterAccess, KindPattern, NamespaceScope};
use crate::resources::inline_secrets::INLINE_SECRETS;
use crate::settings::custom_columns::{PathStep, parse_field_path};

/// The extension API version that brought `contributes.problems`.
pub const PROBLEMS_API: u32 = 2;
/// Rules per extension (the schema's `maxItems`).
pub const MAX_RULES: usize = 20;
/// Kinds the rules of one extension judge.
pub const MAX_KINDS: usize = 10;
/// Conditions of one rule, `all`/`any` counted.
pub const MAX_CONDITIONS: usize = 20;
/// Nesting of `all`/`any`: the rule's own condition is level 1.
pub const MAX_DEPTH: usize = 3;
/// `{{path}}` placeholders in a message.
pub const MAX_PLACEHOLDERS: usize = 5;

/// A rule: objects of `kind` for which `when` holds have a problem titled `title`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProblemContribution {
    pub id: String,
    /// Shown as the problem's reason; unique among the extension's rules.
    pub title: String,
    pub kind: KindPattern,
    pub when: ProblemCondition,
    /// A field holding an RFC 3339 time: when the state began.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub since: Option<String>,
    /// The problem counts only this long after it began (or was first seen).
    #[serde(default)]
    pub grace_minutes: u32,
    /// It may send a notification; `false`: listed only.
    #[serde(default = "yes")]
    pub notify: bool,
    /// Text with `{{<field path>}}` placeholders.
    pub message: String,
}

fn yes() -> bool {
    true
}

/// A condition of a rule, tagged by `type`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ProblemCondition {
    /// The value at `path` is `value`.
    Equals {
        path: String,
        value: ProblemScalar,
    },
    /// The value at `path` is one of `values`.
    In {
        path: String,
        values: Vec<ProblemScalar>,
    },
    /// `path` holds a value (not `null`).
    Exists {
        path: String,
    },
    /// `path` holds nothing or `null`.
    Absent {
        path: String,
    },
    /// An entry of `.status.conditions` of this `conditionType` has `status` (and `reason`, when given).
    Condition {
        #[serde(rename = "conditionType")]
        condition_type: String,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        reason: Option<String>,
    },
    /// The value at `path` is a number (or a string that reads as one) above `value`.
    Above {
        path: String,
        #[ts(type = "number")]
        value: serde_json::Number,
    },
    /// The value at `path` is a number (or a string that reads as one) below `value`.
    Below {
        path: String,
        #[ts(type = "number")]
        value: serde_json::Number,
    },
    /// The time at `path` (RFC 3339) is more than `minutes` ago.
    OlderThan {
        path: String,
        minutes: u32,
    },
    All {
        of: Vec<ProblemCondition>,
    },
    Any {
        of: Vec<ProblemCondition>,
    },
}

/// A value a condition compares with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum ProblemScalar {
    Text(String),
    Number(#[ts(type = "number")] serde_json::Number),
    Flag(bool),
}

/// What reading a manifest checks of its rules beyond the schema: the API version, unique titles, the kinds, the
/// conditions' nesting and number, and every path (of `when`, `since` and the message).
pub(crate) fn check_problems(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let rules = &manifest.contributes.problems;
    let list = JsonPath::default().key("contributes").key("problems");
    if rules.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < PROBLEMS_API {
        return Err(at(
            &list,
            format!("needs sextantApi {PROBLEMS_API} or later"),
        ));
    }
    let mut kinds: Vec<&KindPattern> = Vec::new();
    for (i, rule) in rules.iter().enumerate() {
        let here = list.index(i);
        if let Some(first) = rules[..i]
            .iter()
            .position(|other| other.title.trim() == rule.title.trim())
        {
            return Err(at(
                &here.key("title"),
                format!("duplicate title (also {})", list.index(first)),
            ));
        }
        if !kinds.iter().any(|k| same_kind(k, &rule.kind)) {
            kinds.push(&rule.kind);
            if kinds.len() > MAX_KINDS {
                return Err(at(
                    &here.key("kind"),
                    format!("the rules judge at most {MAX_KINDS} kinds"),
                ));
            }
        }
        let mut count = 0;
        check_condition(&rule.when, &rule.kind, &here.key("when"), 1, &mut count)?;
        if let Some(since) = &rule.since {
            check_path(since, &rule.kind, &here.key("since"))?;
        }
        check_message(&rule.message, &rule.kind, &here.key("message"))?;
    }
    Ok(())
}

fn check_condition(
    condition: &ProblemCondition,
    kind: &KindPattern,
    path: &JsonPath,
    depth: usize,
    count: &mut usize,
) -> Result<(), ManifestError> {
    *count += 1;
    if *count > MAX_CONDITIONS {
        return Err(at(
            path,
            format!("a rule has at most {MAX_CONDITIONS} conditions"),
        ));
    }
    match condition {
        ProblemCondition::Equals { path: field, .. }
        | ProblemCondition::In { path: field, .. }
        | ProblemCondition::Exists { path: field }
        | ProblemCondition::Absent { path: field }
        | ProblemCondition::Above { path: field, .. }
        | ProblemCondition::Below { path: field, .. }
        | ProblemCondition::OlderThan { path: field, .. } => {
            check_path(field, kind, &path.key("path"))
        }
        ProblemCondition::Condition { .. } => Ok(()),
        ProblemCondition::All { of } | ProblemCondition::Any { of } => {
            if depth >= MAX_DEPTH {
                return Err(at(
                    path,
                    format!("`all` and `any` nest at most {MAX_DEPTH} deep"),
                ));
            }
            for (i, inner) in of.iter().enumerate() {
                check_condition(inner, kind, &path.key("of").index(i), depth + 1, count)?;
            }
            Ok(())
        }
    }
}

/// A field path of the custom columns' grammar that reads no secret of `kind`.
fn check_path(text: &str, kind: &KindPattern, path: &JsonPath) -> Result<(), ManifestError> {
    let Some(steps) = parse_field_path(text) else {
        return Err(at(
            path,
            "must be a field path such as `.status.phase`, `.items[0]` or `.metadata.labels[\"app\"]`",
        ));
    };
    if reads_secret(kind, &steps) {
        return Err(at(
            path,
            format!(
                "reads secret values of {}, which rules may not",
                kind_name(kind)
            ),
        ));
    }
    Ok(())
}

/// The placeholders of a message: each `{{…}}` a field path that reads no secret; no `{{` without its `}}`.
fn check_message(text: &str, kind: &KindPattern, path: &JsonPath) -> Result<(), ManifestError> {
    let placeholders = placeholders(text).ok_or_else(|| at(path, "has a `{{` without its `}}`"))?;
    if placeholders.len() > MAX_PLACEHOLDERS {
        return Err(at(
            path,
            format!("has at most {MAX_PLACEHOLDERS} placeholders"),
        ));
    }
    for field in placeholders {
        check_path(field.trim(), kind, path)?;
    }
    Ok(())
}

/// The insides of the `{{…}}` of `text`, in order; `None` when a `{{` has no `}}`.
pub fn placeholders(text: &str) -> Option<Vec<&str>> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let end = after.find("}}")?;
        out.push(&after[..end]);
        rest = &after[end + 2..];
    }
    Some(out)
}

/// Whether a field path of an object of `kind` reads a core Secret's values or is, holds or lies under an inline
/// secret path of the kind (kinds compared ignoring case, as the rule's kind is).
pub fn reads_secret(kind: &KindPattern, steps: &[PathStep]) -> bool {
    let secret_data = kind.group.is_empty()
        && kind.kind.eq_ignore_ascii_case("Secret")
        && matches!(steps.first(), Some(PathStep::Key(k)) if k == "data" || k == "stringData");
    secret_data
        || INLINE_SECRETS
            .iter()
            .filter(|k| {
                k.group.eq_ignore_ascii_case(&kind.group) && k.kind.eq_ignore_ascii_case(&kind.kind)
            })
            .flat_map(|k| k.paths.iter())
            .any(|secret| {
                secret.iter().zip(steps).all(|(want, got)| match got {
                    _ if *want == "*" => true,
                    PathStep::Key(key) => key == want,
                    PathStep::Index(_) => false,
                })
            })
}

/// The kinds the rules of `manifest` judge, each once, in order.
pub fn problem_kinds(manifest: &ExtensionManifest) -> Vec<KindPattern> {
    let mut out: Vec<KindPattern> = Vec::new();
    for rule in &manifest.contributes.problems {
        if !out.iter().any(|k| same_kind(k, &rule.kind)) {
            out.push(rule.kind.clone());
        }
    }
    out
}

/// Whether the manifest's rules judge only kinds in `granted`.
pub fn problems_within(manifest: &ExtensionManifest, granted: Option<&[KindPattern]>) -> bool {
    let kinds = problem_kinds(manifest);
    kinds.is_empty()
        || granted.is_some_and(|granted| {
            kinds
                .iter()
                .all(|k| granted.iter().any(|g| same_kind(g, k)))
        })
}

/// Where the rules of one kind run in a cluster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProblemScope {
    pub kind: KindPattern,
    /// The namespaces where the extension may read the kind; for a kind without namespaces only `All` runs it.
    pub namespaces: NamespaceScope,
}

/// For each kind of `kinds` (agreed to by the user), where its rules run in the cluster with context `cluster_name`:
/// the namespaces where `granted` allows Read; a kind allowed nowhere is left out.
pub fn problem_scopes(
    granted: &ExtensionPermissions,
    cluster_name: &str,
    kinds: &[KindPattern],
) -> Vec<ProblemScope> {
    if !granted.clusters.covers(cluster_name) {
        return Vec::new();
    }
    // `..default()` keeps this building when the agent's access gains fields; the rules are all an extension has.
    #[allow(clippy::needless_update)]
    let access = ClusterAccess {
        preset: AccessPreset::Custom,
        rules: granted.rules.clone(),
        ..ClusterAccess::default()
    };
    kinds
        .iter()
        .filter_map(|kind| {
            let namespaces = access::allowed_namespaces(&access, kind, AccessAction::Read);
            let nowhere =
                matches!(&namespaces, NamespaceScope::Only { namespaces } if namespaces.is_empty());
            (!nowhere).then(|| ProblemScope {
                kind: kind.clone(),
                namespaces,
            })
        })
        .collect()
}

fn same_kind(a: &KindPattern, b: &KindPattern) -> bool {
    a.group.eq_ignore_ascii_case(&b.group) && a.kind.eq_ignore_ascii_case(&b.kind)
}

fn kind_name(kind: &KindPattern) -> String {
    if kind.group.is_empty() {
        kind.kind.clone()
    } else {
        format!("{}/{}", kind.group, kind.kind)
    }
}

fn at(path: &JsonPath, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.to_string(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::extensions::installed::asks_within;
    use crate::extensions::parse_manifest;

    fn manifest(problems: serde_json::Value) -> ExtensionManifest {
        parse_manifest(
            json!({
                "id": "ceph", "name": "Ceph", "version": "1.0.0", "description": "", "author": "Me",
                "sextantApi": 2, "entry": "index.html",
                "permissions": {
                    "clusters": { "type": "only", "names": ["prod"] },
                    "rules": [
                        { "namespaces": { "type": "only", "namespaces": ["rook-ceph"] },
                          "kinds": { "type": "only", "kinds": [{ "group": "ceph.rook.io", "kind": "CephCluster" }] },
                          "actions": ["read"] },
                        { "namespaces": { "type": "all" },
                          "kinds": { "type": "only", "kinds": [{ "group": "", "kind": "Node" }] },
                          "actions": ["read"] }
                    ]
                },
                "contributes": { "problems": problems }
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap()
    }

    fn rule(group: &str, kind: &str, id: &str) -> serde_json::Value {
        json!({ "id": id, "title": id, "kind": { "group": group, "kind": kind },
                "when": { "type": "exists", "path": ".status" }, "message": "x" })
    }

    fn kind(group: &str, kind: &str) -> KindPattern {
        KindPattern::new(group, kind)
    }

    #[test]
    fn a_rule_reads_with_its_defaults() {
        let m = manifest(json!([rule("ceph.rook.io", "CephCluster", "a")]));
        let rule = &m.contributes.problems[0];
        assert!(rule.notify);
        assert_eq!(rule.grace_minutes, 0);
        assert_eq!(rule.since, None);
        assert_eq!(
            rule.when,
            ProblemCondition::Exists {
                path: ".status".into()
            }
        );
        // The wire form the window reads: tagged, camelCase fields.
        let written = serde_json::to_value(&m.contributes.problems).unwrap();
        assert_eq!(
            written[0]["when"],
            json!({ "type": "exists", "path": ".status" })
        );
        assert_eq!(written[0]["graceMinutes"], json!(0));
    }

    #[test]
    fn rules_run_only_for_agreed_kinds_and_a_new_kind_asks_again() {
        let m = manifest(json!([
            rule("ceph.rook.io", "CephCluster", "a"),
            rule("ceph.rook.io", "cephcluster", "b"),
            rule("", "Node", "c"),
        ]));
        assert_eq!(
            problem_kinds(&m),
            vec![kind("ceph.rook.io", "CephCluster"), kind("", "Node")]
        );
        let agreed = problem_kinds(&m);
        assert!(problems_within(&m, Some(&agreed)));
        assert!(asks_within(&m, &m.permissions, None, Some(&agreed), None));
        // A kind not agreed to (an update that judges Nodes now), or nothing agreed to: consent again.
        let fewer = [kind("ceph.rook.io", "CephCluster")];
        assert!(!problems_within(&m, Some(&fewer)));
        assert!(!asks_within(&m, &m.permissions, None, Some(&fewer), None));
        assert!(!asks_within(&m, &m.permissions, None, None, None));
        // Without rules nothing needs agreeing to.
        assert!(problems_within(&manifest(json!([])), None));
    }

    #[test]
    fn rules_run_where_the_extension_may_read() {
        let m = manifest(json!([]));
        let kinds = [
            kind("ceph.rook.io", "CephCluster"),
            kind("", "Node"),
            kind("ceph.rook.io", "CephBlockPool"),
        ];
        assert_eq!(
            problem_scopes(&m.permissions, "prod", &kinds),
            vec![
                ProblemScope {
                    kind: kind("ceph.rook.io", "CephCluster"),
                    namespaces: NamespaceScope::Only {
                        namespaces: vec!["rook-ceph".into()]
                    },
                },
                ProblemScope {
                    kind: kind("", "Node"),
                    namespaces: NamespaceScope::All,
                },
            ],
            "a kind the extension may not read is left out"
        );
        assert!(problem_scopes(&m.permissions, "staging", &kinds).is_empty());
    }

    #[test]
    fn placeholders_are_read_in_order() {
        assert_eq!(
            placeholders("a {{.x}} b {{ .y[0] }}{{.z}}"),
            Some(vec![".x", " .y[0] ", ".z"])
        );
        assert_eq!(placeholders("no placeholders } {"), Some(vec![]));
        assert_eq!(placeholders("open {{.x"), None);
    }

    #[test]
    fn secret_paths_are_judged_ignoring_the_kinds_case() {
        let steps = parse_field_path(".spec.tls.key").unwrap();
        assert!(reads_secret(&kind("ROUTE.openshift.io", "route"), &steps));
        assert!(!reads_secret(&kind("apps", "Deployment"), &steps));
        let data = parse_field_path(".data").unwrap();
        assert!(reads_secret(&kind("", "secret"), &data));
        assert!(!reads_secret(&kind("", "ConfigMap"), &data));
        // A list index stands for any item where the table says `*`, never for a named field.
        let trigger = parse_field_path(".spec.triggers[2].generic.secret").unwrap();
        assert!(reads_secret(
            &kind("build.openshift.io", "BuildConfig"),
            &trigger
        ));
        let named = parse_field_path(".spec[0]").unwrap();
        assert!(!reads_secret(&kind("route.openshift.io", "Route"), &named));
    }
}
