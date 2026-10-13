//! Where Sextant keeps its files, found without Tauri: `sextant mcp` runs before (and without) the application, but
//! must read the same `settings.json` and `mcp-token`. The rule is Tauri's own (`app_config_dir`, `app_data_dir`):
//! the OS directory joined with the bundle identifier.

use std::path::{Path, PathBuf};

/// The bundle identifier (`identifier` in `tauri.conf.json`).
pub const IDENTIFIER: &str = "dev.sextant.app";

/// Name of the token file in the config directory.
pub const TOKEN_FILE: &str = "mcp-token";

/// Name of the settings file in the config directory.
pub const SETTINGS_FILE: &str = "settings.json";

/// Tauri's `app_config_dir()`: `settings.json` and `mcp-token` live here.
pub fn config_dir() -> PathBuf {
    os_dir(dirs::config_dir()).join(IDENTIFIER)
}

/// Tauri's `app_data_dir()`: pasted kubeconfigs and `mcp-audit.jsonl` live here.
pub fn data_dir() -> PathBuf {
    os_dir(dirs::data_dir()).join(IDENTIFIER)
}

/// The token file in a config directory.
pub fn token_path(config_dir: &Path) -> PathBuf {
    config_dir.join(TOKEN_FILE)
}

/// The settings file in a config directory.
pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE)
}

/// An OS directory, or the current directory when the OS gives none (no home directory at all) — Tauri fails then,
/// so the application never starts with such a directory either.
fn os_dir(dir: Option<PathBuf>) -> PathBuf {
    dir.unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use tauri::Manager;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    use super::*;

    #[test]
    fn the_identifier_is_the_one_tauri_builds_with() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
        // An override would move Tauri's directories away from the rule repeated here.
        assert!(config["app"].get("appDirectoriesOverride").is_none());
    }

    #[test]
    fn the_directories_are_the_ones_tauri_resolves() {
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = IDENTIFIER.to_owned();
        let app = mock_builder().build(context).unwrap();
        let paths = app.path();
        assert_eq!(paths.app_config_dir().unwrap(), config_dir());
        assert_eq!(paths.app_data_dir().unwrap(), data_dir());
        assert_eq!(
            token_path(&paths.app_config_dir().unwrap()),
            config_dir().join("mcp-token")
        );
    }
}
