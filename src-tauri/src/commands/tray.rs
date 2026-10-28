//! The tray icon, as far as the window needs to know: whether it exists (Settings offers "keep in the tray" only then),
//! and the texts of its menu in the window's UI language; and closing the window from the window itself.

use serde::{Deserialize, Serialize};
use sextant_core::CoreError;
use tauri::{AppHandle, Runtime};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrayStatus {
    /// The tray icon was created and (on Linux) a StatusNotifier host or an X11 system tray shows it; without it closing the window quits.
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

/// The tray menu's texts, the keys of `src/locales/<language>/tray.json`. The window sends them in its UI language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrayTexts {
    pub show: String,
    pub hide: String,
    pub about: String,
    pub quit: String,
    pub tooltip: String,
}

/// Relabels the tray menu (and the icon's tooltip) in the window's UI language; an empty text stays English. Without
/// an icon only the texts are kept.
#[tauri::command]
pub fn tray_set_texts<R: Runtime>(app: AppHandle<R>, texts: TrayTexts) -> Result<(), CoreError> {
    crate::tray::set_texts(&app, &texts);
    Ok(())
}

/// Closes the window as its close button does (keep in the tray decides): Cmd+W of the macOS app menu when the window
/// has no dock tab to close.
#[tauri::command]
pub fn window_close<R: Runtime>(app: AppHandle<R>) -> Result<(), CoreError> {
    crate::window::close_main(&app);
    Ok(())
}
