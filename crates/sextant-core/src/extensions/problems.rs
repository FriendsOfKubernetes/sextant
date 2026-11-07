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
/// The extension API version that brought rules across objects: `missing`, `toldThroughOwner`, `newestPer` (ADR-0144).
pub const ACROSS_API: u32 = 3;
/// The extension API version that brought `not` and a rule's `source` (ADR-0152).
pub const SOURCES_API: u32 = 4;
/// Longest label selector of a rule's source (the schema's `maxLength`).
pub const MAX_SELECTOR_CHARS: usize = 1000;
/// Rules per extension (the schema's `maxItems`).
pub const MAX_RULES: usize = 20;
/// Kinds the rules of one extension judge.
pub const MAX_KINDS: usize = 10;
/// Conditions of one rule, `all`/`any` counted.
pub const MAX_CONDITIONS: usize = 20;
/// Conditions of one rule from `sextantApi` 4 (#381).
pub const MAX_CONDITIONS_4: usize = 30;
/// Nesting of `all`/`any`: the rule's own condition is level 1.
pub const MAX_DEPTH: usize = 3;
/// Nesting from `sextantApi` 4 (#381): an older Sextant reads only older manifests, so the limits grow with the version.
pub const MAX_DEPTH_4: usize = 4;

/// The limits of a rule's conditions for a manifest of `api`: (conditions, nesting).
pub fn condition_limits(api: u32) -> (usize, usize) {
    if api >= SOURCES_API {
        (MAX_CONDITIONS_4, MAX_DEPTH_4)
    } else {
        (MAX_CONDITIONS, MAX_DEPTH)
    }
}
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
    /// The problem is not told while the object's controller (its owner reference with `controller: true`) has a
    /// problem of this extension's rules: the owner tells it (ADR-0144); `sextantApi` 3.
    #[serde(default)]
    pub told_through_owner: bool,
    /// A label key: of the objects of the rule's kind in one namespace with the same value of this label, only the
    /// newest (by `metadata.creationTimestamp`) can have the problem (ADR-0144); `sextantApi` 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub newest_per: Option<String>,
    /// Which objects of the kind the rule sees: those a label selector picks, and only their metadata (ADR-0152);
    /// `sextantApi` 4. Every rule of a kind has the same source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<RuleSource>,
    /// Rules with the same group notify once per object for all of them (ADR-0161); `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group: Option<String>,
    /// The reason shown, from the object: text with `{{<field path>}}` placeholders, as `message` (#370); the title
    /// when it comes out empty. Not translated. `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// The objects a rule's kind is watched for (`ProblemContribution.source`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuleSource {
    /// A Kubernetes label selector the watch passes to the API server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label_selector: Option<String>,
    /// Only `apiVersion`, `kind` and `metadata` are watched; every path of the rule is under `.metadata`.
    #[serde(default)]
    pub metadata_only: bool,
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
    /// The values at `path` and `otherPath` are the same scalar, or the same number where one is written as text
    /// (`"3"` and `3`, #369) (ADR-0161); `sextantApi` 4. With `not`: they differ.
    Same {
        path: String,
        #[serde(rename = "otherPath")]
        other_path: String,
    },
    /// The value at `path` is a number at least the one at `otherPath` (each a number, a string that reads as one, or a
    /// list counted as its length; #386); `sextantApi` 4.
    AtLeast {
        path: String,
        #[serde(rename = "otherPath")]
        other_path: String,
    },
    /// The time at `path` (RFC 3339) is more than `minutes` ago.
    OlderThan {
        path: String,
        minutes: u32,
    },
    /// The text at `path` names no object of `kind` — in the object's namespace, or for a kind without namespaces in
    /// the cluster (ADR-0144); `sextantApi` 3. Unknown (so not holding) while that list is not read in full where the
    /// extension may read it. Not inside `any`.
    Missing {
        path: String,
        kind: KindPattern,
    },
    All {
        of: Vec<ProblemCondition>,
    },
    Any {
        of: Vec<ProblemCondition>,
    },
    /// Holds where `of` does not (ADR-0152); `sextantApi` 4. Never around `missing`. Around a condition that holds
    /// only from a time on (`olderThan`), it holds until that time.
    Not {
        of: Box<ProblemCondition>,
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
        let metadata_only = check_source(rule, rules, manifest.sextant_api, &list, &here)?;
        let mut count = 0;
        let mut checks = ConditionChecks {
            api: manifest.sextant_api,
            kinds: &mut kinds,
            count: &mut count,
            metadata_only,
            single: false,
        };
        check_condition(
            &rule.when,
            &rule.kind,
            &here.key("when"),
            1,
            Inside::Top,
            &mut checks,
        )?;
        if rule.told_through_owner && manifest.sextant_api < ACROSS_API {
            return Err(at(
                &here.key("toldThroughOwner"),
                format!("needs sextantApi {ACROSS_API} or later"),
            ));
        }
        if let Some(label) = &rule.newest_per {
            if manifest.sextant_api < ACROSS_API {
                return Err(at(
                    &here.key("newestPer"),
                    format!("needs sextantApi {ACROSS_API} or later"),
                ));
            }
            if !is_label_key(label) {
                return Err(at(
                    &here.key("newestPer"),
                    "must be a label key such as `app` or `example.com/name`",
                ));
            }
        }
        if rule.group.is_some() && manifest.sextant_api < SOURCES_API {
            return Err(at(
                &here.key("group"),
                format!("needs sextantApi {SOURCES_API} or later"),
            ));
        }
        if let Some(reason) = &rule.reason {
            if manifest.sextant_api < SOURCES_API {
                return Err(at(
                    &here.key("reason"),
                    format!("needs sextantApi {SOURCES_API} or later"),
                ));
            }
            check_message(reason, &rule.kind, &here.key("reason"), metadata_only)?;
        }
        if let Some(since) = &rule.since {
            check_rule_path(since, &rule.kind, &here.key("since"), metadata_only)?;
        }
        check_message(
            &rule.message,
            &rule.kind,
            &here.key("message"),
            metadata_only,
        )?;
    }
    Ok(())
}

