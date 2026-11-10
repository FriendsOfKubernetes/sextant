//! Problem judges of an extension (`contributes.problemJudges`, ADR-0168): problems the extension's own WebAssembly
//! backend decides, for what declarative rules cannot say (an Istio host resolved through wildcards, short names and
//! `exportTo`). The backend only decides; Sextant keeps everything else — the rule that turns a judge's fact into a
//! problem (`{"type": "judged", "judge", "fact"}`), its texts and translations, notifications, counters, consent and
//! what agents get.
//!
//! A judge names the kinds it reads and, per kind, the field paths it gets (the rules' path grammar, never a Secret,
//! never an inline secret field: [`super::problems::check_rule_path`]), and the facts it may answer, each with up to
//! [`MAX_FACT_VALUES`] named texts a rule's message shows as `{{fact:<name>}}`. The window collects the objects of the
//! read kinds from the problems store's own sources and Rust re-projects them ([`project_objects`]) before the backend
//! gets `handle("problemJudge:<id>", {"objects": [...]})`, every host call and network request refused meanwhile;
//! the answer is read back by [`read_answer`].
//!
//! A read marked `partial` (ADR-0168 amendment) may be read in some namespaces only — where the extension's scope
//! or the API server allows: the judge then also gets `"partial": [{kind, readNamespaces?, unreadNamespaces}]`
//! ([`project_partial`]), and must take that kind's objects in the other namespaces as unknown, not absent. A fact
//! may say what it rests on (`needs`, [`JudgedNeed`]): an agent is then told the problem when it may read those,
//! instead of every kind the judge read.
//!
//! An object the backend gets: `{apiVersion, kind, metadata: {name, namespace?, uid, creationTimestamp?}, values}`,
//! where `values` maps each declared path of its kind to the value there (a path that leads nowhere is left out).
//! Labels and annotations go only as the values of paths that name them (`.metadata.labels`).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::manifest::{ExtensionManifest, ManifestError};
use super::problems::{ProblemCondition, ProblemScope, check_rule_path, reads_secret};
use super::schema::JsonPath;
use crate::access::{KindPattern, NamespaceScope};
use crate::settings::custom_columns::parse_field_path;
use crate::{CoreError, CoreResult, ErrorCode};

/// The extension API version that brought `contributes.problemJudges`.
pub const JUDGES_API: u32 = 4;
/// Judges of one extension.
pub const MAX_JUDGES: usize = 5;
/// Kinds one judge reads.
pub const MAX_JUDGE_KINDS: usize = 10;
/// Paths of one kind a judge reads.
pub const MAX_JUDGE_PATHS: usize = 40;
/// Facts one judge may answer.
pub const MAX_JUDGE_FACTS: usize = 20;
/// Named texts of one fact.
pub const MAX_FACT_VALUES: usize = 5;
/// The backend method that answers the judge `id`: `problemJudge:<id>`.
pub const METHOD_PREFIX: &str = "problemJudge:";
/// Objects of one kind a judge gets at most; a source holding more cannot tell.
pub const MAX_JUDGED_OBJECTS_PER_KIND: usize = 5000;
/// The objects of one call, as JSON, at most.
pub const MAX_JUDGE_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
/// Facts of one answer at most; a longer answer is refused whole. 10 000 (2000 at first): a rule judged `each` tells
/// one problem per fact, so an object may have several of one fact, and 5000 objects a kind may each have some.
pub const MAX_JUDGED_FACTS: usize = 10_000;
/// A fact's text is clipped to this many characters (as a rule's placeholder value).
pub const MAX_FACT_VALUE_CHARS: usize = 1000;
/// What one fact may say it rests on (`needs`); a fact with more keeps none, and with it the stricter rule.
pub const MAX_FACT_NEEDS: usize = 20;
/// Namespaces one `partial` entry names in either list.
pub const MAX_PARTIAL_NAMESPACES: usize = 1000;

