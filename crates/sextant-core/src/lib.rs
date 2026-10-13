//! `sextant-core` — everything Sextant knows about Kubernetes clusters.
//!
//! The crate has no dependency on Tauri or any windowing toolkit, so the same core can back the desktop
//! application and a future mobile one. Anything that spawns OS processes (the `helm` binary) lives behind
//! the `desktop` feature, which is on by default.
//!
//! Every type that crosses the IPC boundary derives `ts_rs::TS`; `cargo test` regenerates the TypeScript
//! bindings (see `.cargo/config.toml` and `npm run gen:types`).

pub mod access;
pub mod argocd;
#[cfg(feature = "desktop")]
pub mod cloud;
pub mod cluster;
pub mod error;
pub mod exec;
#[cfg(test)]
mod fake_api;
pub mod helm;
pub mod kubeconfig;
pub mod logs;
pub mod metrics;
pub mod portforward;
pub mod resources;
pub mod settings;

pub use cluster::{ClusterManager, ConnectionState};
pub use error::{CoreError, CoreResult, ErrorCode};
pub use kubeconfig::{ClusterId, ClusterInfo, KubeconfigRegistry, KubeconfigSource, SourceKind};
pub use resources::{
    DrainOptions, DrainPreview, KindRef, ObjectRef, PodRef, PrinterColumn, ResourceKind, WatchSpec,
    WatchUpdate,
};
pub use settings::{AppSettings, ClusterSettings, McpSettings, SettingsStore, Theme, WindowLayout};
