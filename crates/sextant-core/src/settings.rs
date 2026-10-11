//! Application settings stored as JSON on disk. The application decides the path (`app_config_dir`).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::KubeconfigSource;
use crate::metrics::{PrometheusMode, UsageSource};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Theme {
    /// Follow the OS theme.
    #[default]
    System,
    Light,
    Dark,
}

/// Per-cluster settings, keyed by `ClusterId` in [`AppSettings::clusters`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct ClusterSettings {
    pub display_name: Option<String>,
    pub color: Option<String>,
    /// Selected namespaces; `None` = all namespaces.
    pub namespaces: Option<Vec<String>>,
    /// Last opened sidebar view.
    pub last_view: Option<String>,
    pub prometheus: PrometheusMode,
    pub usage_source: UsageSource,
}

/// Window geometry and panel sizes, restored on start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct WindowLayout {
    pub sidebar_width: u32,
    pub dock_height: u32,
    pub dock_open: bool,
    pub last_cluster: Option<String>,
    /// Logical window size; written by the application when the window is resized.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub maximized: bool,
}

impl Default for WindowLayout {
    fn default() -> Self {
        Self {
            sidebar_width: 220,
            dock_height: 300,
            dock_open: false,
            last_cluster: None,
            width: None,
            height: None,
            maximized: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct AppSettings {
    pub theme: Theme,
    /// Language code, a directory name under `src/locales/`.
    pub language: String,
    /// Kubeconfig files the user added or pasted (not `KUBECONFIG` / `~/.kube/config`).
    pub kubeconfig_sources: Vec<KubeconfigSource>,
    pub clusters: HashMap<String, ClusterSettings>,
    pub window: WindowLayout,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            language: "en".to_owned(),
            kubeconfig_sources: Vec::new(),
            clusters: HashMap::new(),
            window: WindowLayout::default(),
        }
    }
}

/// Settings file with an in-memory copy. Writes are atomic (temp file + rename).
/// A file that cannot be parsed is moved aside to `<name>.bak` and defaults are used.
pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<AppSettings>,
}

impl SettingsStore {
    pub fn open(path: PathBuf) -> Self {
        let current = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<AppSettings>(&text) {
                Ok(settings) => settings,
                Err(_) => {
                    // Keep the broken file for the user, start from defaults.
                    let _ = std::fs::rename(&path, backup_path(&path));
                    AppSettings::default()
                }
            },
            Err(_) => AppSettings::default(),
        };
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn get(&self) -> AppSettings {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Applies `f` and writes the result. On a write error the in-memory copy stays unchanged.
    pub fn update(&self, f: impl FnOnce(&mut AppSettings)) -> CoreResult<()> {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = current.clone();
        f(&mut next);
        write_atomic(&self.path, &next)?;
        *current = next;
        Ok(())
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".bak");
    path.with_file_name(name)
}

fn write_atomic(path: &Path, settings: &AppSettings) -> CoreResult<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| CoreError::other(format!("invalid settings path: {}", path.display())))?;
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(settings)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(&json)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| CoreError::from(e.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &tempfile::TempDir) -> (PathBuf, SettingsStore) {
        let path = dir.path().join("settings.json");
        (path.clone(), SettingsStore::open(path))
    }

    #[test]
    fn missing_file_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let (_, store) = store_in(&dir);
        let s = store.get();
        assert_eq!(s.theme, Theme::System);
        assert_eq!(s.language, "en");
        assert!(s.kubeconfig_sources.is_empty());
        assert_eq!(s.window.sidebar_width, 220);
        assert!(!s.window.dock_open);
    }

    #[test]
    fn update_persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let (path, store) = store_in(&dir);
        store
            .update(|s| {
                s.theme = Theme::Dark;
                s.window.sidebar_width = 312;
                s.window.dock_open = true;
                s.window.dock_height = 410;
                s.window.width = Some(1400);
                s.clusters.insert(
                    "abc".to_owned(),
                    ClusterSettings {
                        display_name: Some("prod".to_owned()),
                        ..Default::default()
                    },
                );
            })
            .unwrap();
        assert_eq!(store.get().theme, Theme::Dark);

        let reopened = SettingsStore::open(path);
        let s = reopened.get();
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.window.sidebar_width, 312);
        assert!(s.window.dock_open);
        assert_eq!(s.window.dock_height, 410);
        assert_eq!(s.window.width, Some(1400));
        assert_eq!(s.clusters["abc"].display_name.as_deref(), Some("prod"));
    }

    #[test]
    fn file_uses_camel_case_keys() {
        let dir = tempfile::tempdir().unwrap();
        let (path, store) = store_in(&dir);
        store.update(|s| s.window.dock_height = 123).unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["window"]["dockHeight"], 123);
        assert_eq!(json["theme"], "system");
        assert!(json.get("kubeconfigSources").is_some());
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults_and_is_kept_as_bak() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ this is not json").unwrap();

        let store = SettingsStore::open(path.clone());
        assert_eq!(store.get(), AppSettings::default());

        let bak = dir.path().join("settings.json.bak");
        assert_eq!(std::fs::read_to_string(bak).unwrap(), "{ this is not json");
        assert!(!path.exists(), "the corrupt file is moved aside");

        // The store keeps working after recovery.
        store.update(|s| s.theme = Theme::Light).unwrap();
        assert_eq!(SettingsStore::open(path).get().theme, Theme::Light);
    }

    #[test]
    fn partial_file_fills_missing_fields_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{ "theme": "dark", "window": { "dockOpen": true } }"#,
        )
        .unwrap();
        let s = SettingsStore::open(path).get();
        assert_eq!(s.theme, Theme::Dark);
        assert!(s.window.dock_open);
        assert_eq!(s.window.dock_height, 300);
        assert_eq!(s.language, "en");
    }

    #[test]
    fn update_creates_missing_directories_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir
            .path()
            .join("nested")
            .join("config")
            .join("settings.json");
        let store = SettingsStore::open(path.clone());
        store.update(|s| s.language = "en".to_owned()).unwrap();
        assert!(path.exists());
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["settings.json".to_owned()]);
    }
}
