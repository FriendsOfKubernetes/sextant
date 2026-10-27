//! `sextant-core` — everything Sextant knows about Kubernetes clusters.
//!
//! The crate has no dependency on Tauri or any windowing toolkit, so the same core can back the desktop
//! application and a future mobile one. Anything that spawns OS processes (the `helm` binary) lives behind
//! the `desktop` feature, which is on by default.
//!
//! Every type that crosses the IPC boundary derives `ts_rs::TS`; `cargo test` regenerates the TypeScript
//! bindings (see `.cargo/config.toml` and `npm run gen:types`).

pub mod access;
pub mod alerts;
pub mod argocd;
#[cfg(feature = "desktop")]
pub mod cloud;
pub mod cluster;
pub mod compare;
pub mod cost;
pub mod debug;
pub mod error;
pub mod exec;
pub mod extensions;
#[cfg(test)]
mod fake_api;
pub mod files;
pub mod gitops_install;
pub mod helm;
pub mod image_fs;
pub mod kubeconfig;
pub mod logs;
pub mod loki;
pub mod metrics;
pub mod node_shell;
pub mod openapi;
pub mod pod_names;
pub mod portforward;
pub mod rbac;
pub mod reflector;
pub mod resources;
pub mod settings;
pub mod timeline;
pub mod tls;
pub mod upgrade;
pub mod vcluster;

pub use cluster::{ClusterManager, ConnectionState};
pub use error::{CoreError, CoreResult, ErrorCode};
pub use kubeconfig::{ClusterId, ClusterInfo, KubeconfigRegistry, KubeconfigSource, SourceKind};
pub use resources::{
    DrainOptions, DrainPreview, KindRef, ObjectRef, PodRef, PrinterColumn, ResourceKind,
    WatchObject, WatchSpec, WatchUpdate,
};
pub use settings::{AppSettings, ClusterSettings, McpSettings, SettingsStore, Theme, WindowLayout};
