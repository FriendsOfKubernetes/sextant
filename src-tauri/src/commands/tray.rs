//! The tray icon, as far as the window needs to know: whether it exists (Settings offers "keep in the tray" only then).

use serde::Serialize;
use sextant_core::CoreError;
use tauri::{AppHandle, Runtime};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrayStatus {
    /// The tray icon was created and (on Linux) a StatusNotifier host shows it; without it closing the window quits.
    pub available: bool,
}

#[tauri::command]
pub async fn tray_status<R: Runtime>(app: AppHandle<R>) -> Result<TrayStatus, CoreError> {
    // On Linux this asks the session bus (blocking, up to about a second): off the async runtime.
    let available = tauri::async_runtime::spawn_blocking(move || crate::tray::available(&app))
        .await
        .unwrap_or(false);
    Ok(TrayStatus { available })
}
