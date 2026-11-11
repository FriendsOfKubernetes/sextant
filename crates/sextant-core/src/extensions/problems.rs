//! Problem rules of an extension (`contributes.problems`, ADR-0137): what a rule is, what reading a manifest checks
//! beyond its schema, and where a rule may run.
//!
//! The window evaluates the rules (`src/extensions/problemRules.ts`) on the problems store's watches; no extension
//! code runs for them. Here: the paths of a rule are field paths of the custom columns' grammar (ADR-0099) and never
//! read a core Secret's values or an inline secret field of the rule's kind (ADR-0120); a message has at most
//! [`MAX_PLACEHOLDERS`] placeholders; conditions nest at most [`MAX_DEPTH`] deep, [`MAX_CONDITIONS`] per rule.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::manifest::{ExtensionManifest, ManifestError};
use super::permissions::ExtensionPermissions;
use super::schema::JsonPath;
use crate::access::{AccessAction, KindPattern, NamespaceScope};
use crate::resources::inline_secrets::INLINE_SECRETS;
use crate::settings::custom_columns::{
    MatchPick, PathStep, compares_trimmed, list_steps, parse_field_path,
};

/// The `kind` of a rule that names none (its kinds come from definitions, `kindsFrom`).
fn no_kind() -> KindPattern {
    KindPattern::new("", "")
}

/// The extension API version that brought `contributes.problems`.
pub const PROBLEMS_API: u32 = 2;
/// The extension API version that brought rules across objects: `missing`, `toldThroughOwner`, `newestPer` (ADR-0144).
pub const ACROSS_API: u32 = 3;
/// The extension API version that brought `not` and a rule's `source` (ADR-0152).
pub const SOURCES_API: u32 = 4;
/// The API of what the moved views still lacked after 0.30.0 (#417, ADR-0169): Sextant 0.30.1.
pub const PARITY_API: u32 = 5;
/// Longest label selector of a rule's source (the schema's `maxLength`).
pub const MAX_SELECTOR_CHARS: usize = 1000;
/// Rules per extension before `sextantApi` 4.
pub const MAX_RULES: usize = 20;
/// Rules per extension from `sextantApi` 4 (the schema's `maxItems`).
pub const MAX_RULES_4: usize = 60;
/// Kinds the rules of one extension judge before `sextantApi` 4.
pub const MAX_KINDS: usize = 10;
/// Kinds the rules of one extension judge from `sextantApi` 4 (Knative's and Crossplane's views need more).
pub const MAX_KINDS_4: usize = 30;
/// Rules per extension from `sextantApi` 5 (ADR-0169; the schema's `maxItems`): every reference of Traefik's kinds, in
/// both of its groups.
pub const MAX_RULES_5: usize = 100;

/// The rules and the kinds they judge an extension of `api` may have: an older Sextant reads only older manifests, so
/// the limits grow with the version.
pub fn rule_limits(api: u32) -> (usize, usize) {
    if api >= PARITY_API {
        (MAX_RULES_5, MAX_KINDS_4)
    } else if api >= SOURCES_API {
        (MAX_RULES_4, MAX_KINDS_4)
    } else {
        (MAX_RULES, MAX_KINDS)
    }
}
/// Conditions of one rule, `all`/`any` counted.
pub const MAX_CONDITIONS: usize = 20;
/// Conditions of one rule from `sextantApi` 4 (#381).
pub const MAX_CONDITIONS_4: usize = 40;
/// Nesting of `all`/`any`: the rule's own condition is level 1.
pub const MAX_DEPTH: usize = 3;
/// Nesting from `sextantApi` 4 (#381): an older Sextant reads only older manifests, so the limits grow with the version.
pub const MAX_DEPTH_4: usize = 6;

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
/// `enteredWithin` counts at most a week (#393).
pub const MAX_ENTERED_MINUTES: u32 = 10_080;

/// A rule: objects of `kind` for which `when` holds have a problem titled `title`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProblemContribution {
    pub id: String,
    /// Shown as the problem's reason; unique among the extension's rules.
    pub title: String,
    /// The kind judged; empty (`""`/`""`) for a rule whose kinds come from definitions (`kinds_from`).
    #[serde(default = "no_kind")]
    pub kind: KindPattern,
    /// The kinds judged, read at run time from the objects of a definition kind (`sextantApi` 4,
    /// [`super::kinds_from`]), instead of `kind`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kinds_from: Option<super::kinds_from::KindsFrom>,
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
    /// Not told while an object of the rule's kind that names this one in its list at `path` — directly or through
    /// others that name each other there — holds `when` (#404): an orphaned HTTPProxy under an invalid one, which
    /// tells it. `sextantApi` 4; unknown (not told) while those rows are not read in full.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub told_through_referrer: Option<ReferrerRule>,
    /// A label key: of the objects of the rule's kind in one namespace with the same value of this label, only the
    /// newest (by `metadata.creationTimestamp`) can have the problem (ADR-0144); `sextantApi` 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub newest_per: Option<String>,
    /// With `newestPer`, what "newest" is ranked by instead of the creation time (#404): a number, the largest
    /// newest (a Build's `openshift.io/build.number`). `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub newest_by: Option<String>,
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
    /// A field path whose value, when the object has one, is what a notification is about instead of the object
    /// (`<kind>/<namespace>/<value>`): the runs of one CronWorkflow notify as one (#394). `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notify_as: Option<String>,
    /// The id of one of `contributes.problemCategories` the rule's problems belong to, instead of the extension's own
    /// category (#410). `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub category: Option<String>,
    /// The reason when `reason` comes out empty, as written (a code like `NotReady`), instead of the title (#404).
    /// `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason_or: Option<String>,
    /// The number whose CLDR plural form picks the message (#404): a numeric path, `|count`/`|sum` allowed; with
    /// `messageForms`. `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub plural_by: Option<String>,
    /// The message by plural form besides `other`, which is `message` (#404): `{"one": "1 policy failed: …"}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message_forms: Option<std::collections::BTreeMap<String, String>>,
    /// Field paths tried in order when `since` gives no time (`endTime`, else `startTime`, else the creation; #407).
    /// `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub since_or: Option<Vec<String>>,
    /// The object the problem is about when it is not the judged one (#405): a failed InstallPlan a Subscription names,
    /// the ClusterPolicy a component DaemonSet belongs to, the object a policy report names. `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub about: Option<RuleAbout>,
    /// Field paths whose values are the problem's progress (#405): when they change, it counts as first seen now, so a
    /// grace measures the time without progress (a rollout's counts, a plan's phase). At most 4; `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stamp: Option<Vec<String>>,
    /// Field paths whose values, when they change, make the problem notify again (#407): a new restart count, a new
    /// reason. At most 4; `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notify_again_on: Option<Vec<String>>,
    /// `seconds`: `since` and `sinceOr` hold seconds since 1970, not RFC 3339 times (a policy result's
    /// `timestamp.seconds`, #404). `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub since_unit: Option<SinceUnit>,
}

/// How a rule's `since` is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SinceUnit {
    Seconds,
}

/// Which object a problem is about (`ProblemContribution.about`): its kind written out, or read from the judged object
/// (`apiVersionPath` + `kindPath`, a policy report's `scope`), its name read, its namespace read, the judged object's
/// (the default), or none (`clusterScoped`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RuleAbout {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<crate::resources::KindRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub api_version_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind_path: Option<String>,
    pub name_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub namespace_path: Option<String>,
    #[serde(default)]
    pub cluster_scoped: bool,
}

/// Fallback paths of a rule's `since`.
pub const MAX_SINCE_OR: usize = 4;

/// A problem category of an extension's own besides its main one (#410): a title, and whether it is off until the user
/// turns it on, as Sextant's opt-in categories are. Never given to agents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProblemCategoryContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub opt_in: bool,
}

/// Categories of one extension besides its main one.
pub const MAX_PROBLEM_CATEGORIES: usize = 5;

/// `contributes.narrowLookups` (ADR-0167 amendment): kinds some rule looks up (`missing`, `related`, `relatedBy`,
/// `selectsNone`), that no rule judges, no `kindsFrom` reads and no judge reads, each once.
pub(crate) fn check_narrow_lookups(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let list = JsonPath::default().key("contributes").key("narrowLookups");
    let kinds = &manifest.contributes.narrow_lookups;
    if kinds.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < SOURCES_API {
        return Err(at(
            &list,
            format!("needs sextantApi {SOURCES_API} or later"),
        ));
    }
    let mut looked: Vec<&KindPattern> = Vec::new();
    for rule in &manifest.contributes.problems {
        looked_up(&rule.when, &mut looked);
    }
    let judged = super::problem_judges::judge_kinds(manifest);
    for (i, kind) in kinds.iter().enumerate() {
        let here = list.index(i);
        if kinds[..i].iter().any(|k| same_kind(k, kind)) {
            return Err(at(&here, "is named twice"));
        }
        if !looked.iter().any(|k| same_kind(k, kind)) {
            return Err(at(
                &here,
                "is no kind the rules look up (`missing`, `related`, `relatedBy`, `selectsNone`)",
            ));
        }
        let judges_it = manifest.contributes.problems.iter().any(|rule| {
            same_kind(&rule.kind, kind)
                || rule
                    .kinds_from
                    .as_ref()
                    .is_some_and(|f| same_kind(&f.kind, kind))
        }) || judged.iter().any(|k| same_kind(k, kind));
        if judges_it {
            return Err(at(
                &here,
                "is a kind the rules or judges read whole: only a kind they only look up is listed in part",
            ));
        }
    }
    Ok(())
}

/// How the window lists a kind the rules only look up (`contributes.lookupSources`, ADR-0169).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LookupSource {
    pub kind: KindPattern,
    /// A Kubernetes label selector the watch passes to the API server: only the objects it picks are looked up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label_selector: Option<String>,
    /// The most objects listed: 1 to 20 000, 5000 without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_objects: Option<u32>,
}

/// `contributes.lookupSources` (ADR-0169): kinds some rule looks up and no rule judges, no `kindsFrom` reads and no
/// judge reads, each once, with a label selector Kubernetes reads or a cap.
pub(crate) fn check_lookup_sources(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let list = JsonPath::default().key("contributes").key("lookupSources");
    let sources = &manifest.contributes.lookup_sources;
    if sources.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < PARITY_API {
        return Err(at(&list, format!("needs sextantApi {PARITY_API} or later")));
    }
    let mut looked: Vec<&KindPattern> = Vec::new();
    for rule in &manifest.contributes.problems {
        looked_up(&rule.when, &mut looked);
    }
    let judged = super::problem_judges::judge_kinds(manifest);
    for (i, source) in sources.iter().enumerate() {
        let here = list.index(i);
        let kind = &source.kind;
        if sources[..i].iter().any(|s| same_kind(&s.kind, kind)) {
            return Err(at(&here.key("kind"), "is named twice"));
        }
        if !looked.iter().any(|k| same_kind(k, kind)) {
            return Err(at(
                &here.key("kind"),
                "is no kind the rules look up (`missing`, `related`, `relatedBy`, `selectsNone`)",
            ));
        }
        let judges_it = manifest.contributes.problems.iter().any(|rule| {
            same_kind(&rule.kind, kind)
                || rule
                    .kinds_from
                    .as_ref()
                    .is_some_and(|f| same_kind(&f.kind, kind))
        }) || judged.iter().any(|k| same_kind(k, kind));
        if judges_it {
            return Err(at(
                &here.key("kind"),
                "is a kind a rule or judge reads: its rules' `source` says how it is listed",
            ));
        }
        if source.label_selector.is_none() && source.max_objects.is_none() {
            return Err(at(&here, "names a `labelSelector`, a `maxObjects` or both"));
        }
        if source.max_objects.is_some_and(|n| n == 0 || n > 20_000) {
            return Err(at(&here.key("maxObjects"), "is 1 to 20 000"));
        }
        if let Some(selector) = &source.label_selector
            && !is_set_selector(selector)
        {
            return Err(at(
                &here.key("labelSelector"),
                "must be a Kubernetes label selector such as `app=web`, `tier in (a,b)` or `!canary`",
            ));
        }
    }
    Ok(())
}

/// `contributes.problemCategories` and each rule's `category` (#410).
pub(crate) fn check_problem_categories(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let list = JsonPath::default()
        .key("contributes")
        .key("problemCategories");
    let categories = &manifest.contributes.problem_categories;
    if manifest.contributes.problems_title.is_some() {
        let title = JsonPath::default().key("contributes").key("problemsTitle");
        if manifest.sextant_api < SOURCES_API {
            return Err(at(
                &title,
                format!("needs sextantApi {SOURCES_API} or later"),
            ));
        }
        if manifest.contributes.problems.is_empty() {
            return Err(at(&title, "needs `contributes.problems`"));
        }
    }
    if !categories.is_empty() && manifest.sextant_api < SOURCES_API {
        return Err(at(
            &list,
            format!("needs sextantApi {SOURCES_API} or later"),
        ));
    }
    if !categories.is_empty() && manifest.contributes.problems.is_empty() {
        return Err(at(&list, "needs `contributes.problems`"));
    }
    for (i, category) in categories.iter().enumerate() {
        if categories[..i].iter().any(|c| c.id == category.id) {
            return Err(at(
                &list.index(i).key("id"),
                "is the id of another category",
            ));
        }
    }
    let rules = JsonPath::default().key("contributes").key("problems");
    for (i, rule) in manifest.contributes.problems.iter().enumerate() {
        let Some(id) = &rule.category else { continue };
        if !categories.iter().any(|c| &c.id == id) {
            return Err(at(
                &rules.index(i).key("category"),
                "is not the id of one of `contributes.problemCategories`",
            ));
        }
    }
    Ok(())
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
    /// A field selector the watch passes to the API server (#409): `status.phase=Pending` on pods. Only fields the API
    /// server selects the kind by (`src/components/Table/field-selectors.json`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub field_selector: Option<String>,
    /// The most objects watched for the rules (#404): 1 to 20 000, 5000 without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_objects: Option<u32>,
}

