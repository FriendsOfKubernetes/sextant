//! What reading a manifest checks of the window's contributions beyond the schema, for the fields `sextantApi` 4
//! brought (ADR-0152 to ADR-0154): an action's condition and placement, a column computed from field paths, and kinds
//! listed in a section of the extension's own. The window evaluates all of them on objects it already holds; no
//! extension code runs for them.

use super::manifest::{
    ActionContribution, ColumnContribution, ColumnFormat, ColumnLookup, ExtensionManifest,
    ManifestError,
};
use super::problems::{check_message, check_object_condition, check_path};
use super::schema::JsonPath;
use crate::access::{AccessAction, KindPattern};
use serde_json::Value;

/// The extension API version that brought computed columns, action conditions and `contributes.kinds`.
pub const WINDOW_API: u32 = 4;
/// Longest value a column's `tones` names.
pub const MAX_TONE_VALUE_CHARS: usize = 100;
/// An action's `patch`, serialized, at most (#367).
pub const MAX_ACTION_PATCH_BYTES: usize = 4096;
/// The one placeholder of an action's `patch`: the time it is sent, RFC 3339.
pub const NOW_PLACEHOLDER: &str = "{{now}}";

/// A column width: `<n>px`, or `minmax(<n>px, <m>fr)` with `<m>` like `1`, `1.5` (#403).
pub fn is_column_width(text: &str) -> bool {
    let px = |s: &str| {
        s.strip_suffix("px")
            .filter(|n| !n.is_empty() && n.len() <= 3 && n.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|n| (40..=600).contains(&n))
    };
    if px(text) {
        return true;
    }
    let Some(inner) = text
        .strip_prefix("minmax(")
        .and_then(|t| t.strip_suffix(')'))
    else {
        return false;
    };
    let Some((min, fr)) = inner.split_once(", ") else {
        return false;
    };
    let fr_ok = fr
        .strip_suffix("fr")
        .filter(|n| {
            !n.is_empty()
                && n.len() <= 3
                && n.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                && !n.starts_with('.')
                && !n.ends_with('.')
        })
        .and_then(|n| n.parse::<f64>().ok())
        .is_some_and(|n| (0.5..=5.0).contains(&n));
    px(min) && fr_ok
}

/// Whether a kind pattern is the details sections' "every kind" (`{"group": "*", "kind": "*"}`, #411).
pub fn is_every_kind(kind: &KindPattern) -> bool {
    kind.group == "*" && kind.kind == "*"
}

/// The domain of a details section's "every kind of the groups under a domain" (`{"group": "*.upbound.io", "kind":
/// "*"}`, `sextantApi` 4): a kind matches when its group ends with `.<domain>` — Crossplane's managed resources of
/// one vendor's providers, never a core object.
pub fn group_suffix(kind: &KindPattern) -> Option<&str> {
    kind.group.strip_prefix("*.").filter(|_| kind.kind == "*")
}

/// Whether a kind pattern is a details section's "every kind of a custom resource group" (`{"group": "*.*", "kind":
/// "*"}`, `sextantApi` 4): a kind matches when its group is a custom resource's ([`is_custom_group`]) — the claims,
/// composite and managed resources of any Crossplane API, never a core object or one of Kubernetes' own groups.
pub fn is_every_custom_group(kind: &KindPattern) -> bool {
    kind.group == "*.*" && kind.kind == "*"
}

/// A pattern's domain is a custom resource's group: a DNS name with a dot, not Kubernetes' own.
fn is_group_domain(domain: &str) -> bool {
    is_custom_group(domain)
        && domain.len() <= 240
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
}

