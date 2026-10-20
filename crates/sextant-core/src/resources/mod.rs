//! Resources of any kind (built-in and custom) handled as dynamic JSON objects.
//!
//! Types live here; `watch.rs` / `get.rs` (watch and read), `list.rs` (one-shot lists and events) and `mutate.rs`
//! (changes) hold the functions; `rollouts.rs` the rollout history and `kubectl rollout undo`.

mod cluster_check;
mod create;
mod dry_run;
mod get;
mod list;
mod mutate;
pub mod rollouts;
mod sample;
pub mod set_image;
mod status_patch;
mod watch;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode};

pub use cluster_check::{ClusterCheck, NamedObject, UnreadKind, cluster_check};
pub use create::create_yaml;
pub use dry_run::{
    DryRunChange, DryRunMode, DryRunObject, DryRunResult, FieldChange, SecretKeyChanges,
    dry_run_patch, dry_run_planned, dry_run_yaml, field_changes,
};
pub(crate) use dry_run::{secret_key_changes, secret_values};
pub(crate) use get::hide_secret_values;
pub(crate) use get::resolve_kind;
pub use get::{get, get_full, secret_value};
pub use list::{ListPage, ObjectCount, count, events, list, resolve};
pub use mutate::{
    ApplyTarget, Document, STEP_TIMEOUT, apply_planned, apply_yaml, cordon, delete, drain,
    drain_preview, parse_documents, patch, plan_apply, replace_yaml, restart, scale,
    suspend_cronjob, trigger_cronjob,
};
pub use mutate::{DeletePreconditions, delete_with};
pub use mutate::{IMMUTABLE_SECRET, SecretWrites, apply_planned_with, patch_with};
pub use sample::{KindSample, MAX_SAMPLE, MAX_SAMPLED_KINDS, SampledObject, sample_namespace};
pub use status_patch::{STATUS_PATCH_KINDS, patch_status};
pub use watch::{watch, watch_with_options};

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

/// How the window wants a watch delivered (#157). The defaults are what agents and extensions get: the whole list in
/// one `Snapshot`, every object kept.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct WatchOptions {
    /// The first list reaches the window in parts as its pages come in (`SnapshotPart` … `SnapshotEnd`), so the first
    /// rows show before a list of thousands of objects is complete. Later relists still send one `Snapshot`.
    pub progressive: bool,
    /// Keep (and send) at most this many objects; the others are counted by uid only, and `Capped` says how many
    /// match in all. `None` keeps every object.
    #[ts(optional)]
    pub max_objects: Option<u32>,
}

/// One batch of a watch subscription. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum WatchUpdate {
    /// Full list (first batch and after every relist). The objects are shared with the watch's store (`Arc`), not
    /// copied: a snapshot of a large list costs pointers, and the JSON is the same as of plain values.
    Snapshot {
        items: Vec<Arc<serde_json::Value>>,
    },
    /// Changes since the previous batch; `deleted` holds uids. Shared with the store like a snapshot's items.
    Delta {
        upserted: Vec<Arc<serde_json::Value>>,
        deleted: Vec<String>,
    },
    Reconnecting,
    Error(CoreError),
    /// Some of the selected namespaces cannot be listed (no permission); the others keep streaming.
    Forbidden {
        namespaces: Vec<String>,
    },
    /// Objects of the first list that came in since the previous part, while the list still runs (only with
    /// `WatchOptions::progressive`). Parts add up; a `SnapshotEnd` completes them.
    SnapshotPart {
        items: Vec<Arc<serde_json::Value>>,
    },
    /// The end of a list sent in parts: the parts, without the uids in `deleted` and with `items` added or replacing
    /// their earlier copies, are the full list a `Snapshot` would have carried.
    SnapshotEnd {
        items: Vec<Arc<serde_json::Value>>,
        deleted: Vec<String>,
    },
    /// The watch keeps only `WatchOptions::max_objects` objects and `total` match in all. Sent after the batch in which
    /// the total changed; a `total` within the cap means nothing is left out any more.
    Capped {
        total: u64,
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
    /// Never evict node shell pods ([`crate::node_shell::is_node_shell_object`]), whatever the other options: they
    /// stay on the node and the drain names them. Set only by the backend for agents (MCP); never read from or sent
    /// to the frontend.
    #[serde(skip)]
    #[ts(skip)]
    pub keep_node_shells: bool,
}
