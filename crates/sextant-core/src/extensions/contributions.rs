//! What reading a manifest checks of the window's contributions beyond the schema, for the fields `sextantApi` 4
//! brought (ADR-0152 to ADR-0154): an action's condition and placement, a column computed from field paths, and kinds
//! listed in a section of the extension's own. The window evaluates all of them on objects it already holds; no
//! extension code runs for them.

use super::manifest::{
    ActionContribution, ColumnContribution, ColumnFormat, ExtensionManifest, ManifestError,
};
use super::problems::{check_object_condition, check_path};
use super::schema::JsonPath;
use crate::access::{AccessAction, KindPattern};

/// The extension API version that brought computed columns, action conditions and `contributes.kinds`.
pub const WINDOW_API: u32 = 4;
/// Longest value a column's `tones` names.
pub const MAX_TONE_VALUE_CHARS: usize = 100;

/// An action's `when`, `whyNot` and `placement`.
pub(crate) fn check_actions(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let list = JsonPath::default().key("contributes").key("actions");
    for (i, action) in manifest.contributes.actions.iter().enumerate() {
        let here = list.index(i);
        for (field, set) in fields_of_action(action) {
            if set && manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &here.key(field),
                    format!("needs sextantApi {WINDOW_API} or later"),
                ));
            }
        }
        if action.why_not.is_some() && action.when.is_none() {
            return Err(at(
                &here.key("whyNot"),
                "explains `when`: the action needs a `when`",
            ));
        }
        if let Some(when) = &action.when {
            check_object_condition(when, &action.kinds, &here.key("when"), manifest.sextant_api)?;
        }
    }
    Ok(())
}

fn fields_of_action(action: &ActionContribution) -> [(&'static str, bool); 3] {
    [
        ("when", action.when.is_some()),
        ("whyNot", action.why_not.is_some()),
        ("placement", action.placement.is_some()),
    ]
}

/// A column: a `jsonPath` or `paths`, and the fields that go with `paths` only with it, in a way its format reads.
pub(crate) fn check_columns(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let list = JsonPath::default().key("contributes").key("columns");
    for (i, column) in manifest.contributes.columns.iter().enumerate() {
        let here = list.index(i);
        let computed = fields_of_column(column);
        for (field, set) in computed {
            if set && manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &here.key(field),
                    format!("needs sextantApi {WINDOW_API} or later"),
                ));
            }
        }
        match (&column.json_path, &column.paths) {
            (None, None) => return Err(at(&here, "needs a `jsonPath` or `paths`")),
            (Some(_), Some(_)) => {
                return Err(at(
                    &here.key("paths"),
                    "a column has a `jsonPath` or `paths`, not both",
                ));
            }
            (Some(_), None) => {
                if let Some((field, _)) = computed.iter().skip(1).find(|(_, set)| *set) {
                    return Err(at(&here.key(field), "goes with `paths`, not `jsonPath`"));
                }
                continue;
            }
            (None, Some(_)) => {}
        }
        let format = column.format.unwrap_or(ColumnFormat::Text);
        if column.end_paths.is_some() && format != ColumnFormat::Duration {
            return Err(at(
                &here.key("endPaths"),
                "goes with `format: \"duration\"`",
            ));
        }
        match (format, &column.total_paths) {
            (ColumnFormat::Ratio, None) => {
                return Err(at(
                    &here.key("totalPaths"),
                    "`format: \"ratio\"` needs `totalPaths`",
                ));
            }
            (ColumnFormat::Ratio, Some(_)) | (_, None) => {}
            (_, Some(_)) => {
                return Err(at(&here.key("totalPaths"), "goes with `format: \"ratio\"`"));
            }
        }
        for (field, paths) in [
            ("paths", &column.paths),
            ("endPaths", &column.end_paths),
            ("totalPaths", &column.total_paths),
            ("tooltipPaths", &column.tooltip_paths),
        ] {
            for (j, text) in paths.iter().flatten().enumerate() {
                check_path(text, &column.kind, &here.key(field).index(j))?;
            }
        }
        for value in column.tones.iter().flat_map(|tones| tones.keys()) {
            if value.trim().is_empty() || value.chars().count() > MAX_TONE_VALUE_CHARS {
                return Err(at(
                    &here.key("tones"),
                    format!("names values of 1 to {MAX_TONE_VALUE_CHARS} characters"),
                ));
            }
        }
        for (j, case) in column.cases.iter().flatten().enumerate() {
            check_object_condition(
                &case.when,
                std::slice::from_ref(&column.kind),
                &here.key("cases").index(j).key("when"),
                manifest.sextant_api,
            )?;
        }
    }
    Ok(())
}

