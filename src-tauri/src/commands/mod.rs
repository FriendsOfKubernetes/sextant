//! Tauri commands. Every command is a thin wrapper over `sextant-core` and returns `Result<T, CoreError>`.
//! One file per feature; `lib.rs` registers them all.

pub mod about;
pub mod access;
pub mod actions;
pub mod alerts;
pub mod argocd;
pub mod cleanup;
pub mod cloud;
pub mod clusters;
pub mod compare;
pub mod cost;
pub mod files;
pub mod fonts;
pub mod gitops_install;
pub mod helm;
pub mod image_files;
pub mod kubeconfig;
pub mod logs;
pub mod loki;
pub mod mcp;
pub mod metrics;
pub mod openapi;
pub mod portforward;
pub mod rbac;
pub mod reflector;
pub mod resources;
pub mod secrets;
pub mod set_image;
pub mod settings;
pub mod storage;
pub mod terminal;
pub mod timeline;
pub mod tls;
pub mod tray;
pub mod upgrade;
pub mod views;