/// A details section's `when` (#408): a condition on the object, as an action's; and its kinds, where
/// `{"group": "*", "kind": "*"}` alone means every kind (#411), without a `when`.
pub(crate) fn check_details_sections(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let list = JsonPath::default()
        .key("contributes")
        .key("detailsSections");
    for (i, section) in manifest.contributes.details_sections.iter().enumerate() {
        for (field, set) in [
            ("heading", section.heading.is_some()),
            ("startHidden", section.start_hidden.is_some()),
        ] {
            if !set {
                continue;
            }
            if manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &list.index(i).key(field),
                    format!("needs sextantApi {WINDOW_API} or later"),
                ));
            }
            if section.placement != super::manifest::DetailsPlacement::Section {
                return Err(at(
                    &list.index(i).key(field),
                    "is for a `section`, not a tab",
                ));
            }
        }
        if section.kinds.iter().any(is_every_kind) {
            let here = list.index(i).key("kinds");
            if manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &here,
                    format!("every kind needs sextantApi {WINDOW_API} or later"),
                ));
            }
            if section.kinds.len() != 1 {
                return Err(at(&here, "with every kind (`*`/`*`) lists no other kind"));
            }
            if section.when.is_some() {
                return Err(at(
                    &list.index(i).key("when"),
                    "is not for a section of every kind",
                ));
            }
        }
        // Every kind of the groups under a domain: `*.<domain>`/`*`, a domain of custom groups; nothing else wild.
        for (k, kind) in section.kinds.iter().enumerate() {
            if is_every_kind(kind) || (!kind.group.contains('*') && kind.kind != "*") {
                continue;
            }
            let here = list.index(i).key("kinds").index(k);
            match group_suffix(kind) {
                _ if is_every_custom_group(kind) => {}
                Some(domain) if is_group_domain(domain) => {}
                Some(_) => {
                    return Err(at(
                        &here.key("group"),
                        "is `*.` and a domain of custom resource groups, such as `*.upbound.io` (not Kubernetes' own)",
                    ));
                }
                None => {
                    return Err(at(
                        &here,
                        "is every kind (`*`/`*`), every kind of a custom resource group (`*.*`/`*`), the kinds of the groups under a domain (`*.upbound.io`/`*`), or one kind",
                    ));
                }
            }
            if manifest.sextant_api < WINDOW_API {
                return Err(at(&here, format!("needs sextantApi {WINDOW_API} or later")));
            }
            if section.when.is_some() {
                return Err(at(
                    &list.index(i).key("when"),
                    "is not for a section of the kinds of a domain's groups",
                ));
            }
        }
        let Some(when) = &section.when else { continue };
        let here = list.index(i).key("when");
        if manifest.sextant_api < WINDOW_API {
            return Err(at(&here, format!("needs sextantApi {WINDOW_API} or later")));
        }
        check_object_condition(when, &section.kinds, &here, manifest.sextant_api)?;
    }
    Ok(())
}

/// An action's `when`, `whyNot` and `placement`, and its `patch` with `ask` and `done`.
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
        if let Some(kinds) = &action.requires_kinds {
            if manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &here.key("requiresKinds"),
                    format!("needs sextantApi {WINDOW_API} or later"),
                ));
            }
            if kinds.is_empty() || kinds.len() > 5 {
                return Err(at(&here.key("requiresKinds"), "names 1 to 5 kinds"));
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
        for (field, set) in [
            ("ask", action.ask.is_some()),
            ("done", action.done.is_some()),
        ] {
            if set && action.patch.is_none() {
                return Err(at(
                    &here.key(field),
                    "goes with `patch`: the action needs a `patch`",
                ));
            }
        }
        if let Some(patch) = &action.patch {
            if action.headless {
                return Err(at(
                    &here.key("headless"),
                    "a `patch` is sent by Sextant without any frame: leave `headless` out",
                ));
            }
            check_action_patch(patch, &here.key("patch"))?;
        }
        if let Some(ask) = &action.ask {
            for (field, text) in [
                ("title", &ask.title),
                ("text", &ask.text),
                ("confirm", &ask.confirm),
            ] {
                check_ask_text(text, action.multiple, &here.key("ask").key(field))?;
            }
        }
    }
    Ok(())
}

