//! Application settings (`settings.json` in the OS config directory).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sextant_core::{AppSettings, CoreError};
use tauri::State;
use ts_rs::TS;

use crate::state::AppState;

/// Whether the settings file could be read and is being saved (`settings_status`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SettingsStatus {
    /// `false` when changes are not written (the file could not be read, is read-only, or a test write next to it
    /// failed, e.g. a directory owned by root); they last for the session. `error` says why.
    pub writable: bool,
    /// Where the unreadable file was copied to, if it was.
    pub backup_path: Option<PathBuf>,
    /// Why the file could not be read or written.
    pub error: Option<CoreError>,
}

/// How `settings.json` was found at start: a file that did not parse was copied aside (`backupPath`), one that
/// cannot be read, is read-only or sits where nothing can be written is not written (`writable: false`).
#[tauri::command]
pub async fn settings_status(state: State<'_, AppState>) -> Result<SettingsStatus, CoreError> {
    let status = state.settings.status();
    Ok(SettingsStatus {
        writable: status.writable,
        backup_path: status.backup_path,
        error: status.error,
    })
}

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, CoreError> {
    Ok(state.settings.get())
}

/// Replaces the frontend-owned settings and returns what was saved.
///
/// Fields the backend writes itself are kept as stored, so a stale copy from the frontend cannot erase them:
/// `kubeconfigSources` (changed only by the `kubeconfig_*` commands), the window geometry (`window.width`,
/// `window.height`, `window.maximized`, recorded on resize) and `extensions` (changed only by the `extension_*`
/// commands).
///
/// The MCP server follows the saved `mcp` (started, stopped or moved to the new port) before this returns.
#[tauri::command]
pub async fn settings_update(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, CoreError> {
    let saved = update_settings(&state, settings)?;
    state.mcp.apply_settings(&saved).await;
    Ok(saved)
}

pub fn update_settings(state: &AppState, settings: AppSettings) -> Result<AppSettings, CoreError> {
    state
        .settings
        .update(move |current| *current = from_frontend(current, settings))?;
    Ok(state.settings.get())
}

/// What to store when the frontend saves `incoming` over `stored`: its own fields, with the ones the backend writes
/// taken from `stored`.
fn from_frontend(stored: &AppSettings, mut incoming: AppSettings) -> AppSettings {
    incoming.kubeconfig_sources = stored.kubeconfig_sources.clone();
    incoming.window.width = stored.window.width;
    incoming.window.height = stored.window.height;
    incoming.window.maximized = stored.window.maximized;
    // Installed extensions and their granted permissions change only through the extension commands: the frontend
    // can neither lose them with a stale copy nor enable or widen one.
    incoming.extensions = stored.extensions.clone();
    incoming
}

#[cfg(test)]
mod tests {
    use super::*;
    use sextant_core::extensions::{ExtensionPermissions, ExtensionSource, InstalledExtension};

    fn installed(id: &str) -> InstalledExtension {
        InstalledExtension {
            id: id.to_owned(),
            version: "1.0.0".to_owned(),
            name: id.to_owned(),
            source: ExtensionSource::File {
                name: format!("{id}.sextant-ext"),
            },
            enabled: true,
            granted: ExtensionPermissions::none(),
            installed_at: 1,
            granted_backend: None,
            granted_problems: None,
        }
    }

    #[test]
    fn a_stale_frontend_copy_keeps_the_installed_extensions_written_by_the_backend() {
        // The frontend read the settings before the backend installed an extension.
        let stale = AppSettings::default();
        let mut stored = stale.clone();
        stored.extensions.push(installed("widgets"));

        let mut incoming = stale.clone();
        incoming.theme = sextant_core::Theme::Dark;
        let saved = from_frontend(&stored, incoming);
        assert_eq!(saved.theme, sextant_core::Theme::Dark);
        assert_eq!(saved.extensions, vec![installed("widgets")]);
    }

    #[test]
    fn the_frontend_cannot_add_enable_or_widen_an_extension() {
        let mut stored = AppSettings::default();
        let mut disabled = installed("widgets");
        disabled.enabled = false;
        stored.extensions.push(disabled.clone());

        let mut incoming = stored.clone();
        incoming.extensions[0].enabled = true;
        incoming.extensions[0].granted.clusters = sextant_core::extensions::ClusterScope::All;
        incoming.extensions.push(installed("sneaky"));
        let saved = from_frontend(&stored, incoming);
        assert_eq!(saved.extensions, vec![disabled]);
    }

    #[test]
    fn backend_written_fields_survive_and_frontend_fields_change() {
        let mut stored = AppSettings::default();
        stored.window.width = Some(1500);
        stored.window.maximized = true;
        let mut incoming = AppSettings::default();
        incoming.window.dock_open = true;
        let saved = from_frontend(&stored, incoming);
        assert_eq!(saved.window.width, Some(1500));
        assert!(saved.window.maximized);
        assert!(saved.window.dock_open);
    }
}