/// The fields the API server selects objects by, per kind: the window's table (`selectors.ts`) and this check share it.
const FIELD_SELECTORS: &str = include_str!("../../../../src/components/Table/field-selectors.json");

/// Whether `selector` is terms `field=value`, `field==value` or `field!=value` of fields the API server selects `kind`
/// by, with values of name characters (at most 63; `status.phase=Pending`, `spec.nodeName!=`).
pub fn is_field_selector(selector: &str, kind: &KindPattern) -> bool {
    let table: serde_json::Value = match serde_json::from_str(FIELD_SELECTORS) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let key = format!("{}/{}", kind.group, kind.kind);
    let known = |field: &str| {
        let has = |list: Option<&serde_json::Value>| {
            list.and_then(serde_json::Value::as_array)
                .is_some_and(|l| l.iter().any(|f| f.as_str() == Some(field)))
        };
        has(table.get("common")) || has(table.get("kinds").and_then(|k| k.get(&key)))
    };
    !selector.is_empty()
        && selector.len() <= MAX_SELECTOR_CHARS
        && selector.split(',').all(|term| {
            let (field, value) = if let Some((f, v)) = term.split_once("!=") {
                (f, v)
            } else if let Some((f, v)) = term.split_once("==") {
                (f, v)
            } else if let Some((f, v)) = term.split_once('=') {
                (f, v)
            } else {
                return false;
            };
            known(field.trim())
                && value.len() <= 63
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
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
        /// Texts compared in lower case (#405): a phase written `Failed` or `failed`.
        #[serde(
            default,
            rename = "ignoreCase",
            skip_serializing_if = "std::ops::Not::not"
        )]
        ignore_case: bool,
    },
    /// The value at `path` is one of `values`.
    In {
        path: String,
        values: Vec<ProblemScalar>,
        /// Texts compared in lower case (#405): a phase written `Failed` or `failed`.
        #[serde(
            default,
            rename = "ignoreCase",
            skip_serializing_if = "std::ops::Not::not"
        )]
        ignore_case: bool,
    },
    /// The text at `path` holds one of `values` (#405); with `ignoreCase`, in any case (ASCII and Unicode lower case).
    /// `sextantApi` 4.
    Contains {
        path: String,
        values: Vec<String>,
        #[serde(default, rename = "ignoreCase")]
        ignore_case: bool,
    },
    /// The text at `path` begins with one of `values` (#405), as `contains`. `sextantApi` 4.
    StartsWith {
        path: String,
        values: Vec<String>,
        #[serde(default, rename = "ignoreCase")]
        ignore_case: bool,
    },
    /// The text at `path` ends with one of `values` (#404), as `contains`: a phase `…PartiallyFailed`. `sextantApi` 4.
    EndsWith {
        path: String,
        values: Vec<String>,
        #[serde(default, rename = "ignoreCase")]
        ignore_case: bool,
    },
    /// `path` holds a value (not `null`).
    Exists {
        path: String,
        /// An empty text counts as nothing too (#405): a primary named `""`.
        #[serde(
            default,
            rename = "nonEmpty",
            skip_serializing_if = "std::ops::Not::not"
        )]
        non_empty: bool,
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
        /// Added to the other value first (#407): `-1` for "one before the limit".
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        offset: Option<i64>,
        /// More paths whose numbers are added to `path`'s first (#407): a JobSet's own restarts and its Jobs'. At most 3.
        #[serde(default, rename = "addPaths", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        add_paths: Option<Vec<String>>,
        /// `path` and `otherPath` name maps (ADR-0169): it holds when, for any key both have, the value at `path` is at
        /// least the one at `otherPath` (plus `offset`), a filter ending a path (`|quantity`) reading each value — a
        /// NodePool's usage of any resource it limits at its limit. A value that is no number on either side compares
        /// nothing. Not with `addPaths`; `sextantApi` 5.
        #[serde(default, rename = "eachKey", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        each_key: Option<bool>,
    },
    /// The object entered the rule's label-selected source less than `minutes` ago, as Sextant saw it (#393): holds from
    /// then for `minutes`, never for objects already there when the list was first read; `sextantApi` 4, problem rules
    /// with a `source.labelSelector` only.
    EnteredWithin {
        minutes: u32,
    },
    /// The time at `path` (RFC 3339) is more than `minutes` ago.
    /// The time at `path` is no further away than the user's certificate warning (`notifications.certExpiryDays`)
    /// and not yet past (#404): a cert-manager Certificate's `notAfter` "expiring", moved when the setting changes.
    /// `sextantApi` 4.
    Expiring {
        path: String,
    },
    OlderThan {
        path: String,
        minutes: u32,
        /// Holds at once for a value that is there but no time (#405), as the built-in rules counted it.
        #[serde(
            default,
            rename = "orUnreadable",
            skip_serializing_if = "std::ops::Not::not"
        )]
        or_unreadable: bool,
    },
    /// The text at `path` names no object of `kind` — in the object's namespace, or for a kind without namespaces in
    /// the cluster (ADR-0144); `sextantApi` 3. Unknown (so not holding) while that list is not read in full where the
    /// extension may read it. Not inside `any`.
    Missing {
        path: String,
        kind: KindPattern,
        /// With a list at `path` (#404), an item's name (`.name`); the item itself when it is a text. The condition
        /// holds when any item names an object that is not there. `sextantApi` 4.
        #[serde(default, rename = "namePath", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        name_path: Option<String>,
        /// Where the named object is (#404): an item's namespace with a list, else the object's own field; the
        /// object's own namespace when there is none. `sextantApi` 4.
        #[serde(
            default,
            rename = "namespacePath",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        namespace_path: Option<String>,
        /// With a list, the items that count (#404): a reference to another provider (`name@provider`) left out.
        /// Reads only the item, no time. `sextantApi` 4.
        #[serde(default, rename = "itemWhen", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        item_when: Option<Box<ProblemCondition>>,
        /// More kinds the name is looked up in (ADR-0169): it is missing only when none of `kind` and these that the
        /// cluster serves has it, and a kind the cluster does not serve has no objects (a Traefik target in either of
        /// Traefik's groups). 1 to 3; `sextantApi` 5.
        #[serde(default, rename = "alsoKinds", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        also_kinds: Option<Vec<KindPattern>>,
        /// With a list, `namespacePath` counts only for the items this holds of (ADR-0169): a reference to another
        /// provider (`name@provider`) is looked up where its object is, whatever namespace it names. Reads only the
        /// item, no time. `sextantApi` 5.
        #[serde(
            default,
            rename = "namespaceWhen",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        namespace_when: Option<Box<ProblemCondition>>,
        /// With a list, the namespace of the object holding it (the value the path reads the list's field from) when
        /// the item names none (ADR-0169): a load balancer's middlewares are looked up in its namespace. `sextantApi` 5.
        #[serde(
            default,
            rename = "enclosingNamespacePath",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        enclosing_namespace_path: Option<String>,
        /// `enclosingNamespacePath` counts only where this holds of the holding object (ADR-0169). Reads only that
        /// object, no time. `sextantApi` 5.
        #[serde(
            default,
            rename = "enclosingNamespaceWhen",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        enclosing_namespace_when: Option<Box<ProblemCondition>>,
    },
    /// The text at `path` names an object of `kind` there (as `missing` looks it up) for which `when` holds (#409): a
    /// claim that exists but is not allocated, an HPA on the same target. `sextantApi` 4; unknown (not holding) while
    /// that list is not read in full; not inside `any` or `not`; `when` reads only the named object (no `missing`,
    /// `related` or times).
    Related {
        path: String,
        kind: KindPattern,
        when: Box<ProblemCondition>,
        /// Never decides whether the rule holds (ADR-0169): when the object is found and `when` holds, its window, its
        /// `since` (with `givesSince`) and its fields (`{{related:…}}`) apply; otherwise the rule holds without them.
        /// Not inside `any`; `sextantApi` 5.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        optional: Option<bool>,
        /// The problem's time is the named object's (ADR-0169): the `lastTransitionTime` of the entry its `when`'s
        /// `condition` matched, over the rule's own. `sextantApi` 5.
        #[serde(
            default,
            rename = "givesSince",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        gives_since: Option<bool>,
    },
    /// The label selector at `selector` (`matchLabels`, `matchExpressions`) picks no object of `kind` in the
    /// namespaces it covers (#404): every namespace where `anyNamespacesPath` is `true`, the names at `namespacesPath`,
    /// else the judged object's own — a ServiceMonitor that selects no Service. `sextantApi` 4; unknown (not holding)
    /// while that list is not read in full or does not watch those namespaces; not inside `any` or `not`.
    SelectsNone {
        kind: KindPattern,
        selector: String,
        #[serde(
            default,
            rename = "anyNamespacesPath",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        any_namespaces_path: Option<String>,
        #[serde(
            default,
            rename = "namespacesPath",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        namespaces_path: Option<String>,
        /// The objects that select the judged one decide where its selector looks (ADR-0169), as Prometheus Operator's
        /// `ignoreNamespaceSelectors`: when `ownNamespaceWhen` holds for every one of them, in its own namespace
        /// only; for some, in its own too. Unknown or none of them: as written. `sextantApi` 5.
        #[serde(
            default,
            rename = "selectedBy",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        selected_by: Option<SelectingObjects>,
        /// Judged only where the selector looks in named namespaces (ADR-0169): one of every namespace (after
        /// `selectedBy`) is not judged and widens no `narrowLookups` list, as the built-in view never judged a monitor
        /// of every namespace. `sextantApi` 5.
        #[serde(default, rename = "namedOnly", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        named_only: Option<bool>,
    },
    /// No object of `kind` (nor of `alsoKinds`) selects the judged object (ADR-0169): none has a label selector at
    /// `selector` that matches its labels with a namespace selector at `namespaceSelector` that covers its namespace —
    /// a ServiceMonitor no Prometheus picks up. Read as Prometheus Operator reads its selectors: a null or missing
    /// `selector` selects nothing, an empty one everything; a null or missing `namespaceSelector` covers the
    /// selecting object's own namespace, an empty one every namespace, any other the namespaces whose labels it
    /// matches (Namespaces are looked up, metadata only). With no object of those kinds at all it does not hold.
    /// `sextantApi` 5; unknown (not holding) while a list is not read in full or does not cover every namespace; not
    /// inside `any` or `not`.
    SelectedByNone {
        kind: KindPattern,
        #[serde(default, rename = "alsoKinds", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        also_kinds: Option<Vec<KindPattern>>,
        selector: String,
        #[serde(rename = "namespaceSelector")]
        namespace_selector: String,
    },
    /// An object of `kind` in the judged object's namespace has, for every pair, the text at `theirs` equal to the
    /// judged object's at `ours`, and `when` holds for it (#404): an HPA on the VPA's target. `sextantApi` 4; unknown
    /// while that list is not read in full; not inside `any` or `not`; `when` reads only that object, no time.
    RelatedBy {
        kind: KindPattern,
        pairs: Vec<FieldPair>,
        when: Box<ProblemCondition>,
        /// As `related`'s (ADR-0169); `sextantApi` 5.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        optional: Option<bool>,
        /// As `related`'s (ADR-0169); `sextantApi` 5.
        #[serde(
            default,
            rename = "givesSince",
            skip_serializing_if = "Option::is_none"
        )]
        #[ts(optional)]
        gives_since: Option<bool>,
        /// Only one of the objects the pairs find counts (ADR-0169): one that also holds every `prefer` pair, else the
        /// newest (by `creationTimestamp`, then name) — helm-controller's install Job of a chart. `sextantApi` 5.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        newest: Option<bool>,
        /// With `newest` (ADR-0169): the object taken before the newest. The first of these whose `ours` reads a text
        /// on the judged object — a field path, or a text with `{{…}}` placeholders of it — names it: a found object
        /// whose `theirs` holds that text (the Job a chart's `status.jobName` names, else `helm-install-<name>`).
        /// 1 to 4; `sextantApi` 5.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        prefer: Option<Vec<FieldPair>>,
    },
    /// The cluster serves `kind` (ADR-0169), as discovery says: Addons on a k3s or RKE2 server. Unknown (not holding)
    /// before discovery answered; not inside `any` or `not`; problem rules only. `sextantApi` 5.
    Served {
        kind: KindPattern,
    },
    /// The text at `path` fits one of `patterns` (ADR-0169): `*` any text, `#` one or more ASCII digits, every other
    /// character itself (a kubelet version `*+k3s#`). No pattern language, so no backtracking. `sextantApi` 5.
    Fits {
        path: String,
        patterns: Vec<String>,
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
    /// The latest answer of the extension's backend for the judge `judge` (`contributes.problemJudges`, ADR-0168)
    /// gives `fact` for the object; `sextantApi` 4. Unknown (not holding) while the judge cannot tell — a read list
    /// not read in full, a failed or timed-out call; not inside `any` or `not`; the rule's kind is one the judge reads.
    Judged {
        judge: String,
        fact: String,
        /// One problem for each time the answer gives the fact for the object, each with its own texts and an
        /// identity of them (notifications, "Only new since"), not one for the first; only as a rule's whole `when`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        each: Option<bool>,
    },
    /// What the extension's own rules say of the row's object (ADR-0169), for a computed column's cases only: `found`
    /// (the default) a problem of them stands (counted or in its grace), `unknown` they cannot tell (a list a rule
    /// looks up not read in full, the object's kind not judged where it is), `checking` their lists are still being
    /// read. `sextantApi` 5; the column's kind is one the rules judge.
    Problem {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        state: Option<ProblemState>,
    },
}

