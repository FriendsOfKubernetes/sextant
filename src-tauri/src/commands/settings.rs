//! Application settings (`settings.json` in the OS config directory).

use sextant_core::{AppSettings, CoreError};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, CoreError> {
    Ok(state.settings.get())
}

/// Replaces the frontend-owned settings and returns what was saved.
///
/// Fields the backend writes itself are kept as stored, so a stale copy from the frontend cannot erase them:
/// `kubeconfigSources` (changed only by the `kubeconfig_*` commands) and the window geometry
/// (`window.width`, `window.height`, `window.maximized`, recorded on resize).
#[tauri::command]
pub async fn settings_update(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, CoreError> {
    update_settings(&state, settings)
}

pub fn update_settings(state: &AppState, settings: AppSettings) -> Result<AppSettings, CoreError> {
    state.settings.update(move |current| {
        let kubeconfig_sources = std::mem::take(&mut current.kubeconfig_sources);
        let width = current.window.width;
        let height = current.window.height;
        let maximized = current.window.maximized;
        *current = settings;
        current.kubeconfig_sources = kubeconfig_sources;
        current.window.width = width;
        current.window.height = height;
        current.window.maximized = maximized;
    })?;
    Ok(state.settings.get())
}