fn fields_of_action(action: &ActionContribution) -> [(&'static str, bool); 7] {
    [
        ("headless", action.headless),
        ("when", action.when.is_some()),
        ("whyNot", action.why_not.is_some()),
        ("placement", action.placement.is_some()),
        ("patch", action.patch.is_some()),
        ("ask", action.ask.is_some()),
        ("done", action.done.is_some()),
    ]
}

/// The placeholders Sextant fills in an action's question (#378): `{{count}}`, and the object's `{{kind}}`,
/// `{{namespace}}` and `{{name}}` on an action of one object.
pub const ASK_PLACEHOLDERS: [&str; 4] = ["count", "kind", "namespace", "name"];

fn check_ask_text(text: &str, multiple: bool, path: &JsonPath) -> Result<(), ManifestError> {
    let found = super::problems::placeholders(text)
        .ok_or_else(|| at(path, "has a `{{` without its `}}`"))?;
    for name in found {
        let name = name.trim();
        if !ASK_PLACEHOLDERS.contains(&name) {
            return Err(at(
                path,
                format!(
                    "`{{{{{name}}}}}`: Sextant fills only `{{{{count}}}}`, `{{{{kind}}}}`, `{{{{namespace}}}}` and `{{{{name}}}}`"
                ),
            ));
        }
        if multiple && name != "count" {
            return Err(at(
                path,
                format!(
                    "`{{{{{name}}}}}` names one object: the action runs on several (`multiple`)"
                ),
            ));
        }
    }
    Ok(())
}

/// An action's `patch` (#367): at most [`MAX_ACTION_PATCH_BYTES`], `{{now}}` only as a whole string value, no key with
/// `{{` and never Sextant's marker of hidden values.
fn check_action_patch(patch: &Value, path: &JsonPath) -> Result<(), ManifestError> {
    if patch.as_object().is_some_and(serde_json::Map::is_empty) {
        return Err(at(path, "must not be empty"));
    }
    if serde_json::to_vec(patch).map_or(usize::MAX, |b| b.len()) > MAX_ACTION_PATCH_BYTES {
        return Err(at(
            path,
            format!("must be at most {MAX_ACTION_PATCH_BYTES} bytes"),
        ));
    }
    fn walk(value: &Value, path: &JsonPath) -> Result<(), ManifestError> {
        match value {
            Value::String(text) if text.contains("{{") && text != NOW_PLACEHOLDER => Err(at(
                path,
                "has `{{now}}` as a whole value, and no other `{{…}}`",
            )),
            Value::Array(items) => items
                .iter()
                .enumerate()
                .try_for_each(|(i, v)| walk(v, &path.index(i))),
            Value::Object(map) => map.iter().try_for_each(|(k, v)| {
                if k.contains("{{") {
                    Err(at(&path.key(k), "a key has no placeholder"))
                } else if k == crate::resources::VALUES_HIDDEN_ANNOTATION {
                    Err(at(
                        &path.key(k),
                        "must not name Sextant's marker of hidden values",
                    ))
                } else {
                    walk(v, &path.key(k))
                }
            }),
            _ => Ok(()),
        }
    }
    walk(patch, path)
}

/// A column: a `jsonPath` or `paths`, and the fields that go with `paths` only with it, in a way its format reads.
pub(crate) fn check_columns(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let list = JsonPath::default().key("contributes").key("columns");
    for (i, column) in manifest.contributes.columns.iter().enumerate() {
        let here = list.index(i);
        // More cases from sextantApi 4 (#403): an older Sextant reads only older manifests.
        let max_cases = if manifest.sextant_api >= WINDOW_API {
            20
        } else {
            10
        };
        if column.cases.as_ref().is_some_and(|c| c.len() > max_cases) {
            return Err(at(
                &here.key("cases"),
                format!("has at most {max_cases} cases"),
            ));
        }
        if let Some(width) = &column.width {
            if manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &here.key("width"),
                    format!("needs sextantApi {WINDOW_API} or later"),
                ));
            }
            if !is_column_width(width) {
                return Err(at(
                    &here.key("width"),
                    "is `<n>px` or `minmax(<n>px, <m>fr)`, n from 40 to 600 and m from 0.5 to 5",
                ));
            }
        }
        if column.filter_by.is_some() {
            if manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &here.key("filterBy"),
                    format!("needs sextantApi {WINDOW_API} or later"),
                ));
            }
            if column.format.unwrap_or(ColumnFormat::Text) != ColumnFormat::Text
                || column.cases.as_ref().is_none_or(|c| c.is_empty())
            {
                return Err(at(
                    &here.key("filterBy"),
                    "is `\"value\"` on a text column with `cases`",
                ));
            }
        }
        if let Some(separator) = &column.separator {
            if !matches!(
                column.format,
                Some(ColumnFormat::List | ColumnFormat::Entries)
            ) || column.items.as_ref().is_some_and(|i| i.separator.is_some())
            {
                return Err(at(
                    &here.key("separator"),
                    "goes with `format: \"list\"` or `\"entries\"` (with `items`, theirs)",
                ));
            }
            check_separator(separator, &here.key("separator"))?;
        }
        if let Some(items) = &column.items {
            check_items(manifest, column, items, &here.key("items"))?;
        }
        if column.join_paths.is_some() {
            if manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &here.key("joinPaths"),
                    format!("needs sextantApi {WINDOW_API} or later"),
                ));
            }
            if !is_list(column.format) {
                return Err(at(
                    &here.key("joinPaths"),
                    "goes with `format: \"list\"` or `\"firstPlus\"`",
                ));
            }
        }
        if let Some(id) = &column.after_column {
            if manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &here.key("afterColumn"),
                    format!("needs sextantApi {WINDOW_API} or later"),
                ));
            }
            if !is_column_id(id) {
                return Err(at(
                    &here.key("afterColumn"),
                    "must be a column id: letters, digits, `-`, `_` and `:`",
                ));
            }
        }
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
            (None, None) if column.lookup.is_none() => {
                return Err(at(&here, "needs a `jsonPath`, `paths` or a `lookup`"));
            }
            (None, None) => {}
            (Some(_), Some(_)) => {
                return Err(at(
                    &here.key("paths"),
                    "a column has a `jsonPath` or `paths`, not both",
                ));
            }
            (Some(_), None) => {
                if let Some((field, _)) = computed.iter().skip(1).find(|(_, set)| *set) {
                    return Err(at(
                        &here.key(field),
                        "goes with `paths` or a `lookup`, not `jsonPath`",
                    ));
                }
                continue;
            }
            (None, Some(_)) => {}
        }
        let format = column.format.unwrap_or(ColumnFormat::Text);
        if let Some(lookup) = &column.lookup {
            check_lookup(lookup, &column.kind, &here.key("lookup"))?;
        }
        if let Some(text) = &column.value_text {
            check_value_text(text, format, &here.key("valueText"))?;
        }
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
                let place = here.key(field).index(j);
                // A number read may be a list's sum or count (#407): a ratio of succeeded over wanted jobs.
                let text = if matches!(field, "paths" | "totalPaths") {
                    super::problems::numeric_path(text, manifest.sextant_api, &place)?
                } else {
                    text.as_str()
                };
                check_path(text, &column.kind, &place)?;
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
        if column.sorted.is_some() && !is_list(column.format) {
            return Err(at(
                &here.key("sorted"),
                "goes with `format: \"list\"` or `\"firstPlus\"`",
            ));
        }
        if column.format == Some(ColumnFormat::FirstPlus) && manifest.sextant_api < WINDOW_API {
            return Err(at(
                &here.key("format"),
                format!("`firstPlus` needs sextantApi {WINDOW_API} or later"),
            ));
        }
        for (j, case) in column.cases.iter().flatten().enumerate() {
            check_object_condition(
                &case.when,
                std::slice::from_ref(&column.kind),
                &here.key("cases").index(j).key("when"),
                manifest.sextant_api,
            )?;
            // The text by plural form (#404), as a rule's message.
            let case_at = here.key("cases").index(j);
            match (&case.plural_by, &case.text_forms) {
                (None, None) => {}
                (Some(by), Some(forms)) => {
                    let by_at = case_at.key("pluralBy");
                    let by = super::problems::numeric_path(by, manifest.sextant_api, &by_at)?;
                    check_path(by, &column.kind, &by_at)?;
                    if forms.is_empty() {
                        return Err(at(&case_at.key("textForms"), "gives at least one form"));
                    }
                    for (form, text) in forms {
                        let form_at = case_at.key("textForms").key(form);
                        if form == "other"
                            || !super::section_badges::PLURAL_FORMS.contains(&form.as_str())
                        {
                            return Err(at(
                                &form_at,
                                "is a CLDR plural form besides `other` (the `text`): zero, one, two, few or many",
                            ));
                        }
                        if text.trim().is_empty() || text.chars().count() > 200 {
                            return Err(at(&form_at, "is a text of 1 to 200 characters"));
                        }
                        check_message(text, &column.kind, &form_at, false)?;
                    }
                }
                (Some(_), None) => {
                    return Err(at(&case_at.key("pluralBy"), "goes with `textForms`"));
                }
                (None, Some(_)) => {
                    return Err(at(&case_at.key("textForms"), "goes with `pluralBy`"));
                }
            }
            // An empty text leaves the cell blank (#404); never a blank one.
            let text_at = here.key("cases").index(j).key("text");
            if case.text.is_empty() && manifest.sextant_api < WINDOW_API {
                return Err(at(
                    &text_at,
                    format!("is empty only from sextantApi {WINDOW_API}"),
                ));
            }
            if !case.text.is_empty() && case.text.trim().is_empty() {
                return Err(at(&text_at, "must not be blank"));
            }
            // Field values in the text, as a problem message has them (#368), and in its tooltip (#380).
            check_message(
                &case.text,
                &column.kind,
                &here.key("cases").index(j).key("text"),
                false,
            )?;
            // A number column sorts and filters by it; a text column sorts by it (#403), its text still shown; a text
            // column's may be a text with the text's placeholders (#404).
            match &case.value {
                None => {}
                Some(serde_json::Value::Number(_))
                    if matches!(
                        format,
                        ColumnFormat::Number
                            | ColumnFormat::Text
                            | ColumnFormat::Count
                            | ColumnFormat::Sum
                    ) => {}
                // On a number, count or sum column the filled text is read as a number (#404): an error count coloured
                // by its case still sorts and filters as the count.
                Some(serde_json::Value::String(text))
                    if matches!(
                        format,
                        ColumnFormat::Text
                            | ColumnFormat::Number
                            | ColumnFormat::Count
                            | ColumnFormat::Sum
                    ) =>
                {
                    if text.trim().is_empty() || text.chars().count() > 200 {
                        return Err(at(
                            &here.key("cases").index(j).key("value"),
                            "is a text of 1 to 200 characters",
                        ));
                    }
                    check_message(
                        text,
                        &column.kind,
                        &here.key("cases").index(j).key("value"),
                        false,
                    )?;
                }
                Some(_) => {
                    return Err(at(
                        &here.key("cases").index(j).key("value"),
                        "goes with `format: \"number\"`, `\"text\"`, `\"count\"` or `\"sum\"`",
                    ));
                }
            }
            if let Some(tooltip) = &case.tooltip {
                check_message(
                    tooltip,
                    &column.kind,
                    &here.key("cases").index(j).key("tooltip"),
                    false,
                )?;
            }
            if let Some(more) = &case.tooltip_or {
                let place = here.key("cases").index(j).key("tooltipOr");
                if case.tooltip.is_none() || more.is_empty() || more.len() > 3 {
                    return Err(at(&place, "follows a `tooltip` with 1 to 3 more"));
                }
                for (k, tooltip) in more.iter().enumerate() {
                    check_message(tooltip, &column.kind, &place.index(k), false)?;
                }
            }
        }
    }
    Ok(())
}