/// The objects that select a `selectsNone`'s judged object and may narrow where it looks (ADR-0169).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SelectingObjects {
    pub kind: KindPattern,
    /// 1 to 3 more kinds; a kind the cluster does not serve has no objects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub also_kinds: Option<Vec<KindPattern>>,
    /// Their label selector of the judged object's kind, read as `selectedByNone` reads it.
    pub selector: String,
    /// Their namespace selector of it, read as `selectedByNone` reads it.
    pub namespace_selector: String,
    /// Holds for one of them that makes the selector look in the judged object's own namespace; reads only that
    /// object, no time.
    pub own_namespace_when: Box<ProblemCondition>,
}

/// What a `problem` case asks of the extension's rules (ADR-0169).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ProblemState {
    Found,
    Unknown,
    Checking,
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
    let (max_rules, max_kinds) = rule_limits(manifest.sextant_api);
    if rules.len() > max_rules {
        return Err(at(&list, format!("has at most {max_rules} rules")));
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
        super::kinds_from::check_rule_kinds(manifest, rule, &here)?;
        // A rule of kinds from definitions counts its definition kind (agreed to with the rules').
        let own = rule
            .kinds_from
            .as_ref()
            .map_or(&rule.kind, |from| &from.kind);
        if !kinds.iter().any(|k| same_kind(k, own)) {
            kinds.push(own);
            if kinds.len() > max_kinds {
                return Err(at(
                    &here.key("kind"),
                    format!("the rules judge at most {max_kinds} kinds"),
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
            narrowed: rule
                .source
                .as_ref()
                .is_some_and(|s| s.label_selector.is_some()),
            judges: &manifest.contributes.problem_judges,
            case: false,
        };
        check_condition(
            &rule.when,
            &rule.kind,
            &here.key("when"),
            1,
            Inside::Top,
            &mut checks,
        )?;
        if let Some(referrer) = &rule.told_through_referrer {
            let here = here.key("toldThroughReferrer");
            if manifest.sextant_api < SOURCES_API {
                return Err(at(
                    &here,
                    format!("needs sextantApi {SOURCES_API} or later"),
                ));
            }
            check_rule_path(&referrer.path, &rule.kind, &here.key("path"), metadata_only)?;
            let also = referrer.also_paths.as_deref().unwrap_or_default();
            if also.len() > 3 {
                return Err(at(&here.key("alsoPaths"), "has at most 3 paths"));
            }
            for (i, extra) in also.iter().enumerate() {
                check_rule_path(
                    extra,
                    &rule.kind,
                    &here.key("alsoPaths").index(i),
                    metadata_only,
                )?;
            }
            check_rule_path(
                &referrer.name_path,
                &rule.kind,
                &here.key("namePath"),
                false,
            )?;
            if let Some(ns) = &referrer.namespace_path {
                check_rule_path(ns, &rule.kind, &here.key("namespacePath"), false)?;
            }
            check_object_condition(
                &referrer.when,
                std::slice::from_ref(&rule.kind),
                &here.key("when"),
                manifest.sextant_api,
            )?;
            if uses_time(&referrer.when) {
                return Err(at(
                    &here.key("when"),
                    "reads no time (`olderThan`): it is judged when that object changes",
                ));
            }
        }
        if let Some(by) = &rule.newest_by {
            let by_at = here.key("newestBy");
            if manifest.sextant_api < SOURCES_API {
                return Err(at(
                    &by_at,
                    format!("needs sextantApi {SOURCES_API} or later"),
                ));
            }
            if rule.newest_per.is_none() {
                return Err(at(&by_at, "goes with `newestPer`"));
            }
            let by = numeric_path(by, manifest.sextant_api, &by_at)?;
            check_rule_path(by, &rule.kind, &by_at, metadata_only)?;
        }
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
            // The earliest of a list's times may start it (`|min`, #404).
            let since_at = here.key("since");
            let since = numeric_path(since, manifest.sextant_api, &since_at)?;
            check_rule_path(since, &rule.kind, &since_at, metadata_only)?;
        }
        for (field, set) in [
            ("reasonOr", rule.reason_or.is_some()),
            ("sinceOr", rule.since_or.is_some()),
            ("about", rule.about.is_some()),
            ("stamp", rule.stamp.is_some()),
            ("notifyAgainOn", rule.notify_again_on.is_some()),
            ("sinceUnit", rule.since_unit.is_some()),
            ("pluralBy", rule.plural_by.is_some()),
            ("messageForms", rule.message_forms.is_some()),
        ] {
            if set && manifest.sextant_api < SOURCES_API {
                return Err(at(
                    &here.key(field),
                    format!("needs sextantApi {SOURCES_API} or later"),
                ));
            }
        }
        if let Some(text) = &rule.reason_or
            && text.contains("{{")
        {
            return Err(at(
                &here.key("reasonOr"),
                "is written as it shows: no `{{…}}`",
            ));
        }
        match (&rule.plural_by, &rule.message_forms) {
            (None, None) => {}
            (Some(by), Some(forms)) => {
                let by_at = here.key("pluralBy");
                let by = numeric_path(by, manifest.sextant_api, &by_at)?;
                check_rule_path(by, &rule.kind, &by_at, metadata_only)?;
                if forms.is_empty() {
                    return Err(at(&here.key("messageForms"), "gives at least one form"));
                }
                for (form, text) in forms {
                    let form_at = here.key("messageForms").key(form);
                    if form == "other"
                        || !super::section_badges::PLURAL_FORMS.contains(&form.as_str())
                    {
                        return Err(at(
                            &form_at,
                            "is a CLDR plural form besides `other` (the `message`): zero, one, two, few or many",
                        ));
                    }
                    if text.trim().is_empty() || text.chars().count() > 300 {
                        return Err(at(&form_at, "is a text of 1 to 300 characters"));
                    }
                    check_rule_message(text, rule, manifest, &form_at, metadata_only)?;
                }
            }
            (Some(_), None) => {
                return Err(at(&here.key("pluralBy"), "goes with `messageForms`"));
            }
            (None, Some(_)) => {
                return Err(at(&here.key("messageForms"), "goes with `pluralBy`"));
            }
        }
        if rule.since_unit.is_some() && rule.since.is_none() {
            return Err(at(
                &here.key("sinceUnit"),
                "says how `since` is written: the rule needs a `since`",
            ));
        }
        let since_or = rule.since_or.as_deref().unwrap_or_default();
        if !since_or.is_empty() && rule.since.is_none() {
            return Err(at(
                &here.key("sinceOr"),
                "falls back from `since`: the rule needs a `since`",
            ));
        }
        for (j, path) in since_or.iter().enumerate() {
            let place = here.key("sinceOr").index(j);
            let path = numeric_path(path, manifest.sextant_api, &place)?;
            check_rule_path(path, &rule.kind, &place, metadata_only)?;
        }
        if let Some(about) = &rule.about {
            let here = here.key("about");
            match (&about.kind, &about.api_version_path, &about.kind_path) {
                (Some(_), None, None) | (None, Some(_), Some(_)) => {}
                _ => {
                    return Err(at(
                        &here,
                        "names its kind, or reads it with both `apiVersionPath` and `kindPath`",
                    ));
                }
            }
            if about.cluster_scoped && about.namespace_path.is_some() {
                return Err(at(
                    &here.key("namespacePath"),
                    "is not for a cluster-scoped object",
                ));
            }
            for (field, path) in [
                ("apiVersionPath", about.api_version_path.as_ref()),
                ("kindPath", about.kind_path.as_ref()),
                ("namePath", Some(&about.name_path)),
                ("namespacePath", about.namespace_path.as_ref()),
            ] {
                if let Some(path) = path {
                    check_rule_path(path, &rule.kind, &here.key(field), metadata_only)?;
                }
            }
        }
        for (field, paths) in [
            ("stamp", rule.stamp.as_ref()),
            ("notifyAgainOn", rule.notify_again_on.as_ref()),
        ] {
            let Some(paths) = paths else { continue };
            if paths.is_empty() || paths.len() > MAX_SINCE_OR {
                return Err(at(
                    &here.key(field),
                    format!("has 1 to {MAX_SINCE_OR} paths"),
                ));
            }
            for (j, path) in paths.iter().enumerate() {
                // A list's sum or count marks progress too (#404): Kueue's eviction counts.
                let place = here.key(field).index(j);
                let path = numeric_path(path, manifest.sextant_api, &place)?;
                check_rule_path(path, &rule.kind, &place, metadata_only)?;
            }
        }
        if let Some(path) = &rule.notify_as {
            if manifest.sextant_api < SOURCES_API {
                return Err(at(
                    &here.key("notifyAs"),
                    format!("needs sextantApi {SOURCES_API} or later"),
                ));
            }
            check_rule_path(path, &rule.kind, &here.key("notifyAs"), metadata_only)?;
        }
        check_rule_message(
            &rule.message,
            rule,
            manifest,
            &here.key("message"),
            metadata_only,
        )?;
        if manifest.sextant_api < SOURCES_API {
            check_plain_syntax(rule, &here)?;
        }
    }
    Ok(())
}

/// Below `sextantApi` 4, a rule's paths and message keep the grammar Sextant 0.28–0.29 read (#420): paths of names and
/// indexes only, and placeholders that are such a path. The match steps (`[type="Ready"]`, `[*]`, `[<field]`) and the
/// placeholders' filters, fallbacks and sums came with `sextantApi` 4; an older Sextant refuses them, so a manifest
/// that names an older API must not use them, or a catalog would offer it to a Sextant that cannot install it.
fn check_plain_syntax(rule: &ProblemContribution, here: &JsonPath) -> Result<(), ManifestError> {
    let plain = |text: &str| {
        parse_field_path(text.trim())
            .is_some_and(|steps| steps.iter().all(|s| !matches!(s, PathStep::Match { .. })))
    };
    let needs = |path: &JsonPath, what: &str| {
        Err(at(
            path,
            format!("{what} needs sextantApi {SOURCES_API} or later"),
        ))
    };
    if condition_paths(&rule.when).iter().any(|p| !plain(p)) {
        return needs(
            &here.key("when"),
            "a path step that matches list items (`[field=\"value\"]`, `[*]`, `[<field]`)",
        );
    }
    if rule.since.as_deref().is_some_and(|p| !plain(p)) {
        return needs(
            &here.key("since"),
            "a path step that matches list items (`[field=\"value\"]`, `[*]`, `[<field]`)",
        );
    }
    let placeholders = placeholders(&rule.message).unwrap_or_default();
    if placeholders.iter().any(|p| !plain(p)) {
        return needs(
            &here.key("message"),
            "a placeholder other than a field path of names and indexes",
        );
    }
    Ok(())
}

/// A rule's message: [`check_message`], where a `{{fact:<name>}}` placeholder names a value of a fact the rule's
/// `judged` conditions name (ADR-0168), counted with the others.
fn check_rule_message(
    text: &str,
    rule: &ProblemContribution,
    manifest: &ExtensionManifest,
    path: &JsonPath,
    metadata_only: bool,
) -> Result<(), ManifestError> {
    let Some(found) = placeholders(text) else {
        return Err(at(path, "has a `{{` without its `}}`"));
    };
    if found.len() > MAX_PLACEHOLDERS {
        return Err(at(
            path,
            format!("has at most {MAX_PLACEHOLDERS} placeholders"),
        ));
    }
    let allowed =
        super::problem_judges::fact_values(&manifest.contributes.problem_judges, &rule.when);
    let mut rest = String::with_capacity(text.len());
    let mut tail = text;
    while let Some(start) = tail.find("{{") {
        let after = &tail[start + 2..];
        let Some(end) = after.find("}}") else { break };
        let inner = &after[..end];
        if let Some(paths) = related_placeholder(inner) {
            // A field of the object the rule's first `related`/`relatedBy` found (ADR-0169), filled by the window.
            if manifest.sextant_api < PARITY_API {
                return Err(at(
                    path,
                    format!("`{{{{related:…}}}}` needs sextantApi {PARITY_API} or later"),
                ));
            }
            let mut kinds = Vec::new();
            related_kinds(&rule.when, &mut kinds);
            if kinds.is_empty() {
                return Err(at(
                    path,
                    "has `{{related:…}}`, which only a rule with `related` or `relatedBy` fills",
                ));
            }
            for one in paths {
                if one.contains('|') || placeholder_literal(one).is_some() {
                    return Err(at(
                        path,
                        "has `{{related:…}}` with a filter or a literal: it names the found object's fields only",
                    ));
                }
                for kind in &kinds {
                    check_rule_path(one, kind, path, false)?;
                }
            }
            rest.push_str(&tail[..start]);
        } else if inner.trim() == SELECTS_NONE_NAMESPACES {
            // The namespaces the rule's `selectsNone` looked in (ADR-0169), filled by the window.
            if manifest.sextant_api < PARITY_API {
                return Err(at(
                    path,
                    format!(
                        "`{{{{{SELECTS_NONE_NAMESPACES}}}}}` needs sextantApi {PARITY_API} or later"
                    ),
                ));
            }
            if !has_selects_none(&rule.when) {
                return Err(at(
                    path,
                    format!(
                        "has `{{{{{SELECTS_NONE_NAMESPACES}}}}}`, which only a rule with `selectsNone` fills"
                    ),
                ));
            }
            rest.push_str(&tail[..start]);
        } else if let Some(name) = super::problem_judges::fact_placeholder(inner) {
            if !allowed.contains(&name) {
                return Err(at(
                    path,
                    format!(
                        "has `{{{{fact:{name}}}}}`, which no fact of the rule's `judged` conditions gives"
                    ),
                ));
            }
            rest.push_str(&tail[..start]);
        } else {
            rest.push_str(&tail[..start + 2 + end + 2]);
        }
        tail = &after[end + 2..];
    }
    rest.push_str(tail);
    check_message(&rest, &rule.kind, path, metadata_only)
}

/// The paths of a `{{related:<path> ?? <path>}}` placeholder (ADR-0169), trimmed; `None` for any other placeholder.
pub fn related_placeholder(inner: &str) -> Option<Vec<&str>> {
    let rest = inner.trim().strip_prefix("related:")?;
    Some(
        split_outside_quotes(rest, "??")
            .into_iter()
            .map(str::trim)
            .collect(),
    )
}

/// The kinds a condition's `related` and `relatedBy` name, each once, in order.
fn related_kinds<'c>(condition: &'c ProblemCondition, out: &mut Vec<&'c KindPattern>) {
    match condition {
        ProblemCondition::Related { kind, .. } | ProblemCondition::RelatedBy { kind, .. } => {
            if !out.iter().any(|k| same_kind(k, kind)) {
                out.push(kind);
            }
        }
        ProblemCondition::All { of } | ProblemCondition::Any { of } => {
            of.iter().for_each(|inner| related_kinds(inner, out))
        }
        ProblemCondition::Not { of } => related_kinds(of, out),
        _ => {}
    }
}

