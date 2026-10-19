//! Appearance (ADR-0093): the interface font and the monospace font (terminal, YAML, logs, code). Written by the
//! frontend, which turns a choice into the `--font-latin` / `--font-mono` CSS variables.
//!
//! Read leniently like the other frontend-written settings: an unknown kind, a custom choice without a usable family
//! name, or a value of the wrong type reads as the built-in font instead of failing the file. A family name is kept
//! only after [`sanitize_family`]: it goes into a CSS value, so quotes, backslashes, semicolons, braces, angle brackets
//! and control characters are dropped and its length is capped. A family that is not installed on this computer (a
//! settings file from another one) is kept: the CSS stack falls back to the built-in font after it.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// Longest font family name kept, in characters.
pub const MAX_FONT_FAMILY_CHARS: usize = 100;

/// Where a font comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FontKind {
    /// The bundled font: Fira Sans for the interface, Fira Mono for code.
    #[default]
    Builtin,
    /// The system's stack (`system-ui…` / `ui-monospace…`), as before the bundled fonts.
    System,
    /// A font family installed on this computer, named by `family`.
    Custom,
}

/// One font choice: a kind and, for `custom`, the family name.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FontChoice {
    pub kind: FontKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub family: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct AppearanceSettings {
    /// The interface font.
    pub ui_font: FontChoice,
    /// The monospace font: terminal, YAML editor, logs and code.
    pub mono_font: FontChoice,
}

/// `name` fit for a quoted CSS font-family value, or `None` when nothing usable is left: quotes, backslashes,
/// semicolons, braces, angle brackets are dropped, control characters and runs of white space become one space, and
/// at most [`MAX_FONT_FAMILY_CHARS`] characters are kept.
pub fn sanitize_family(name: &str) -> Option<String> {
    let kept: String = name
        .chars()
        .filter(|c| !matches!(c, '"' | '\'' | '\\' | ';' | '{' | '}' | '<' | '>'))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let joined = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = joined.chars().take(MAX_FONT_FAMILY_CHARS).collect();
    let capped = capped.trim_end().to_owned();
    (!capped.is_empty()).then_some(capped)
}

fn read_choice(value: Option<&serde_json::Value>) -> FontChoice {
    let Some(value) = value else {
        return FontChoice::default();
    };
    match value.get("kind").and_then(serde_json::Value::as_str) {
        Some("system") => FontChoice {
            kind: FontKind::System,
            family: None,
        },
        Some("custom") => match value
            .get("family")
            .and_then(serde_json::Value::as_str)
            .and_then(sanitize_family)
        {
            Some(family) => FontChoice {
                kind: FontKind::Custom,
                family: Some(family),
            },
            None => FontChoice::default(),
        },
        _ => FontChoice::default(),
    }
}

/// `#[serde(with)]` module of `AppSettings::appearance`: written as it is, read choice by choice.
pub(crate) mod appearance_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &AppearanceSettings,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<AppearanceSettings, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        Ok(AppearanceSettings {
            ui_font: read_choice(value.get("uiFont")),
            mono_font: read_choice(value.get("monoFont")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppSettings;
    use serde_json::json;

    #[test]
    fn the_built_in_fonts_are_the_default() {
        let settings: AppSettings = serde_json::from_value(json!({ "theme": "dark" })).unwrap();
        assert_eq!(settings.appearance, AppearanceSettings::default());
        assert_eq!(settings.appearance.ui_font.kind, FontKind::Builtin);
        assert_eq!(
            serde_json::to_value(&settings.appearance).unwrap(),
            json!({ "uiFont": { "kind": "builtin" }, "monoFont": { "kind": "builtin" } })
        );
    }

    #[test]
    fn choices_round_trip() {
        let appearance = json!({
            "uiFont": { "kind": "system" },
            "monoFont": { "kind": "custom", "family": "JetBrains Mono" }
        });
        let settings: AppSettings =
            serde_json::from_value(json!({ "appearance": appearance })).unwrap();
        assert_eq!(settings.appearance.ui_font.kind, FontKind::System);
        assert_eq!(
            settings.appearance.mono_font,
            FontChoice {
                kind: FontKind::Custom,
                family: Some("JetBrains Mono".into())
            }
        );
        let written = serde_json::to_value(&settings).unwrap();
        assert_eq!(written["appearance"], appearance);
    }

    #[test]
    fn a_bad_choice_reads_as_the_built_in_font_without_failing_the_file() {
        let settings: AppSettings = serde_json::from_value(json!({
            "theme": "dark",
            "appearance": {
                "uiFont": { "kind": "from-a-newer-version" },
                "monoFont": { "kind": "custom", "family": "\"';{}<>\\" }
            }
        }))
        .unwrap();
        assert_eq!(settings.theme, crate::Theme::Dark);
        assert_eq!(settings.appearance, AppearanceSettings::default());

        for wrong in [
            json!([1, 2]),
            json!("x"),
            json!({ "uiFont": 5, "monoFont": { "kind": "custom" } }),
        ] {
            let s: AppSettings = serde_json::from_value(json!({ "appearance": wrong })).unwrap();
            assert_eq!(s.appearance, AppearanceSettings::default(), "{wrong}");
        }
    }

    #[test]
    fn a_family_name_is_cleaned_for_css() {
        assert_eq!(
            sanitize_family("  Fira\t\"Code\"; } body{x:y}  ").as_deref(),
            Some("Fira Code bodyx:y")
        );
        assert_eq!(
            sanitize_family("Noto\\ Sans\u{0007}\nCJK").as_deref(),
            Some("Noto Sans CJK")
        );
        assert_eq!(sanitize_family(" '\"; ").as_deref(), None);
        let long = sanitize_family(&"x".repeat(MAX_FONT_FAMILY_CHARS + 20)).unwrap();
        assert_eq!(long.chars().count(), MAX_FONT_FAMILY_CHARS);
        let settings: AppSettings = serde_json::from_value(json!({
            "appearance": { "uiFont": { "kind": "custom", "family": "Inter\"; color: red" } }
        }))
        .unwrap();
        assert_eq!(
            settings.appearance.ui_font.family.as_deref(),
            Some("Inter color: red")
        );
    }
}