/// A column's `lookup` (#387): the list, index and the item's field (relative, `.setWeight`) are field paths that read
/// no secret of the kind, the field checked where it is read (`<list>[0]<field>`).
fn check_lookup(
    lookup: &ColumnLookup,
    kind: &KindPattern,
    path: &JsonPath,
) -> Result<(), ManifestError> {
    check_path(&lookup.list, kind, &path.key("list"))?;
    check_path(&lookup.index, kind, &path.key("index"))?;
    let field = lookup.field.trim();
    if !field.starts_with('.') && !field.starts_with('[') {
        return Err(at(
            &path.key("field"),
            "must be a field path inside an item, such as `.setWeight`",
        ));
    }
    check_path(
        &format!("{}[0]{field}", lookup.list.trim()),
        kind,
        &path.key("field"),
    )
}

/// A column's `valueText` (#387): the one placeholder `{{value}}`, at least once, for a `text` or `number` value.
fn check_value_text(
    text: &str,
    format: ColumnFormat,
    path: &JsonPath,
) -> Result<(), ManifestError> {
    if !matches!(
        format,
        ColumnFormat::Text | ColumnFormat::Number | ColumnFormat::Count | ColumnFormat::Sum
    ) {
        return Err(at(
            path,
            "goes with `format` `text`, `number`, `count` or `sum`",
        ));
    }
    let found = super::problems::placeholders(text)
        .ok_or_else(|| at(path, "has a `{{` without its `}}`"))?;
    if found.is_empty() || found.iter().any(|p| p.trim() != "value") {
        return Err(at(path, "has `{{value}}`, and no other placeholder"));
    }
    Ok(())
}

