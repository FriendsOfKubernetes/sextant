//! The order of clusters in the cluster rail: the ids the user put in order by dragging or with "Move up/down".
//! Written by the frontend; an empty list means the default order (the order of the kubeconfig sources and their
//! contexts). Clusters not in the list follow the ordered ones in the default order; the ids of clusters that are
//! gone are dropped when the frontend next writes the list, and a deleted or renamed context updates it at once
//! (`kubeconfig::edit::forget_cluster_settings` / `move_cluster_settings`).
//!
//! Read leniently like the other frontend-written settings: an entry that is not a short non-empty string, or that
//! repeats an earlier one, is left out, at most [`MAX_CLUSTER_ORDER`] are kept, and a value of the wrong type reads
//! as the default order without failing the file.

use serde::{Deserialize, Deserializer, Serialize};

/// Most ids the order keeps (more are left out when the file is read).
pub const MAX_CLUSTER_ORDER: usize = 2000;
/// Longest id kept, in bytes (a `ClusterId` is far shorter).
pub const MAX_CLUSTER_ID_LEN: usize = 256;

/// `#[serde(with)]` module of `AppSettings::cluster_order`: written as it is, read entry by entry.
pub(crate) mod cluster_order_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &Vec<String>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
        let serde_json::Value::Array(entries) = serde_json::Value::deserialize(d)? else {
            return Ok(Vec::new());
        };
        let mut ids: Vec<String> = Vec::new();
        for entry in entries {
            if ids.len() >= MAX_CLUSTER_ORDER {
                break;
            }
            let Some(id) = entry.as_str() else { continue };
            if !id.is_empty()
                && id.len() <= MAX_CLUSTER_ID_LEN
                && !ids.iter().any(|kept| kept == id)
            {
                ids.push(id.to_owned());
            }
        }
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
    use serde_json::json;

    #[test]
    fn the_order_is_empty_by_default_and_round_trips_through_the_file() {
        assert!(AppSettings::default().cluster_order.is_empty());
        let settings = AppSettings {
            cluster_order: vec!["c3".into(), "c1".into(), "c2".into()],
            ..AppSettings::default()
        };
        let text = serde_json::to_string(&settings).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["clusterOrder"], json!(["c3", "c1", "c2"]));
        let back: AppSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.cluster_order, settings.cluster_order);
    }

    #[test]
    fn bad_entries_are_left_out_and_a_bad_value_keeps_the_default_order() {
        let long = "x".repeat(MAX_CLUSTER_ID_LEN + 1);
        let settings: AppSettings = serde_json::from_value(json!({
            "theme": "dark",
            "clusterOrder": ["b", 7, "", null, "a", "b", long, {"id": "c"}, "c"]
        }))
        .unwrap();
        assert_eq!(settings.theme, crate::Theme::Dark);
        assert_eq!(settings.cluster_order, vec!["b", "a", "c"]);
        let wrong: AppSettings = serde_json::from_value(json!({ "clusterOrder": "a,b" })).unwrap();
        assert!(wrong.cluster_order.is_empty());
        let missing: AppSettings = serde_json::from_value(json!({})).unwrap();
        assert!(missing.cluster_order.is_empty());
    }

    #[test]
    fn the_order_is_capped() {
        let ids: Vec<String> = (0..MAX_CLUSTER_ORDER + 5)
            .map(|i| format!("c{i}"))
            .collect();
        let settings: AppSettings = serde_json::from_value(json!({ "clusterOrder": ids })).unwrap();
        assert_eq!(settings.cluster_order.len(), MAX_CLUSTER_ORDER);
        assert_eq!(settings.cluster_order[0], "c0");
    }
}
