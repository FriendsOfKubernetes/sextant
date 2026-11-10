//! Counters on an extension's own sidebar section (`contributes.sectionBadges`, sextantApi 3, #331): the window counts
//! the objects with active problems of the extension's own rules (ADR-0137) and draws the number on the section's
//! header, as Sextant's own sections have it (`registerSectionBadge`). No extension code runs for it.
//!
//! Here: what reading a manifest checks beyond the schema — the API version, a section the extension's own pages make
//! (one of them gives it a `sectionTitle`), one counter per section, and rule ids its `problems` have.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::manifest::{ExtensionManifest, ManifestError};
use super::schema::JsonPath;

/// The extension API version that brought `contributes.sectionBadges`.
pub const SECTION_BADGES_API: u32 = 3;
/// Counters per extension (the schema's `maxItems`).
pub const MAX_SECTION_BADGES: usize = 10;

/// A counter on the extension's own sidebar section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SectionBadgeContribution {
    /// The section: one the extension's own pages make (a page of it has a `sectionTitle`).
    pub section: String,
    /// The ids of the rules whose problems it counts; empty: every rule of the extension.
    #[serde(default)]
    pub rules: Vec<String>,
    /// Its tooltip and accessible label by CLDR plural form (`one`, `few`, `many`, `other`, …), each with `{{count}}`
    /// (#398); `sextantApi` 4. Without it, Sextant's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<std::collections::BTreeMap<String, String>>,
    /// What it counts: the objects with a problem (`objects`, the default) or the problems themselves (`problems`: a
    /// VirtualService with two missing gateways counts two, as Sextant's own Istio counter did); `sextantApi` 4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub count: Option<SectionBadgeCount>,
}

/// What a section counter counts (`SectionBadgeContribution.count`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SectionBadgeCount {
    /// The objects with an active problem, each once.
    Objects,
    /// The active problems.
    Problems,
}

/// The CLDR plural forms a counter's label may give.
pub const PLURAL_FORMS: [&str; 6] = ["zero", "one", "two", "few", "many", "other"];

/// A label's forms: CLDR names only, `other` among them, each text with `{{count}}` and no other placeholder.
pub(crate) fn check_label_forms(
    forms: &std::collections::BTreeMap<String, String>,
    path: &JsonPath,
    need_other: bool,
) -> Result<(), ManifestError> {
    if need_other && !forms.contains_key("other") {
        return Err(at(path, "gives the form `other`"));
    }
    for (form, text) in forms {
        if !PLURAL_FORMS.contains(&form.as_str()) {
            return Err(at(
                &path.key(form),
                "is a CLDR plural form: zero, one, two, few, many or other",
            ));
        }
        let found = super::problems::placeholders(text);
        if found.as_deref() != Some(&["count"][..]) {
            return Err(at(
                &path.key(form),
                "has `{{count}}` once, and no other placeholder",
            ));
        }
    }
    Ok(())
}

/// What reading a manifest checks of its section counters beyond the schema.
pub(crate) fn check_section_badges(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let badges = &manifest.contributes.section_badges;
    let list = JsonPath::default().key("contributes").key("sectionBadges");
    if badges.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < SECTION_BADGES_API {
        return Err(at(
            &list,
            format!("needs sextantApi {SECTION_BADGES_API} or later"),
        ));
    }
    if manifest.contributes.problems.is_empty() {
        return Err(at(&list, "counts problems: needs `contributes.problems`"));
    }
    for (i, badge) in badges.iter().enumerate() {
        let here = list.index(i);
        if !super::contributions::own_section(manifest, &badge.section) {
            return Err(at(
                &here.key("section"),
                "must be a section of the extension's own: one of its pages (or kinds) with this section has a `sectionTitle`",
            ));
        }
        if let Some(first) = badges[..i]
            .iter()
            .position(|other| other.section == badge.section)
        {
            return Err(at(
                &here.key("section"),
                format!("duplicate section (also {})", list.index(first)),
            ));
        }
        if let Some(label) = &badge.label {
            if manifest.sextant_api < super::contributions::WINDOW_API {
                return Err(at(
                    &here.key("label"),
                    format!(
                        "needs sextantApi {} or later",
                        super::contributions::WINDOW_API
                    ),
                ));
            }
            check_label_forms(label, &here.key("label"), true)?;
        }
        if badge.count.is_some() && manifest.sextant_api < super::contributions::WINDOW_API {
            return Err(at(
                &here.key("count"),
                format!(
                    "needs sextantApi {} or later",
                    super::contributions::WINDOW_API
                ),
            ));
        }
        for (j, rule) in badge.rules.iter().enumerate() {
            if !manifest.contributes.problems.iter().any(|r| &r.id == rule) {
                return Err(at(
                    &here.key("rules").index(j),
                    "is not the id of one of `contributes.problems`",
                ));
            }
        }
    }
    Ok(())
}

fn at(path: &JsonPath, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.to_string(),
        message: message.into(),
    }
}
