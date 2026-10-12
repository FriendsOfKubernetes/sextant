//! Application settings stored as JSON on disk. The application decides the path (`app_config_dir`).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode};
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
    /// The `helm` binary chosen in Settings; `None` = look `helm` up in `PATH`.
    pub helm_path: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            language: "en".to_owned(),
            kubeconfig_sources: Vec::new(),
            clusters: HashMap::new(),
            window: WindowLayout::default(),
            helm_path: None,
        }
    }
}

/// How the settings file was found when the store was opened (`settings_status`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsFileStatus {
    /// `false` when changes are kept in memory only: the file could not be read, or it is read-only.
    pub writable: bool,
    /// Where a file that did not parse was copied to before anything was written over it.
    pub backup_path: Option<PathBuf>,
    /// Why the file could not be used (read, parsed or written); names the file.
    pub error: Option<CoreError>,
}

impl SettingsFileStatus {
    fn healthy() -> Self {
        Self {
            writable: true,
            backup_path: None,
            error: None,
        }
    }
}

/// Settings file with an in-memory copy. Writes are atomic (temp file + rename).
///
/// What the user saved is never lost silently:
/// - a file that does not parse is first copied to `<name>.bak-<YYYYMMDD-HHMMSS>` (UTC; an existing copy is never
///   replaced), then defaults are used and saved over it;
/// - a file that cannot be read (no permission, a directory, an I/O error) or is read-only is never written:
///   changes stay in memory for this session;
/// - if the copy cannot be made, the file is not written either.
///
/// [`SettingsStore::status`] tells which of these happened.
pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<AppSettings>,
    status: SettingsFileStatus,
}