/// A judge: the backend decides its facts from the declared fields of the objects of the kinds it reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProblemJudgeContribution {
    pub id: String,
    /// The kinds it reads and, of each, the fields it gets.
    pub reads: Vec<JudgeRead>,
    /// The facts it may answer about an object.
    pub facts: Vec<JudgeFact>,
}

/// A kind a judge reads, and the field paths of its objects it gets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JudgeRead {
    pub kind: KindPattern,
    /// Field paths of the rules' grammar (`.spec.hosts`, `.spec.http[*].route[*].destination`).
    pub paths: Vec<String>,
    /// A kind the cluster may not serve: then the judge gets none of its objects, instead of not telling at all (a
    /// served kind not read in full still cannot tell). A ServiceEntry where Istio's CRDs leave it out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub optional: Option<bool>,
    /// A kind that may be read in some namespaces only (the extension's scope there, or the API server refusing the
    /// others): the judge then gets the objects read and, in the input's `partial`, where the kind was not read
    /// ([`JudgedPartial`]), instead of not telling at all. A read without it cannot tell unless read everywhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub partial: Option<bool>,
}

/// A fact a judge may answer about an object, and the texts it may give with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JudgeFact {
    pub id: String,
    /// Names of the texts a rule's message shows as `{{fact:<name>}}`.
    #[serde(default)]
    pub values: Vec<String>,
}

/// An object as a judge gets it: who it is, and the values at the declared paths of its kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JudgedObject {
    pub api_version: String,
    pub kind: String,
    pub metadata: JudgedMetadata,
    /// Declared path → the value there; a path that leads nowhere is left out.
    #[ts(type = "Record<string, unknown>")]
    pub values: BTreeMap<String, Value>,
}

/// The metadata every judged object carries; anything else only through a declared path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JudgedMetadata {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub namespace: Option<String>,
    pub uid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub creation_timestamp: Option<String>,
}

/// One fact of a judge's answer: about the object `uid`, with the texts its declared value names give.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JudgedFact {
    pub uid: String,
    pub fact: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub values: Option<BTreeMap<String, String>>,
    /// What the finding rests on (at most [`MAX_FACT_NEEDS`], each of a kind the judge reads): an agent is told the
    /// problem when it may read every one of them. Without it, every kind the judge read where it read them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub needs: Option<Vec<JudgedNeed>>,
}

/// An object or a list a judged fact rests on: one object of `kind` (`name`), or the kind's objects in `namespace`,
/// or (neither) in every namespace. For a kind without namespaces, `namespace` is left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JudgedNeed {
    pub kind: KindPattern,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
}

/// A kind of a `partial` read that was not read everywhere: its objects outside the read namespaces are unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JudgedPartial {
    pub kind: KindPattern,
    /// Read in full only in these namespaces (every other is unread); left out: in every namespace but
    /// `unreadNamespaces`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub read_namespaces: Option<Vec<String>>,
    /// Namespaces where the list was refused: its objects there are unknown, not absent.
    #[serde(default)]
    pub unread_namespaces: Vec<String>,
}

/// A fact's value name: a letter, then letters, digits and `-`, at most 40.
fn is_value_name(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && text.len() <= 40
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The name of a `{{fact:<name>}}` placeholder's inside, when it is one.
pub fn fact_placeholder(inner: &str) -> Option<&str> {
    inner.trim().strip_prefix("fact:").map(str::trim)
}

/// The `(judge, fact)` pairs of the `judged` conditions in `condition`.
pub fn judged_in(condition: &ProblemCondition) -> Vec<(&str, &str)> {
    match condition {
        ProblemCondition::Judged { judge, fact, .. } => vec![(judge.as_str(), fact.as_str())],
        ProblemCondition::All { of } | ProblemCondition::Any { of } => {
            of.iter().flat_map(judged_in).collect()
        }
        ProblemCondition::Not { of } => judged_in(of),
        _ => Vec::new(),
    }
}

fn same_kind(a: &KindPattern, b: &KindPattern) -> bool {
    a.group.eq_ignore_ascii_case(&b.group) && a.kind.eq_ignore_ascii_case(&b.kind)
}

fn at(path: &JsonPath, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.to_string(),
        message: message.into(),
    }
}

