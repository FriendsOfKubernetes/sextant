//! Translations of a manifest's texts (`translations`, ADR-0140): language tag → text key → text. English is the
//! manifest itself; the window shows a text in the UI language when the manifest has it, else in English
//! (`src/extensions/localize.ts`). Reading a manifest checks that every key names a text of this manifest, that each
//! translation keeps that text's limits, and that a problem message keeps exactly the English placeholders — a
//! translation never adds a field path the English message did not read. Metric queries, kinds and paths are never
//! translated; a metric query's title is.

use std::collections::BTreeMap;

use super::manifest::{ExtensionManifest, ManifestError};
use super::problems::{PROBLEMS_API, placeholders};
use super::schema::JsonPath;

/// Languages one manifest translates to (the schema's `maxProperties`).
pub const MAX_LANGUAGES: usize = 30;
/// Texts per language (the schema's `maxProperties`).
pub const MAX_TEXTS: usize = 300;

/// How long a translated text may be: as long as the English one may.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Text<'a> {
    /// A title or label: 1–80 characters.
    Title,
    /// The description: up to 500 characters.
    Description,
    /// A problem message: up to 300 characters with the English message's placeholders.
    Message(&'a str),
}

impl Text<'_> {
    fn max_chars(self) -> usize {
        match self {
            Text::Title => 80,
            Text::Description => 500,
            Text::Message(_) => 300,
        }
    }
}

/// Every text of the manifest a translation may give, by key.
fn texts(manifest: &ExtensionManifest) -> BTreeMap<String, Text<'_>> {
    let c = &manifest.contributes;
    let mut out = BTreeMap::new();
    out.insert("name".to_owned(), Text::Title);
    out.insert("description".to_owned(), Text::Description);
    for page in &c.pages {
        out.insert(format!("pages.{}.title", page.id), Text::Title);
        if page.section_title.is_some() {
            out.insert(format!("pages.{}.sectionTitle", page.id), Text::Title);
        }
    }
    for section in &c.details_sections {
        out.insert(format!("detailsSections.{}.title", section.id), Text::Title);
    }
    for action in &c.actions {
        out.insert(format!("actions.{}.title", action.id), Text::Title);
    }
    for column in &c.columns {
        out.insert(format!("columns.{}.title", column.id), Text::Title);
    }
    for dock in &c.dock_actions {
        out.insert(format!("dockActions.{}.title", dock.id), Text::Title);
    }
    if c.settings.is_some() {
        out.insert("settings.title".to_owned(), Text::Title);
    }
    for rule in &c.problems {
        out.insert(format!("problems.{}.title", rule.id), Text::Title);
        out.insert(
            format!("problems.{}.message", rule.id),
            Text::Message(&rule.message),
        );
    }
    for query in &c.metric_queries {
        out.insert(format!("metricQueries.{}.title", query.id), Text::Title);
    }
    for credential in manifest.backend.iter().flat_map(|b| &b.credentials) {
        out.insert(
            format!("backend.credentials.{}.label", credential.id),
            Text::Title,
        );
    }
    out
}

/// A language tag as Sextant's own languages are written: `de`, `pt-BR`, `zh-CN`, `sr-Latn`, `es-419`.
pub fn is_language_tag(tag: &str) -> bool {
    let mut parts = tag.split('-');
    let language = parts.next().unwrap_or_default();
    if !(2..=3).contains(&language.len()) || !language.bytes().all(|b| b.is_ascii_lowercase()) {
        return false;
    }
    let mut rest: Vec<&str> = parts.collect();
    if let Some(script) = rest.first()
        && script.len() == 4
    {
        let mut chars = script.chars();
        if !chars.next().is_some_and(|c| c.is_ascii_uppercase())
            || !chars.all(|c| c.is_ascii_lowercase())
        {
            return false;
        }
        rest.remove(0);
    }
    match rest.as_slice() {
        [] => true,
        [region] => {
            (region.len() == 2 && region.bytes().all(|b| b.is_ascii_uppercase()))
                || (region.len() == 3 && region.bytes().all(|b| b.is_ascii_digit()))
        }
        _ => false,
    }
}

/// The placeholders of a message, sorted, so two messages are compared by what they read, not by word order.
fn sorted_placeholders(text: &str) -> Option<Vec<&str>> {
    let mut list = placeholders(text)?;
    list.sort_unstable();
    Some(list)
}

/// What reading a manifest checks of its translations beyond the schema, in a stable order (languages, then keys).
pub(crate) fn check_translations(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    if manifest.translations.is_empty() {
        return Ok(());
    }
    let root = JsonPath::default().key("translations");
    if manifest.sextant_api < PROBLEMS_API {
        return Err(at(
            &root,
            format!("needs sextantApi {PROBLEMS_API} or later"),
        ));
    }
    let texts = texts(manifest);
    for (language, translated) in &manifest.translations {
        let here = root.key(language);
        if !is_language_tag(language) {
            return Err(at(
                &here,
                "must be a language tag such as `de`, `pt-BR` or `zh-CN`",
            ));
        }
        if language == "en" {
            return Err(at(
                &here,
                "English is the manifest itself: translate to other languages only",
            ));
        }
        for (key, text) in translated {
            let path = here.key(key);
            let Some(kind) = texts.get(key) else {
                return Err(at(&path, format!("`{key}` is not a text of this manifest")));
            };
            if text.trim().is_empty() {
                return Err(at(&path, "must not be blank"));
            }
            let max = kind.max_chars();
            if text.chars().count() > max {
                return Err(at(&path, format!("must be at most {max} characters")));
            }
            if let Text::Message(english) = kind
                && sorted_placeholders(text) != sorted_placeholders(english)
            {
                return Err(at(
                    &path,
                    "must have the same `{{…}}` placeholders as the English message",
                ));
            }
        }
        // A problem's title is its reason: unique among the rules in every language.
        let mut titles: Vec<(&str, &str)> = Vec::new();
        for rule in &manifest.contributes.problems {
            let key = format!("problems.{}.title", rule.id);
            let title = translated
                .get(&key)
                .map_or(rule.title.as_str(), String::as_str);
            if let Some((other, _)) = titles.iter().find(|(_, t)| *t == title) {
                return Err(at(
                    &here.key(&key),
                    format!("is also the title of the rule `{other}` in this language"),
                ));
            }
            titles.push((rule.id.as_str(), title));
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

#[cfg(test)]
mod tests;