/// A rule's `source`: written only from `sextantApi` 4, with at least one field, a label selector Kubernetes reads,
/// and the same on every rule of the kind. Whether it watches metadata only.
fn check_source(
    rule: &ProblemContribution,
    rules: &[ProblemContribution],
    api: u32,
    list: &JsonPath,
    here: &JsonPath,
) -> Result<bool, ManifestError> {
    if let Some(source) = &rule.source {
        let path = here.key("source");
        if api < SOURCES_API {
            return Err(at(
                &path,
                format!("needs sextantApi {SOURCES_API} or later"),
            ));
        }
        if source.label_selector.is_none() && !source.metadata_only {
            return Err(at(
                &path,
                "names a `labelSelector`, `metadataOnly: true` or both",
            ));
        }
        if let Some(selector) = &source.label_selector
            && !is_set_selector(selector)
        {
            return Err(at(
                &path.key("labelSelector"),
                "must be a Kubernetes label selector such as `app=web`, `tier in (a,b)` or `!canary`",
            ));
        }
    }
    if let Some(first) = rules
        .iter()
        .position(|other| same_kind(&other.kind, &rule.kind))
        && rules[first].source != rule.source
    {
        return Err(at(
            &here.key("source"),
            format!(
                "every rule of {} has the same source (as {})",
                kind_name(&rule.kind),
                list.index(first)
            ),
        ));
    }
    Ok(rule.source.as_ref().is_some_and(|s| s.metadata_only))
}

/// What checking one rule's conditions keeps across them.
struct ConditionChecks<'a, 'k> {
    api: u32,
    /// The kinds the rules judge or look up so far (`missing` adds its kind).
    kinds: &'a mut Vec<&'k KindPattern>,
    count: &'a mut usize,
    /// The rule's source watches metadata only: every path is under `.metadata`.
    metadata_only: bool,
    /// A condition the window evaluates on one object (an action's `when`, a column's case): no `missing`.
    single: bool,
}

/// A condition of an action or a column (ADR-0153, ADR-0154): the grammar of problem rules without `missing`, its
/// paths reading no secret of any of `kinds`, within the same nesting and size limits.
pub(crate) fn check_object_condition(
    condition: &ProblemCondition,
    kinds: &[KindPattern],
    path: &JsonPath,
    api: u32,
) -> Result<(), ManifestError> {
    for kind in kinds {
        let mut seen = Vec::new();
        let mut count = 0;
        let mut checks = ConditionChecks {
            api,
            kinds: &mut seen,
            count: &mut count,
            metadata_only: false,
            single: true,
        };
        check_condition(condition, kind, path, 1, Inside::Top, &mut checks)?;
    }
    Ok(())
}

/// What a condition is inside of: `missing` is refused inside `any` and `not`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Inside {
    Top,
    Any,
    Not,
}

