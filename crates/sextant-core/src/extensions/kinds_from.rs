//! Rule kinds read from definitions (`kindsFrom`, `sextantApi` 4; ADR-0137/ADR-0144 amendment): a problem rule whose
//! kinds are known only at run time, from objects of a definition kind — Crossplane's claim and composite kinds,
//! named by its CompositeResourceDefinitions. The rule names no `kind`; instead
//! `"kindsFrom": {"kind": <definition kind>, "groupPath": ".spec.group", "kindPaths": [".spec.names.kind", …], "max": 20}`.
//!
//! What the user agrees to is the definition kind among the rules' kinds (`grantedProblems`) and the `kindsFrom` word
//! for word (`InstalledExtension.grantedKindsFrom`): "the kinds CompositeResourceDefinitions define". Which kinds that
//! is in a cluster is decided here, in Rust, never by the window ([`defined_scopes`]): Sextant lists the definition
//! kind itself with the user's connection, only where the extension's granted rules allow Read on it, reads the group
//! and kinds at the declared paths of the first `max` definitions by namespace and name, and keeps a kind only when it
//! is a custom resource's (a group with a dot, not Kubernetes' own), holds no inline secret field (ADR-0120), is not a
//! kind the manifest names itself, and the extension may read it somewhere. Each becomes a [`ProblemScope`] with
//! `definedBy`, and the window runs the `kindsFrom` rules only on sources of those scopes.
//!
//! A `kindsFrom` rule judges each object by its own fields: no `missing`, `related`, `relatedBy`, `selectsNone` or
//! `judged`, no `toldThroughOwner`, `toldThroughReferrer` or `newestPer`, and no `source.fieldSelector` (the fields an
//! API server selects by are per kind). Every `kindsFrom` of a manifest is the same one.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::manifest::{ExtensionManifest, ManifestError};
use super::permissions::ExtensionPermissions;
use super::problems::{
    ProblemContribution, ProblemScope, check_rule_path, problem_kinds, problem_scopes,
};
use super::schema::JsonPath;
use crate::access::{KindPattern, NamespaceScope};
use crate::cluster::ClusterManager;
use crate::kubeconfig::ClusterId;
use crate::resources::KindRef;
use crate::resources::inline_secrets::INLINE_SECRETS;
use crate::settings::custom_columns::{PathStep, parse_field_path};

/// The extension API version that brought `kindsFrom`.
pub const KINDS_FROM_API: u32 = 4;
/// Definitions a `kindsFrom` reads at most (`max`).
pub const MAX_DEFINITIONS: u32 = 20;
/// Kind paths of one `kindsFrom`.
pub const MAX_KIND_PATHS: usize = 4;
/// Definition objects listed at most to find the first `max` by name.
pub const MAX_DEFINITIONS_LISTED: u32 = 500;
/// Namespaces listed one by one when the extension may read the definition kind only in some.
pub const MAX_DEFINITION_NAMESPACES: usize = 100;

/// Where a rule's kinds come from: the objects of `kind` name them, a group at `groupPath` and kinds at `kindPaths`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KindsFrom {
    /// The definition kind (`apiextensions.crossplane.io/CompositeResourceDefinition`).
    pub kind: KindPattern,
    /// The field holding the defined kinds' API group (`.spec.group`).
    pub group_path: String,
    /// The fields holding the kinds defined (`.spec.names.kind`, `.spec.claimNames.kind`); 1 to 4.
    pub kind_paths: Vec<String>,
    /// The first this many definitions by namespace and name are read; 1 to 20.
    pub max: u32,
}

fn at(path: &JsonPath, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.to_string(),
        message: message.into(),
    }
}

/// A path of keys and indexes only: it names one value of a definition.
fn plain_steps(path: &str) -> Option<Vec<PathStep>> {
    let steps = parse_field_path(path)?;
    steps
        .iter()
        .all(|s| matches!(s, PathStep::Key(_) | PathStep::Index(_)))
        .then_some(steps)
}

