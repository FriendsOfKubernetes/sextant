//! Comparing objects (#156): paths the user chose to ignore, per kind. Written by the frontend.
//!
//! Read leniently like the other frontend-written lists: a kind key that is not `group/Kind`, a path that does not
//! start with `/`, is too long or has a control character, a repeated path, and whatever is past the caps is left out
//! instead of failing the file; a value of the wrong type reads as empty.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// Kinds with saved ignore paths, at most.
pub const MAX_IGNORE_KINDS: usize = 200;
/// Ignore paths per kind, at most.
pub const MAX_IGNORE_PATHS: usize = 50;
/// Longest ignore path, in characters.
pub const MAX_IGNORE_PATH_CHARS: usize = 256;
/// Longest kind key (`group/Kind`), in characters.
const MAX_KIND_KEY_CHARS: usize = 320;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct CompareSettings {
    /// Per kind (`apps/Deployment`, `/ConfigMap`: group, `/`, kind), JSON-pointer-like paths left out of every
    /// comparison of that kind: `/spec/replicas`, `/metadata/labels/app.kubernetes.io~1version`; `*` stands for any
    /// one key or list item.
    pub ignore_paths: BTreeMap<String, Vec<String>>,
}

fn is_kind_key(key: &str) -> bool {
    let Some((group, kind)) = key.rsplit_once('/') else {
        return false;
    };
    key.chars().count() <= MAX_KIND_KEY_CHARS
        && !kind.is_empty()
        && kind.chars().all(|c| c.is_ascii_alphanumeric())
        && group
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

fn is_path(path: &str) -> bool {
    path.starts_with('/')
        && path.len() > 1
        && path.chars().count() <= MAX_IGNORE_PATH_CHARS
        && !path.chars().any(char::is_control)
}

/// `#[serde(with)]` module of `AppSettings::compare`: written as it is, read entry by entry.
pub(crate) mod compare_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &CompareSettings,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<CompareSettings, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        let Some(serde_json::Value::Object(kinds)) = value.get("ignorePaths") else {
            return Ok(CompareSettings::default());
        };
        let mut ignore_paths = BTreeMap::new();
        for (key, paths) in kinds {
            if ignore_paths.len() >= MAX_IGNORE_KINDS {
                break;
            }
            let serde_json::Value::Array(paths) = paths else {
                continue;
            };
            if !is_kind_key(key) {
                continue;
            }
            let mut kept: Vec<String> = Vec::new();
            for path in paths {
                if kept.len() >= MAX_IGNORE_PATHS {
                    break;
                }
                if let Some(path) = path.as_str().filter(|p| is_path(p))
                    && !kept.iter().any(|k| k == path)
                {
                    kept.push(path.to_owned());
                }
            }
            if !kept.is_empty() {
                ignore_paths.insert(key.clone(), kept);
            }
        }
        Ok(CompareSettings { ignore_paths })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
    use serde_json::json;

    #[test]
    fn ignore_paths_are_empty_by_default_and_round_trip() {
        assert!(AppSettings::default().compare.ignore_paths.is_empty());
        let mut settings = AppSettings::default();
        settings
            .compare
            .ignore_paths
            .insert("apps/Deployment".into(), vec!["/spec/replicas".into()]);
        let text = serde_json::to_string(&settings).unwrap();
        let back: AppSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.compare, settings.compare);
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            json["compare"]["ignorePaths"]["apps/Deployment"][0],
            "/spec/replicas"
        );
    }

    #[test]
    fn bad_ignore_paths_are_left_out_without_failing_the_file() {
        let settings: AppSettings = serde_json::from_value(json!({
            "theme": "dark",
            "compare": { "ignorePaths": {
                "apps/Deployment": ["/spec/replicas", "/spec/replicas", "spec/x", "/", 7, "/a\u{0007}b",
                                    format!("/{}", "x".repeat(MAX_IGNORE_PATH_CHARS))],
                "/ConfigMap": ["/data/*"],
                "not a kind": ["/spec"],
                "apps/": ["/spec"],
                "/Secret": "not a list",
                "/Service": []
            }}
        }))
        .unwrap();
        assert_eq!(settings.theme, crate::Theme::Dark);
        let paths = &settings.compare.ignore_paths;
        assert_eq!(paths.len(), 2, "{paths:?}");
        assert_eq!(paths["apps/Deployment"], ["/spec/replicas"]);
        assert_eq!(paths["/ConfigMap"], ["/data/*"]);

        let wrong: AppSettings = serde_json::from_value(json!({ "compare": [1, 2] })).unwrap();
        assert!(wrong.compare.ignore_paths.is_empty());
    }

    #[test]
    fn ignore_paths_are_capped() {
        let kinds: serde_json::Map<String, serde_json::Value> = (0..MAX_IGNORE_KINDS + 5)
            .map(|i| {
                let paths: Vec<String> = (0..MAX_IGNORE_PATHS + 5)
                    .map(|p| format!("/p{p}"))
                    .collect();
                (format!("example.com/Kind{i}"), json!(paths))
            })
            .collect();
        let settings: AppSettings =
            serde_json::from_value(json!({ "compare": { "ignorePaths": kinds } })).unwrap();
        assert_eq!(settings.compare.ignore_paths.len(), MAX_IGNORE_KINDS);
        assert!(
            settings
                .compare
                .ignore_paths
                .values()
                .all(|p| p.len() == MAX_IGNORE_PATHS)
        );
    }
}