/// `afterColumn`: a column id of letters, digits, `-`, `_` and `:`.
fn is_column_id(text: &str) -> bool {
    (1..=80).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))
}

/// The most cases of a column's `items` (#404).
pub const MAX_ITEM_CASES: usize = 10;

/// A `list` column's `items` (#404): over paths of a list each (no `*`), 1 to 10 cases on the item, a short separator.
fn check_items(
    manifest: &ExtensionManifest,
    column: &ColumnContribution,
    items: &super::manifest::ColumnItems,
    here: &JsonPath,
) -> Result<(), ManifestError> {
    if manifest.sextant_api < WINDOW_API {
        return Err(at(here, format!("needs sextantApi {WINDOW_API} or later")));
    }
    if !is_list(column.format) {
        return Err(at(here, "goes with `format: \"list\"` or `\"firstPlus\"`"));
    }
    if column.format == Some(ColumnFormat::FirstPlus) && items.separator.is_some() {
        return Err(at(
            &here.key("separator"),
            "goes with `format: \"list\"`: `firstPlus` shows one item",
        ));
    }
    // Each item's paths read from the item: the column's paths name the lists themselves. A list path that holds no
    // secret holds none in its items, so the items' paths are checked as the column's text placeholders are. Cases
    // that read an item only as itself (`.`) and the object (`$.…`) may go with `*`: the item is then the value the
    // checked path reads (`.spec.servers[*].hosts[*]`).
    if column.paths.iter().flatten().any(|p| p.contains('*'))
        && !items.cases.iter().all(reads_item_itself)
    {
        return Err(at(
            &here.key("cases"),
            "go with `paths` that name the lists themselves, without `*`, unless they read the item only as `.`",
        ));
    }
    if items.cases.is_empty() || items.cases.len() > MAX_ITEM_CASES {
        return Err(at(
            &here.key("cases"),
            format!("has 1 to {MAX_ITEM_CASES} cases"),
        ));
    }
    for (j, case) in items.cases.iter().enumerate() {
        let at_case = here.key("cases").index(j);
        super::problems::check_item_condition(
            &case.when,
            &column.kind,
            &at_case.key("when"),
            manifest.sextant_api,
        )?;
        if case.text.trim().is_empty() || case.text.chars().count() > 200 {
            return Err(at(&at_case.key("text"), "is a text of 1 to 200 characters"));
        }
        super::problems::check_item_message(&case.text, &column.kind, &at_case.key("text"))?;
    }
    if let Some(separator) = &items.separator {
        check_separator(separator, &here.key("separator"))?;
    }
    Ok(())
}