/// What reading a manifest checks of a rule's `kindsFrom` (and of a rule without one, its `kind`).
pub(crate) fn check_rule_kinds(
    manifest: &ExtensionManifest,
    rule: &ProblemContribution,
    here: &JsonPath,
) -> Result<(), ManifestError> {
    let Some(from) = &rule.kinds_from else {
        if rule.kind.kind.trim().is_empty() {
            return Err(at(here, "names its `kind`, or its kinds with `kindsFrom`"));
        }
        return Ok(());
    };
    let path = here.key("kindsFrom");
    if manifest.sextant_api < KINDS_FROM_API {
        return Err(at(
            &path,
            format!("needs sextantApi {KINDS_FROM_API} or later"),
        ));
    }
    if !rule.kind.kind.is_empty() || !rule.kind.group.is_empty() {
        return Err(at(
            &here.key("kind"),
            "goes without `kindsFrom`: the definitions name the kinds",
        ));
    }
    if from.kind.kind.contains('*') || from.kind.group.contains('*') {
        return Err(at(&path.key("kind"), "is one kind, not a pattern"));
    }
    if from.kind.group.is_empty() && from.kind.kind.eq_ignore_ascii_case("Secret") {
        return Err(at(&path.key("kind"), "is never a Secret"));
    }
    let fields = std::iter::once((path.key("groupPath"), &from.group_path)).chain(
        from.kind_paths
            .iter()
            .enumerate()
            .map(|(i, p)| (path.key("kindPaths").index(i), p)),
    );
    for (field_at, field) in fields {
        if plain_steps(field).is_none() {
            return Err(at(
                &field_at,
                "is a field path of keys and indexes only, naming one text",
            ));
        }
        check_rule_path(field, &from.kind, &field_at, false)?;
    }
    if from.kind_paths.is_empty() || from.kind_paths.len() > MAX_KIND_PATHS {
        return Err(at(
            &path.key("kindPaths"),
            format!("has 1 to {MAX_KIND_PATHS} paths"),
        ));
    }
    for (i, p) in from.kind_paths.iter().enumerate() {
        if from.kind_paths[..i].contains(p) {
            return Err(at(&path.key("kindPaths").index(i), "is named twice"));
        }
    }
    if from.max == 0 || from.max > MAX_DEFINITIONS {
        return Err(at(&path.key("max"), format!("is 1 to {MAX_DEFINITIONS}")));
    }
    let rules = JsonPath::default().key("contributes").key("problems");
    if let Some(first) = manifest
        .contributes
        .problems
        .iter()
        .position(|other| other.kinds_from.as_ref().is_some_and(|f| f != from))
    {
        return Err(at(
            &path,
            format!(
                "is the same in every rule with `kindsFrom` (as {})",
                rules.index(first)
            ),
        ));
    }
    let own_fields = "judges each object by its own fields";
    if rule.told_through_owner {
        return Err(at(
            &here.key("toldThroughOwner"),
            format!("goes without `kindsFrom`: a rule with it {own_fields}"),
        ));
    }
    if rule.told_through_referrer.is_some() {
        return Err(at(
            &here.key("toldThroughReferrer"),
            format!("goes without `kindsFrom`: a rule with it {own_fields}"),
        ));
    }
    if rule.newest_per.is_some() {
        return Err(at(
            &here.key("newestPer"),
            format!("goes without `kindsFrom`: a rule with it {own_fields}"),
        ));
    }
    if rule
        .source
        .as_ref()
        .is_some_and(|s| s.field_selector.is_some())
    {
        return Err(at(
            &here.key("source").key("fieldSelector"),
            "goes without `kindsFrom`: the fields an API server selects by are each kind's own",
        ));
    }
    if super::problems::looks_across(&rule.when) {
        return Err(at(
            &here.key("when"),
            format!(
                "has no `missing`, `related`, `relatedBy`, `selectsNone` or `judged`: a rule with `kindsFrom` {own_fields}"
            ),
        ));
    }
    Ok(())
}

/// The `kindsFrom` of the manifest's rules, each once (at most one: every rule's is the same).
pub fn kinds_from_of(manifest: &ExtensionManifest) -> Vec<KindsFrom> {
    let mut out: Vec<KindsFrom> = Vec::new();
    for from in manifest
        .contributes
        .problems
        .iter()
        .filter_map(|r| r.kinds_from.as_ref())
    {
        if !out.contains(from) {
            out.push(from.clone());
        }
    }
    out
}

/// Whether every `kindsFrom` of the manifest was agreed to, word for word.
pub fn kinds_from_within(manifest: &ExtensionManifest, granted: Option<&[KindsFrom]>) -> bool {
    kinds_from_of(manifest)
        .iter()
        .all(|from| granted.is_some_and(|g| g.contains(from)))
}

/// The text at `steps` of `object`, when there is one.
fn text_at<'v>(object: &'v Value, steps: &[PathStep]) -> Option<&'v str> {
    let mut here = object;
    for step in steps {
        here = match step {
            PathStep::Key(key) => here.get(key)?,
            PathStep::Index(i) => here.get(*i)?,
            PathStep::Match { .. } => return None,
        };
    }
    here.as_str()
}

/// A Kubernetes kind's name: a capital letter, then letters and digits, at most 63.
fn is_kind_name(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && text.len() <= 63
        && chars.all(|c| c.is_ascii_alphanumeric())
}

