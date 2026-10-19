//! Column widths of tables: the widths the user dragged, per table and column, and when the table's widths last
//! changed. Written by the frontend.
//!
//! Read leniently like the other frontend-written lists: a table or column id that is empty, too long or has a
//! control character, a width that is not a number, and a table without any width is left out instead of failing the
//! file; a width outside [`MIN_COLUMN_WIDTH`]..=[`MAX_COLUMN_WIDTH`] is clamped; a value of the wrong type reads as
//! empty. Past the caps the most recently changed tables are kept ([`MAX_TABLES`], by `used`), the frontend applies
//! the same rule before it writes, so a new table's widths are never the ones dropped.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// Tables with saved widths, at most (the frontend's `MAX_TABLES`).
pub const MAX_TABLES: usize = 300;
/// Saved widths per table, at most (the frontend's `MAX_COLUMNS`).
pub const MAX_COLUMNS: usize = 64;
/// Longest table id (`kind:apps/Deployment`, `helm.releases`), in characters.
pub const MAX_TABLE_ID_CHARS: usize = 200;
/// Longest column id, in characters.
pub const MAX_COLUMN_ID_CHARS: usize = 128;
/// Narrowest column, in pixels (the frontend's `MIN_COLUMN_WIDTH`).
pub const MIN_COLUMN_WIDTH: u32 = 48;
/// Widest column, in pixels (the frontend's `MAX_COLUMN_WIDTH`).
pub const MAX_COLUMN_WIDTH: u32 = 1600;

/// The widths of one table.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct TableColumnWidths {
    /// Column id → width in pixels, only for the columns the user resized.
    pub columns: BTreeMap<String, u32>,
    /// When the widths last changed (milliseconds since the Unix epoch): past [`MAX_TABLES`] the most recent are kept.
    #[ts(type = "number")]
    pub used: u64,
}

/// Table id → its widths.
pub type ColumnWidths = BTreeMap<String, TableColumnWidths>;

fn is_id(id: &str, max: usize) -> bool {
    !id.trim().is_empty() && id.chars().count() <= max && !id.chars().any(char::is_control)
}

fn width_of(value: &serde_json::Value) -> Option<u32> {
    let n = value.as_f64().filter(|n| n.is_finite())?;
    // Clamped first, so the cast cannot overflow.
    Some(
        n.round()
            .clamp(f64::from(MIN_COLUMN_WIDTH), f64::from(MAX_COLUMN_WIDTH)) as u32,
    )
}