fn check_condition<'k>(
    condition: &'k ProblemCondition,
    kind: &KindPattern,
    path: &JsonPath,
    depth: usize,
    inside: Inside,
    checks: &mut ConditionChecks<'_, 'k>,
) -> Result<(), ManifestError> {
    *checks.count += 1;
    let count = &*checks.count;
    let (max_conditions, max_depth) = condition_limits(checks.api);
    if *count > max_conditions {
        return Err(at(
            path,
            format!("a rule has at most {max_conditions} conditions"),
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
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)
        }
        ProblemCondition::Same {
            path: field,
            other_path,
        }
        | ProblemCondition::AtLeast {
            path: field,
            other_path,
        } => {
            if checks.api < SOURCES_API {
                let name = if matches!(condition, ProblemCondition::Same { .. }) {
                    "same"
                } else {
                    "atLeast"
                };
                return Err(at(
                    &path.key("type"),
                    format!("`{name}` needs sextantApi {SOURCES_API} or later"),
                ));
            }
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)?;
            check_rule_path(
                other_path,
                kind,
                &path.key("otherPath"),
                checks.metadata_only,
            )
        }
        ProblemCondition::Condition { .. } if checks.metadata_only => Err(at(
            &path.key("type"),
            "`condition` reads `.status.conditions`, which a `metadataOnly` source does not watch",
        )),
        ProblemCondition::Condition { .. } => Ok(()),
        ProblemCondition::Missing {
            path: field,
            kind: target,
        } => {
            if checks.single {
                return Err(at(
                    &path.key("type"),
                    "`missing` judges across objects: only problem rules may use it",
                ));
            }
            if checks.api < ACROSS_API {
                return Err(at(
                    &path.key("type"),
                    format!("`missing` needs sextantApi {ACROSS_API} or later"),
                ));
            }
            match inside {
                Inside::Any => {
                    return Err(at(
                        &path.key("type"),
                        "`missing` cannot be inside `any`: a list not read would make the whole `any` unknown",
                    ));
                }
                Inside::Not => {
                    return Err(at(
                        &path.key("type"),
                        "`missing` cannot be inside `not`: a list not read would make it unknown",
                    ));
                }
                Inside::Top => {}
            }
            if target.group.is_empty() && target.kind.eq_ignore_ascii_case("Secret") {
                return Err(at(&path.key("kind"), "Secrets are never listed for rules"));
            }
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)?;
            if !checks.kinds.iter().any(|k| same_kind(k, target)) {
                checks.kinds.push(target);
                if checks.kinds.len() > MAX_KINDS {
                    return Err(at(
                        &path.key("kind"),
                        format!("the rules judge at most {MAX_KINDS} kinds"),
                    ));
                }
            }
            Ok(())
        }
        ProblemCondition::All { of } | ProblemCondition::Any { of } => {
            if depth >= max_depth {
                return Err(at(
                    path,
                    format!("`all` and `any` nest at most {max_depth} deep"),
                ));
            }
            let inner_inside = match (inside, condition) {
                (Inside::Top, ProblemCondition::Any { .. }) => Inside::Any,
                _ => inside,
            };
            for (i, inner) in of.iter().enumerate() {
                check_condition(
                    inner,
                    kind,
                    &path.key("of").index(i),
                    depth + 1,
                    inner_inside,
                    checks,
                )?;
            }
            Ok(())
        }
        ProblemCondition::Not { of } => {
            if checks.api < SOURCES_API {
                return Err(at(
                    &path.key("type"),
                    format!("`not` needs sextantApi {SOURCES_API} or later"),
                ));
            }
            if depth >= max_depth {
                return Err(at(
                    path,
                    format!("`all`, `any` and `not` nest at most {max_depth} deep"),
                ));
            }
            check_condition(of, kind, &path.key("of"), depth + 1, Inside::Not, checks)
        }
    }
}

/// A label key: an optional DNS subdomain prefix and `/`, then a name of 1–63 letters, digits, `-`, `_` and `.`,
/// starting and ending with a letter or digit.
fn is_label_key(text: &str) -> bool {
    let (prefix, name) = match text.rsplit_once('/') {
        Some((prefix, name)) => (Some(prefix), name),
        None => (None, text),
    };
    let alnum = |c: char| c.is_ascii_alphanumeric();
    let name_ok = !name.is_empty()
        && name.len() <= 63
        && name.starts_with(alnum)
        && name.ends_with(alnum)
        && name
            .chars()
            .all(|c| alnum(c) || matches!(c, '-' | '_' | '.'));
    let prefix_ok = prefix.is_none_or(|p| {
        !p.is_empty()
            && p.len() <= 253
            && p.split('.').all(|part| {
                !part.is_empty()
                    && part.len() <= 63
                    && part.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
                    && part.ends_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
                    && part
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            })
    });
    name_ok && prefix_ok
}

/// The kinds a condition looks up (`missing`), each once, added to `out`.
fn looked_up<'c>(condition: &'c ProblemCondition, out: &mut Vec<&'c KindPattern>) {
    match condition {
        ProblemCondition::Missing { kind, .. } => {
            if !out.iter().any(|k| same_kind(k, kind)) {
                out.push(kind);
            }
        }
        ProblemCondition::All { of } | ProblemCondition::Any { of } => {
            for inner in of {
                looked_up(inner, out);
            }
        }
        ProblemCondition::Not { of } => looked_up(of, out),
        _ => {}
    }
}

