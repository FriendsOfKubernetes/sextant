//! Resources of any kind (built-in and custom) handled as dynamic JSON objects.
//!
//! Types live here; `watch.rs` / `get.rs` (watch and read), `list.rs` (one-shot lists and events) and `mutate.rs`
//! (changes) hold the functions.

mod get;
mod list;
mod mutate;
mod watch;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode};

pub use get::{get, get_full, secret_value};
pub use list::{ListPage, events, list, resolve};
pub use mutate::{
    STEP_TIMEOUT, apply_yaml, cordon, delete, drain, drain_preview, patch, replace_yaml, restart,
    scale, suspend_cronjob, trigger_cronjob,
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

/// How the body of `resource_patch` is read: a JSON merge patch (RFC 7386, an object) or a JSON patch (RFC 6902, a
/// list of operations).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PatchType {
    Merge,
    Json,
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
    /// Only the `metadata` of each object (metadata-only list and watch), no `spec`, `data` or `status`: to notice
    /// changes without downloading the objects, as the Helm page does with release Secrets. Off when left out.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub metadata_only: bool,
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
    /// Some of the selected namespaces cannot be listed (no permission); the others keep streaming.
    Forbidden {
        namespaces: Vec<String>,
    },
}

/// A pod, by namespace and name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PodRef {
    pub namespace: String,
    pub name: String,
}

/// What draining a node would do with its pods (`node_drain_preview`), like `kubectl drain --dry-run`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DrainPreview {
    /// Pods that are evicted.
    pub evict: Vec<PodRef>,
    /// Pods without a controller: evicted only with `force`.
    pub unmanaged: Vec<PodRef>,
    /// Pods with `emptyDir` volumes: evicted only with `deleteEmptyDirData`.
    pub empty_dir: Vec<PodRef>,
    /// DaemonSet pods: never evicted.
    pub daemon_set: Vec<PodRef>,
}

/// Options of `node_drain`, as `kubectl drain --force --delete-emptydir-data`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DrainOptions {
    /// Also evict pods without a controller.
    pub force: bool,
    /// Also evict pods with `emptyDir` volumes (their data is lost).
    pub delete_empty_dir_data: bool,
}
