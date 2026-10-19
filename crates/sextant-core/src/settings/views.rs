//! Saved views, pins and workspaces (#149): frontend-written lists in `settings.json`.
//!
//! Each list is read entry by entry: an entry that does not read or breaks a rule (an id that is not
//! `[A-Za-z0-9_-]{1,64}`, an empty or over-long name, a repeated id, more entries than the cap) is left out instead of
//! failing the whole file, and a value that is not a list reads as empty. Fields this version does not know are
//! ignored, like the rest of the settings.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// Most saved views kept.
pub const MAX_VIEWS: usize = 500;
/// Most pins kept.
pub const MAX_PINS: usize = 500;
/// Most workspaces kept.
pub const MAX_WORKSPACES: usize = 100;
/// Most clusters one workspace lists.
pub const MAX_WORKSPACE_CLUSTERS: usize = 1000;
/// Longest name of a view or workspace, in characters.
pub const MAX_NAME_CHARS: usize = 120;
/// Longest search text or label selector of a view, in characters.
pub const MAX_FILTER_CHARS: usize = 1000;

/// A resource table saved under a name: its kind and how it was filtered, sorted and which columns it showed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct SavedView {
    pub id: String,
    pub name: String,
    /// The cluster (`ClusterId`) the view belongs to; `None` = offered in every cluster.
    pub cluster: Option<String>,
    /// API group of the kind (`""` for the core group).
    pub group: String,
    pub kind: String,
    /// Namespaces of the namespace filter; `None` = all namespaces.
    pub namespaces: Option<Vec<String>>,
    /// The table's search text.
    pub search: String,
    /// "Only problems" (kinds that say what a problem is).
    pub only_problems: bool,
    /// A label selector the watch is asked for (`app=web,tier!=db`); empty = none.
    pub label_selector: String,
    /// The sorted column; `None` = the table's default.
    pub sort: Option<ViewSort>,
    /// Column ids the table hides.
    pub hidden_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct ViewSort {
    pub column: String,
    pub desc: bool,
}

/// An object or a saved view on a cluster's favourites strip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Pin {
    pub id: String,
    /// The cluster (`ClusterId`) whose strip shows it.
    pub cluster: String,
    pub target: PinTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum PinTarget {
    /// One object, opened in the details panel.
    #[serde(rename_all = "camelCase")]
    Object {
        group: String,
        version: String,
        kind: String,
        namespace: Option<String>,
        name: String,
    },
    /// A saved view (`SavedView::id`).
    #[serde(rename_all = "camelCase")]
    View { view: String },
}

/// A named set of clusters to switch between ("prod", "staging"): the cluster rail shows only them, and only their
/// views and pins are offered. Switching never connects or disconnects a cluster.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// `ClusterId`s, in the order chosen.
    pub clusters: Vec<String>,
}

/// Whether `id` names a view, pin or workspace: `[A-Za-z0-9_-]{1,64}`.
pub fn is_entry_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_name(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= MAX_NAME_CHARS
}

fn is_filter(text: &str) -> bool {
    text.chars().count() <= MAX_FILTER_CHARS
}

impl SavedView {
    fn is_valid(&self) -> bool {
        is_entry_id(&self.id)
            && is_name(&self.name)
            && !self.kind.is_empty()
            && self.cluster.as_deref().is_none_or(|c| !c.is_empty())
            && is_filter(&self.search)
            && is_filter(&self.label_selector)
    }
}

impl Pin {
    fn is_valid(&self) -> bool {
        is_entry_id(&self.id)
            && !self.cluster.is_empty()
            && match &self.target {
                PinTarget::Object { kind, name, .. } => !kind.is_empty() && !name.is_empty(),
                PinTarget::View { view } => is_entry_id(view),
            }
    }
}

impl Workspace {
    fn is_valid(&self) -> bool {
        is_entry_id(&self.id)
            && is_name(&self.name)
            && self.clusters.len() <= MAX_WORKSPACE_CLUSTERS
    }
}

/// Reads a list entry by entry, keeping the valid ones with distinct ids, at most `cap`.
fn read_list<'de, D, T>(
    deserializer: D,
    cap: usize,
    valid: impl Fn(&T) -> bool,
    id: impl Fn(&T) -> &str,
) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: for<'a> Deserialize<'a>,
{
    let serde_json::Value::Array(entries) = serde_json::Value::deserialize(deserializer)? else {
        return Ok(Vec::new());
    };
    let mut list: Vec<T> = Vec::new();
    for entry in entries {
        if list.len() >= cap {
            break;
        }
        let Ok(item) = serde_json::from_value::<T>(entry) else {
            continue;
        };
        if valid(&item) && !list.iter().any(|kept| id(kept) == id(&item)) {
            list.push(item);
        }
    }
    Ok(list)
}

/// `#[serde(with)]` modules of the `AppSettings` fields: written as they are, read through [`read_list`].
macro_rules! field {
    ($module:ident, $ty:ty, $read:expr) => {
        pub(crate) mod $module {
            use super::*;
            pub(crate) fn serialize<S: serde::Serializer>(
                value: &$ty,
                s: S,
            ) -> Result<S::Ok, S::Error> {
                value.serialize(s)
            }
            pub(crate) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<$ty, D::Error> {
                $read(d)
            }
        }
    };
}

