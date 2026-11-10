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
use crate::access::{self, AccessAction, AccessPreset, ClusterAccess, KindPattern, NamespaceScope};
use crate::resources::inline_secrets::INLINE_SECRETS;
use crate::settings::custom_columns::{PathStep, parse_field_path};

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

/// The rules and the kinds they judge an extension of `api` may have: an older Sextant reads only older manifests, so
/// the limits grow with the version.
pub fn rule_limits(api: u32) -> (usize, usize) {
    if api >= SOURCES_API {
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
    },
    /// The text at `path` names an object of `kind` there (as `missing` looks it up) for which `when` holds (#409): a
    /// claim that exists but is not allocated, an HPA on the same target. `sextantApi` 4; unknown (not holding) while
    /// that list is not read in full; not inside `any` or `not`; `when` reads only the named object (no `missing`,
    /// `related` or times).
    Related {
        path: String,
        kind: KindPattern,
        when: Box<ProblemCondition>,
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
    },
    /// An object of `kind` in the judged object's namespace has, for every pair, the text at `theirs` equal to the
    /// judged object's at `ours`, and `when` holds for it (#404): an HPA on the VPA's target. `sextantApi` 4; unknown
    /// while that list is not read in full; not inside `any` or `not`; `when` reads only that object, no time.
    RelatedBy {
        kind: KindPattern,
        pairs: Vec<FieldPair>,
        when: Box<ProblemCondition>,
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
        if let Some(name) = super::problem_judges::fact_placeholder(inner) {
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
            narrowed: false,
            judges: &[],
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
            check_object_condition(
                when,
                std::slice::from_ref(target),
                &path.key("when"),
                checks.api,
            )?;
            if uses_time(when) {
                return Err(at(
                    &path.key("when"),
                    "reads no time (`olderThan`): it is judged when that object changes",
                ));
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
        ProblemCondition::SelectsNone {
            kind: target,
            selector,
            any_namespaces_path,
            namespaces_path,
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
        ProblemCondition::Related {
            path: field,
            kind: target,
            when,
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
            if !matches!(inside, Inside::Top) {
                return Err(at(
                    &path.key("type"),
                    "`related` cannot be inside `any` or `not`: a list not read would make it unknown",
                ));
            }
            if target.group.is_empty() && target.kind.eq_ignore_ascii_case("Secret") {
                return Err(at(&path.key("kind"), "Secrets are never listed for rules"));
            }
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)?;
            // The named object's own condition: paths of its kind, nothing across objects, no time (it is judged when
            // that object changes, not as time passes).
            check_object_condition(
                when,
                std::slice::from_ref(target),
                &path.key("when"),
                checks.api,
            )?;
            if uses_time(when) {
                return Err(at(
                    &path.key("when"),
                    "reads no time (`olderThan`): it is judged when that object changes",
                ));
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
        ProblemCondition::Missing {
            path: field,
            kind: target,
            name_path,
            namespace_path,
            item_when,
        } => {
            let listed = field.contains('*');
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
            // From sextantApi 4 a Secret is looked up by name only (#404): the window lists Secrets for rules
            // metadata-only, never a value (a SealedSecret's target Secret, ADR-0109).
            if target.group.is_empty()
                && target.kind.eq_ignore_ascii_case("Secret")
                && checks.api < SOURCES_API
            {
                return Err(at(&path.key("kind"), "Secrets are never listed for rules"));
            }
            check_rule_path(field, kind, &path.key("path"), checks.metadata_only)?;
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
        ProblemCondition::Missing { kind, .. }
        | ProblemCondition::Related { kind, .. }
        | ProblemCondition::RelatedBy { kind, .. }
        | ProblemCondition::SelectsNone { kind, .. } => {
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
        if field.trim() == "missing" {
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
        if added.len() > 1 && !matches!(filters.first(), Some(&"sum" | &"count")) {
            return Err(at(
                path,
                "adds paths with `+` only before `|sum` or `|count`",
            ));
        }
        if added.len() > MAX_ADDED_PATHS {
            return Err(at(path, format!("adds at most {MAX_ADDED_PATHS} paths")));
        }
        for filter in filters {
            let clip = filter
                .strip_prefix("clip:")
                .and_then(|n| n.parse::<u32>().ok())
                .is_some_and(|n| (1..=1000).contains(&n));
            // `after:<marker>` (#404): the text after the marker's last place, `Kind=` of a composed job's GVK.
            let after = filter.strip_prefix("after:").is_some_and(|marker| {
                (1..=20).contains(&marker.chars().count())
                    && !marker.contains(['{', '}', '|', '"'])
                    && !marker.chars().any(char::is_control)
            });
            // `fqdn:<path>`: a short name completed with the namespace at the path, as Kubernetes' DNS names a
            // Service (`web` → `web.shop.svc.cluster.local`).
            if let Some(namespace) = filter.strip_prefix("fqdn:") {
                check_placeholder_path(namespace, kind, path, metadata_only, item)?;
                continue;
            }
            if !clip && !after && !PLACEHOLDER_FILTERS.contains(&filter) {
                return Err(at(
                    path,
                    format!(
                        "has a filter `{filter}`: one of {}, clip:<1 to 1000>, after:<marker>, fqdn:<namespace path>",
                        PLACEHOLDER_FILTERS.join(", ")
                    ),
                ));
            }
        }
        for added in added {
            check_placeholder_path(added, kind, path, metadata_only, item)?;
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
pub const PLACEHOLDER_FILTERS: [&str; 15] = [
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
}
