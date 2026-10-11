//! Resources of any kind (built-in and custom) handled as dynamic JSON objects.
//!
//! Types live here; `watch.rs` / `get.rs` (watch and read) and `mutate.rs` (changes) hold the functions.

mod get;
mod mutate;
mod watch;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode};

pub use get::get;
pub use mutate::{
    apply_yaml, cordon, delete, drain, replace_yaml, restart, scale, suspend_cronjob,
    trigger_cronjob,
};
pub use watch::watch;

/// Group/version/kind. `group` is `""` for the core API group.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KindRef {
    pub group: String,
    pub version: String,
    pub kind: String,
}

/// A kind the cluster serves (from discovery).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ResourceKind {
    pub kind_ref: KindRef,
    pub plural: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
    /// `additionalPrinterColumns` of a CRD; empty for built-in kinds.
    pub printer_columns: Vec<PrinterColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrinterColumn {
    pub name: String,
    pub json_path: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub priority: i32,
}

/// Points to one object.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ObjectRef {
    pub kind: KindRef,
    pub namespace: Option<String>,
    pub name: String,
}

impl ObjectRef {
    /// The namespace of an object of a namespaced kind; without one the reference is `invalid`, with the same text
    /// for every function that takes an `ObjectRef` (read, change, logs, exec).
    pub(crate) fn required_namespace(&self) -> CoreResult<&str> {
        self.namespace
            .as_deref()
            .filter(|ns| !ns.is_empty())
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::Invalid,
                    format!("{} {} needs a namespace", self.kind.kind, self.name),
                )
            })
    }
}

/// What to watch. `namespaces: None` means all namespaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WatchSpec {
    pub kind: KindRef,
    pub namespaces: Option<Vec<String>>,
    pub label_selector: Option<String>,
    pub field_selector: Option<String>,
}

/// One batch of a watch subscription. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum WatchUpdate {
    /// Full list (first batch and after every relist).
    Snapshot {
        items: Vec<serde_json::Value>,
    },
    /// Changes since the previous batch; `deleted` holds uids.
    Delta {
        upserted: Vec<serde_json::Value>,
        deleted: Vec<String>,
    },
    Reconnecting,
    Error(CoreError),
}