/// A rule message's placeholder of the namespaces its `selectsNone` looked in (ADR-0169): `{{selectsNone:namespaces}}`,
/// sorted, in the UI language's list. No field path reads like it, so it meant nothing before `sextantApi` 5.
pub const SELECTS_NONE_NAMESPACES: &str = "selectsNone:namespaces";

/// Whether a condition has a `selectsNone`.
fn has_selects_none(condition: &ProblemCondition) -> bool {
    match condition {
        ProblemCondition::SelectsNone { .. } => true,
        ProblemCondition::All { of } | ProblemCondition::Any { of } => {
            of.iter().any(has_selects_none)
        }
        ProblemCondition::Not { of } => has_selects_none(of),
        _ => false,
    }
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
        if source.max_objects.is_some_and(|n| n == 0 || n > 20_000) {
            return Err(at(&path.key("maxObjects"), "is 1 to 20 000"));
        }
        if source.label_selector.is_none()
            && source.field_selector.is_none()
            && source.max_objects.is_none()
            && !source.metadata_only
        {
            return Err(at(
                &path,
                "names a `labelSelector`, a `fieldSelector`, `metadataOnly: true` or more",
            ));
        }
        if let Some(selector) = &source.field_selector
            && !is_field_selector(selector, &rule.kind)
        {
            return Err(at(
                &path.key("fieldSelector"),
                "must be field terms the API server selects this kind by, such as `status.phase=Pending` on pods",
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
                rule.kinds_from.as_ref().map_or_else(
                    || kind_name(&rule.kind),
                    |from| format!("the kinds {} define", kind_name(&from.kind))
                ),
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
    /// The rule's source has a label selector: `enteredWithin` can be told.
    narrowed: bool,
    /// The manifest's judges (`judged`, ADR-0168).
    judges: &'k [super::problem_judges::ProblemJudgeContribution],
    /// A computed column's case (ADR-0169): `problem` may ask what the extension's rules say of the row.
    case: bool,
}

/// A condition of an action or a column (ADR-0153, ADR-0154): the grammar of problem rules without `missing`, its
/// paths reading no secret of any of `kinds`, within the same nesting and size limits.
pub(crate) fn check_object_condition(
    condition: &ProblemCondition,
    kinds: &[KindPattern],
    path: &JsonPath,
    api: u32,
) -> Result<(), ManifestError> {
    check_single(condition, kinds, path, api, false)
}

/// A computed column's case (ADR-0153): an object condition that may also ask what the extension's rules say of the
/// row (`problem`, ADR-0169).
pub(crate) fn check_case_condition(
    condition: &ProblemCondition,
    kinds: &[KindPattern],
    path: &JsonPath,
    api: u32,
) -> Result<(), ManifestError> {
    check_single(condition, kinds, path, api, true)
}

fn check_single(
    condition: &ProblemCondition,
    kinds: &[KindPattern],
    path: &JsonPath,
    api: u32,
    case: bool,
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
            narrowed: false,
            judges: &[],
            case,
        };
        check_condition(condition, kind, path, 1, Inside::Top, &mut checks)?;
    }
    Ok(())
}

/// Whether a condition asks what the extension's rules say of the object (`problem`, ADR-0169).
pub(crate) fn asks_problems(condition: &ProblemCondition) -> bool {
    match condition {
        ProblemCondition::Problem { .. } => true,
        ProblemCondition::All { of } | ProblemCondition::Any { of } => of.iter().any(asks_problems),
        ProblemCondition::Not { of } => asks_problems(of),
        _ => false,
    }
}

/// What a condition is inside of: `missing` is refused inside `any` and `not`, but for an `any` of lookups only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Inside {
    Top,
    Any,
    Not,
    /// An `any` whose every branch is a `missing` or `related` (`sextantApi` 4): it holds when any of their objects
    /// is missing or related (one group of lookups), and cannot tell otherwise when a list is not read — never wrong.
    AnyOfLookups,
}

