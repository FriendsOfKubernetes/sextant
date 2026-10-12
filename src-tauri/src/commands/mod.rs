//! Tauri commands. Every command is a thin wrapper over `sextant-core` and returns `Result<T, CoreError>`.
//! One file per feature; `lib.rs` registers them all.

pub mod actions;
pub mod clusters;
pub mod files;
pub mod helm;
pub mod logs;
pub mod metrics;
pub mod portforward;
pub mod resources;
pub mod secrets;
pub mod settings;
pub mod terminal;