/// A field path of the custom columns' grammar that reads no secret of `kind`.
pub(crate) fn check_path(
    text: &str,
    kind: &KindPattern,
    path: &JsonPath,
) -> Result<(), ManifestError> {
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

/// A path of a rule: [`check_path`], and under `.metadata` when the rule's source watches metadata only.
fn check_rule_path(
    text: &str,
    kind: &KindPattern,
    path: &JsonPath,
    metadata_only: bool,
) -> Result<(), ManifestError> {
    check_path(text, kind, path)?;
    if metadata_only
        && !matches!(parse_field_path(text).as_deref(), Some([PathStep::Key(first), ..]) if first == "metadata")
    {
        return Err(at(
            path,
            "must be under `.metadata`: the rule's source watches metadata only",
        ));
    }
    Ok(())
}

/// A Kubernetes label selector (`labels.Parse`): requirements separated by commas, each `key`, `!key`, `key=value`,
/// `key==value`, `key!=value`, `key in (v, …)` or `key notin (v, …)`; keys and values as Kubernetes allows them
/// (a value may be empty).
pub fn is_set_selector(text: &str) -> bool {
    if text.is_empty() || text.chars().count() > MAX_SELECTOR_CHARS {
        return false;
    }
    let mut requirements = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (i, c) in text.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            ',' if depth == 0 => {
                requirements.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    if depth != 0 {
        return false;
    }
    requirements.push(&text[start..]);
    requirements.into_iter().all(is_requirement)
}

fn is_requirement(text: &str) -> bool {
    let text = text.trim();
    if let Some(key) = text.strip_prefix('!') {
        return is_label_key(key.trim());
    }
    for op in ["!=", "==", "="] {
        if let Some((key, value)) = text.split_once(op) {
            return is_label_key(key.trim()) && is_selector_value(value.trim());
        }
    }
    for op in [" notin ", " in "] {
        if let Some((key, values)) = text.split_once(op) {
            let values = values.trim();
            let Some(inner) = values.strip_prefix('(').and_then(|v| v.strip_suffix(')')) else {
                return false;
            };
            return is_label_key(key.trim())
                && inner.split(',').all(|v| is_selector_value(v.trim()));
        }
    }
    is_label_key(text)
}

/// A label value or nothing.
fn is_selector_value(text: &str) -> bool {
    text.is_empty() || (is_label_key(text) && !text.contains('/'))
}

/// The placeholders of a message: each `{{…}}` a field path that reads no secret; no `{{` without its `}}`.
pub(crate) fn check_message(
    text: &str,
    kind: &KindPattern,
    path: &JsonPath,
    metadata_only: bool,
) -> Result<(), ManifestError> {
    let placeholders = placeholders(text).ok_or_else(|| at(path, "has a `{{` without its `}}`"))?;
    if placeholders.len() > MAX_PLACEHOLDERS {
        return Err(at(
            path,
            format!("has at most {MAX_PLACEHOLDERS} placeholders"),
        ));
    }
    for field in placeholders {
        check_rule_path(field.trim(), kind, path, metadata_only)?;
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
                    // A map's value picked by its fields may sit under any key (#392): as `*`.
                    PathStep::Match { .. } => true,
                })
            })
}

/// The kinds the rules of `manifest` judge or look up (`missing`), each once, in order: what the user agrees to have
/// them read (`grantedProblems`).
pub fn problem_kinds(manifest: &ExtensionManifest) -> Vec<KindPattern> {
    let mut out: Vec<KindPattern> = Vec::new();
    for rule in &manifest.contributes.problems {
        if !out.iter().any(|k| same_kind(k, &rule.kind)) {
            out.push(rule.kind.clone());
        }
        let mut targets = Vec::new();
        looked_up(&rule.when, &mut targets);
        for target in targets {
            if !out.iter().any(|k| same_kind(k, target)) {
                out.push(target.clone());
            }
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
    use crate::extensions::installed::{Granted, asks_within};
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
        assert!(asks_within(
            &m,
            &m.permissions,
            Granted {
                problems: Some(&agreed),
                ..Granted::default()
            }
        ));
        // A kind not agreed to (an update that judges Nodes now), or nothing agreed to: consent again.
        let fewer = [kind("ceph.rook.io", "CephCluster")];
        assert!(!problems_within(&m, Some(&fewer)));
        assert!(!asks_within(
            &m,
            &m.permissions,
            Granted {
                problems: Some(&fewer),
                ..Granted::default()
            }
        ));
        assert!(!asks_within(&m, &m.permissions, Granted::default()));
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