/// Whether a condition is one lookup of another kind's objects (`missing`, `related`).
fn is_lookup(condition: &ProblemCondition) -> bool {
    matches!(
        condition,
        ProblemCondition::Missing { .. } | ProblemCondition::Related { .. }
    )
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
        ProblemCondition::Contains {
            path: field,
            values,
            ..
        }
        | ProblemCondition::StartsWith {
            path: field,
            values,
            ..
        }
        | ProblemCondition::EndsWith {
            path: field,
            values,
            ..
        } => {
            if checks.api < SOURCES_API {
                return Err(at(
                    &path.key("type"),
                    format!("text conditions need sextantApi {SOURCES_API} or later"),
                ));
            }
            // A value may hold the object's own texts (#404): `{{.metadata.namespace}}/`, a Secret named in its own
            // namespace.
            for (i, value) in values.iter().enumerate() {
                if value.contains("{{") {
                    check_message(
                        value,
                        kind,
                        &path.key("values").index(i),
                        checks.metadata_only,
                    )?;
                }
            }
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)
        }
        // A number compared may be a list's sum or count (`|sum`, `|count`, #407).
        ProblemCondition::Equals { path: field, .. }
        | ProblemCondition::In { path: field, .. }
        | ProblemCondition::Above { path: field, .. }
        | ProblemCondition::Below { path: field, .. } => check_rule_path(
            numeric_path(field, checks.api, &path.key("path"))?,
            kind,
            &path.key("path"),
            checks.metadata_only,
        ),
        // Whether an inline secret field is there (ADR-0169): its presence, never its value — what the marker of
        // hidden values tells an extension anyway.
        ProblemCondition::Exists { path: field, .. } | ProblemCondition::Absent { path: field }
            if checks.api >= PARITY_API && is_inline_secret_field(kind, field) =>
        {
            if checks.metadata_only
                && !matches!(parse_field_path(field).as_deref(), Some([PathStep::Key(first), ..]) if first == "metadata")
            {
                return Err(at(
                    &path.key("path"),
                    "must be under `.metadata`: the rule's source watches metadata only",
                ));
            }
            Ok(())
        }
        ProblemCondition::Exists { path: field, .. }
        | ProblemCondition::Absent { path: field }
        | ProblemCondition::OlderThan { path: field, .. } => {
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)
        }
        ProblemCondition::Expiring { path: field } => {
            if checks.api < SOURCES_API {
                return Err(at(
                    &path.key("type"),
                    format!("`expiring` needs sextantApi {SOURCES_API} or later"),
                ));
            }
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)
        }
        ProblemCondition::Same {
            path: field,
            other_path,
        }
        | ProblemCondition::AtLeast {
            path: field,
            other_path,
            ..
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
            check_rule_path(
                numeric_path(field, checks.api, &path.key("path"))?,
                kind,
                &path.key("path"),
                checks.metadata_only,
            )?;
            check_rule_path(
                numeric_path(other_path, checks.api, &path.key("otherPath"))?,
                kind,
                &path.key("otherPath"),
                checks.metadata_only,
            )?;
            if let ProblemCondition::AtLeast {
                each_key: Some(each),
                add_paths,
                ..
            } = condition
            {
                // Every key of two maps (ADR-0169).
                if checks.api < PARITY_API {
                    return Err(at(
                        &path.key("eachKey"),
                        format!("needs sextantApi {PARITY_API} or later"),
                    ));
                }
                if !each {
                    return Err(at(&path.key("eachKey"), "is `true` or left out"));
                }
                if add_paths.is_some() {
                    return Err(at(
                        &path.key("addPaths"),
                        "goes without `eachKey`: the values of one key are compared",
                    ));
                }
                for (field, place) in [(field, "path"), (other_path, "otherPath")] {
                    let text = numeric_path(field, checks.api, &path.key(place))?;
                    if text.contains('*') {
                        return Err(at(
                            &path.key(place),
                            "names a map of the object, without `*`, with `eachKey`",
                        ));
                    }
                }
            }
            if let ProblemCondition::AtLeast {
                add_paths: Some(more),
                ..
            } = condition
            {
                if more.is_empty() || more.len() > 3 {
                    return Err(at(&path.key("addPaths"), "has 1 to 3 paths"));
                }
                for (j, extra) in more.iter().enumerate() {
                    let place = path.key("addPaths").index(j);
                    check_rule_path(
                        numeric_path(extra, checks.api, &place)?,
                        kind,
                        &place,
                        checks.metadata_only,
                    )?;
                }
            }
            Ok(())
        }
        ProblemCondition::Condition { .. } if checks.metadata_only => Err(at(
            &path.key("type"),
            "`condition` reads `.status.conditions`, which a `metadataOnly` source does not watch",
        )),
        ProblemCondition::Condition { .. } => Ok(()),
        ProblemCondition::EnteredWithin { minutes } => {
            if checks.api < SOURCES_API {
                return Err(at(
                    &path.key("type"),
                    format!("`enteredWithin` needs sextantApi {SOURCES_API} or later"),
                ));
            }
            if checks.single || !checks.narrowed {
                return Err(at(
                    &path.key("type"),
                    "`enteredWithin` tells when an object entered a rule's `source.labelSelector`: only such rules may use it",
                ));
            }
            if *minutes == 0 || *minutes > MAX_ENTERED_MINUTES {
                return Err(at(
                    &path.key("minutes"),
                    format!("must be 1 to {MAX_ENTERED_MINUTES} minutes"),
                ));
            }
            Ok(())
        }
        ProblemCondition::RelatedBy {
            kind: target,
            pairs,
            when,
            optional,
            gives_since,
            newest,
            prefer,
        } => {
            if checks.single {
                return Err(at(
                    &path.key("type"),
                    "`relatedBy` judges across objects: only problem rules may use it",
                ));
            }
            if checks.api < SOURCES_API {
                return Err(at(
                    &path.key("type"),
                    format!("`relatedBy` needs sextantApi {SOURCES_API} or later"),
                ));
            }
            if !matches!(inside, Inside::Top) {
                return Err(at(
                    &path.key("type"),
                    "`relatedBy` cannot be inside `any` or `not`: a list not read would make it unknown",
                ));
            }
            if target.group.is_empty() && target.kind.eq_ignore_ascii_case("Secret") {
                return Err(at(&path.key("kind"), "Secrets are never listed for rules"));
            }
            if pairs.is_empty() || pairs.len() > MAX_FIELD_PAIRS {
                return Err(at(
                    &path.key("pairs"),
                    format!("has 1 to {MAX_FIELD_PAIRS} pairs"),
                ));
            }
            for (i, pair) in pairs.iter().enumerate() {
                let at_pair = path.key("pairs").index(i);
                check_rule_path(&pair.ours, kind, &at_pair.key("ours"), checks.metadata_only)?;
                check_rule_path(&pair.theirs, target, &at_pair.key("theirs"), false)?;
            }
            for (key, set) in [("newest", newest.is_some()), ("prefer", prefer.is_some())] {
                if set && checks.api < PARITY_API {
                    return Err(at(
                        &path.key(key),
                        format!("needs sextantApi {PARITY_API} or later"),
                    ));
                }
            }
            if newest.is_some_and(|n| !n) {
                return Err(at(&path.key("newest"), "is `true` or left out"));
            }
            if let Some(prefer) = prefer {
                if newest.is_none() {
                    return Err(at(
                        &path.key("prefer"),
                        "goes with `newest`: the object preferred before the newest",
                    ));
                }
                if prefer.is_empty() || prefer.len() > MAX_FIELD_PAIRS {
                    return Err(at(
                        &path.key("prefer"),
                        format!("has 1 to {MAX_FIELD_PAIRS} pairs"),
                    ));
                }
                for (i, pair) in prefer.iter().enumerate() {
                    let at_pair = path.key("prefer").index(i);
                    // A text of the judged object's own (`helm-install-{{.metadata.name}}`), or one of its fields.
                    if pair.ours.contains("{{") {
                        check_message(
                            &pair.ours,
                            kind,
                            &at_pair.key("ours"),
                            checks.metadata_only,
                        )?;
                    } else {
                        check_rule_path(
                            &pair.ours,
                            kind,
                            &at_pair.key("ours"),
                            checks.metadata_only,
                        )?;
                    }
                    check_rule_path(&pair.theirs, target, &at_pair.key("theirs"), false)?;
                }
            }
            check_related_parts(when, target, *optional, *gives_since, path, checks)?;
            if !checks.kinds.iter().any(|k| same_kind(k, target)) {
                checks.kinds.push(target);
                let max_kinds = rule_limits(checks.api).1;
                if checks.kinds.len() > max_kinds {
                    return Err(at(
                        &path.key("kind"),
                        format!("the rules judge at most {max_kinds} kinds"),
                    ));
                }
            }
            Ok(())
        }
        ProblemCondition::Served { .. } => {
            if checks.single {
                return Err(at(
                    &path.key("type"),
                    "`served` is told by discovery: only problem rules may use it",
                ));
            }
            if checks.api < PARITY_API {
                return Err(at(
                    &path.key("type"),
                    format!("`served` needs sextantApi {PARITY_API} or later"),
                ));
            }
            if !matches!(inside, Inside::Top) {
                return Err(at(
                    &path.key("type"),
                    "`served` cannot be inside `any` or `not`: before discovery answers it is unknown",
                ));
            }
            Ok(())
        }
        ProblemCondition::Fits {
            path: field,
            patterns,
        } => {
            if checks.api < PARITY_API {
                return Err(at(
                    &path.key("type"),
                    format!("`fits` needs sextantApi {PARITY_API} or later"),
                ));
            }
            if patterns.is_empty() || patterns.len() > MAX_PATTERNS {
                return Err(at(
                    &path.key("patterns"),
                    format!("has 1 to {MAX_PATTERNS} patterns"),
                ));
            }
            for (i, pattern) in patterns.iter().enumerate() {
                let count = pattern.chars().count();
                if count == 0 || count > MAX_PATTERN_CHARS || pattern.chars().any(char::is_control)
                {
                    return Err(at(
                        &path.key("patterns").index(i),
                        format!(
                            "is a pattern of 1 to {MAX_PATTERN_CHARS} characters without control characters"
                        ),
                    ));
                }
            }
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)
        }
        ProblemCondition::SelectsNone {
            kind: target,
            selector,
            any_namespaces_path,
            namespaces_path,
            selected_by,
            named_only,
        } => {
            if checks.single {
                return Err(at(
                    &path.key("type"),
                    "`selectsNone` judges across objects: only problem rules may use it",
                ));
            }
            if checks.api < SOURCES_API {
                return Err(at(
                    &path.key("type"),
                    format!("`selectsNone` needs sextantApi {SOURCES_API} or later"),
                ));
            }
            if !matches!(inside, Inside::Top) {
                return Err(at(
                    &path.key("type"),
                    "`selectsNone` cannot be inside `any` or `not`: a list not read would make it unknown",
                ));
            }
            if target.group.is_empty() && target.kind.eq_ignore_ascii_case("Secret") {
                return Err(at(&path.key("kind"), "Secrets are never listed for rules"));
            }
            for (key, set) in [
                ("selectedBy", selected_by.is_some()),
                ("namedOnly", named_only.is_some()),
            ] {
                if set && checks.api < PARITY_API {
                    return Err(at(
                        &path.key(key),
                        format!("needs sextantApi {PARITY_API} or later"),
                    ));
                }
            }
            if let Some(by) = selected_by {
                let by_at = path.key("selectedBy");
                check_selecting(
                    &by.kind,
                    by.also_kinds.as_deref(),
                    &by.selector,
                    &by.namespace_selector,
                    by.also_kinds.is_some(),
                    &by_at,
                    checks,
                )?;
                let mut selecting = vec![by.kind.clone()];
                selecting.extend(by.also_kinds.iter().flatten().cloned());
                check_object_condition(
                    &by.own_namespace_when,
                    &selecting,
                    &by_at.key("ownNamespaceWhen"),
                    checks.api,
                )?;
                if uses_time(&by.own_namespace_when) {
                    return Err(at(
                        &by_at.key("ownNamespaceWhen"),
                        "reads no time (`olderThan`): it is judged when that object changes",
                    ));
                }
            }
            check_rule_path(selector, kind, &path.key("selector"), checks.metadata_only)?;
            for (key, field) in [
                ("anyNamespacesPath", any_namespaces_path),
                ("namespacesPath", namespaces_path),
            ] {
                if let Some(field) = field {
                    check_rule_path(field, kind, &path.key(key), checks.metadata_only)?;
                }
            }
            if !checks.kinds.iter().any(|k| same_kind(k, target)) {
                checks.kinds.push(target);
                let max_kinds = rule_limits(checks.api).1;
                if checks.kinds.len() > max_kinds {
                    return Err(at(
                        &path.key("kind"),
                        format!("the rules judge at most {max_kinds} kinds"),
                    ));
                }
            }
            Ok(())
        }
        ProblemCondition::SelectedByNone {
            kind: target,
            also_kinds,
            selector,
            namespace_selector,
        } => {
            if checks.single {
                return Err(at(
                    &path.key("type"),
                    "`selectedByNone` judges across objects: only problem rules may use it",
                ));
            }
            if checks.api < PARITY_API {
                return Err(at(
                    &path.key("type"),
                    format!("`selectedByNone` needs sextantApi {PARITY_API} or later"),
                ));
            }
            if !matches!(inside, Inside::Top) {
                return Err(at(
                    &path.key("type"),
                    "`selectedByNone` cannot be inside `any` or `not`: a list not read would make it unknown",
                ));
            }
            check_selecting(
                target,
                also_kinds.as_deref(),
                selector,
                namespace_selector,
                also_kinds.is_some(),
                path,
                checks,
            )
        }
        ProblemCondition::Related {
            path: field,
            kind: target,
            when,
            optional,
            gives_since,
        } => {
            if checks.single {
                return Err(at(
                    &path.key("type"),
                    "`related` judges across objects: only problem rules may use it",
                ));
            }
            if checks.api < SOURCES_API {
                return Err(at(
                    &path.key("type"),
                    format!("`related` needs sextantApi {SOURCES_API} or later"),
                ));
            }
            if !matches!(inside, Inside::Top | Inside::AnyOfLookups) {
                return Err(at(
                    &path.key("type"),
                    "`related` cannot be inside `any` or `not`: a list not read would make it unknown (but in an `any` of `missing` and `related` only)",
                ));
            }
            if target.group.is_empty() && target.kind.eq_ignore_ascii_case("Secret") {
                return Err(at(&path.key("kind"), "Secrets are never listed for rules"));
            }
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)?;
            if optional.is_some() && matches!(inside, Inside::AnyOfLookups) {
                return Err(at(
                    &path.key("optional"),
                    "is for a `related` outside `any`: an optional lookup decides nothing",
                ));
            }
            // The named object's own condition: paths of its kind, nothing across objects, no time below sextantApi 5
            // (it is judged when that object changes, not as time passes).
            check_related_parts(when, target, *optional, *gives_since, path, checks)?;
            if !checks.kinds.iter().any(|k| same_kind(k, target)) {
                checks.kinds.push(target);
                let max_kinds = rule_limits(checks.api).1;
                if checks.kinds.len() > max_kinds {
                    return Err(at(
                        &path.key("kind"),
                        format!("the rules judge at most {max_kinds} kinds"),
                    ));
                }
            }
            Ok(())
        }
        ProblemCondition::Missing {
            path: field,
            kind: target,
            name_path,
            namespace_path,
            item_when,
            also_kinds,
            namespace_when,
            enclosing_namespace_path,
            enclosing_namespace_when,
        } => {
            let listed = field.contains('*');
            for (key, set) in [
                ("alsoKinds", also_kinds.is_some()),
                ("namespaceWhen", namespace_when.is_some()),
                ("enclosingNamespacePath", enclosing_namespace_path.is_some()),
                ("enclosingNamespaceWhen", enclosing_namespace_when.is_some()),
            ] {
                if set && checks.api < PARITY_API {
                    return Err(at(
                        &path.key(key),
                        format!("needs sextantApi {PARITY_API} or later"),
                    ));
                }
            }
            if namespace_when.is_some() && (!listed || namespace_path.is_none()) {
                return Err(at(
                    &path.key("namespaceWhen"),
                    "goes with a `path` that reads a list (`[*]`) and a `namespacePath`",
                ));
            }
            if enclosing_namespace_when.is_some() && enclosing_namespace_path.is_none() {
                return Err(at(
                    &path.key("enclosingNamespaceWhen"),
                    "goes with `enclosingNamespacePath`",
                ));
            }
            if let Some(enclosing) = enclosing_namespace_path {
                let held = parse_field_path(field.trim()).is_some_and(|steps| {
                    matches!(
                        steps.as_slice(),
                        [
                            ..,
                            PathStep::Key(_),
                            PathStep::Match {
                                pick: MatchPick::All,
                                ..
                            }
                        ]
                    )
                });
                if !held {
                    return Err(at(
                        &path.key("enclosingNamespacePath"),
                        "goes with a `path` whose last step lists a field's items (`.middlewares[*]`)",
                    ));
                }
                check_rule_path(
                    enclosing,
                    kind,
                    &path.key("enclosingNamespacePath"),
                    checks.metadata_only,
                )?;
            }
            for (key, when) in [
                ("namespaceWhen", namespace_when),
                ("enclosingNamespaceWhen", enclosing_namespace_when),
            ] {
                if let Some(when) = when {
                    check_object_condition(
                        when,
                        std::slice::from_ref(kind),
                        &path.key(key),
                        checks.api,
                    )?;
                    if uses_time(when) {
                        return Err(at(&path.key(key), "reads no time (`olderThan`)"));
                    }
                }
            }
            let also = also_kinds.as_deref().unwrap_or_default();
            if also_kinds.is_some() && (also.is_empty() || also.len() > 3) {
                return Err(at(&path.key("alsoKinds"), "has 1 to 3 kinds"));
            }
            for (i, other) in also.iter().enumerate() {
                if same_kind(other, target) || also[..i].iter().any(|k| same_kind(k, other)) {
                    return Err(at(
                        &path.key("alsoKinds").index(i),
                        "names a kind `missing` already looks up",
                    ));
                }
                if other.group.is_empty() && other.kind.eq_ignore_ascii_case("Secret") {
                    return Err(at(
                        &path.key("alsoKinds").index(i),
                        "Secrets are never listed for rules",
                    ));
                }
            }
            if (name_path.is_some() || namespace_path.is_some() || item_when.is_some())
                && checks.api < SOURCES_API
            {
                return Err(at(
                    &path.key("type"),
                    format!(
                        "`missing` of a list or another namespace needs sextantApi {SOURCES_API} or later"
                    ),
                ));
            }
            if (name_path.is_some() || item_when.is_some()) && !listed {
                return Err(at(
                    &path.key("namePath"),
                    "goes with a `path` that reads a list (`[*]`)",
                ));
            }
            // Item paths read the item: checked as paths of the rule's kind (a list path holding no secret holds
            // none in its items).
            for (key, item_path) in [("namePath", name_path), ("namespacePath", namespace_path)] {
                if let Some(item_path) = item_path {
                    check_rule_path(item_path, kind, &path.key(key), checks.metadata_only)?;
                }
            }
            if let Some(when) = item_when {
                check_object_condition(
                    when,
                    std::slice::from_ref(kind),
                    &path.key("itemWhen"),
                    checks.api,
                )?;
                if uses_time(when) {
                    return Err(at(&path.key("itemWhen"), "reads no time (`olderThan`)"));
                }
            }
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
                        "`missing` cannot be inside `any`: a list not read would make the whole `any` unknown (but in an `any` of `missing` and `related` only)",
                    ));
                }
                Inside::Not => {
                    return Err(at(
                        &path.key("type"),
                        "`missing` cannot be inside `not`: a list not read would make it unknown",
                    ));
                }
                Inside::Top | Inside::AnyOfLookups => {}
            }
            // From sextantApi 4 a Secret is looked up by name only (#404): the window lists Secrets for rules
            // metadata-only, never a value (a SealedSecret's target Secret, ADR-0109).
            if target.group.is_empty()
                && target.kind.eq_ignore_ascii_case("Secret")
                && checks.api < SOURCES_API
            {
                return Err(at(&path.key("kind"), "Secrets are never listed for rules"));
            }
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)?;
            for (i, target) in std::iter::once(target).chain(also).enumerate() {
                if !checks.kinds.iter().any(|k| same_kind(k, target)) {
                    checks.kinds.push(target);
                    let max_kinds = rule_limits(checks.api).1;
                    if checks.kinds.len() > max_kinds {
                        let place = if i == 0 {
                            path.key("kind")
                        } else {
                            path.key("alsoKinds").index(i - 1)
                        };
                        return Err(at(
                            &place,
                            format!("the rules judge at most {max_kinds} kinds"),
                        ));
                    }
                }
            }
            Ok(())
        }
        ProblemCondition::Problem { .. } => {
            if !checks.case {
                return Err(at(
                    &path.key("type"),
                    "`problem` asks what the extension's rules say of a table's row: only a computed column's cases may use it",
                ));
            }
            if checks.api < PARITY_API {
                return Err(at(
                    &path.key("type"),
                    format!("`problem` needs sextantApi {PARITY_API} or later"),
                ));
            }
            Ok(())
        }
        ProblemCondition::Judged { judge, fact, each } => {
            if checks.single {
                return Err(at(
                    &path.key("type"),
                    "`judged` is decided by the extension's backend: only problem rules may use it",
                ));
            }
            if checks.api < SOURCES_API {
                return Err(at(
                    &path.key("type"),
                    format!("`judged` needs sextantApi {SOURCES_API} or later"),
                ));
            }
            if !matches!(inside, Inside::Top) {
                return Err(at(
                    &path.key("type"),
                    "`judged` cannot be inside `any` or `not`: a judge that cannot tell would make it unknown",
                ));
            }
            // One problem per fact (`each`): the rule's whole `when`, so nothing else decides which of them stand.
            if each.is_some() && depth > 1 {
                return Err(at(
                    &path.key("each"),
                    "is only for a `judged` that is the rule's whole `when` (not inside `all`)",
                ));
            }
            super::problem_judges::check_judged(checks.judges, judge, fact, kind, path)
        }
        ProblemCondition::All { of } | ProblemCondition::Any { of } => {
            if depth >= max_depth {
                return Err(at(
                    path,
                    format!("`all` and `any` nest at most {max_depth} deep"),
                ));
            }
            let inner_inside = match (inside, condition) {
                (Inside::Top, ProblemCondition::Any { of })
                    if checks.api >= SOURCES_API && !of.is_empty() && of.iter().all(is_lookup) =>
                {
                    Inside::AnyOfLookups
                }
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

/// A compared path without its `|sum` or `|count` (#407): a list's numbers added, or its items (a map's entries)
/// counted; `sextantApi` 4.
pub(crate) fn numeric_path<'t>(
    text: &'t str,
    api: u32,
    path: &JsonPath,
) -> Result<&'t str, ManifestError> {
    let Some((field, filter)) = text.rsplit_once('|') else {
        return Ok(text);
    };
    // `|min`/`|max` (#404): a list's smallest or largest number, or earliest or latest time.
    // `|quantity` (#404): a Kubernetes quantity ("64Gi", "500m") read as its amount.
    // `|daysLeft`: the whole days until a time, 0 once it has passed (a certificate's days left).
    if !matches!(
        filter.trim(),
        "sum" | "count" | "min" | "max" | "quantity" | "daysLeft"
    ) {
        return Err(at(
            path,
            "ends in `|sum`, `|count`, `|min`, `|max`, `|quantity` or `|daysLeft`, or in no filter",
        ));
    }
    if api < SOURCES_API {
        return Err(at(
            path,
            format!(
                "`|{}` needs sextantApi {SOURCES_API} or later",
                filter.trim()
            ),
        ));
    }
    Ok(field.trim())
}

