//! The "What's new" window: the newest version whose notes the user has seen. Written by the frontend when the window
//! closes (and on a fresh install, so a new user is not shown the notes of a version they never used); set by the
//! settings migration to "0.29.0" for a settings file of an earlier Sextant, so an update shows what changed. Read
//! leniently: a value that is not a version reads as none.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct WhatsNewSettings {
    /// `major.minor.patch` of the newest notes seen; none on a fresh install until the window first loads.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub seen_version: Option<String>,
}

/// The version the settings migration writes for a file of Sextant 0.29 or earlier (ADR-0166).
pub const BEFORE_0_30: &str = "0.29.0";

/// `major.minor.patch` of digits, at most 32 characters.
pub fn is_version(text: &str) -> bool {
    text.len() <= 32
        && text.split('.').count() == 3
        && text
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// `#[serde(with)]` module of `AppSettings::whats_new`: written as it is, read field by field.
pub(crate) mod whats_new_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &WhatsNewSettings,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<WhatsNewSettings, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        Ok(WhatsNewSettings {
            seen_version: value
                .get("seenVersion")
                .and_then(serde_json::Value::as_str)
                .filter(|v| is_version(v))
                .map(str::to_owned),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_reads_and_anything_else_is_none() {
        let read = |json: &str| -> WhatsNewSettings {
            whats_new_field::deserialize(&mut serde_json::Deserializer::from_str(json)).unwrap()
        };
        assert_eq!(
            read(r#"{"seenVersion":"0.30.0"}"#).seen_version.as_deref(),
            Some("0.30.0")
        );
        for bad in [
            r#"{"seenVersion":"0.30"}"#,
            r#"{"seenVersion":7}"#,
            r#"{"seenVersion":"x.y.z"}"#,
            "[]",
            "null",
        ] {
            assert_eq!(read(bad).seen_version, None, "{bad}");
        }
    }
}
