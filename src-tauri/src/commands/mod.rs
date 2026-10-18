//! Tauri commands. Every command is a thin wrapper over `sextant-core` and returns `Result<T, CoreError>`.
//! One file per feature; `lib.rs` registers them all.

pub mod about;
pub mod access;
pub mod actions;
pub mod argocd;
pub mod cloud;
pub mod clusters;
pub mod files;
pub mod gitops_install;
pub mod helm;
pub mod logs;
pub mod mcp;
pub mod metrics;
pub mod portforward;
pub mod rbac;
pub mod resources;
pub mod secrets;
pub mod settings;
pub mod terminal;
pub mod tls;
pub mod tray;
