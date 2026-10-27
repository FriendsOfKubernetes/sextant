//! Appearance (ADR-0093): the interface font and the monospace font (terminal, YAML, logs, code), and the accessibility
//! choices of ADR-0092 (reduced motion, the interface text size, screen reader support in the terminal). Written by the
//! frontend, which turns a font choice into the `--font-latin` / `--font-mono` CSS variables and the rest into
//! attributes and the font size of `<html>`.
//!
//! Read leniently like the other frontend-written settings: an unknown kind, a custom choice without a usable family
//! name, or a value of the wrong type reads as the built-in font (the default of the other fields) instead of failing
//! the file. A family name is kept
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

/// Whether transitions, animations, smooth scrolling and the blinking terminal cursor are turned off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReduceMotion {
    /// Follow the operating system (`prefers-reduced-motion`).
    #[default]
    System,
    /// Always reduce motion.
    On,
    /// Never reduce motion, whatever the operating system says.
    Off,
}

/// The interface text sizes offered, in percent of the default; anything else reads as [`DEFAULT_TEXT_SIZE`].
pub const TEXT_SIZES: [u16; 5] = [90, 100, 110, 125, 150];
/// The default interface text size, in percent.
pub const DEFAULT_TEXT_SIZE: u16 = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct AppearanceSettings {
    /// The interface font.
    pub ui_font: FontChoice,
    /// The monospace font: terminal, YAML editor, logs and code.
    pub mono_font: FontChoice,
    /// Reduced motion: the system's preference by default.
    pub reduce_motion: ReduceMotion,
    /// The interface text size in percent of the default, one of [`TEXT_SIZES`].
    pub text_size: u16,
    /// xterm's screen reader mode in terminals (off by default: it costs rendering speed).
    pub terminal_screen_reader: bool,
    /// Indent child items in every cluster sidebar (on by default since 0.25; off keeps the original alignment).
    pub sidebar_indent: bool,
    /// Draw tree guides in every cluster sidebar, independently of indentation.
    pub sidebar_guides: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            ui_font: FontChoice::default(),
            mono_font: FontChoice::default(),
            reduce_motion: ReduceMotion::default(),
            text_size: DEFAULT_TEXT_SIZE,
            terminal_screen_reader: false,
            sidebar_indent: true,
            sidebar_guides: false,
        }
    }
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

fn read_reduce_motion(value: Option<&serde_json::Value>) -> ReduceMotion {
    match value.and_then(serde_json::Value::as_str) {
        Some("on") => ReduceMotion::On,
        Some("off") => ReduceMotion::Off,
        _ => ReduceMotion::System,
    }
}