/// What reading a manifest checks of its judges beyond the schema: the API version, a backend to answer, the limits,
/// unique facts and value names, paths that read no secret, and that the rules of each judge use it and belong to one
/// problem category (one judge runs once per cluster).
pub(crate) fn check_problem_judges(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let judges = &manifest.contributes.problem_judges;
    let list = JsonPath::default().key("contributes").key("problemJudges");
    if judges.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < JUDGES_API {
        return Err(at(&list, format!("needs sextantApi {JUDGES_API} or later")));
    }
    if manifest.backend.is_none() {
        return Err(at(
            &list,
            "needs a `backend`: the extension's backend decides the judges' facts",
        ));
    }
    if judges.len() > MAX_JUDGES {
        return Err(at(&list, format!("has at most {MAX_JUDGES} judges")));
    }
    for (i, judge) in judges.iter().enumerate() {
        let here = list.index(i);
        if judge.reads.is_empty() || judge.reads.len() > MAX_JUDGE_KINDS {
            return Err(at(
                &here.key("reads"),
                format!("reads 1 to {MAX_JUDGE_KINDS} kinds"),
            ));
        }
        for (j, read) in judge.reads.iter().enumerate() {
            let read_at = here.key("reads").index(j);
            if judge.reads[..j]
                .iter()
                .any(|r| same_kind(&r.kind, &read.kind))
            {
                return Err(at(&read_at.key("kind"), "is read twice by the judge"));
            }
            if read.kind.group.is_empty() && read.kind.kind.eq_ignore_ascii_case("Secret") {
                return Err(at(
                    &read_at.key("kind"),
                    "Secrets are never given to a judge",
                ));
            }
            if read.paths.is_empty() || read.paths.len() > MAX_JUDGE_PATHS {
                return Err(at(
                    &read_at.key("paths"),
                    format!("has 1 to {MAX_JUDGE_PATHS} paths"),
                ));
            }
            for (k, path) in read.paths.iter().enumerate() {
                check_rule_path(path, &read.kind, &read_at.key("paths").index(k), false)?;
            }
        }
        if judge.facts.is_empty() || judge.facts.len() > MAX_JUDGE_FACTS {
            return Err(at(
                &here.key("facts"),
                format!("has 1 to {MAX_JUDGE_FACTS} facts"),
            ));
        }
        for (j, fact) in judge.facts.iter().enumerate() {
            let fact_at = here.key("facts").index(j);
            if judge.facts[..j].iter().any(|f| f.id == fact.id) {
                return Err(at(
                    &fact_at.key("id"),
                    "is the id of another fact of the judge",
                ));
            }
            if fact.values.len() > MAX_FACT_VALUES {
                return Err(at(
                    &fact_at.key("values"),
                    format!("names at most {MAX_FACT_VALUES} values"),
                ));
            }
            for (k, value) in fact.values.iter().enumerate() {
                let value_at = fact_at.key("values").index(k);
                if !is_value_name(value) {
                    return Err(at(
                        &value_at,
                        "is a name of a letter, then letters, digits and `-`, at most 40",
                    ));
                }
                if fact.values[..k].contains(value) {
                    return Err(at(&value_at, "is named twice"));
                }
            }
        }
        // The rules that use it, and their category: a judge runs once per cluster, for one category's sources.
        let rules = JsonPath::default().key("contributes").key("problems");
        let mut category: Option<(usize, Option<&str>)> = None;
        for (r, rule) in manifest.contributes.problems.iter().enumerate() {
            if !judged_in(&rule.when).iter().any(|(j, _)| *j == judge.id) {
                continue;
            }
            match category {
                None => category = Some((r, rule.category.as_deref())),
                Some((first, own)) if own != rule.category.as_deref() => {
                    return Err(at(
                        &rules.index(r).key("category"),
                        format!(
                            "the rules of the judge `{}` belong to one problem category (as {})",
                            judge.id,
                            rules.index(first)
                        ),
                    ));
                }
                Some(_) => {}
            }
        }
        if category.is_none() {
            return Err(at(
                &here.key("id"),
                "no rule judges with it (a `judged` condition naming it)",
            ));
        }
    }
    Ok(())
}