/// Whether a condition holds only from or until a time (`olderThan`, `enteredWithin`).
fn uses_time(condition: &ProblemCondition) -> bool {
    match condition {
        ProblemCondition::OlderThan { .. }
        | ProblemCondition::EnteredWithin { .. }
        | ProblemCondition::Expiring { .. } => true,
        ProblemCondition::All { of } | ProblemCondition::Any { of } => of.iter().any(uses_time),
        ProblemCondition::Not { of } => uses_time(of),
        _ => false,
    }
}

/// The most patterns of a `fits`, and the most characters of one (ADR-0169).
pub const MAX_PATTERNS: usize = 20;
pub const MAX_PATTERN_CHARS: usize = 256;

/// Whether `text` fits `pattern` (`fits`, ADR-0169): `*` any text, `#` one or more ASCII digits, every other
/// character itself. Linear in the text per pattern position, never backtracking past one `*`.
pub fn fits_pattern(text: &str, pattern: &str) -> bool {
    let text: Vec<char> = text.chars().collect();
    let pattern: Vec<char> = pattern.chars().collect();
    // The text positions each pattern prefix can end at, as a set (a bit per position).
    let mut at = vec![false; text.len() + 1];
    at[0] = true;
    for p in &pattern {
        let mut next = vec![false; text.len() + 1];
        match p {
            '*' => {
                let mut reached = false;
                for (i, slot) in next.iter_mut().enumerate() {
                    reached |= at[i];
                    *slot = reached;
                }
            }
            '#' => {
                for i in 0..text.len() {
                    if (at[i] || next[i]) && text[i].is_ascii_digit() {
                        next[i + 1] = true;
                    }
                }
            }
            c => {
                for i in 0..text.len() {
                    if at[i] && text[i] == *c {
                        next[i + 1] = true;
                    }
                }
            }
        }
        at = next;
    }
    at[text.len()]
}

/// A `related`'s or `relatedBy`'s `when`, `optional` and `givesSince` (ADR-0169): the named object's own condition,
/// reading only that object; a time (`olderThan`) only from `sextantApi` 5, never `expiring` (the user's setting moves
/// it, which the named object's row does not follow).
fn check_related_parts(
    when: &ProblemCondition,
    target: &KindPattern,
    optional: Option<bool>,
    gives_since: Option<bool>,
    path: &JsonPath,
    checks: &ConditionChecks<'_, '_>,
) -> Result<(), ManifestError> {
    for (key, set) in [("optional", optional), ("givesSince", gives_since)] {
        let Some(set) = set else { continue };
        if checks.api < PARITY_API {
            return Err(at(
                &path.key(key),
                format!("needs sextantApi {PARITY_API} or later"),
            ));
        }
        if !set {
            return Err(at(&path.key(key), "is `true` or left out"));
        }
    }
    check_object_condition(
        when,
        std::slice::from_ref(target),
        &path.key("when"),
        checks.api,
    )?;
    if checks.api < PARITY_API && uses_time(when) {
        return Err(at(
            &path.key("when"),
            "reads no time (`olderThan`): it is judged when that object changes",
        ));
    }
    if uses_setting_time(when) {
        return Err(at(
            &path.key("when"),
            "reads no `expiring`: the user's setting moves it, and the named object's row is judged when it changes",
        ));
    }
    Ok(())
}

/// Whether a condition reads a time the user's setting moves (`expiring`).
fn uses_setting_time(condition: &ProblemCondition) -> bool {
    match condition {
        ProblemCondition::Expiring { .. } => true,
        ProblemCondition::All { of } | ProblemCondition::Any { of } => {
            of.iter().any(uses_setting_time)
        }
        ProblemCondition::Not { of } => uses_setting_time(of),
        _ => false,
    }
}

/// Whether a condition reads other objects than the judged one: a looked-up kind (`missing`, `related`,
/// `relatedBy`, `selectsNone`) or a judge's answer (`judged`).
pub(crate) fn looks_across(condition: &ProblemCondition) -> bool {
    let mut kinds = Vec::new();
    looked_up(condition, &mut kinds);
    !kinds.is_empty() || !super::problem_judges::judged_in(condition).is_empty()
}