fn read_text_size(value: Option<&serde_json::Value>) -> u16 {
    value
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u16::try_from(n).ok())
        .filter(|n| TEXT_SIZES.contains(n))
        .unwrap_or(DEFAULT_TEXT_SIZE)
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
            reduce_motion: read_reduce_motion(value.get("reduceMotion")),
            text_size: read_text_size(value.get("textSize")),
            terminal_screen_reader: value
                .get("terminalScreenReader")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            sidebar_indent: value
                .get("sidebarIndent")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true),
            sidebar_guides: value
                .get("sidebarGuides")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
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
            json!({
                "uiFont": { "kind": "builtin" },
                "monoFont": { "kind": "builtin" },
                "reduceMotion": "system",
                "textSize": 100,
                "terminalScreenReader": false,
                "sidebarIndent": true,
                "sidebarGuides": false
            })
        );
    }

    #[test]
    fn choices_round_trip() {
        let appearance = json!({
            "uiFont": { "kind": "system" },
            "monoFont": { "kind": "custom", "family": "JetBrains Mono" },
            "reduceMotion": "on",
            "textSize": 125,
            "terminalScreenReader": true,
            "sidebarIndent": true,
            "sidebarGuides": false
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
        assert_eq!(settings.appearance.reduce_motion, ReduceMotion::On);
        assert_eq!(settings.appearance.text_size, 125);
        assert!(settings.appearance.terminal_screen_reader);
        let written = serde_json::to_value(&settings).unwrap();
        assert_eq!(written["appearance"], appearance);
    }

    #[test]
    fn accessibility_choices_read_leniently() {
        // A settings file of v0.15 (fonts only) gets the defaults.
        let old: AppSettings = serde_json::from_value(json!({
            "appearance": { "uiFont": { "kind": "system" }, "monoFont": { "kind": "builtin" } }
        }))
        .unwrap();
        assert_eq!(old.appearance.ui_font.kind, FontKind::System);
        assert_eq!(old.appearance.reduce_motion, ReduceMotion::System);
        assert_eq!(old.appearance.text_size, DEFAULT_TEXT_SIZE);
        assert!(!old.appearance.terminal_screen_reader);

        for (motion, size, reader) in [
            (json!("sometimes"), json!(130), json!("yes")),
            (json!(true), json!("125"), json!(1)),
            (json!(null), json!(-100), json!(null)),
            (json!({}), json!(100_000_000), json!([])),
            (json!("off"), json!(150.5), json!(false)),
        ] {
            let s: AppSettings = serde_json::from_value(json!({
                "theme": "dark",
                "appearance": { "reduceMotion": motion, "textSize": size, "terminalScreenReader": reader }
            }))
            .unwrap();
            assert_eq!(s.theme, crate::Theme::Dark);
            let expected = if motion == json!("off") {
                ReduceMotion::Off
            } else {
                ReduceMotion::System
            };
            assert_eq!(s.appearance.reduce_motion, expected, "{motion}");
            assert_eq!(s.appearance.text_size, DEFAULT_TEXT_SIZE, "{size}");
            assert!(!s.appearance.terminal_screen_reader, "{reader}");
        }
        for size in TEXT_SIZES {
            let s: AppSettings =
                serde_json::from_value(json!({ "appearance": { "textSize": size } })).unwrap();
            assert_eq!(s.appearance.text_size, size);
        }
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
    fn sidebar_choices_default_to_indented_without_guides_and_read_leniently() {
        for appearance in [
            json!({}),
            json!({ "sidebarIndent": "true", "sidebarGuides": 1 }),
            json!({ "sidebarIndent": null, "sidebarGuides": [] }),
        ] {
            let settings: AppSettings = serde_json::from_value(json!({
                "theme": "dark", "appearance": appearance
            }))
            .unwrap();
            let written = serde_json::to_value(&settings).unwrap();
            assert_eq!(written["appearance"]["sidebarIndent"], true);
            assert_eq!(written["appearance"]["sidebarGuides"], false);
            assert_eq!(settings.theme, crate::Theme::Dark);
        }
    }

    #[test]
    fn sidebar_choices_round_trip_independently_and_keep_other_appearance() {
        for (indent, guides) in [(false, false), (true, false), (false, true), (true, true)] {
            let settings: AppSettings = serde_json::from_value(json!({
                "appearance": {
                    "sidebarIndent": indent, "sidebarGuides": guides,
                    "uiFont": { "kind": "system" }, "textSize": 125
                }
            }))
            .unwrap();
            let written = serde_json::to_value(&settings).unwrap();
            assert_eq!(written["appearance"]["sidebarIndent"], indent);
            assert_eq!(written["appearance"]["sidebarGuides"], guides);
            assert_eq!(written["appearance"]["uiFont"]["kind"], "system");
            assert_eq!(written["appearance"]["textSize"], 125);
            let reloaded: AppSettings = serde_json::from_value(written).unwrap();
            assert_eq!(reloaded.appearance, settings.appearance);
        }
        let settings: AppSettings = serde_json::from_value(json!({
            "appearance": { "sidebarIndent": "yes", "sidebarGuides": true }
        }))
        .unwrap();
        let written = serde_json::to_value(settings).unwrap();
        assert_eq!(written["appearance"]["sidebarIndent"], true);
        assert_eq!(written["appearance"]["sidebarGuides"], true);
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