/// The `judged` condition of a rule of `kind` (`check_condition`): a declared judge and fact, a kind it reads.
pub(crate) fn check_judged(
    manifest_judges: &[ProblemJudgeContribution],
    judge: &str,
    fact: &str,
    kind: &KindPattern,
    path: &JsonPath,
) -> Result<(), ManifestError> {
    let Some(found) = manifest_judges.iter().find(|j| j.id == judge) else {
        return Err(at(
            &path.key("judge"),
            "is not the id of one of `contributes.problemJudges`",
        ));
    };
    if !found.facts.iter().any(|f| f.id == fact) {
        return Err(at(
            &path.key("fact"),
            format!("is not a fact of the judge `{judge}`"),
        ));
    }
    if !found.reads.iter().any(|r| same_kind(&r.kind, kind)) {
        return Err(at(
            &path.key("judge"),
            format!("does not read the rule's kind {}", kind_name(kind)),
        ));
    }
    Ok(())
}

/// The value names a rule's message may show (`{{fact:<name>}}`): those of the facts its `judged` conditions name.
pub(crate) fn fact_values<'m>(
    judges: &'m [ProblemJudgeContribution],
    condition: &ProblemCondition,
) -> Vec<&'m str> {
    let mut out: Vec<&str> = Vec::new();
    for (judge, fact) in judged_in(condition) {
        let values = judges
            .iter()
            .find(|j| j.id == judge)
            .and_then(|j| j.facts.iter().find(|f| f.id == fact))
            .map(|f| f.values.as_slice())
            .unwrap_or_default();
        for value in values {
            if !out.contains(&value.as_str()) {
                out.push(value);
            }
        }
    }
    out
}

/// The kinds the judges of `manifest` read, each once: agreed to with the rules' kinds (`grantedProblems`).
pub fn judge_kinds(manifest: &ExtensionManifest) -> Vec<KindPattern> {
    let mut out: Vec<KindPattern> = Vec::new();
    for read in manifest
        .contributes
        .problem_judges
        .iter()
        .flat_map(|j| &j.reads)
    {
        if !out.iter().any(|k| same_kind(k, &read.kind)) {
            out.push(read.kind.clone());
        }
    }
    out
}

fn kind_name(kind: &KindPattern) -> String {
    if kind.group.is_empty() {
        kind.kind.clone()
    } else {
        format!("{}/{}", kind.group, kind.kind)
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

fn text_field<'v>(value: &'v Value, key: &str, max: usize) -> Option<&'v str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && t.len() <= max)
}

