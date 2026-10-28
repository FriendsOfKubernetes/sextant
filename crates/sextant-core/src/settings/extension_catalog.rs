//! The extension catalog (ADR-0130): whether Sextant may read it at all. Written by the frontend (Settings →
//! Extensions); the backend reads it before every catalog request. Read leniently: a value of the wrong type keeps the
//! default (on) and the rest of the file still reads.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct ExtensionCatalogSettings {
    /// `false`: no request to the catalog, and its tab and update notices are hidden.
    pub enabled: bool,
}

impl Default for ExtensionCatalogSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// `#[serde(with)]` module of `AppSettings::extension_catalog`: written as it is, read field by field.
pub(crate) mod extension_catalog_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &ExtensionCatalogSettings,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<ExtensionCatalogSettings, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        Ok(ExtensionCatalogSettings {
            enabled: value
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(ExtensionCatalogSettings::default().enabled),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::settings::AppSettings;
    use serde_json::json;

    #[test]
    fn the_catalog_is_on_by_default_and_a_wrong_value_keeps_it_on() {
        assert!(AppSettings::default().extension_catalog.enabled);
        let read = |value: serde_json::Value| -> AppSettings {
            serde_json::from_value(json!({ "extensionCatalog": value, "closeToTray": true }))
                .unwrap()
        };
        assert!(!read(json!({ "enabled": false })).extension_catalog.enabled);
        let wrong = read(json!({ "enabled": "no" }));
        assert!(wrong.extension_catalog.enabled);
        assert!(wrong.close_to_tray, "the rest of the file still reads");
        assert!(read(json!("off")).extension_catalog.enabled);
        let written = serde_json::to_value(read(json!({ "enabled": false }))).unwrap();
        assert_eq!(written["extensionCatalog"], json!({ "enabled": false }));
    }
}