/// A list format: `list` or `firstPlus`.
fn is_list(format: Option<ColumnFormat>) -> bool {
    matches!(format, Some(ColumnFormat::List | ColumnFormat::FirstPlus))
}

/// An item case that reads the item only as itself (`.`) and the object only through `$` paths.
fn reads_item_itself(case: &super::manifest::ColumnItemCase) -> bool {
    let placeholders = super::problems::placeholders(&case.text).unwrap_or_default();
    let texts_ok = placeholders.iter().all(|inner| {
        let mut parts = inner.split('|');
        let field = parts.next().unwrap_or_default().trim();
        let filters_ok = parts.all(|f| {
            f.trim()
                .strip_prefix("fqdn:")
                .is_none_or(|p| p.trim().starts_with('$'))
        });
        filters_ok && (field == "." || field.starts_with('$'))
    });
    texts_ok
        && super::problems::condition_paths(&case.when)
            .iter()
            .all(|p| p.trim() == "." || p.trim().starts_with('$'))
}

/// What joins a list's texts: 1 to 5 characters, no control characters or `{{`.
fn check_separator(separator: &str, here: &JsonPath) -> Result<(), ManifestError> {
    let count = separator.chars().count();
    if !(1..=5).contains(&count)
        || separator.chars().any(char::is_control)
        || separator.contains("{{")
    {
        return Err(at(
            here,
            "is 1 to 5 characters, no control characters or `{{`",
        ));
    }
    Ok(())
}