/// The objects the window collected for `judge`, as the backend gets them: each of a kind the judge reads, in a
/// namespace of that kind's scope (a kind without namespaces only with every namespace), with name, uid, namespace and
/// creation time only, and the values of the judge's paths of its kind only — a path that reads secret material is
/// dropped again. At most [`MAX_JUDGED_OBJECTS_PER_KIND`] per kind and [`MAX_JUDGE_PAYLOAD_BYTES`] in all.
pub fn project_objects(
    judge: &ProblemJudgeContribution,
    objects: Vec<Value>,
    scopes: &[ProblemScope],
) -> CoreResult<Vec<JudgedObject>> {
    let mut counts = vec![0usize; judge.reads.len()];
    let mut uids = HashSet::new();
    let mut out = Vec::with_capacity(objects.len());
    for object in objects {
        let (Some(api_version), Some(kind)) = (
            text_field(&object, "apiVersion", 317),
            text_field(&object, "kind", 63),
        ) else {
            return Err(invalid("a judged object has no apiVersion or kind"));
        };
        let group = api_version.rsplit_once('/').map_or("", |(group, _)| group);
        let wanted = KindPattern::new(group, kind);
        let Some(index) = judge.reads.iter().position(|r| same_kind(&r.kind, &wanted)) else {
            return Err(invalid(format!(
                "the judge `{}` does not read {}",
                judge.id,
                kind_name(&wanted)
            )));
        };
        let read = &judge.reads[index];
        counts[index] += 1;
        if counts[index] > MAX_JUDGED_OBJECTS_PER_KIND {
            return Err(invalid(format!(
                "a judge gets at most {MAX_JUDGED_OBJECTS_PER_KIND} objects of a kind"
            )));
        }
        let meta = object.get("metadata").unwrap_or(&Value::Null);
        let (Some(name), Some(uid)) = (text_field(meta, "name", 253), text_field(meta, "uid", 128))
        else {
            return Err(invalid("a judged object has no name or uid"));
        };
        if !uids.insert(uid.to_owned()) {
            return Err(invalid("two judged objects have the same uid"));
        }
        let namespace = text_field(meta, "namespace", 63).map(str::to_owned);
        let scope = scopes
            .iter()
            .find(|s| same_kind(&s.kind, &read.kind))
            .map(|s| &s.namespaces);
        let within = match (scope, namespace.as_deref()) {
            (Some(NamespaceScope::All), _) => true,
            (Some(NamespaceScope::Only { namespaces }), Some(ns)) => {
                namespaces.iter().any(|n| n == ns)
            }
            _ => false,
        };
        if !within {
            return Err(CoreError::new(
                ErrorCode::Forbidden,
                format!(
                    "the extension may not have {} judged there",
                    kind_name(&read.kind)
                ),
            ));
        }
        let mut values = BTreeMap::new();
        if let Some(sent) = object.get("values").and_then(Value::as_object) {
            for path in &read.paths {
                let Some(value) = sent.get(path) else {
                    continue;
                };
                // Refused when the manifest was read; checked again on the object's own kind.
                let secret =
                    parse_field_path(path).is_none_or(|steps| reads_secret(&wanted, &steps));
                if !secret {
                    values.insert(path.clone(), value.clone());
                }
            }
        }
        out.push(JudgedObject {
            api_version: api_version.to_owned(),
            kind: kind.to_owned(),
            metadata: JudgedMetadata {
                name: name.to_owned(),
                namespace,
                uid: uid.to_owned(),
                creation_timestamp: text_field(meta, "creationTimestamp", 64).map(str::to_owned),
            },
            values,
        });
    }
    let size = serde_json::to_vec(&out).map_or(usize::MAX, |b| b.len());
    if size > MAX_JUDGE_PAYLOAD_BYTES {
        return Err(invalid(format!(
            "the judged objects are larger than {} MiB",
            MAX_JUDGE_PAYLOAD_BYTES / (1024 * 1024)
        )));
    }
    Ok(out)
}

