//! Terminal snippets (#154): saved commands with `{{placeholder}}`s, a frontend-written list in `settings.json`.
//!
//! The list is read entry by entry like the saved views ([`super::views`]): an entry that does not read or breaks a
//! rule (an id that is not `[A-Za-z0-9_-]{1,64}`, an empty or over-long name or command, a repeated id, more entries
//! than the cap, a control, invisible or text-direction character) is left out instead of failing the whole file, and
//! a value that is not a list reads as empty.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use super::views::is_entry_id;

/// Most snippets kept.
pub const MAX_SNIPPETS: usize = 500;
/// Longest name of a snippet, in characters.
pub const MAX_SNIPPET_NAME_CHARS: usize = 120;
/// Longest command of a snippet, in characters.
pub const MAX_SNIPPET_COMMAND_CHARS: usize = 4096;

/// A saved command for the terminal. Placeholders (`{{namespace}}`, `{{pod}}`, `{{container}}`, `{{cluster}}`,
/// `{{context}}`) are filled by the frontend from the pane it is inserted into, each value shell-quoted.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
}

impl Snippet {
    fn is_valid(&self) -> bool {
        is_entry_id(&self.id)
            && !self.name.trim().is_empty()
            && self.name.chars().count() <= MAX_SNIPPET_NAME_CHARS
            && !self.command.trim().is_empty()
            && self.command.chars().count() <= MAX_SNIPPET_COMMAND_CHARS
            && !has_hidden_chars(&self.name)
            && !has_hidden_chars(&self.command)
    }
}

/// Whether `text` has a control character (C0, DEL, C1) or an invisible or text-direction character (zero-width
/// U+200B–U+200F, bidi U+202A–U+202E and U+2066–U+2069, BOM U+FEFF): a snippet is typed into shells, so it must read
/// as what runs (`hasHiddenChars` in `src/features/terminal/text.ts`).
fn has_hidden_chars(text: &str) -> bool {
    text.chars().any(|c| {
        c.is_control()
            || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
    })
}

/// `#[serde(with)]` module of `AppSettings::snippets`: written as it is, read entry by entry.
pub(crate) mod snippets_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &[Snippet],
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Snippet>, D::Error> {
        let serde_json::Value::Array(entries) = serde_json::Value::deserialize(d)? else {
            return Ok(Vec::new());
        };
        let mut list: Vec<Snippet> = Vec::new();
        for entry in entries {
            if list.len() >= MAX_SNIPPETS {
                break;
            }
            let Ok(snippet) = serde_json::from_value::<Snippet>(entry) else {
                continue;
            };
            if snippet.is_valid() && !list.iter().any(|kept| kept.id == snippet.id) {
                list.push(snippet);
            }
        }
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{AppSettings, SettingsStore};
    use serde_json::json;

    fn snippet(id: &str) -> Snippet {
        Snippet {
            id: id.to_owned(),
            name: format!("Snippet {id}"),
            command: "kubectl -n {{namespace}} logs {{pod}} -c {{container}}".to_owned(),
        }
    }

    #[test]
    fn snippets_are_empty_by_default_and_round_trip_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = SettingsStore::open(path.clone());
        assert!(store.get().snippets.is_empty());
        store
            .update(|s| s.snippets = vec![snippet("a"), snippet("b")])
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["snippets"][0]["command"], snippet("a").command);
        let reread = SettingsStore::open(path).get();
        assert_eq!(reread.snippets, vec![snippet("a"), snippet("b")]);
    }

    #[test]
    fn a_file_without_snippets_reads_with_an_empty_list() {
        let settings: AppSettings =
            serde_json::from_value(json!({ "theme": "dark", "views": [] })).unwrap();
        assert!(settings.snippets.is_empty());
    }

    #[test]
    fn bad_snippets_are_left_out_without_failing_the_file() {
        let settings: AppSettings = serde_json::from_value(json!({
            "theme": "dark",
            "snippets": [
                { "id": "ok", "name": "Good", "command": "ls", "future": true },
                { "id": "ok", "name": "Same id", "command": "ls" },
                { "id": "../x", "name": "Bad id", "command": "ls" },
                { "id": "noname", "name": " ", "command": "ls" },
                { "id": "nocmd", "name": "No command" },
                { "id": "badtype", "name": "Bad", "command": 42 },
                { "id": "long", "name": "Long", "command": "x".repeat(MAX_SNIPPET_COMMAND_CHARS + 1) },
                { "id": "enter", "name": "Enter", "command": "rm -rf /\r" },
                { "id": "bidi", "name": "Bidi", "command": "ls \u{202E}fdp.exe" },
                { "id": "zw", "name": "Zero\u{200B}width", "command": "ls" },
                "not an object"
            ]
        }))
        .unwrap();
        assert_eq!(settings.theme, crate::Theme::Dark);
        assert_eq!(settings.snippets.len(), 1);
        assert_eq!(settings.snippets[0].name, "Good");

        let not_a_list: AppSettings =
            serde_json::from_value(json!({ "snippets": { "a": 1 } })).unwrap();
        assert!(not_a_list.snippets.is_empty());
    }

    #[test]
    fn snippets_are_capped() {
        let list: Vec<_> = (0..MAX_SNIPPETS + 5)
            .map(|i| json!({ "id": format!("s{i}"), "name": "x", "command": "ls" }))
            .collect();
        let settings: AppSettings = serde_json::from_value(json!({ "snippets": list })).unwrap();
        assert_eq!(settings.snippets.len(), MAX_SNIPPETS);
    }
}