fn fields_of_column(column: &ColumnContribution) -> [(&'static str, bool); 7] {
    [
        ("paths", column.paths.is_some()),
        ("format", column.format.is_some()),
        ("endPaths", column.end_paths.is_some()),
        ("totalPaths", column.total_paths.is_some()),
        ("tones", column.tones.is_some()),
        ("tooltipPaths", column.tooltip_paths.is_some()),
        ("cases", column.cases.is_some()),
    ]
}

/// `contributes.kinds`: kinds of an API group other than the core one, each once, in sections of the extension's own.
pub(crate) fn check_kinds(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let kinds = &manifest.contributes.kinds;
    let list = JsonPath::default().key("contributes").key("kinds");
    if kinds.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < WINDOW_API {
        return Err(at(&list, format!("needs sextantApi {WINDOW_API} or later")));
    }
    for (i, entry) in kinds.iter().enumerate() {
        let here = list.index(i);
        if entry.group.trim().is_empty() || entry.group.contains('*') || entry.kind.contains('*') {
            return Err(at(
                &here.key("group"),
                "must be the API group of a custom resource: Sextant lists the core API's kinds itself",
            ));
        }
        let this = KindPattern::new(&entry.group, &entry.kind);
        if let Some(first) = kinds[..i]
            .iter()
            .position(|other| same_kind(&KindPattern::new(&other.group, &other.kind), &this))
        {
            return Err(at(
                &here.key("kind"),
                format!("duplicate kind (also {})", list.index(first)),
            ));
        }
        if !own_section(manifest, &entry.section) {
            return Err(at(
                &here.key("section"),
                "must be a section of the extension's own: a kind or page of it with this section has a `sectionTitle`",
            ));
        }
    }
    Ok(())
}

/// The permissions `sextantApi` 4 brought: the `portForward` action (ADR-0156) and `statusPatches` of custom kinds
/// only, each once (ADR-0155).
pub(crate) fn check_permissions(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let permissions = JsonPath::default().key("permissions");
    if manifest.sextant_api < WINDOW_API {
        for (i, rule) in manifest.permissions.rules.iter().enumerate() {
            if let Some(j) = rule
                .actions
                .iter()
                .position(|a| *a == AccessAction::PortForward)
            {
                return Err(at(
                    &permissions.key("rules").index(i).key("actions").index(j),
                    format!("`portForward` needs sextantApi {WINDOW_API} or later"),
                ));
            }
        }
    }
    let list = permissions.key("statusPatches");
    let kinds = &manifest.permissions.status_patches;
    if kinds.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < WINDOW_API {
        return Err(at(&list, format!("needs sextantApi {WINDOW_API} or later")));
    }
    for (i, kind) in kinds.iter().enumerate() {
        let here = list.index(i);
        if !is_custom_group(&kind.group) || kind.kind.contains('*') {
            return Err(at(
                &here.key("group"),
                "must be the API group of a custom resource: Kubernetes' own kinds' status is never patched",
            ));
        }
        if let Some(first) = kinds[..i].iter().position(|other| same_kind(other, kind)) {
            return Err(at(
                &here.key("kind"),
                format!("duplicate kind (also {})", list.index(first)),
            ));
        }
    }
    Ok(())
}

/// A custom resource's API group: a DNS name with a dot, not one of Kubernetes' own (`*.k8s.io`, `*.kubernetes.io`).
fn is_custom_group(group: &str) -> bool {
    let group = group.to_ascii_lowercase();
    group.contains('.')
        && !group.contains('*')
        && !group.trim().is_empty()
        && group != "k8s.io"
        && !group.ends_with(".k8s.io")
        && !group.ends_with(".kubernetes.io")
}

/// Whether `section` is the extension's own: one of its pages or listed kinds with this section gives it a title.
pub(crate) fn own_section(manifest: &ExtensionManifest, section: &str) -> bool {
    let c = &manifest.contributes;
    c.pages
        .iter()
        .any(|page| page.section == section && page.section_title.is_some())
        || c.kinds
            .iter()
            .any(|kind| kind.section == section && kind.section_title.is_some())
}

/// The kinds the extension lists in its own sections: where its actions may be `primary` (ADR-0154).
pub fn listed_kinds(manifest: &ExtensionManifest) -> Vec<KindPattern> {
    manifest
        .contributes
        .kinds
        .iter()
        .map(|k| KindPattern::new(&k.group, &k.kind))
        .collect()
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