/// The kinds a condition looks up (`missing`), each once, added to `out`.
fn looked_up<'c>(condition: &'c ProblemCondition, out: &mut Vec<&'c KindPattern>) {
    match condition {
        ProblemCondition::Missing {
            kind, also_kinds, ..
        } => {
            for kind in std::iter::once(kind).chain(also_kinds.iter().flatten()) {
                if !out.iter().any(|k| same_kind(k, kind)) {
                    out.push(kind);
                }
            }
        }
        ProblemCondition::Related { kind, .. } | ProblemCondition::RelatedBy { kind, .. } => {
            if !out.iter().any(|k| same_kind(k, kind)) {
                out.push(kind);
            }
        }
        // The objects that select, and the Namespaces whose labels their namespace selectors match (ADR-0169).
        ProblemCondition::SelectsNone {
            kind, selected_by, ..
        } => {
            let selecting = selected_by.iter().flat_map(|by| {
                std::iter::once(&by.kind)
                    .chain(by.also_kinds.iter().flatten())
                    .chain(std::iter::once(namespace_kind()))
            });
            for kind in std::iter::once(kind).chain(selecting) {
                if !out.iter().any(|k| same_kind(k, kind)) {
                    out.push(kind);
                }
            }
        }
        ProblemCondition::SelectedByNone {
            kind, also_kinds, ..
        } => {
            for kind in std::iter::once(kind)
                .chain(also_kinds.iter().flatten())
                .chain(std::iter::once(namespace_kind()))
            {
                if !out.iter().any(|k| same_kind(k, kind)) {
                    out.push(kind);
                }
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
pub(crate) fn check_rule_path(
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
    check_placeholders(text, kind, path, metadata_only, false)
}

/// An item text of a list column (`items.cases[].text`): a message whose placeholders read the item, where `{{.}}` is
/// the item itself (a text item) and a path starting with `$` reads the object (`{{$.metadata.namespace}}`).
pub(crate) fn check_item_message(
    text: &str,
    kind: &KindPattern,
    path: &JsonPath,
) -> Result<(), ManifestError> {
    check_placeholders(text, kind, path, false, true)
}

/// A placeholder's path checked as a field path; in an item text `.` (the item) passes and `$…` is the object's path.
fn check_placeholder_path(
    text: &str,
    kind: &KindPattern,
    path: &JsonPath,
    metadata_only: bool,
    item: bool,
) -> Result<(), ManifestError> {
    let text = text.trim();
    if item && text == "." {
        return Ok(());
    }
    let text = if item {
        text.strip_prefix('$').unwrap_or(text)
    } else {
        text
    };
    check_rule_path(text, kind, path, metadata_only)
}

fn check_placeholders(
    text: &str,
    kind: &KindPattern,
    path: &JsonPath,
    metadata_only: bool,
    item: bool,
) -> Result<(), ManifestError> {
    let placeholders = placeholders(text).ok_or_else(|| at(path, "has a `{{` without its `}}`"))?;
    if placeholders.len() > MAX_PLACEHOLDERS {
        return Err(at(
            path,
            format!("has at most {MAX_PLACEHOLDERS} placeholders"),
        ));
    }
    for field in placeholders {
        // `{{missing}}` (#404): a rule's message names the objects its `missing` of a list did not find.
        // `{{found}}` (ADR-0167 amendment): the objects its `related` or `relatedBy` found, an HPA fighting a VPA.
        if field.trim() == "missing" || field.trim() == "found" {
            continue;
        }
        // `{{path|filter}}` (#404): the value as its first line, last segment, a list joined, or a count.
        // Up to two filters in a row (`|firstLine|clip:300`, #404); `clip:<n>` keeps 1 to 1000 characters.
        let mut parts = field.split('|');
        let field = parts.next().unwrap_or_default();
        let filters: Vec<&str> = parts.map(str::trim).collect();
        if filters.len() > 2 {
            return Err(at(path, "has at most two filters"));
        }
        // Paths tried in turn with `??` (#404): `{{.message ?? .reason}}`, the first with a value that is not empty.
        let tried = split_outside_quotes(field, "??");
        if tried.len() > MAX_ADDED_PATHS {
            return Err(at(path, format!("tries at most {MAX_ADDED_PATHS} paths")));
        }
        if tried.len() > 1 && field.contains('+') && added_paths(field).len() > 1 {
            return Err(at(
                path,
                "adds paths with `+` or tries them with `??`, not both",
            ));
        }
        check_filters(&filters, kind, path, metadata_only, item)?;
        if tried.len() > 1 {
            let last = tried.len() - 1;
            for (i, one) in tried.into_iter().enumerate() {
                // The last may be a literal (#404): `{{.status.updated ?? 0}}`, `{{.value ?? "*"}}`.
                if i == last && placeholder_literal(one.trim()).is_some() {
                    continue;
                }
                check_placeholder_path(one, kind, path, metadata_only, item)?;
            }
            continue;
        }
        // Paths added with `+` before `|sum` (#404): `{{.status.restarts + .status.jobs[*].restarts|sum}}`.
        // Paths multiplied with ` * ` before `|product` (#404): a Prometheus' replicas times its shards.
        let multiplied = split_outside_quotes(field, " * ");
        if multiplied.len() > 1 {
            if filters.first() != Some(&"product") {
                return Err(at(
                    path,
                    "multiplies paths with ` * ` only before `|product`",
                ));
            }
            if multiplied.len() > MAX_ADDED_PATHS {
                return Err(at(
                    path,
                    format!("multiplies at most {MAX_ADDED_PATHS} paths"),
                ));
            }
            for one in multiplied {
                check_placeholder_path(one, kind, path, metadata_only, item)?;
            }
            continue;
        }
        let added = added_paths(field);
        if added.len() > 1 && !matches!(filters.first(), Some(&"sum" | &"count" | &"positions")) {
            return Err(at(
                path,
                "adds paths with `+` only before `|sum`, `|count` or `|positions`",
            ));
        }
        if added.len() > MAX_ADDED_PATHS {
            return Err(at(path, format!("adds at most {MAX_ADDED_PATHS} paths")));
        }
        check_filters(&filters, kind, path, metadata_only, item)?;
        for added in added {
            check_placeholder_path(added, kind, path, metadata_only, item)?;
            // `|positions` (ADR-0169): places in one list, the one its last step matches in.
            if filters.first() == Some(&"positions") && !lists_matches(added) {
                return Err(at(
                    path,
                    "has `|positions` after a path whose last step, and no other, lists the matches (`.spec.routes[match~=\"\",*]`)",
                ));
            }
        }
    }
    Ok(())
}

/// Whether a placeholder's path lists matches in its last step and in no other (`|positions`, ADR-0169).
fn lists_matches(text: &str) -> bool {
    let text = text.trim();
    parse_field_path(text.strip_prefix('$').unwrap_or(text)).is_some_and(|steps| {
        list_steps(&steps) == 1
            && matches!(
                steps.last(),
                Some(PathStep::Match {
                    pick: MatchPick::All,
                    ..
                })
            )
    })
}

/// Below `sextantApi` 5, no path or placeholder of `contributes` (the raw manifest, before defaults) uses what came
/// with it (ADR-0169): lists three deep, a match field compared trimmed (`[field~="…"]`), `|positions`, `|uniqueKey`,
/// `|quantity` in a text, `{{selectsNone:namespaces}}`. An older
/// Sextant refuses them, so a manifest that names an older API must not use them (#420). Strings are visited in key
/// order, as the SDK's `checkParitySyntax`.
pub(crate) fn check_parity_syntax(api: u32, contributes: &Value) -> Result<(), ManifestError> {
    if api >= PARITY_API {
        return Ok(());
    }
    fn new_in(text: &str) -> Option<&'static str> {
        // A compared path may end in a filter (`|count`).
        let text = split_outside_quotes(text, "|")[0].trim();
        let steps = parse_field_path(text.strip_prefix('$').unwrap_or(text))?;
        if list_steps(&steps) > 2 {
            Some("a path with lists three deep (`[*]`)")
        } else if compares_trimmed(&steps) {
            Some("a match field compared trimmed (`[field~=\"…\"]`)")
        } else {
            None
        }
    }
    fn visit(value: &Value, here: &JsonPath) -> Result<(), ManifestError> {
        match value {
            Value::String(text) => {
                let mut found = new_in(text);
                for inner in placeholders(text).unwrap_or_default() {
                    let mut parts = inner.split('|');
                    let field = parts.next().unwrap_or_default();
                    let filters: Vec<&str> = parts.map(str::trim).collect();
                    if filters.contains(&"positions") {
                        found = found.or(Some("`|positions`"));
                    }
                    if filters.contains(&"uniqueKey") {
                        found = found.or(Some("`|uniqueKey`"));
                    }
                    if filters.contains(&"quantity") {
                        found = found.or(Some("`|quantity` in a text"));
                    }
                    if filters.iter().any(|f| f.starts_with("cut:")) {
                        found = found.or(Some("`|cut:<n>`"));
                    }
                    if related_placeholder(inner).is_some() {
                        found = found.or(Some("`{{related:…}}`"));
                    }
                    if inner.trim() == SELECTS_NONE_NAMESPACES {
                        found = found.or(Some("`{{selectsNone:namespaces}}`"));
                    }
                    for one in split_outside_quotes(field, "??")
                        .into_iter()
                        .flat_map(|p| split_outside_quotes(p, "+"))
                        .flat_map(|p| split_outside_quotes(p, " * "))
                    {
                        found = found.or_else(|| new_in(one));
                    }
                }
                match found {
                    Some(what) => Err(at(
                        here,
                        format!("{what} needs sextantApi {PARITY_API} or later"),
                    )),
                    None => Ok(()),
                }
            }
            Value::Array(items) => items
                .iter()
                .enumerate()
                .try_for_each(|(i, item)| visit(item, &here.index(i))),
            Value::Object(fields) => {
                let mut keys: Vec<&String> = fields.keys().collect();
                keys.sort();
                keys.into_iter()
                    .try_for_each(|key| visit(&fields[key], &here.key(key)))
            }
            _ => Ok(()),
        }
    }
    visit(contributes, &JsonPath::default().key("contributes"))
}

/// A placeholder's filters: the listed ones, `clip:<n>`, `after:<marker>`, `fqdn:<path>`, and `share` first in a list
/// column's item text only (ADR-0167 amendment).
fn check_filters(
    filters: &[&str],
    kind: &KindPattern,
    path: &JsonPath,
    metadata_only: bool,
    item: bool,
) -> Result<(), ManifestError> {
    for (i, filter) in filters.iter().copied().enumerate() {
        if filter == "share" {
            if !item || i != 0 {
                return Err(at(
                    path,
                    "has `|share` only first in a list column's item text: an item's share of the list",
                ));
            }
            continue;
        }
        let clip = filter
            .strip_prefix("clip:")
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| (1..=1000).contains(&n));
        // `cut:<n>` (ADR-0169): the first characters without "…", as a built-in column cut a checksum.
        let clip = clip
            || filter
                .strip_prefix("cut:")
                .and_then(|n| n.parse::<u32>().ok())
                .is_some_and(|n| (1..=1000).contains(&n));
        // `after:<marker>` (#404): the text after the marker's last place, `Kind=` of a composed job's GVK.
        let after = filter.strip_prefix("after:").is_some_and(|marker| {
            (1..=20).contains(&marker.chars().count())
                && !marker.contains(['{', '}', '|', '"'])
                && !marker.chars().any(char::is_control)
        });
        // `fqdn:<path>`: a short name completed with the namespace at the path, as Kubernetes' DNS names a Service
        // (`web` → `web.shop.svc.cluster.local`).
        if let Some(namespace) = filter.strip_prefix("fqdn:") {
            check_placeholder_path(namespace, kind, path, metadata_only, item)?;
            continue;
        }
        if !clip && !after && !PLACEHOLDER_FILTERS.contains(&filter) {
            return Err(at(
                path,
                format!(
                    "has a filter `{filter}`: one of {}, clip:<1 to 1000>, cut:<1 to 1000>, after:<marker>, fqdn:<namespace path>",
                    PLACEHOLDER_FILTERS.join(", ")
                ),
            ));
        }
    }
    Ok(())
}

/// The paths an object condition reads, nested ones included (`path`, `otherPath`, `addPaths`), as written.
pub(crate) fn condition_paths(condition: &ProblemCondition) -> Vec<String> {
    fn visit(value: &Value, out: &mut Vec<String>) {
        let Value::Object(fields) = value else {
            return;
        };
        for (key, field) in fields {
            match (key.as_str(), field) {
                ("path" | "otherPath", Value::String(text)) => out.push(text.clone()),
                ("addPaths", Value::Array(items)) => {
                    out.extend(items.iter().filter_map(Value::as_str).map(str::to_owned))
                }
                ("of", Value::Array(items)) => items.iter().for_each(|item| visit(item, out)),
                ("of", item) => visit(item, out),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    if let Ok(value) = serde_json::to_value(condition) {
        visit(&value, &mut out);
    }
    out
}

/// A condition on a list column's item (`items.cases[].when`): an object condition whose path `.` reads the item
/// itself (a text item, ADR-0167 amendment); every other path is checked as the column's.
pub(crate) fn check_item_condition(
    condition: &ProblemCondition,
    kind: &KindPattern,
    path: &JsonPath,
    api: u32,
) -> Result<(), ManifestError> {
    fn itself(value: &mut Value) {
        let Value::Object(fields) = value else {
            return;
        };
        for (key, field) in fields.iter_mut() {
            match (key.as_str(), field) {
                ("path" | "otherPath", Value::String(text)) if text.trim() == "." => {
                    // Checked as a path that reads no secret: the item is the value of a checked list path.
                    *text = ".metadata.name".to_owned();
                }
                ("addPaths", Value::Array(items)) => {
                    for item in items.iter_mut() {
                        if item.as_str().is_some_and(|t| t.trim() == ".") {
                            *item = Value::String(".metadata.name".to_owned());
                        }
                    }
                }
                ("of", Value::Array(items)) => items.iter_mut().for_each(itself),
                ("of", item) => itself(item),
                _ => {}
            }
        }
    }
    let mut value = serde_json::to_value(condition).map_err(|_| at(path, "is not a condition"))?;
    itself(&mut value);
    let checked: ProblemCondition =
        serde_json::from_value(value).map_err(|_| at(path, "is not a condition"))?;
    check_object_condition(&checked, std::slice::from_ref(kind), path, api)
}

/// A placeholder's literal fallback (#404): a number, or a text in double quotes of at most 40 characters without
/// quotes or braces inside.
pub fn placeholder_literal(text: &str) -> Option<&str> {
    if let Some(inner) = text.strip_prefix('"').and_then(|t| t.strip_suffix('"')) {
        let fits = inner.chars().count() <= 40
            && !inner.contains(['"', '{', '}'])
            && !inner.chars().any(char::is_control);
        return fits.then_some(inner);
    }
    let number = !text.is_empty()
        && text.len() <= 20
        && text.parse::<f64>().is_ok_and(f64::is_finite)
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b'.'));
    number.then_some(text)
}

/// A field of another object and one of the judged object's that must hold the same text (`relatedBy`, #404).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FieldPair {
    /// The path in the other object (`.spec.scaleTargetRef.name`).
    pub theirs: String,
    /// The path in the judged object (`.spec.targetRef.name`).
    pub ours: String,
}

/// The most pairs a `relatedBy` compares (#404).
pub const MAX_FIELD_PAIRS: usize = 4;

/// How a rule's object is named by others of its kind (`toldThroughReferrer`, #404).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReferrerRule {
    /// The list of references in a referrer (`.spec.includes`).
    pub path: String,
    /// More places a referrer names others, each a list or one object (`.spec.tcpproxy.include`), at most 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub also_paths: Option<Vec<String>>,
    /// An item's name (`.name`).
    pub name_path: String,
    /// An item's namespace (`.namespace`), else the referrer's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub namespace_path: Option<String>,
    /// What a referrer holds to tell the problem (`Valid` False); reads only the referrer, no time.
    pub when: Box<ProblemCondition>,
}

/// The most paths a placeholder adds (#404).
pub const MAX_ADDED_PATHS: usize = 4;

/// A placeholder's path split at each `+` outside a quoted match value (#404); one path when there is none.
pub fn added_paths(field: &str) -> Vec<&str> {
    split_outside_quotes(field, "+")
}

/// `field` split at each `sep` outside a quoted match value.
fn split_outside_quotes<'a>(field: &'a str, sep: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let (mut quoted, mut start, mut i) = (false, 0, 0);
    while i < field.len() {
        let rest = &field[i..];
        if rest.starts_with('"') {
            quoted = !quoted;
        } else if !quoted && rest.starts_with(sep) {
            out.push(&field[start..i]);
            i += sep.len();
            start = i;
            continue;
        }
        i += rest.chars().next().map_or(1, char::len_utf8);
    }
    out.push(&field[start..]);
    out
}

/// What may follow a placeholder's path after `|` (#404); `lower` writes a text in lower case.
pub const PLACEHOLDER_FILTERS: [&str; 19] = [
    "lower",
    "firstLine",
    "lastSegment",
    "list",
    "join",
    "count",
    "sum",
    "keys",
    "unique",
    "countAll",
    "selector",
    "product",
    "cpu",
    "bytes",
    "daysLeft",
    // The exact host names of Traefik-style match rules: the quoted arguments of `Host(…)`/`HostSNI(…)`, lower case,
    // not `*`, each once, joined with ", " (as the built-in Traefik Hosts column; `hostsOf` in the window).
    "ruleHosts",
    // The 1-based places of a `[…,*]` step's matches in its list, each once, in order, in the UI language's list
    // (ADR-0169): the routes Traefik skips. Paths joined with `+` give every one's places. `sextantApi` 5.
    "positions",
    // A sort key of a list's texts (ADR-0169): each once, empty ones left out, sorted by code point, joined with `,`
    // in every language — as a built-in view keyed a list of names. `sextantApi` 5.
    "uniqueKey",
    // A Kubernetes quantity ("1k", "1500m") written as its amount in the UI language, a whole one without fraction
    // digits and any other with two (ADR-0169), as the built-in Karpenter view wrote a limit. `sextantApi` 5.
    "quantity",
];

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

/// The kind `selectedByNone` and `selectsNone.selectedBy` look Namespaces up as (their labels, metadata only).
fn namespace_kind() -> &'static KindPattern {
    static NAMESPACE: std::sync::LazyLock<KindPattern> =
        std::sync::LazyLock::new(|| KindPattern::new("", "Namespace"));
    &NAMESPACE
}

