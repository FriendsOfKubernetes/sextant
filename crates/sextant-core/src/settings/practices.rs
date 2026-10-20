//! The "Best practices" checks (#207): which checks are turned off and which namespaces are never checked. Written
//! by the frontend (the settings dialog of the page); the checks themselves run in the frontend.
//!
//! Read leniently like the other frontend-written settings: a field of the wrong type keeps its default, an entry
//! that is not a non-empty string is left out, entries are trimmed and kept once, and each list is capped.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// At most this many entries are kept per list.
pub const MAX_PRACTICES_ENTRIES: usize = 256;
/// Longer entries are left out (a namespace name is at most 63 characters, a check id far shorter).
pub const MAX_PRACTICES_ENTRY_LEN: usize = 253;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct PracticesSettings {
    /// Ids of the checks turned off (`readinessProbe`, `singleReplica`, …). A check that is not listed is on, so a
    /// check added by a later version starts on; an id this version does not know is kept as it is.
    pub disabled_checks: Vec<String>,
    /// Namespaces whose objects are never checked (the page, the details and the problems category alike).
    pub excluded_namespaces: Vec<String>,
}

impl Default for PracticesSettings {
    fn default() -> Self {
        Self {
            disabled_checks: Vec::new(),
            // Run by the cluster's platform: their owners, not the cluster's users, decide how they are deployed.
            excluded_namespaces: ["kube-system", "kube-public", "kube-node-lease"]
                .map(str::to_owned)
                .to_vec(),
        }
    }
}

/// The strings of a JSON list, trimmed, non-empty, each once, capped; `None` when the value is not a list.
fn string_list(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let items = value?.as_array()?;
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Some(text) = item.as_str().map(str::trim) else {
            continue;
        };
        if text.is_empty() || text.len() > MAX_PRACTICES_ENTRY_LEN || out.iter().any(|s| s == text)
        {
            continue;
        }
        out.push(text.to_owned());
        if out.len() == MAX_PRACTICES_ENTRIES {
            break;
        }
    }
    Some(out)
}

/// `#[serde(with)]` module of `AppSettings::practices`: written as it is, read field by field.
pub(crate) mod practices_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &PracticesSettings,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<PracticesSettings, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        let defaults = PracticesSettings::default();
        Ok(PracticesSettings {
            disabled_checks: string_list(value.get("disabledChecks"))
                .unwrap_or(defaults.disabled_checks),
            excluded_namespaces: string_list(value.get("excludedNamespaces"))
                .unwrap_or(defaults.excluded_namespaces),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
    use serde_json::json;

    #[test]
    fn practices_default_to_every_check_on_outside_the_kube_namespaces_and_round_trip() {
        let defaults = AppSettings::default().practices;
        assert!(defaults.disabled_checks.is_empty());
        assert_eq!(
            defaults.excluded_namespaces,
            ["kube-system", "kube-public", "kube-node-lease"]
        );
        let settings = AppSettings {
            practices: PracticesSettings {
                disabled_checks: vec!["livenessProbe".to_owned()],
                excluded_namespaces: vec!["batch".to_owned()],
            },
            ..AppSettings::default()
        };
        let text = serde_json::to_string(&settings).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            json["practices"],
            json!({ "disabledChecks": ["livenessProbe"], "excludedNamespaces": ["batch"] })
        );
        let back: AppSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.practices, settings.practices);
    }

    #[test]
    fn a_bad_practices_value_keeps_the_defaults_without_failing_the_file() {
        let settings: AppSettings = serde_json::from_value(json!({
            "theme": "dark",
            "practices": {
                "disabledChecks": ["singleReplica", 7, "", " singleReplica ", "futureCheck"],
                "excludedNamespaces": "kube-system",
                "extra": true
            }
        }))
        .unwrap();
        assert_eq!(settings.theme, crate::Theme::Dark);
        assert_eq!(
            settings.practices.disabled_checks,
            ["singleReplica", "futureCheck"]
        );
        assert_eq!(
            settings.practices.excluded_namespaces,
            PracticesSettings::default().excluded_namespaces
        );
        let wrong: AppSettings = serde_json::from_value(json!({ "practices": [1] })).unwrap();
        assert_eq!(wrong.practices, PracticesSettings::default());
        let missing: AppSettings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(missing.practices, PracticesSettings::default());
        // An explicitly empty list is the user's choice, not a missing one.
        let empty: AppSettings =
            serde_json::from_value(json!({ "practices": { "excludedNamespaces": [] } })).unwrap();
        assert!(empty.practices.excluded_namespaces.is_empty());
    }

    #[test]
    fn practices_lists_are_capped() {
        let many: Vec<String> = (0..1000).map(|i| format!("ns-{i}")).collect();
        let long = "x".repeat(MAX_PRACTICES_ENTRY_LEN + 1);
        let settings: AppSettings = serde_json::from_value(json!({
            "practices": { "excludedNamespaces": many, "disabledChecks": [long, "noPdb"] }
        }))
        .unwrap();
        assert_eq!(
            settings.practices.excluded_namespaces.len(),
            MAX_PRACTICES_ENTRIES
        );
        assert_eq!(settings.practices.disabled_checks, ["noPdb"]);
    }
}
