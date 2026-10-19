//! The font families installed on this computer, for Settings -> Appearance -> "Other installed font…" (ADR-0093).
//! A web view cannot list them (WebKitGTK has no font enumeration), so the backend reads the system font folders with
//! `fontdb` (pure Rust: no process is started, fontconfig's files are parsed, not run). Only family names leave this
//! module, never file paths. The list is read once per run and cached: reading every font file takes a moment.
//! Neither agents (MCP) nor extensions can call it: it is a window command only.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Serialize;
use sextant_core::CoreError;
use sextant_core::settings::appearance::sanitize_family;
use ts_rs::TS;

/// One installed font family.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SystemFont {
    /// The family name, as CSS `font-family` names it.
    pub family: String,
    /// At least one face of the family is monospaced (its glyphs share one advance width).
    pub monospace: bool,
}

/// Families after the first this many are left out (a machine with a font collection beyond reason).
pub const MAX_FAMILIES: usize = 5_000;

static CACHE: OnceLock<Vec<SystemFont>> = OnceLock::new();

#[tauri::command]
pub async fn system_fonts() -> Result<Vec<SystemFont>, CoreError> {
    // Reads (memory-maps) every font file: off the async runtime. `get_or_init` runs the scan once; a call that comes
    // while it runs waits for it instead of scanning again.
    tauri::async_runtime::spawn_blocking(|| CACHE.get_or_init(scan_system_fonts).clone())
        .await
        .map_err(|e| CoreError::other(format!("listing fonts failed: {e}")))
}

fn scan_system_fonts() -> Vec<SystemFont> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    families(&db)
}

/// Whether a family name is offered: not hidden, and stored by the settings exactly as it is.
fn offered(name: &str) -> bool {
    !name.starts_with('.') && sanitize_family(name).as_deref() == Some(name)
}

/// The families of `db`, sorted case-insensitively and without repeats; a family is monospace when any of its faces
/// is. Names that are empty or hidden (a leading `.`, macOS's system-private fonts) are left out, and so is a name
/// that the settings would store differently ([`sanitize_family`]: quotes, semicolons, control characters…): it could
/// never be matched again.
pub fn families(db: &fontdb::Database) -> Vec<SystemFont> {
    let mut by_name: BTreeMap<String, SystemFont> = BTreeMap::new();
    for face in db.faces() {
        // The first name is the English one when the font has it (fontdb puts it first).
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        let name = name.trim();
        if !offered(name) {
            continue;
        }
        let entry = by_name
            .entry(name.to_lowercase())
            .or_insert_with(|| SystemFont {
                family: name.to_string(),
                monospace: false,
            });
        entry.monospace |= face.monospaced;
    }
    by_name.into_values().take(MAX_FAMILIES).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_database_has_no_families() {
        assert!(families(&fontdb::Database::new()).is_empty());
    }

    #[test]
    fn names_the_settings_would_change_are_not_offered() {
        assert!(offered("Fira Mono"));
        assert!(offered("Noto Sans CJK JP"));
        for name in [
            "",
            ".SF NS",
            "Bob's Font",
            "Semi;Colon",
            "Quote\"d",
            "Tab\tName",
            "Two  Spaces",
        ] {
            assert!(!offered(name), "{name:?}");
        }
    }

    #[test]
    fn a_font_file_gives_its_family_name_and_whether_it_is_monospace() {
        // The Latin subset of the bundled Fira Mono (OFL-1.1), as TrueType: fontdb does not read WOFF2.
        let mut db = fontdb::Database::new();
        db.load_font_data(include_bytes!("testdata/fira-mono-latin-400.ttf").to_vec());
        db.load_font_data(include_bytes!("testdata/fira-mono-latin-400.ttf").to_vec());
        assert_eq!(
            families(&db),
            [SystemFont {
                family: "Fira Mono".into(),
                monospace: true
            }]
        );
    }

    #[test]
    fn system_families_are_sorted_names_without_repeats() {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let list = families(&db);
        // A build machine may have no fonts at all; what is there must be clean.
        let mut seen = std::collections::HashSet::new();
        for font in &list {
            assert!(!font.family.is_empty());
            assert!(!font.family.contains('/'), "a name, not a path: {font:?}");
            assert!(seen.insert(font.family.to_lowercase()), "{font:?}");
        }
        let names: Vec<String> = list.iter().map(|f| f.family.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    #[test]
    fn neither_agents_nor_extensions_can_list_fonts() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(!tools.iter().any(|t| t.contains("font")), "{tools:?}");
        let methods = crate::extensions::api::METHODS;
        assert!(!methods.iter().any(|m| m.contains("font")), "{methods:?}");
    }
}