/// The objects that select (`selectedByNone`, `selectsNone.selectedBy`, ADR-0169): kinds that are no Secret, each
/// once, 1 to 3 more; their selector paths read no secret of theirs; they and the Namespaces count among the rules'
/// kinds, in that order.
fn check_selecting<'k>(
    target: &'k KindPattern,
    also: Option<&'k [KindPattern]>,
    selector: &str,
    namespace_selector: &str,
    also_written: bool,
    path: &JsonPath,
    checks: &mut ConditionChecks<'_, 'k>,
) -> Result<(), ManifestError> {
    let also = also.unwrap_or_default();
    if target.group.is_empty() && target.kind.eq_ignore_ascii_case("Secret") {
        return Err(at(&path.key("kind"), "Secrets are never listed for rules"));
    }
    if also_written && (also.is_empty() || also.len() > 3) {
        return Err(at(&path.key("alsoKinds"), "has 1 to 3 kinds"));
    }
    for (i, other) in also.iter().enumerate() {
        if same_kind(other, target) || also[..i].iter().any(|k| same_kind(k, other)) {
            return Err(at(
                &path.key("alsoKinds").index(i),
                "names a kind already looked up",
            ));
        }
        if other.group.is_empty() && other.kind.eq_ignore_ascii_case("Secret") {
            return Err(at(
                &path.key("alsoKinds").index(i),
                "Secrets are never listed for rules",
            ));
        }
    }
    for (i, kind) in std::iter::once(target).chain(also).enumerate() {
        let place = |key: &str| {
            if i == 0 {
                path.key(key)
            } else {
                path.key("alsoKinds").index(i - 1)
            }
        };
        check_rule_path(selector, kind, &place("selector"), false)?;
        check_rule_path(namespace_selector, kind, &place("namespaceSelector"), false)?;
    }
    let max_kinds = rule_limits(checks.api).1;
    for (i, kind) in std::iter::once(target)
        .chain(also)
        .chain(std::iter::once(namespace_kind()))
        .enumerate()
    {
        if checks.kinds.iter().any(|k| same_kind(k, kind)) {
            continue;
        }
        checks.kinds.push(kind);
        if checks.kinds.len() > max_kinds {
            let place = if i == 0 {
                path.key("kind")
            } else if i <= also.len() {
                path.key("alsoKinds").index(i - 1)
            } else {
                path.key("namespaceSelector")
            };
            return Err(at(
                &place,
                format!("the rules judge at most {max_kinds} kinds"),
            ));
        }
    }
    Ok(())
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

/// Whether a field path names exactly one inline secret field of `kind` (a k3s node's `node-args` annotation), by names
/// only: what `exists`/`absent` may ask of from `sextantApi` 5 (ADR-0169). A path into it, or through `*`, is not.
pub fn is_inline_secret_field(kind: &KindPattern, text: &str) -> bool {
    let Some(steps) = parse_field_path(text.trim()) else {
        return false;
    };
    INLINE_SECRETS
        .iter()
        .filter(|k| {
            k.group.eq_ignore_ascii_case(&kind.group) && k.kind.eq_ignore_ascii_case(&kind.kind)
        })
        .flat_map(|k| k.paths.iter())
        .any(|secret| {
            secret.len() == steps.len()
                && !secret.contains(&"*")
                && secret
                    .iter()
                    .zip(&steps)
                    .all(|(want, got)| matches!(got, PathStep::Key(key) if key == want))
        })
}

/// The kinds the rules of `manifest` judge or look up (`missing`), and then those its judges read (ADR-0168), each
/// once, in order: what the user agrees to have them read (`grantedProblems`).
pub fn problem_kinds(manifest: &ExtensionManifest) -> Vec<KindPattern> {
    let mut out: Vec<KindPattern> = Vec::new();
    // The kinds the judges read go to the extension's backend (ADR-0168): agreed to with the rules' kinds.
    let judged = super::problem_judges::judge_kinds(manifest);
    for rule in &manifest.contributes.problems {
        // A rule of kinds from definitions (`kindsFrom`): its definition kind; the kinds it defines are decided in a
        // cluster by `kinds_from::defined_scopes`.
        let own = rule
            .kinds_from
            .as_ref()
            .map_or(&rule.kind, |from| &from.kind);
        if !out.iter().any(|k| same_kind(k, own)) {
            out.push(own.clone());
        }
        let mut targets = Vec::new();
        looked_up(&rule.when, &mut targets);
        for target in targets {
            if !out.iter().any(|k| same_kind(k, target)) {
                out.push(target.clone());
            }
        }
    }
    for kind in judged {
        if !out.iter().any(|k| same_kind(k, &kind)) {
            out.push(kind);
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
    /// A kind the objects of this definition kind define (`kindsFrom`): only the rules with `kindsFrom` run on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub defined_by: Option<KindPattern>,
    /// A definition kind (`kindsFrom`) of which the cluster holds more objects than the `kindsFrom` reads (`max`): the
    /// kinds the others define are not judged, so the category is told it judges a part (as a capped list is).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(optional, as = "Option<bool>")]
    pub more_definitions: bool,
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
    kinds
        .iter()
        .filter_map(|kind| {
            // The rules', or every namespace of a group `readGroups` reads.
            let namespaces = granted.allowed_namespaces(kind, AccessAction::Read);
            let nowhere =
                matches!(&namespaces, NamespaceScope::Only { namespaces } if namespaces.is_empty());
            (!nowhere).then(|| ProblemScope {
                kind: kind.clone(),
                namespaces,
                defined_by: None,
                more_definitions: false,
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
                path: ".status".into(),
                non_empty: false
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
    fn a_missing_looked_up_in_more_kinds_asks_for_each_and_api_5_takes_more_rules() {
        let mut m = manifest(json!([]));
        m.sextant_api = PARITY_API;
        m.contributes.problems = serde_json::from_value(json!([{
            "id": "mw", "title": "Middleware missing", "kind": { "group": "traefik.io", "kind": "IngressRoute" },
            "when": { "type": "missing", "path": ".spec.routes[*].services[*].middlewares[*]",
                      "kind": { "group": "traefik.io", "kind": "Middleware" },
                      "alsoKinds": [{ "group": "traefik.containo.us", "kind": "Middleware" }],
                      "namePath": ".name", "enclosingNamespacePath": ".namespace" },
            "message": "Middleware {{missing}}"
        }]))
        .unwrap();
        assert_eq!(
            problem_kinds(&m),
            vec![
                kind("traefik.io", "IngressRoute"),
                kind("traefik.io", "Middleware"),
                kind("traefik.containo.us", "Middleware")
            ]
        );
        assert_eq!(rule_limits(PARITY_API), (MAX_RULES_5, MAX_KINDS_4));
        assert_eq!(rule_limits(SOURCES_API), (MAX_RULES_4, MAX_KINDS_4));
        // The syntax API 5 brought, refused below it wherever it is in `contributes`.
        let three = json!({ "columns": [{ "paths": [".a[*].b[*].c[*]"] }] });
        assert!(check_parity_syntax(PARITY_API, &three).is_ok());
        let refused = check_parity_syntax(SOURCES_API, &three).unwrap_err();
        assert_eq!(refused.path, "contributes.columns[0].paths[0]");
        assert!(refused.message.contains("needs sextantApi 5"));
        let filter =
            json!({ "problems": [{ "message": "{{.spec.routes[match=\"\",*]|positions}}" }] });
        assert!(check_parity_syntax(SOURCES_API, &filter).is_err());
        let trimmed = json!({ "problems": [{ "when": { "path": ".r[m~=\"\",*]|count" } }] });
        assert!(check_parity_syntax(SOURCES_API, &trimmed).is_err());
        assert!(
            check_parity_syntax(
                SOURCES_API,
                &json!({ "problems": [{ "message": "{{.a[b!=\"\",*]|count}}" }] })
            )
            .is_ok()
        );
    }

    #[test]
    fn who_selects_an_object_is_looked_up_with_the_namespaces_and_api_5_syntax_is_refused_below() {
        let mut m = manifest(json!([]));
        m.sextant_api = PARITY_API;
        let prometheus = json!({ "group": "monitoring.coreos.com", "kind": "Prometheus" });
        let agent = json!({ "group": "monitoring.coreos.com", "kind": "PrometheusAgent" });
        m.contributes.problems = serde_json::from_value(json!([{
            "id": "np", "title": "Not picked up", "kind": { "group": "monitoring.coreos.com", "kind": "ServiceMonitor" },
            "when": { "type": "selectedByNone", "kind": prometheus, "alsoKinds": [agent],
                      "selector": ".spec.serviceMonitorSelector",
                      "namespaceSelector": ".spec.serviceMonitorNamespaceSelector" },
            "message": "x"
        }, {
            "id": "sn", "title": "Selects nothing", "kind": { "group": "monitoring.coreos.com", "kind": "PodMonitor" },
            "when": { "type": "selectsNone", "kind": { "group": "", "kind": "Pod" }, "selector": ".spec.selector",
                      "selectedBy": { "kind": prometheus, "selector": ".spec.podMonitorSelector",
                                      "namespaceSelector": ".spec.podMonitorNamespaceSelector",
                                      "ownNamespaceWhen": { "type": "equals", "path": ".spec.ignoreNamespaceSelectors", "value": true } } },
            "message": "in {{selectsNone:namespaces}}"
        }]))
        .unwrap();
        assert_eq!(
            problem_kinds(&m),
            vec![
                kind("monitoring.coreos.com", "ServiceMonitor"),
                kind("monitoring.coreos.com", "Prometheus"),
                kind("monitoring.coreos.com", "PrometheusAgent"),
                kind("", "Namespace"),
                kind("monitoring.coreos.com", "PodMonitor"),
                kind("", "Pod"),
            ]
        );
        assert!(looks_across(&m.contributes.problems[0].when));
        for text in ["{{.spec.names|uniqueKey}}", "in {{selectsNone:namespaces}}"] {
            let found = json!({ "problems": [{ "message": text }] });
            assert!(check_parity_syntax(PARITY_API, &found).is_ok());
            let refused = check_parity_syntax(SOURCES_API, &found).unwrap_err();
            assert!(refused.message.contains("needs sextantApi 5"), "{text}");
        }
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
                    defined_by: None,
                    more_definitions: false,
                },
                ProblemScope {
                    kind: kind("", "Node"),
                    namespaces: NamespaceScope::All,
                    defined_by: None,
                    more_definitions: false,
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

    #[test]
    fn maps_are_compared_key_by_key_and_a_quantity_written_only_from_api_5() {
        let at_limit = json!({ "type": "atLeast", "path": ".status.resources|quantity",
                               "otherPath": ".spec.limits|quantity", "eachKey": true });
        let condition: ProblemCondition = serde_json::from_value(at_limit.clone()).unwrap();
        let kind = KindPattern::new("karpenter.sh", "NodePool");
        let here = JsonPath::default().key("when");
        assert!(
            check_object_condition(&condition, std::slice::from_ref(&kind), &here, PARITY_API)
                .is_ok()
        );
        let refused =
            check_object_condition(&condition, std::slice::from_ref(&kind), &here, SOURCES_API)
                .unwrap_err();
        assert!(refused.to_string().contains("eachKey"), "{refused}");
        // Without it an `atLeast` reads as it did, and writes no `eachKey`.
        let one: ProblemCondition =
            serde_json::from_value(json!({ "type": "atLeast", "path": ".a", "otherPath": ".b" }))
                .unwrap();
        assert_eq!(
            serde_json::to_value(&one).unwrap(),
            json!({ "type": "atLeast", "path": ".a", "otherPath": ".b" })
        );
        assert_eq!(serde_json::to_value(&condition).unwrap(), at_limit);
        // `|quantity` in a text is new; in a compared path it is not.
        let text =
            json!({ "columns": [{ "cases": [{ "text": "{{.spec.limits.nodes|quantity}}" }] }] });
        assert!(check_parity_syntax(SOURCES_API, &text).is_err());
        assert!(check_parity_syntax(PARITY_API, &text).is_ok());
        assert!(
            check_parity_syntax(
                SOURCES_API,
                &json!({ "kinds": [{ "problemWhen": at_limit }] })
            )
            .is_ok()
        );
        // A case's `{{value}}` is taken out before its other placeholders are checked.
        let own = super::super::contributions::own_text_placeholders;
        assert_eq!(own("{{ value }} ({{.a}})"), (true, " ({{.a}})".to_owned()));
        assert_eq!(own("{{.value}} {{"), (false, "{{.value}} {{".to_owned()));
    }

    #[test]
    fn a_pattern_reads_any_text_and_digits_as_the_window_does() {
        // The same cases as `fitsPattern` in src/extensions/relatedFound.test.ts.
        for (text, pattern, fits) in [
            ("v1.33.4+k3s1", "*+k3s#", true),
            ("v1.33.4+k3s12", "*+k3s#", true),
            ("v1.33.4+k3sx", "*+k3s#", false),
            ("v1.33.4+k3s", "*+k3s#", false),
            ("v1.33.4+rke2r1", "*+rke2r#", true),
            ("", "*", true),
            ("a", "", false),
            ("ab12cd", "a*#*d", true),
        ] {
            assert_eq!(fits_pattern(text, pattern), fits, "{text} {pattern}");
        }
    }

    #[test]
    fn a_related_placeholder_names_paths_and_nothing_else_reads_like_it() {
        assert_eq!(
            related_placeholder(" related:.a ?? .b[x=\"?? \"] "),
            Some(vec![".a", ".b[x=\"?? \"]"])
        );
        assert_eq!(related_placeholder(".related"), None);
        assert_eq!(related_placeholder("missing"), None);
    }
}