field!(views_field, Vec<SavedView>, |d| read_list(
    d,
    MAX_VIEWS,
    SavedView::is_valid,
    |v: &SavedView| v.id.as_str()
));
field!(pins_field, Vec<Pin>, |d| read_list(
    d,
    MAX_PINS,
    Pin::is_valid,
    |p: &Pin| p.id.as_str()
));
field!(workspaces_field, Vec<Workspace>, |d| read_list(
    d,
    MAX_WORKSPACES,
    Workspace::is_valid,
    |w: &Workspace| w.id.as_str()
));
// An active workspace id that is not a valid id reads as none (the frontend also ignores one no workspace has).
field!(active_workspace_field, Option<String>, |d| {
    let value = serde_json::Value::deserialize(d)?;
    Ok(value
        .as_str()
        .filter(|id| is_entry_id(id))
        .map(str::to_owned))
});

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{AppSettings, SettingsStore};
    use serde_json::json;

    fn view(id: &str) -> SavedView {
        SavedView {
            id: id.to_owned(),
            name: format!("View {id}"),
            cluster: Some("c1".to_owned()),
            group: "apps".to_owned(),
            kind: "Deployment".to_owned(),
            namespaces: Some(vec!["shop".to_owned()]),
            search: "web".to_owned(),
            only_problems: true,
            label_selector: "tier=front".to_owned(),
            sort: Some(ViewSort {
                column: "age".to_owned(),
                desc: true,
            }),
            hidden_columns: vec!["images".to_owned()],
        }
    }

    #[test]
    fn views_pins_and_workspaces_are_empty_by_default_and_round_trip_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = SettingsStore::open(path.clone());
        let defaults = store.get();
        assert!(
            defaults.views.is_empty() && defaults.pins.is_empty() && defaults.workspaces.is_empty()
        );
        assert_eq!(defaults.active_workspace, None);

        let pin = Pin {
            id: "p1".to_owned(),
            cluster: "c1".to_owned(),
            target: PinTarget::Object {
                group: String::new(),
                version: "v1".to_owned(),
                kind: "Pod".to_owned(),
                namespace: Some("shop".to_owned()),
                name: "web-0".to_owned(),
            },
        };
        let view_pin = Pin {
            id: "p2".to_owned(),
            cluster: "c1".to_owned(),
            target: PinTarget::View {
                view: "v1".to_owned(),
            },
        };
        let workspace = Workspace {
            id: "prod".to_owned(),
            name: "Production".to_owned(),
            clusters: vec!["c1".to_owned()],
        };
        store
            .update(|s| {
                s.views = vec![view("v1")];
                s.pins = vec![pin.clone(), view_pin.clone()];
                s.workspaces = vec![workspace.clone()];
                s.active_workspace = Some("prod".to_owned());
            })
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["views"][0]["onlyProblems"], true);
        assert_eq!(json["views"][0]["sort"]["column"], "age");
        assert_eq!(json["pins"][0]["target"]["type"], "object");
        assert_eq!(
            json["pins"][1]["target"],
            json!({"type": "view", "view": "v1"})
        );
        assert_eq!(json["activeWorkspace"], "prod");

        let reread = SettingsStore::open(path).get();
        assert_eq!(reread.views, vec![view("v1")]);
        assert_eq!(reread.pins, vec![pin, view_pin]);
        assert_eq!(reread.workspaces, vec![workspace]);
        assert_eq!(reread.active_workspace.as_deref(), Some("prod"));
    }

    #[test]
    fn a_file_without_the_fields_reads_with_empty_lists() {
        let settings: AppSettings =
            serde_json::from_value(json!({ "theme": "dark", "fleet": { "selected": ["c1"] } }))
                .unwrap();
        assert!(
            settings.views.is_empty() && settings.pins.is_empty() && settings.workspaces.is_empty()
        );
        assert_eq!(settings.active_workspace, None);
    }

    #[test]
    fn bad_entries_are_left_out_without_failing_the_file() {
        let settings: AppSettings = serde_json::from_value(json!({
            "theme": "dark",
            "views": [
                { "id": "ok", "name": "Good", "kind": "Pod" },
                { "id": "ok", "name": "Same id", "kind": "Pod" },
                { "id": "../x", "name": "Bad id", "kind": "Pod" },
                { "id": "noname", "name": "  ", "kind": "Pod" },
                { "id": "nokind", "name": "No kind" },
                { "id": "badtype", "name": "Bad", "kind": "Pod", "onlyProblems": "yes" },
                "not an object"
            ],
            "pins": [
                { "id": "p", "cluster": "c1", "target": { "type": "unknown" } },
                { "id": "q", "cluster": "c1", "target": { "type": "view", "view": "ok" } }
            ],
            "workspaces": { "not": "a list" },
            "activeWorkspace": "../etc"
        }))
        .unwrap();
        assert_eq!(settings.theme, crate::Theme::Dark);
        assert_eq!(settings.views.len(), 1);
        assert_eq!(settings.views[0].name, "Good");
        assert_eq!(settings.pins.len(), 1);
        assert_eq!(settings.pins[0].id, "q");
        assert!(settings.workspaces.is_empty());
        assert_eq!(settings.active_workspace, None);
    }

    #[test]
    fn lists_are_capped() {
        let views: Vec<_> = (0..MAX_VIEWS + 5)
            .map(|i| json!({ "id": format!("v{i}"), "name": "x", "kind": "Pod" }))
            .collect();
        let settings: AppSettings = serde_json::from_value(json!({ "views": views })).unwrap();
        assert_eq!(settings.views.len(), MAX_VIEWS);
    }
}
