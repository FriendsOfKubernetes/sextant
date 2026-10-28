//! Terminal tools (ADR-0132): whether a cluster's terminal offers kubectl when it has none, or one out of the skew
//! Kubernetes supports. Written by the frontend ("Don't ask again" in the terminal, Settings → Terminal); read
//! leniently, so a value of the wrong type keeps the default (on) and the rest of the file still reads.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct TerminalToolsSettings {
    pub offer_kubectl: bool,
}

impl Default for TerminalToolsSettings {
    fn default() -> Self {
        Self {
            offer_kubectl: true,
        }
    }
}

/// `#[serde(with)]` module of `AppSettings::terminal_tools`: written as it is, read field by field.
pub(crate) mod terminal_tools_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &TerminalToolsSettings,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<TerminalToolsSettings, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        Ok(TerminalToolsSettings {
            offer_kubectl: value
                .get("offerKubectl")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(TerminalToolsSettings::default().offer_kubectl),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::settings::AppSettings;
    use serde_json::json;

    #[test]
    fn the_kubectl_offer_is_on_by_default_and_a_wrong_value_keeps_it_on() {
        assert!(AppSettings::default().terminal_tools.offer_kubectl);
        let read = |value: serde_json::Value| -> AppSettings {
            serde_json::from_value(json!({ "terminalTools": value })).unwrap()
        };
        assert!(
            !read(json!({ "offerKubectl": false }))
                .terminal_tools
                .offer_kubectl
        );
        assert!(
            read(json!({ "offerKubectl": 0 }))
                .terminal_tools
                .offer_kubectl
        );
    }
}
