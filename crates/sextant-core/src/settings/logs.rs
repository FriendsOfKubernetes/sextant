//! How the logs view shows lines: wrapped or one line per entry, and with or without the colours of ANSI escape
//! sequences. Written by the frontend (the toggles in the logs toolbar).
//!
//! Read leniently like the other frontend-written settings: a field of the wrong type keeps its default and the
//! rest of the file still reads.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct LogViewSettings {
    /// `true`: long lines wrap to the width of the view and line breaks inside an entry start new lines; `false`:
    /// one line per entry, scrolled sideways, with a line break shown as a symbol.
    pub wrap: bool,
    /// Show the colours and styles of ANSI escape sequences (SGR); `false` shows the text without them. The
    /// sequences themselves are never shown.
    pub colours: bool,
}

impl Default for LogViewSettings {
    fn default() -> Self {
        Self {
            wrap: false,
            colours: true,
        }
    }
}

/// `#[serde(with)]` module of `AppSettings::logs`: written as it is, read field by field.
pub(crate) mod logs_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &LogViewSettings,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<LogViewSettings, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        let defaults = LogViewSettings::default();
        let flag = |name: &str, default: bool| {
            value
                .get(name)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(default)
        };
        Ok(LogViewSettings {
            wrap: flag("wrap", defaults.wrap),
            colours: flag("colours", defaults.colours),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
    use serde_json::json;

    #[test]
    fn log_view_defaults_to_one_line_with_colours_and_round_trips() {
        assert_eq!(
            AppSettings::default().logs,
            LogViewSettings {
                wrap: false,
                colours: true
            }
        );
        let settings = AppSettings {
            logs: LogViewSettings {
                wrap: true,
                colours: false,
            },
            ..AppSettings::default()
        };
        let text = serde_json::to_string(&settings).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["logs"], json!({ "wrap": true, "colours": false }));
        let back: AppSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.logs, settings.logs);
    }

    #[test]
    fn a_bad_log_view_value_keeps_the_defaults_without_failing_the_file() {
        let settings: AppSettings = serde_json::from_value(json!({
            "theme": "dark",
            "logs": { "wrap": "yes", "colours": false, "extra": 1 }
        }))
        .unwrap();
        assert_eq!(settings.theme, crate::Theme::Dark);
        assert_eq!(
            settings.logs,
            LogViewSettings {
                wrap: false,
                colours: false
            }
        );
        let wrong: AppSettings = serde_json::from_value(json!({ "logs": [true] })).unwrap();
        assert_eq!(wrong.logs, LogViewSettings::default());
        let missing: AppSettings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(missing.logs, LogViewSettings::default());
    }
}