fn table_of(value: &serde_json::Value) -> Option<TableColumnWidths> {
    let serde_json::Value::Object(columns) = value.get("columns")? else {
        return None;
    };
    let mut kept = BTreeMap::new();
    for (column, width) in columns {
        if kept.len() >= MAX_COLUMNS {
            break;
        }
        if let Some(width) = width_of(width)
            && is_id(column, MAX_COLUMN_ID_CHARS)
        {
            kept.insert(column.clone(), width);
        }
    }
    let used = value
        .get("used")
        .and_then(serde_json::Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        // Saturating: a float past u64::MAX becomes u64::MAX.
        .map_or(0, |n| n as u64);
    (!kept.is_empty()).then_some(TableColumnWidths {
        columns: kept,
        used,
    })
}

/// `#[serde(with)]` module of `AppSettings::column_widths`: written as it is, read entry by entry.
pub(crate) mod column_widths_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &ColumnWidths,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<ColumnWidths, D::Error> {
        let value = serde_json::Value::deserialize(d)?;
        let serde_json::Value::Object(tables) = value else {
            return Ok(ColumnWidths::new());
        };
        let mut read: Vec<(String, TableColumnWidths)> = tables
            .into_iter()
            .filter(|(id, _)| is_id(id, MAX_TABLE_ID_CHARS))
            .filter_map(|(id, entry)| table_of(&entry).map(|t| (id, t)))
            .collect();
        // The most recently changed first; the same moment by id, so the result does not depend on the file's order.
        read.sort_by(|a, b| b.1.used.cmp(&a.1.used).then_with(|| a.0.cmp(&b.0)));
        read.truncate(MAX_TABLES);
        Ok(read.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
    use serde_json::json;

    #[test]
    fn column_widths_are_empty_by_default_and_round_trip() {
        assert!(AppSettings::default().column_widths.is_empty());
        let mut settings = AppSettings::default();
        settings.column_widths.insert(
            "kind:apps/Deployment".into(),
            TableColumnWidths {
                columns: BTreeMap::from([
                    ("name".to_owned(), 240),
                    ("printer-0-Ready Replicas".to_owned(), 96),
                ]),
                used: 1_760_000_000_000,
            },
        );
        let text = serde_json::to_string(&settings).unwrap();
        let back: AppSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.column_widths, settings.column_widths);
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            json["columnWidths"]["kind:apps/Deployment"]["columns"]["name"],
            240
        );
        assert_eq!(
            json["columnWidths"]["kind:apps/Deployment"]["used"],
            1_760_000_000_000_u64
        );
    }

    #[test]
    fn bad_column_widths_are_left_out_or_clamped_without_failing_the_file() {
        let settings: AppSettings = serde_json::from_value(json!({
            "theme": "dark",
            "columnWidths": {
                "helm.releases": {
                    "columns": { "0": 120, "1": 3, "2": 99999, "3": "wide", "4": null, "": 80, "a\u{0007}": 80, "5": 150.6 },
                    "used": "yesterday"
                },
                "": { "columns": { "0": 100 } },
                "x".repeat(MAX_TABLE_ID_CHARS + 1): { "columns": { "0": 100 } },
                "portforward": "not a map",
                "events": { "columns": {} },
                "old-shape": { "0": 100 }
            }
        }))
        .unwrap();
        assert_eq!(settings.theme, crate::Theme::Dark);
        let widths = &settings.column_widths;
        assert_eq!(widths.len(), 1, "{widths:?}");
        let helm = &widths["helm.releases"];
        assert_eq!(helm.used, 0);
        assert_eq!(helm.columns.len(), 4, "{helm:?}");
        assert_eq!(helm.columns["0"], 120);
        assert_eq!(helm.columns["1"], MIN_COLUMN_WIDTH);
        assert_eq!(helm.columns["2"], MAX_COLUMN_WIDTH);
        assert_eq!(helm.columns["5"], 151);

        let wrong: AppSettings = serde_json::from_value(json!({ "columnWidths": [1, 2] })).unwrap();
        assert!(wrong.column_widths.is_empty());
    }

    #[test]
    fn past_the_cap_the_most_recently_changed_tables_are_kept() {
        let tables: serde_json::Map<String, serde_json::Value> = (0..MAX_TABLES + 5)
            .map(|i| {
                let columns: serde_json::Map<String, serde_json::Value> = (0..MAX_COLUMNS + 5)
                    .map(|c| (format!("c{c}"), json!(100)))
                    .collect();
                // "table-000" is the newest: alphabetically first would be the oldest otherwise.
                let used = 1_000_000 - i as u64;
                (
                    format!("table-{i:03}"),
                    json!({ "columns": columns, "used": used }),
                )
            })
            .collect();
        let settings: AppSettings =
            serde_json::from_value(json!({ "columnWidths": tables })).unwrap();
        let widths = &settings.column_widths;
        assert_eq!(widths.len(), MAX_TABLES);
        assert!(widths.values().all(|c| c.columns.len() == MAX_COLUMNS));
        assert!(widths.contains_key("table-000"));
        assert!(!widths.contains_key(&format!("table-{:03}", MAX_TABLES)));

        // A table changed last stays even when its id sorts last.
        let mut tables: serde_json::Map<String, serde_json::Value> = (0..MAX_TABLES)
            .map(|i| {
                (
                    format!("a-{i:03}"),
                    json!({ "columns": { "0": 80 }, "used": 10 }),
                )
            })
            .collect();
        tables.insert(
            "zz-new".into(),
            json!({ "columns": { "0": 80 }, "used": 20 }),
        );
        let settings: AppSettings =
            serde_json::from_value(json!({ "columnWidths": tables })).unwrap();
        assert_eq!(settings.column_widths.len(), MAX_TABLES);
        assert!(settings.column_widths.contains_key("zz-new"));
    }
}