impl SettingsStore {
    pub fn open(path: PathBuf) -> Self {
        let (current, status) = load(&path);
        Self {
            path,
            current: Mutex::new(current),
            status,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether the file was usable when the store was opened and whether changes are written.
    pub fn status(&self) -> SettingsFileStatus {
        self.status.clone()
    }

    pub fn get(&self) -> AppSettings {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Applies `f` and writes the result. On a write error the in-memory copy stays unchanged. When the store is not
    /// writable ([`SettingsFileStatus::writable`]), only the in-memory copy changes.
    pub fn update(&self, f: impl FnOnce(&mut AppSettings)) -> CoreResult<()> {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = current.clone();
        f(&mut next);
        if self.status.writable {
            write_atomic(&self.path, &next)?;
        }
        *current = next;
        Ok(())
    }
}

/// Reads the settings file and decides whether it may be written.
fn load(path: &Path) -> (AppSettings, SettingsFileStatus) {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return (AppSettings::default(), SettingsFileStatus::healthy());
        }
        Err(err) => {
            let error = CoreError::new(
                io_code(&err),
                format!(
                    "cannot read {}: {err}; changes are not saved",
                    path.display()
                ),
            );
            return (AppSettings::default(), not_writable(error));
        }
    };
    let read_only = std::fs::metadata(path).is_ok_and(|m| m.permissions().readonly());
    let read_only_error = || {
        CoreError::new(
            ErrorCode::Forbidden,
            format!("{} is read-only; changes are not saved", path.display()),
        )
    };
    match serde_json::from_slice::<AppSettings>(&bytes) {
        Ok(settings) if read_only => (settings, not_writable(read_only_error())),
        Ok(settings) => (settings, SettingsFileStatus::healthy()),
        Err(parse) => {
            let status = match write_backup(path, &bytes) {
                Ok(backup) => SettingsFileStatus {
                    writable: !read_only,
                    error: Some(CoreError::new(
                        ErrorCode::Invalid,
                        format!(
                            "{} is not valid ({parse}); it was copied to {} and defaults are used",
                            path.display(),
                            backup.display()
                        ),
                    )),
                    backup_path: Some(backup),
                },
                Err(err) => not_writable(CoreError::new(
                    ErrorCode::Invalid,
                    format!(
                        "{} is not valid ({parse}) and could not be copied aside ({err}); changes are not saved",
                        path.display()
                    ),
                )),
            };
            (AppSettings::default(), status)
        }
    }
}

fn not_writable(error: CoreError) -> SettingsFileStatus {
    SettingsFileStatus {
        writable: false,
        backup_path: None,
        error: Some(error),
    }
}

fn io_code(err: &std::io::Error) -> ErrorCode {
    match err.kind() {
        std::io::ErrorKind::PermissionDenied => ErrorCode::Forbidden,
        _ => CoreError::from(std::io::Error::from(err.kind())).code,
    }
}

/// Copies `bytes` to `<name>.bak-<UTC time>` next to `path`, adding `-2`, `-3`, … when that name is taken. The name
/// is claimed with `create_new`, so an existing copy is never replaced, also by another Sextant at the same moment.
fn write_backup(path: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "settings.json".to_owned());
    let stamp = utc_stamp(std::time::SystemTime::now());
    for attempt in 1..1000 {
        let candidate = if attempt == 1 {
            path.with_file_name(format!("{name}.bak-{stamp}"))
        } else {
            path.with_file_name(format!("{name}.bak-{stamp}-{attempt}"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.sync_all()?;
                return Ok(candidate);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "too many backups with the same time",
    ))
}

/// `YYYYMMDD-HHMMSS` in UTC (file-name safe on every OS).
fn utc_stamp(time: std::time::SystemTime) -> String {
    let secs = time
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian calendar (H. Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
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

    /// Names of the files in `dir` that start with `settings.json.bak-`, sorted.
    fn backups(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.starts_with("settings.json.bak-"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn healthy_or_missing_file_is_writable_without_error() {
        let dir = tempfile::tempdir().unwrap();
        let (path, store) = store_in(&dir);
        assert_eq!(
            store.status(),
            SettingsFileStatus {
                writable: true,
                backup_path: None,
                error: None
            }
        );
        store.update(|s| s.theme = Theme::Dark).unwrap();
        assert!(SettingsStore::open(path).status().writable);
    }

    #[test]
    fn corrupt_file_is_copied_to_a_timestamped_backup_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ this is not json").unwrap();

        let store = SettingsStore::open(path.clone());
        assert_eq!(store.get(), AppSettings::default());
        let status = store.status();
        let bak = status.backup_path.clone().expect("a backup is made");
        assert_eq!(bak.parent(), Some(dir.path()));
        let name = bak.file_name().unwrap().to_string_lossy().into_owned();
        // settings.json.bak-YYYYMMDD-HHMMSS (UTC), no characters Windows forbids in file names.
        let stamp = name.strip_prefix("settings.json.bak-").unwrap();
        assert_eq!(stamp.len(), 15, "{name}");
        assert!(
            stamp.chars().enumerate().all(|(i, c)| if i == 8 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }),
            "{name}"
        );
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), "{ this is not json");
        assert_eq!(status.error.map(|e| e.code), Some(ErrorCode::Invalid));
        assert!(status.writable, "the content is safe in the backup");

        // The store keeps working after recovery.
        store.update(|s| s.theme = Theme::Light).unwrap();
        assert_eq!(SettingsStore::open(path).get().theme, Theme::Light);
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), "{ this is not json");
    }

    #[test]
    fn backup_stamp_is_the_utc_time() {
        // Reference values: `date -u -d '<time>' +%s`.
        let at = |secs| utc_stamp(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs));
        assert_eq!(at(1_791_819_012), "20261012-153012");
        assert_eq!(at(951_868_799), "20000229-235959");
        assert_eq!(at(946_598_400), "19991231-000000");
    }

    #[test]
    fn a_second_corruption_does_not_overwrite_the_first_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "first broken").unwrap();
        let first = SettingsStore::open(path.clone())
            .status()
            .backup_path
            .unwrap();

        // Broken again within the same second: the time stamp alone would collide.
        std::fs::write(&path, "second broken").unwrap();
        let second = SettingsStore::open(path.clone())
            .status()
            .backup_path
            .unwrap();

        assert_ne!(first, second);
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "first broken");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "second broken");
        assert_eq!(backups(dir.path()).len(), 2);
    }

    #[test]
    fn read_only_file_is_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let text = r#"{ "theme": "dark" }"#;
        std::fs::write(&path, text).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&path, perms.clone()).unwrap();

        let store = SettingsStore::open(path.clone());
        assert_eq!(store.get().theme, Theme::Dark);
        let status = store.status();
        assert!(!status.writable);
        assert!(status.error.is_some());
        assert_eq!(status.backup_path, None);

        // Changes live in memory for this session; the file stays as it was.
        store.update(|s| s.theme = Theme::Light).unwrap();
        assert_eq!(store.get().theme, Theme::Light);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        assert!(backups(dir.path()).is_empty());

        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&path, perms).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_is_never_written_and_not_copied() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let text = r#"{ "theme": "dark", "helmPath": "/opt/helm" }"#;
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&path).is_ok() {
            eprintln!("skipped: running as a user that ignores file permissions (root)");
            return;
        }

        let store = SettingsStore::open(path.clone());
        let status = store.status();
        assert!(!status.writable);
        assert_eq!(status.backup_path, None);
        let error = status.error.expect("the read error is reported");
        assert!(
            error.message.contains(&path.display().to_string()),
            "names the file: {error}"
        );

        store.update(|s| s.theme = Theme::Light).unwrap();
        assert_eq!(store.get().theme, Theme::Light);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        assert!(backups(dir.path()).is_empty());
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