/// A namespace list of a `partial` entry: DNS labels, at most [`MAX_PARTIAL_NAMESPACES`], sorted, each once.
fn namespace_list(value: Option<&Value>, what: &str) -> CoreResult<Option<Vec<String>>> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let Some(items) = value.as_array() else {
        return Err(invalid(format!("a partial read's {what} is not a list")));
    };
    if items.len() > MAX_PARTIAL_NAMESPACES {
        return Err(invalid(format!(
            "a partial read names at most {MAX_PARTIAL_NAMESPACES} namespaces"
        )));
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        match item.as_str() {
            Some(ns) if super::services::is_dns_label(ns) => out.push(ns.to_owned()),
            _ => {
                return Err(invalid(format!(
                    "a partial read's {what} holds a name that is no namespace"
                )));
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(Some(out))
}

/// Where the window says the kinds of `judge`'s `partial` reads were not read (`given`), as the backend gets it:
/// each a `partial` read of the judge, once; its read namespaces cut to the kind's scope, and a `partial` read whose
/// scope is a list of namespaces said to be read only there even when the window left it out — so the backend is
/// never told a kind was read where the extension may not read it. Every object of `sent` of such a kind is in a
/// namespace it was read in (one without a namespace only where it was read everywhere).
pub fn project_partial(
    judge: &ProblemJudgeContribution,
    given: Vec<Value>,
    scopes: &[ProblemScope],
    sent: &[JudgedObject],
) -> CoreResult<Vec<JudgedPartial>> {
    let mut out: Vec<JudgedPartial> = Vec::new();
    for entry in given {
        let kind = entry
            .get("kind")
            .and_then(|k| serde_json::from_value::<KindPattern>(k.clone()).ok())
            .ok_or_else(|| invalid("a partial read names no kind"))?;
        let Some(read) = judge.reads.iter().find(|r| same_kind(&r.kind, &kind)) else {
            return Err(invalid(format!(
                "the judge `{}` does not read {}",
                judge.id,
                kind_name(&kind)
            )));
        };
        if read.partial != Some(true) {
            return Err(invalid(format!(
                "the judge `{}` does not read {} in part",
                judge.id,
                kind_name(&kind)
            )));
        }
        if out.iter().any(|p| same_kind(&p.kind, &read.kind)) {
            return Err(invalid(format!(
                "{} is said twice to be read in part",
                kind_name(&kind)
            )));
        }
        out.push(JudgedPartial {
            kind: read.kind.clone(),
            read_namespaces: namespace_list(entry.get("readNamespaces"), "read namespaces")?,
            unread_namespaces: namespace_list(entry.get("unreadNamespaces"), "unread namespaces")?
                .unwrap_or_default(),
        });
    }
    for read in judge.reads.iter().filter(|r| r.partial == Some(true)) {
        let scope = scopes
            .iter()
            .find(|s| same_kind(&s.kind, &read.kind))
            .map(|s| &s.namespaces);
        let Some(NamespaceScope::Only { namespaces }) = scope else {
            continue;
        };
        match out.iter_mut().find(|p| same_kind(&p.kind, &read.kind)) {
            Some(entry) => {
                let read_in = entry
                    .read_namespaces
                    .take()
                    .unwrap_or_else(|| namespaces.clone());
                let mut kept: Vec<String> = read_in
                    .into_iter()
                    .filter(|ns| namespaces.contains(ns))
                    .collect();
                kept.sort();
                entry.read_namespaces = Some(kept);
            }
            None => {
                let mut kept = namespaces.clone();
                kept.sort();
                kept.dedup();
                out.push(JudgedPartial {
                    kind: read.kind.clone(),
                    read_namespaces: Some(kept),
                    unread_namespaces: Vec::new(),
                });
            }
        }
    }
    for object in sent {
        let group = object
            .api_version
            .rsplit_once('/')
            .map_or("", |(group, _)| group);
        let kind = KindPattern::new(group, object.kind.as_str());
        let Some(entry) = out.iter().find(|p| same_kind(&p.kind, &kind)) else {
            continue;
        };
        let read_there = match object.metadata.namespace.as_deref() {
            Some(ns) => {
                !entry.unread_namespaces.iter().any(|n| n == ns)
                    && entry
                        .read_namespaces
                        .as_ref()
                        .is_none_or(|read| read.iter().any(|n| n == ns))
            }
            None => entry.read_namespaces.is_none() && entry.unread_namespaces.is_empty(),
        };
        if !read_there {
            return Err(invalid(format!(
                "a judged {} is in a namespace said not to be read",
                kind_name(&kind)
            )));
        }
    }
    out.sort_by_key(|a| kind_name(&a.kind));
    Ok(out)
}

/// What a fact says it rests on, as Sextant keeps it: only needs of kinds the judge reads; `None` (the stricter rule:
/// every kind the judge read) when the answer gives none, more than [`MAX_FACT_NEEDS`], or one that is not a need.
fn needs_of(judge: &ProblemJudgeContribution, value: Option<&Value>) -> Option<Vec<JudgedNeed>> {
    let items = value?.as_array()?;
    if items.len() > MAX_FACT_NEEDS {
        return None;
    }
    let mut out = Vec::new();
    for item in items {
        let need: JudgedNeed = serde_json::from_value(item.clone()).ok()?;
        let named = |text: &Option<String>, max: usize| {
            text.as_deref()
                .is_none_or(|t| !t.is_empty() && t.len() <= max && !t.chars().any(char::is_control))
        };
        if !named(&need.name, 253)
            || need
                .namespace
                .as_deref()
                .is_some_and(|ns| !super::services::is_dns_label(ns))
        {
            return None;
        }
        // The judge never saw another kind: what it says of one rests on nothing it read.
        let Some(read) = judge.reads.iter().find(|r| same_kind(&r.kind, &need.kind)) else {
            continue;
        };
        let need = JudgedNeed {
            kind: read.kind.clone(),
            ..need
        };
        if !out.contains(&need) {
            out.push(need);
        }
    }
    Some(out)
}

/// A fact's text as a message may show it: control characters as spaces, a URI cleaned, clipped.
fn shown(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = crate::alerts::clean_text(flat.trim());
    let mut chars = cleaned.chars();
    let mut out: String = chars.by_ref().take(MAX_FACT_VALUE_CHARS).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

/// What a judge answered, as Sextant keeps it: a list of at most [`MAX_JUDGED_FACTS`] facts, each about an object it
/// was given, of a fact it declares, with only the texts that fact names (cleaned and clipped) and what it rests on
/// ([`needs_of`]); one fact per object, fact id and texts — the same fact of an object again with other texts is kept
/// (a rule judged `each` tells each), the very same again is not (the first one's needs stand). Facts outside that are
/// left out and counted (the second item).
pub fn read_answer(
    judge: &ProblemJudgeContribution,
    sent: &[JudgedObject],
    answer: Value,
) -> CoreResult<(Vec<JudgedFact>, usize)> {
    let Value::Array(items) = answer else {
        return Err(invalid(
            "the judge answered with something that is not a list of facts",
        ));
    };
    if items.len() > MAX_JUDGED_FACTS {
        return Err(invalid(format!(
            "the judge answered more than {MAX_JUDGED_FACTS} facts"
        )));
    }
    let uids: HashSet<&str> = sent.iter().map(|o| o.metadata.uid.as_str()).collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut left_out = 0;
    for item in items {
        let uid = item.get("uid").and_then(Value::as_str);
        let fact = item
            .get("fact")
            .and_then(Value::as_str)
            .and_then(|f| judge.facts.iter().find(|d| d.id == f));
        let (Some(uid), Some(fact)) = (uid.filter(|u| uids.contains(u)), fact) else {
            left_out += 1;
            continue;
        };
        let values: BTreeMap<String, String> = item
            .get("values")
            .and_then(Value::as_object)
            .map(|given| {
                fact.values
                    .iter()
                    .filter_map(|name| {
                        let text = given.get(name)?.as_str()?;
                        Some((name.clone(), shown(text)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !seen.insert((uid.to_owned(), fact.id.clone(), values.clone())) {
            continue;
        }
        out.push(JudgedFact {
            uid: uid.to_owned(),
            fact: fact.id.clone(),
            values: (!values.is_empty()).then_some(values),
            needs: needs_of(judge, item.get("needs")),
        });
    }
    Ok((out, left_out))
}

#[cfg(test)]
mod tests;