/// A DNS subdomain: lower-case labels of letters, digits and `-`, joined by dots, at most 253.
fn is_dns_subdomain(text: &str) -> bool {
    text.len() <= 253
        && text.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

/// The kinds the `definitions` (objects of `from.kind`) define, as Sextant takes them: of the first `from.max` by
/// namespace and name, the group at `groupPath` and each kind at `kindPaths`; only a custom resource's group, a kind's
/// name, no kind with an inline secret field (ADR-0120) and none of `named` (the kinds the manifest names itself);
/// each once, in that order.
pub fn defined_kinds(
    from: &KindsFrom,
    definitions: &[Value],
    named: &[KindPattern],
) -> Vec<KindPattern> {
    let (Some(group_steps), Some(kind_steps)) = (
        plain_steps(&from.group_path),
        from.kind_paths
            .iter()
            .map(|p| plain_steps(p))
            .collect::<Option<Vec<_>>>(),
    ) else {
        return Vec::new();
    };
    let key = |o: &Value| {
        let meta = o.get("metadata");
        let text = |k: &str| {
            meta.and_then(|m| m.get(k))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        (text("namespace"), text("name"))
    };
    let mut sorted: Vec<&Value> = definitions.iter().collect();
    sorted.sort_by_key(|o| key(o));
    let same = |a: &KindPattern, b: &KindPattern| {
        a.group.eq_ignore_ascii_case(&b.group) && a.kind.eq_ignore_ascii_case(&b.kind)
    };
    let mut out: Vec<KindPattern> = Vec::new();
    for definition in sorted.into_iter().take(from.max as usize) {
        let Some(group) = text_at(definition, &group_steps) else {
            continue;
        };
        if !super::contributions::is_custom_group(group) || !is_dns_subdomain(group) {
            continue;
        }
        for steps in &kind_steps {
            let Some(kind) = text_at(definition, steps).filter(|k| is_kind_name(k)) else {
                continue;
            };
            let found = KindPattern::new(group, kind);
            let inline = INLINE_SECRETS
                .iter()
                .any(|k| k.group.eq_ignore_ascii_case(group) && k.kind.eq_ignore_ascii_case(kind));
            if inline
                || named.iter().any(|n| same(n, &found))
                || out.iter().any(|o| same(o, &found))
            {
                continue;
            }
            out.push(found);
        }
    }
    out
}

/// Where the `kindsFrom` rules run in the cluster `cluster` (context `context`) for an extension granted `granted`
/// and the `kindsFrom` agreed to (`agreed`, each also in the manifest): for each kind the definitions define
/// ([`defined_kinds`]) that the extension may read somewhere, a scope `definedBy` the definition kind. The definitions
/// are listed with the user's connection only where the extension may read them (`scopes`: the manifest's own kinds'
/// scopes, among them the definition kind's); a list that fails defines nothing.
pub async fn defined_scopes(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    context: &str,
    granted: &ExtensionPermissions,
    manifest: &ExtensionManifest,
    agreed: &[KindsFrom],
    scopes: &[ProblemScope],
) -> Vec<ProblemScope> {
    let named = problem_kinds(manifest);
    let mut out: Vec<ProblemScope> = Vec::new();
    for from in kinds_from_of(manifest)
        .into_iter()
        .filter(|f| agreed.contains(f))
    {
        let Some(scope) = scopes.iter().find(|s| {
            s.kind.group.eq_ignore_ascii_case(&from.kind.group)
                && s.kind.kind.eq_ignore_ascii_case(&from.kind.kind)
        }) else {
            continue;
        };
        let kind = KindRef {
            group: from.kind.group.clone(),
            version: String::new(),
            kind: from.kind.kind.clone(),
        };
        let namespaces: Vec<Option<&str>> = match &scope.namespaces {
            NamespaceScope::All => vec![None],
            NamespaceScope::Only { namespaces } => namespaces
                .iter()
                .take(MAX_DEFINITION_NAMESPACES)
                .map(|ns| Some(ns.as_str()))
                .collect(),
        };
        let mut definitions = Vec::new();
        let mut failed = false;
        for namespace in namespaces {
            match crate::resources::list(
                mgr,
                cluster,
                &kind,
                namespace,
                None,
                None,
                MAX_DEFINITIONS_LISTED,
            )
            .await
            {
                Ok(page) => definitions.extend(page.items),
                Err(_) => failed = true,
            }
        }
        if failed {
            continue;
        }
        let defined = defined_kinds(&from, &definitions, &named);
        for found in problem_scopes(granted, context, &defined) {
            out.push(ProblemScope {
                defined_by: Some(from.kind.clone()),
                ..found
            });
        }
    }
    out
}

#[cfg(test)]
mod tests;