fn fields_of_column(column: &ColumnContribution) -> [(&'static str, bool); 14] {
    [
        ("sorted", column.sorted.is_some()),
        ("separator", column.separator.is_some()),
        ("items", column.items.is_some()),
        ("filterBy", column.filter_by.is_some()),
        ("joinPaths", column.join_paths.is_some()),
        ("paths", column.paths.is_some()),
        ("lookup", column.lookup.is_some()),
        ("valueText", column.value_text.is_some()),
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
        if let Some(when) = &entry.problem_when {
            let pattern = KindPattern::new(&entry.group, &entry.kind);
            check_object_condition(
                when,
                std::slice::from_ref(&pattern),
                &here.key("problemWhen"),
                manifest.sextant_api,
            )?;
        }
        for (j, alias) in entry.aliases.iter().enumerate() {
            let ok = (1..=20).contains(&alias.len())
                && alias
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
            if !ok {
                return Err(at(
                    &here.key("aliases").index(j),
                    "a short name has 1 to 20 lowercase letters, digits and `-`",
                ));
            }
        }
    }
    Ok(())
}

/// `contributes.menuItems` came with `sextantApi` 4 (ADR-0157).
pub(crate) fn check_menu_items(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    if !manifest.contributes.menu_items.is_empty() && manifest.sextant_api < WINDOW_API {
        return Err(at(
            &JsonPath::default().key("contributes").key("menuItems"),
            format!("needs sextantApi {WINDOW_API} or later"),
        ));
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
pub(crate) fn is_custom_group(group: &str) -> bool {
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
        || c.sections
            .iter()
            .any(|s| s.section == section && s.title.is_some())
}

/// `contributes.sections` and `clusterSettings` (ADR-0160): `sextantApi` 4, each section once and the extension's own.
pub(crate) fn check_sections(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let c = &manifest.contributes;
    if c.cluster_settings.is_some() && manifest.sextant_api < WINDOW_API {
        return Err(at(
            &JsonPath::default()
                .key("contributes")
                .key("clusterSettings"),
            format!("needs sextantApi {WINDOW_API} or later"),
        ));
    }
    let list = JsonPath::default().key("contributes").key("sections");
    if c.sections.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < WINDOW_API {
        return Err(at(&list, format!("needs sextantApi {WINDOW_API} or later")));
    }
    for (i, entry) in c.sections.iter().enumerate() {
        let here = list.index(i);
        if let Some(first) = c.sections[..i]
            .iter()
            .position(|o| o.section == entry.section)
        {
            return Err(at(
                &here.key("section"),
                format!("duplicate section (also {})", list.index(first)),
            ));
        }
        if !own_section(manifest, &entry.section) {
            return Err(at(
                &here.key("section"),
                "must be a section of the extension's own: it, or a kind or page of it with this section, has a title",
            ));
        }
    }
    Ok(())
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
