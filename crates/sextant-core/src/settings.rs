//! Application settings stored as JSON on disk. The application decides the path (`app_config_dir`).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::access::ClusterAccess;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::extensions::InstalledExtension;
use crate::kubeconfig::KubeconfigSource;
use crate::metrics::{PrometheusMode, UsageSource};

pub mod views;
pub use views::{Pin, PinTarget, SavedView, ViewSort, Workspace};
pub mod snippets;
pub use snippets::Snippet;
pub mod compare;
pub use compare::CompareSettings;

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

/// Per-cluster settings, keyed by `ClusterId` in [`AppSettings::clusters`]. `Deserialize` is written by hand
/// (below) so that an `agentAccess` this version cannot read is kept.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, TS)]
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
    /// The user's own icon in the cluster rail; `None` = initials of the name on the label color. Owned by the
    /// frontend, like `color`.
    pub icon: Option<ClusterIcon>,
    /// What an AI agent connected through the MCP server may do in this cluster; closed by default. Owned by the
    /// frontend; the MCP server reads it fresh on every call.
    pub agent_access: ClusterAccess,
    /// The `agentAccess` value this version could not read (written by a newer Sextant or edited by hand), kept as
    /// found. While it is set, `agent_access` is the default (Off), so nothing is allowed; the file gets the original
    /// value back under `agentAccess` on every write, until the user resets the access or chooses a set. Owned by the
    /// frontend, like `agent_access`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub agent_access_unrecognised: Option<serde_json::Value>,
    /// The namespace of the Argo CD installation the user chose when several namespaces looked like one. Owned by
    /// the frontend; the backend takes it only when it is one of the candidates it found itself (ADR-0032). Left out
    /// of the file when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub argocd_namespace: Option<String>,
    /// "Preview changes before applying" (#141): the editor's save, Apply YAML and a Helm upgrade or install show the
    /// server's dry run first. `None` follows the cluster's name (on for a production-looking name, see the frontend's
    /// `previewByDefault`). Owned by the frontend; left out of the file when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub preview_changes: Option<bool>,
}

/// `ClusterSettings` as stored, with `agentAccess` still unread.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct StoredClusterSettings {
    display_name: Option<String>,
    color: Option<String>,
    namespaces: Option<Vec<String>>,
    last_view: Option<String>,
    prometheus: PrometheusMode,
    usage_source: UsageSource,
    icon: Option<ClusterIcon>,
    agent_access: Option<serde_json::Value>,
    agent_access_unrecognised: Option<serde_json::Value>,
    argocd_namespace: Option<String>,
    preview_changes: Option<bool>,
}

impl<'de> Deserialize<'de> for ClusterSettings {
    /// An `agentAccess` that does not read strictly ([`ClusterAccess::parse_strict`]) acts as Off and its JSON is kept
    /// in `agent_access_unrecognised`. A kept value always wins over `agentAccess` beside it: the frontend clears it
    /// by sending `agentAccess` alone, so a stale or forged pair can never open access.
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let stored = StoredClusterSettings::deserialize(deserializer)?;
        let (agent_access, agent_access_unrecognised) =
            match (stored.agent_access_unrecognised, stored.agent_access) {
                (Some(kept), _) => (ClusterAccess::default(), Some(kept)),
                (None, None) => (ClusterAccess::default(), None),
                (None, Some(raw)) => match ClusterAccess::parse_strict(&raw) {
                    Some(access) => (access, None),
                    None => (ClusterAccess::default(), Some(raw)),
                },
            };
        Ok(Self {
            display_name: stored.display_name,
            color: stored.color,
            namespaces: stored.namespaces,
            last_view: stored.last_view,
            prometheus: stored.prometheus,
            usage_source: stored.usage_source,
            icon: stored.icon,
            agent_access,
            agent_access_unrecognised,
            argocd_namespace: stored.argocd_namespace,
            preview_changes: stored.preview_changes,
        })
    }
}

/// A cluster's own rail icon (`ClusterSettings::icon`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ClusterIcon {
    /// One or two letters or an emoji on the label color.
    Text { text: String },
    /// A picture chosen from disk, already shrunk to a 96×96 PNG by the frontend: `data:image/png;base64,…`.
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
}

/// Port the MCP server listens on by default (on 127.0.0.1).
pub const DEFAULT_MCP_PORT: u16 = 47391;

/// The built-in MCP server for AI agents (Settings → AI agents (MCP)). Owned by the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct McpSettings {
    /// The server runs while Sextant is open; off by default.
    pub enabled: bool,
    /// Port on 127.0.0.1.
    pub port: u16,
}

impl Default for McpSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_MCP_PORT,
        }
    }
}

/// Desktop notifications about new problems in connected clusters (Settings → General → Notifications). Owned by
/// the frontend, which watches only the clusters that are already connected (it never connects one for
/// notifications) and only the categories that are on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct NotificationSettings {
    /// The global switch; on by default.
    pub enabled: bool,
    /// Problem categories turned off (`pods`, `nodes`, …). Kept as text, so a category another version knows never
    /// damages the file; an unknown one is ignored.
    pub disabled_categories: Vec<String>,
    /// Clusters (ids) that never notify.
    pub muted_clusters: Vec<String>,
    /// "Mute for 1 hour": nothing is shown until this RFC 3339 time.
    pub muted_until: Option<String>,
    /// How many days before it expires a certificate (a TLS Secret's, a cert-manager Certificate's) is shown as
    /// expiring in its details and in the TLS certificates list; 14 by default. Written by the frontend, which
    /// clamps it to 1..=365.
    pub cert_expiry_days: u32,
    /// Opt-in problem categories turned on (`security`, #143): unlike the others they are off until the user turns
    /// them on, so a new category of this kind never starts notifying after an update. One setting for the problems
    /// screen, the sidebar counter and the notifications. Kept as text like `disabled_categories`; an unknown one is
    /// ignored.
    pub enabled_categories: Vec<String>,
    /// The opt-in category "disk almost full" (#152): a claim counts as almost full from this percent of its bytes
    /// or inodes used; 85 by default. Written by the frontend, which clamps it to 50..=99.
    pub volume_warn_percent: u32,
    /// …and as critically full from this one; 95 by default, never below the warning.
    pub volume_critical_percent: u32,
}

/// `NotificationSettings::cert_expiry_days` of a new install.
pub const DEFAULT_CERT_EXPIRY_DAYS: u32 = 14;
/// `NotificationSettings::volume_warn_percent` of a new install.
pub const DEFAULT_VOLUME_WARN_PERCENT: u32 = 85;
/// `NotificationSettings::volume_critical_percent` of a new install.
pub const DEFAULT_VOLUME_CRITICAL_PERCENT: u32 = 95;

/// The overview of several clusters ("All clusters", #144). Written by the frontend; opening the overview never
/// connects a cluster by itself.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct FleetSettings {
    /// The clusters (ids) the overview shows, in the order they were chosen. An id no kubeconfig has any more is
    /// ignored by the frontend.
    pub selected: Vec<String>,
}

/// The change timeline (#145). Written by the frontend.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct TimelineSettings {
    /// Keep each cluster's recorded timeline in a file between runs (`timeline::save`); off by default, so what was
    /// recorded lives in memory only and goes when Sextant quits.
    pub persist: bool,
}

/// The "Cleanup" page (#147). Written by the frontend, which keeps the always-skipped system namespaces
/// (`kube-system`, `kube-public`, `kube-node-lease`) out of this list and applies its own bounds to the ages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct CleanupSettings {
    /// Namespaces whose objects are never offered for deletion, besides the system ones.
    pub excluded_namespaces: Vec<String>,
    /// How many days an object must have been unused (or finished) before it is a candidate, per kind of rule.
    pub min_age_days: CleanupAges,
    /// Offer ConfigMaps nothing seems to use. Off by default: Sextant cannot see every reference (operators,
    /// CSI drivers, controller arguments, applications reading through the API).
    pub check_config_maps: bool,
    /// Offer Secrets nothing seems to use. Off by default, for the same reason.
    pub check_secrets: bool,
}

/// Days per rule of the "Cleanup" page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct CleanupAges {
    /// ConfigMaps and Secrets that nothing refers to.
    pub configs: u32,
    /// Services without endpoints.
    pub services: u32,
    /// Finished Pods.
    pub pods: u32,
    /// Finished Jobs.
    pub jobs: u32,
    /// PersistentVolumeClaims no Pod mounts.
    pub claims: u32,
    /// Released or Available PersistentVolumes.
    pub volumes: u32,
    /// Empty namespaces.
    pub namespaces: u32,
}

impl Default for CleanupAges {
    fn default() -> Self {
        Self {
            configs: 7,
            services: 7,
            pods: 7,
            jobs: 7,
            claims: 30,
            volumes: 30,
            namespaces: 30,
        }
    }
}

impl Default for CleanupSettings {
    fn default() -> Self {
        Self {
            excluded_namespaces: [
                "cert-manager",
                "flux-system",
                "argocd",
                "ingress-nginx",
                "istio-system",
                "monitoring",
                "local-path-storage",
            ]
            .map(str::to_owned)
            .to_vec(),
            min_age_days: CleanupAges::default(),
            check_config_maps: false,
            check_secrets: false,
        }
    }
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            disabled_categories: Vec::new(),
            muted_clusters: Vec::new(),
            muted_until: None,
            cert_expiry_days: DEFAULT_CERT_EXPIRY_DAYS,
            enabled_categories: Vec::new(),
            volume_warn_percent: DEFAULT_VOLUME_WARN_PERCENT,
            volume_critical_percent: DEFAULT_VOLUME_CRITICAL_PERCENT,
        }
    }
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
    /// The cluster rail shows names next to the icons. Written by the frontend.
    pub rail_expanded: bool,
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
            rail_expanded: false,
        }
    }
}

/// `AppSettings.language` of "follow the operating system".
pub const SYSTEM_LANGUAGE: &str = "system";

/// `AppSettings.settings_version` this version writes. 1: `language` "en" is a choice (before, it was the only
/// language and the default, so it said nothing; see [`migrate`]).
pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct AppSettings {
    pub theme: Theme,
    /// UI language: a directory name under `src/locales/` (`en`, `de`, `zh-CN`…), the user's explicit choice; or
    /// `system` (the default of a new install; empty reads the same), which follows the OS language when Sextant has
    /// it and is English otherwise. Written by the frontend. The `en` of a file of an older version (version 0) was
    /// only the default and becomes `system` ([`migrate`]).
    pub language: String,
    /// The settings format: 0 for a file written before the field existed, [`SETTINGS_VERSION`] after [`migrate`].
    /// Owned by the backend: a write never lowers it.
    #[serde(default)]
    pub settings_version: u32,
    /// Kubeconfig files the user added or pasted (not `KUBECONFIG` / `~/.kube/config`).
    pub kubeconfig_sources: Vec<KubeconfigSource>,
    pub clusters: HashMap<String, ClusterSettings>,
    pub window: WindowLayout,
    /// The `helm` binary chosen in Settings; `None` = look `helm` up in `PATH`.
    pub helm_path: Option<String>,
    /// Colour scheme of the YAML editors: `auto` (follows the app theme) or a scheme id. Owned by the frontend,
    /// which treats an unknown value as `auto`; kept as text so a value from another version never damages the file.
    pub editor_theme: String,
    /// Look for a new Sextant release when the application starts (the "Check for updates" button works anyway).
    pub check_for_updates: bool,
    /// Closing the main window only hides it while the tray icon exists; quitting is "Quit" in the tray menu.
    /// Written by the frontend (Settings -> Window); off by default, so closing the window quits the app.
    pub close_to_tray: bool,
    /// The built-in MCP server.
    pub mcp: McpSettings,
    /// Image of the temporary privileged pod behind a shell on a node (`node_shell`); empty means the default
    /// (`node_shell::DEFAULT_IMAGE`). The image needs `nsenter`; `sleep` runs on the node.
    pub node_shell_image: String,
    /// Default image of a debug container (`debug`), chosen in the debug dialog; empty means the default
    /// (`debug::DEFAULT_IMAGE`). Written by the frontend.
    pub debug_image: String,
    /// Installed extensions and what the user granted them. Written only by the backend (install, consent, enable,
    /// remove); `settings_update` keeps the stored list whatever the frontend sends. An entry this version cannot
    /// read is left out rather than failing the file.
    #[serde(with = "crate::extensions::installed::lenient_list")]
    #[ts(as = "Vec<InstalledExtension>")]
    pub extensions: Vec<InstalledExtension>,
    /// Desktop notifications about new problems in connected clusters. Written by the frontend.
    pub notifications: NotificationSettings,
    /// The overview of several clusters: which clusters it shows. Written by the frontend.
    pub fleet: FleetSettings,
    /// The change timeline (#145): whether recorded changes are kept between runs. Written by the frontend.
    pub timeline: TimelineSettings,
    /// The "Cleanup" page (#147): namespaces it never checks and how old a candidate must be. Written by the frontend.
    pub cleanup: CleanupSettings,
    /// Kubeconfig management (#150): which sources (besides Sextant's own files) the user allowed Sextant to edit, and
    /// how early expiring credentials are flagged. Written by the frontend.
    pub kubeconfig: crate::kubeconfig::edit::KubeconfigSettings,
    /// Saved views (#149): named resource tables, per cluster or for every cluster, in the user's order. Written by
    /// the frontend; an entry that does not read is left out ([`views`]).
    #[serde(with = "views::views_field")]
    #[ts(as = "Vec<SavedView>")]
    pub views: Vec<SavedView>,
    /// Pinned objects and views, per cluster (#149). Written by the frontend.
    #[serde(with = "views::pins_field")]
    #[ts(as = "Vec<Pin>")]
    pub pins: Vec<Pin>,
    /// Named sets of clusters (#149). Written by the frontend.
    #[serde(with = "views::workspaces_field")]
    #[ts(as = "Vec<Workspace>")]
    pub workspaces: Vec<Workspace>,
    /// The workspace the cluster rail is filtered by; `None` = every cluster. Written by the frontend.
    #[serde(with = "views::active_workspace_field")]
    #[ts(as = "Option<String>")]
    pub active_workspace: Option<String>,
    /// Terminal snippets (#154): saved commands with placeholders, in the user's order. Written by the frontend; an
    /// entry that does not read is left out ([`snippets`]).
    #[serde(with = "snippets::snippets_field")]
    #[ts(as = "Vec<Snippet>")]
    pub snippets: Vec<Snippet>,
    /// Comparing objects (#156): paths ignored per kind. Written by the frontend; read leniently ([`compare`]).
    #[serde(with = "compare::compare_field")]
    #[ts(as = "CompareSettings")]
    pub compare: CompareSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            language: SYSTEM_LANGUAGE.to_owned(),
            settings_version: SETTINGS_VERSION,
            kubeconfig_sources: Vec::new(),
            clusters: HashMap::new(),
            window: WindowLayout::default(),
            helm_path: None,
            editor_theme: "auto".to_owned(),
            check_for_updates: true,
            close_to_tray: false,
            mcp: McpSettings::default(),
            node_shell_image: crate::node_shell::DEFAULT_IMAGE.to_owned(),
            debug_image: crate::debug::DEFAULT_IMAGE.to_owned(),
            extensions: Vec::new(),
            notifications: NotificationSettings::default(),
            fleet: FleetSettings::default(),
            timeline: TimelineSettings::default(),
            cleanup: CleanupSettings::default(),
            kubeconfig: crate::kubeconfig::edit::KubeconfigSettings::default(),
            views: Vec::new(),
            pins: Vec::new(),
            workspaces: Vec::new(),
            active_workspace: None,
            snippets: Vec::new(),
            compare: CompareSettings::default(),
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
///   replaced, and an earlier copy with the same bytes is reused, so a file that stays broken is copied once, not on
///   every start), then defaults are used; the file itself is written over only by the next change ([`Self::update`]);
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
        let (mut current, status) = load(&path);
        migrate(&mut current);
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
        // A frontend copy from before the migration must not undo it.
        next.settings_version = next.settings_version.max(current.settings_version);
        if self.status.writable {
            write_atomic(&self.path, &next)?;
        }
        *current = next;
        Ok(())
    }
}

/// Brings settings read from an older file up to [`SETTINGS_VERSION`]. Version 0 → 1: every earlier version stored
/// `language: "en"` by default while English was the only language, so it was never a choice; it becomes `system`
/// (the OS language when Sextant has it). An `en` stored from version 1 on is the user's and stays.
pub fn migrate(settings: &mut AppSettings) {
    if settings.settings_version < 1 {
        if settings.language == "en" {
            settings.language = SYSTEM_LANGUAGE.to_owned();
        }
        settings.settings_version = 1;
    }
}

/// Reads the settings file and decides whether it may be written.
fn load(path: &Path) -> (AppSettings, SettingsFileStatus) {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let status = match probe_write(path) {
                Ok(()) => SettingsFileStatus::healthy(),
                Err(error) => not_writable(error),
            };
            return (AppSettings::default(), status);
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
        Ok(settings) => match probe_write(path) {
            Ok(()) => (settings, SettingsFileStatus::healthy()),
            Err(error) => (settings, not_writable(error)),
        },
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

/// Whether a settings write would work, tried for real: a temporary file next to `path` (what [`write_atomic`] makes
/// before renaming it over the file), removed again. File mode bits alone miss a directory owned by root (after a
/// run with `sudo`), a read-only mount and the like.
fn probe_write(path: &Path) -> Result<(), CoreError> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| CoreError::other(format!("invalid settings path: {}", path.display())))?;
    let unwritable = |err: std::io::Error| {
        CoreError::new(
            io_code(&err),
            format!(
                "cannot write to {}: {err}; changes are not saved",
                dir.display()
            ),
        )
    };
    std::fs::create_dir_all(dir).map_err(unwritable)?;
    tempfile::Builder::new()
        .prefix(".settings-probe-")
        .tempfile_in(dir)
        .map(drop)
        .map_err(unwritable)
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
/// An existing `<name>.bak-*` with exactly `bytes` is returned instead of making another copy.
fn write_backup(path: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "settings.json".to_owned());
    if let Some(same) = existing_backup(path, &name, bytes) {
        return Ok(same);
    }
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

/// A regular file `<name>.bak-*` next to `path` whose content is exactly `bytes` (the earliest such name); a copy that
/// cannot be read is not a match.
fn existing_backup(path: &Path, name: &str, bytes: &[u8]) -> Option<PathBuf> {
    let prefix = format!("{name}.bak-");
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty())?;
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .filter(|entry| {
            // `symlink_metadata`: a link named like a copy is not taken for one.
            std::fs::symlink_metadata(entry.path())
                .is_ok_and(|m| m.is_file() && m.len() == bytes.len() as u64)
        })
        .map(|entry| entry.path())
        .collect();
    candidates.sort();
    candidates
        .into_iter()
        .find(|candidate| std::fs::read(candidate).is_ok_and(|content| content == bytes))
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

/// For the file, puts the `agentAccess` value that could not be read back where it was found, so a newer Sextant (or
/// the person who edited it) finds it as written. The frontend sees it beside a closed access instead
/// (`agentAccessUnrecognised`).
fn restore_unrecognised_access(settings: &mut serde_json::Value) {
    let Some(clusters) = settings
        .get_mut("clusters")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    for cluster in clusters.values_mut().filter_map(|c| c.as_object_mut()) {
        if let Some(kept) = cluster.remove("agentAccessUnrecognised") {
            cluster.insert("agentAccess".to_owned(), kept);
        }
    }
}

fn write_atomic(path: &Path, settings: &AppSettings) -> CoreResult<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| CoreError::other(format!("invalid settings path: {}", path.display())))?;
    std::fs::create_dir_all(dir)?;
    let mut value = serde_json::to_value(settings)?;
    restore_unrecognised_access(&mut value);
    let json = serde_json::to_vec_pretty(&value)?;
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
        assert_eq!(s.language, SYSTEM_LANGUAGE);
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
    fn a_file_that_stays_broken_is_copied_once_whatever_the_number_of_starts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "still broken").unwrap();
        // A copy of other bytes, and one that only shares the length, are not reused.
        std::fs::write(
            dir.path().join("settings.json.bak-20000101-000000"),
            "older broken",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("settings.json.bak-20000101-000001"),
            "STILL BROKEN",
        )
        .unwrap();

        let first = SettingsStore::open(path.clone()).status();
        let second = SettingsStore::open(path.clone()).status();
        let third = SettingsStore::open(path.clone()).status();

        let copy = first.backup_path.clone().expect("a backup is made");
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), "still broken");
        assert_eq!(second.backup_path.as_ref(), Some(&copy));
        assert_eq!(third.backup_path.as_ref(), Some(&copy));
        assert_eq!(backups(dir.path()).len(), 3, "{:?}", backups(dir.path()));
        for status in [&second, &third] {
            assert!(status.writable);
            assert_eq!(
                status.error.as_ref().map(|e| e.code),
                Some(ErrorCode::Invalid)
            );
        }
        // Opening does not write the file over; the next change does.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "still broken");
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
        assert_eq!(s.language, SYSTEM_LANGUAGE);
        assert_eq!(s.editor_theme, "auto");
        assert!(s.check_for_updates);
    }

    #[test]
    fn an_old_default_english_follows_the_system_and_a_chosen_language_stays() {
        let dir = tempfile::tempdir().unwrap();
        // A file of an older version: its "en" was the only language and the default, never a choice.
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "language": "en", "theme": "dark" }"#).unwrap();
        let store = SettingsStore::open(path.clone());
        assert_eq!(store.get().language, SYSTEM_LANGUAGE);
        assert_eq!(store.get().settings_version, SETTINGS_VERSION);
        assert_eq!(store.get().theme, Theme::Dark);
        // English chosen after the migration stays English, also when a stale copy (version 0) is saved.
        store
            .update(|s| {
                s.language = "en".to_owned();
                s.settings_version = 0;
            })
            .unwrap();
        let reopened = SettingsStore::open(path.clone()).get();
        assert_eq!(reopened.language, "en");
        assert_eq!(reopened.settings_version, SETTINGS_VERSION);
        // An old file with another language keeps it.
        std::fs::write(&path, r#"{ "language": "de" }"#).unwrap();
        assert_eq!(SettingsStore::open(path).get().language, "de");
        // A new install, then an explicit choice that survives a reopen.
        let fresh = tempfile::tempdir().unwrap();
        let (path, store) = store_in(&fresh);
        assert_eq!(store.get().language, SYSTEM_LANGUAGE);
        store.update(|s| s.language = "zh-CN".to_owned()).unwrap();
        assert_eq!(SettingsStore::open(path.clone()).get().language, "zh-CN");
        store
            .update(|s| s.language = SYSTEM_LANGUAGE.to_owned())
            .unwrap();
        assert_eq!(SettingsStore::open(path).get().language, SYSTEM_LANGUAGE);
    }

    #[test]
    fn unknown_editor_theme_is_kept_and_does_not_damage_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "editorTheme": "from-a-newer-version" }"#).unwrap();
        let store = SettingsStore::open(path.clone());
        assert!(store.status().writable);
        assert_eq!(store.status().backup_path, None);
        assert_eq!(store.get().editor_theme, "from-a-newer-version");
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

    #[test]
    fn cluster_icon_and_rail_view_round_trip_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let (path, store) = store_in(&dir);
        store
            .update(|s| {
                s.window.rail_expanded = true;
                s.clusters.insert(
                    "text".to_owned(),
                    ClusterSettings {
                        icon: Some(ClusterIcon::Text {
                            text: "🚀".to_owned(),
                        }),
                        ..Default::default()
                    },
                );
                s.clusters.insert(
                    "image".to_owned(),
                    ClusterSettings {
                        icon: Some(ClusterIcon::Image {
                            data_url: "data:image/png;base64,iVBORw0KGgo=".to_owned(),
                        }),
                        ..Default::default()
                    },
                );
            })
            .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["window"]["railExpanded"], true);
        assert_eq!(
            json["clusters"]["text"]["icon"],
            serde_json::json!({ "type": "text", "text": "🚀" })
        );
        assert_eq!(
            json["clusters"]["image"]["icon"],
            serde_json::json!({ "type": "image", "dataUrl": "data:image/png;base64,iVBORw0KGgo=" })
        );

        let s = SettingsStore::open(path).get();
        assert!(s.window.rail_expanded);
        assert_eq!(
            s.clusters["text"].icon,
            Some(ClusterIcon::Text {
                text: "🚀".to_owned()
            })
        );
        assert_eq!(
            s.clusters["image"].icon,
            Some(ClusterIcon::Image {
                data_url: "data:image/png;base64,iVBORw0KGgo=".to_owned()
            })
        );
    }

    #[test]
    fn the_chosen_argocd_namespace_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let (path, store) = store_in(&dir);
        store
            .update(|s| {
                s.clusters.insert(
                    "c1".to_owned(),
                    ClusterSettings {
                        argocd_namespace: Some("gitops".to_owned()),
                        ..Default::default()
                    },
                );
                s.clusters
                    .insert("c2".to_owned(), ClusterSettings::default());
            })
            .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["clusters"]["c1"]["argocdNamespace"], "gitops");

        assert!(json["clusters"]["c2"].get("argocdNamespace").is_none());

        let s = SettingsStore::open(path).get();
        assert_eq!(s.clusters["c1"].argocd_namespace.as_deref(), Some("gitops"));
        assert_eq!(s.clusters["c2"].argocd_namespace, None);
    }

    #[test]
    fn the_preview_choice_round_trips_and_is_left_out_while_automatic() {
        let dir = tempfile::tempdir().unwrap();
        let (path, store) = store_in(&dir);
        store
            .update(|s| {
                s.clusters.insert(
                    "c1".to_owned(),
                    ClusterSettings {
                        preview_changes: Some(false),
                        ..Default::default()
                    },
                );
                s.clusters
                    .insert("c2".to_owned(), ClusterSettings::default());
            })
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["clusters"]["c1"]["previewChanges"], false);
        assert!(json["clusters"]["c2"].get("previewChanges").is_none());
        let s = SettingsStore::open(path).get();
        assert_eq!(s.clusters["c1"].preview_changes, Some(false));
        assert_eq!(s.clusters["c2"].preview_changes, None);
    }

    #[test]
    fn a_file_without_cluster_icons_or_rail_view_reads_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r##"{ "window": { "sidebarWidth": 300, "dockHeight": 250, "dockOpen": true, "lastCluster": "c1" },
                 "clusters": { "c1": { "displayName": "prod", "color": "#3d90ce", "lastView": "nodes" } } }"##,
        )
        .unwrap();
        let store = SettingsStore::open(path);
        assert_eq!(store.status().backup_path, None);
        let s = store.get();
        assert!(!s.window.rail_expanded);
        assert_eq!(s.window.sidebar_width, 300);
        assert_eq!(s.clusters["c1"].icon, None);
        assert_eq!(s.clusters["c1"].display_name.as_deref(), Some("prod"));
        assert!(!AppSettings::default().window.rail_expanded);
    }

    #[test]
    fn close_to_tray_is_off_unless_the_file_turns_it_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "theme": "dark", "checkForUpdates": false }"#).unwrap();
        let store = SettingsStore::open(path.clone());
        assert_eq!(store.status().backup_path, None);
        assert!(
            !store.get().close_to_tray,
            "a file from an older version keeps the window closing the app"
        );
        assert!(!AppSettings::default().close_to_tray);

        std::fs::write(&path, r#"{ "closeToTray": true }"#).unwrap();
        assert!(SettingsStore::open(path).get().close_to_tray);
    }

    #[test]
    fn agent_access_and_mcp_round_trip_through_the_file() {
        use crate::access::{
            AccessAction, AccessPreset, AccessRule, KindPattern, KindScope, NamespaceScope,
        };
        let dir = tempfile::tempdir().unwrap();
        let (path, store) = store_in(&dir);
        let access = ClusterAccess {
            preset: AccessPreset::Custom,
            rules: vec![AccessRule {
                namespaces: NamespaceScope::Only {
                    namespaces: vec!["prod".to_owned()],
                },
                kinds: KindScope::Only {
                    kinds: vec![KindPattern::helm_release()],
                },
                actions: vec![AccessAction::Read, AccessAction::Delete],
                confirm: true,
            }],
        };
        store
            .update(|s| {
                s.mcp = McpSettings {
                    enabled: true,
                    port: 50123,
                };
                s.clusters.insert(
                    "c1".to_owned(),
                    ClusterSettings {
                        agent_access: access.clone(),
                        ..Default::default()
                    },
                );
            })
            .unwrap();

        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            json["mcp"],
            serde_json::json!({ "enabled": true, "port": 50123 })
        );
        assert_eq!(json["clusters"]["c1"]["agentAccess"]["preset"], "custom");
        assert_eq!(
            json["clusters"]["c1"]["agentAccess"]["rules"][0]["actions"],
            serde_json::json!(["read", "delete"])
        );

        let s = SettingsStore::open(path).get();
        assert_eq!(
            s.mcp,
            McpSettings {
                enabled: true,
                port: 50123
            }
        );
        assert_eq!(s.clusters["c1"].agent_access, access);
    }

    #[test]
    fn a_file_without_agent_access_or_mcp_reads_closed_and_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r##"{ "theme": "dark", "clusters": { "c1": { "displayName": "prod", "color": "#3d90ce" } } }"##,
        )
        .unwrap();
        let store = SettingsStore::open(path);
        assert_eq!(store.status().backup_path, None);
        let s = store.get();
        assert_eq!(s.clusters["c1"].agent_access, ClusterAccess::default());
        assert_eq!(
            s.clusters["c1"].agent_access.preset,
            crate::access::AccessPreset::Off
        );
        assert!(!s.mcp.enabled);
        assert_eq!(s.mcp.port, 47391);
        assert_eq!(AppSettings::default().mcp, s.mcp);
    }

    #[test]
    fn agent_access_from_a_newer_version_closes_access_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r##"{ "helmPath": "/opt/helm", "mcp": { "enabled": true },
                 "clusters": { "c1": { "displayName": "prod", "agentAccess": { "preset": "superUser" } } } }"##,
        )
        .unwrap();
        let store = SettingsStore::open(path);
        assert_eq!(store.status().backup_path, None);
        let s = store.get();
        assert_eq!(s.helm_path.as_deref(), Some("/opt/helm"));
        assert_eq!(s.clusters["c1"].display_name.as_deref(), Some("prod"));
        assert_eq!(s.clusters["c1"].agent_access, ClusterAccess::default());
        assert!(s.mcp.enabled);
        assert_eq!(s.mcp.port, 47391);
    }

    #[test]
    fn the_node_shell_image_defaults_to_busybox_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "theme": "dark" }"#).unwrap();
        let store = SettingsStore::open(path.clone());
        assert_eq!(store.get().node_shell_image, "busybox:stable");
        store
            .update(|s| s.node_shell_image = "registry.example/tools:1".to_owned())
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["nodeShellImage"], "registry.example/tools:1");
        assert_eq!(
            SettingsStore::open(path).get().node_shell_image,
            "registry.example/tools:1"
        );
    }

    #[test]
    fn the_debug_image_defaults_to_busybox_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "theme": "dark" }"#).unwrap();
        let store = SettingsStore::open(path.clone());
        assert_eq!(store.get().debug_image, "busybox:stable");
        store
            .update(|s| s.debug_image = "nicolaka/netshoot:latest".to_owned())
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["debugImage"], "nicolaka/netshoot:latest");
        assert_eq!(
            SettingsStore::open(path).get().debug_image,
            "nicolaka/netshoot:latest"
        );
    }

    #[test]
    fn notifications_are_on_by_default_and_their_settings_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // A file of an older version, without the field.
        std::fs::write(&path, r#"{ "theme": "dark" }"#).unwrap();
        let store = SettingsStore::open(path.clone());
        assert_eq!(store.get().notifications, NotificationSettings::default());
        assert!(store.get().notifications.enabled);
        store
            .update(|s| {
                s.notifications = NotificationSettings {
                    enabled: false,
                    disabled_categories: vec!["pods".to_owned(), "a-future-category".to_owned()],
                    muted_clusters: vec!["c1".to_owned()],
                    muted_until: Some("2026-10-18T12:00:00.000Z".to_owned()),
                    cert_expiry_days: 30,
                    enabled_categories: vec!["security".to_owned()],
                    volume_warn_percent: 80,
                    volume_critical_percent: 90,
                }
            })
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["notifications"]["enabled"], false);
        assert_eq!(json["notifications"]["disabledCategories"][0], "pods");
        assert_eq!(json["notifications"]["mutedClusters"][0], "c1");
        assert_eq!(
            json["notifications"]["mutedUntil"],
            "2026-10-18T12:00:00.000Z"
        );
        let read = SettingsStore::open(path).get().notifications;
        assert!(!read.enabled);
        assert_eq!(read.disabled_categories, ["pods", "a-future-category"]);
        assert_eq!(
            read.muted_until.as_deref(),
            Some("2026-10-18T12:00:00.000Z")
        );
        // A partly written object keeps the defaults of the missing fields.
        let partial: NotificationSettings =
            serde_json::from_str(r#"{ "mutedClusters": ["c2"] }"#).unwrap();
        assert!(partial.enabled);
        assert_eq!(partial.muted_clusters, ["c2"]);
        assert_eq!(partial.cert_expiry_days, DEFAULT_CERT_EXPIRY_DAYS);
        assert_eq!(read.cert_expiry_days, 30);
        assert_eq!(json["notifications"]["certExpiryDays"], 30);
        assert_eq!(json["notifications"]["enabledCategories"][0], "security");
        assert_eq!(read.enabled_categories, ["security"]);
        assert!(partial.enabled_categories.is_empty());
        assert_eq!(json["notifications"]["volumeWarnPercent"], 80);
        assert_eq!(
            (read.volume_warn_percent, read.volume_critical_percent),
            (80, 90)
        );
        assert_eq!(
            (partial.volume_warn_percent, partial.volume_critical_percent),
            (DEFAULT_VOLUME_WARN_PERCENT, DEFAULT_VOLUME_CRITICAL_PERCENT)
        );
    }

    #[test]
    fn the_fleet_selection_is_empty_by_default_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // A file of an older version, without the field.
        std::fs::write(&path, r#"{ "theme": "dark" }"#).unwrap();
        let store = SettingsStore::open(path.clone());
        assert!(store.get().fleet.selected.is_empty());
        store
            .update(|s| s.fleet.selected = vec!["c2".to_owned(), "c1".to_owned()])
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["fleet"]["selected"][0], "c2");
        assert_eq!(SettingsStore::open(path).get().fleet.selected, ["c2", "c1"]);
        let partial: FleetSettings = serde_json::from_str("{}").unwrap();
        assert!(partial.selected.is_empty());
    }

    #[test]
    fn the_cleanup_settings_have_defaults_and_keep_a_partial_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // A file of an older version, without the field.
        std::fs::write(&path, r#"{ "theme": "dark" }"#).unwrap();
        let store = SettingsStore::open(path.clone());
        let cleanup = store.get().cleanup;
        assert_eq!(cleanup, CleanupSettings::default());
        assert!(
            cleanup
                .excluded_namespaces
                .contains(&"flux-system".to_owned())
        );
        assert!(
            !cleanup
                .excluded_namespaces
                .contains(&"kube-system".to_owned())
        );
        assert_eq!(
            (cleanup.min_age_days.pods, cleanup.min_age_days.volumes),
            (7, 30)
        );
        assert!(!cleanup.check_config_maps && !cleanup.check_secrets);
        store
            .update(|s| {
                s.cleanup.excluded_namespaces = vec!["team-x".to_owned()];
                s.cleanup.min_age_days.jobs = 3;
            })
            .unwrap();
        let read = SettingsStore::open(path).get().cleanup;
        assert_eq!(read.excluded_namespaces, ["team-x"]);
        assert_eq!(read.min_age_days.jobs, 3);
        // A value with some ages only keeps the defaults of the others.
        let partial: CleanupSettings =
            serde_json::from_str(r#"{"minAgeDays":{"pods":1}}"#).unwrap();
        assert_eq!(partial.min_age_days.pods, 1);
        assert_eq!(partial.min_age_days.claims, 30);
        assert_eq!(
            partial.excluded_namespaces,
            CleanupSettings::default().excluded_namespaces
        );
    }

    #[test]
    fn installed_extensions_round_trip_through_the_file() {
        use crate::extensions::{ExtensionPermissions, ExtensionSource, InstalledExtension};
        let dir = tempfile::tempdir().unwrap();
        let (path, store) = store_in(&dir);
        assert!(store.get().extensions.is_empty());
        let installed = InstalledExtension {
            id: "dev.example.widgets".to_owned(),
            version: "1.0.0".to_owned(),
            name: "Widgets".to_owned(),
            source: ExtensionSource::Url {
                url: "https://github.com/o/r/releases/download/v1/w.sextant-ext".to_owned(),
            },
            enabled: true,
            granted: ExtensionPermissions::none(),
            installed_at: 1_760_000_000_000,
        };
        store
            .update(|s| s.extensions.push(installed.clone()))
            .unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(json["extensions"][0]["source"]["type"], "url");
        assert_eq!(json["extensions"][0]["installedAt"], 1_760_000_000_000u64);
        assert_eq!(json["extensions"][0]["granted"]["clusters"]["type"], "only");
        assert_eq!(SettingsStore::open(path).get().extensions, vec![installed]);
    }

    #[test]
    fn a_bad_extensions_entry_is_left_out_and_never_damages_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let good = r#"{ "id": "good", "version": "1.0.0", "name": "Good", "source": { "type": "folder", "path": "/src/good" },
                        "enabled": true, "installedAt": 1,
                        "granted": { "clusters": { "type": "all" }, "rules": [] } }"#;
        let unknown_source = r#"{ "id": "odd", "version": "1.0.0", "name": "Odd", "source": { "type": "ftp", "host": "x" },
                        "enabled": true, "installedAt": 1, "granted": { "clusters": { "type": "all" }, "rules": [] } }"#;
        let newer_rules = r#"{ "id": "newer", "version": "1.0.0", "name": "Newer", "source": { "type": "file", "name": "n.zip" },
                        "enabled": true, "installedAt": 1,
                        "granted": { "clusters": { "type": "all" }, "rules": [], "deny": [] } }"#;
        let duplicate = good.replace("Good", "Second");
        std::fs::write(
            &path,
            format!(
                r#"{{ "theme": "dark", "extensions": [{good}, {unknown_source}, {{ "id": 5 }}, {newer_rules}, {duplicate}] }}"#
            ),
        )
        .unwrap();
        let store = SettingsStore::open(path.clone());
        assert_eq!(store.status().backup_path, None);
        let s = store.get();
        assert_eq!(s.theme, Theme::Dark);
        let ids: Vec<&str> = s.extensions.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["good", "newer"],
            "unreadable entries and a second `good` are left out"
        );
        assert_eq!(s.extensions[0].name, "Good");
        assert_eq!(
            s.extensions[1].granted,
            crate::extensions::ExtensionPermissions::none(),
            "permissions this version cannot read are closed"
        );

        std::fs::write(&path, r#"{ "theme": "dark", "extensions": { "id": "x" } }"#).unwrap();
        let store = SettingsStore::open(path);
        assert_eq!(store.status().backup_path, None);
        assert_eq!(store.get().theme, Theme::Dark);
        assert!(store.get().extensions.is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn a_directory_that_cannot_be_written_is_reported_before_anything_is_saved() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        std::fs::create_dir(&config).unwrap();
        let path = config.join("settings.json");
        let text = r#"{ "theme": "dark" }"#;
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o555)).unwrap();
        let restore = || {
            std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        if std::fs::File::create(config.join("probe")).is_ok() {
            restore();
            eprintln!("skipped: running as a user that ignores directory permissions (root)");
            return;
        }

        let store = SettingsStore::open(path.clone());
        let status = store.status();
        assert!(!status.writable, "{status:?}");
        let error = status.error.expect("the reason is reported");
        assert_eq!(error.code, ErrorCode::Forbidden);
        assert!(
            error.message.contains(&config.display().to_string()),
            "names the directory: {error}"
        );
        assert_eq!(store.get().theme, Theme::Dark);

        // The session works in memory; the file is untouched.
        store.update(|s| s.theme = Theme::Light).unwrap();
        assert_eq!(store.get().theme, Theme::Light);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);

        restore();
        // The probe leaves nothing behind in a directory it could write to.
        assert!(SettingsStore::open(path).status().writable);
        let names: Vec<_> = std::fs::read_dir(&config)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["settings.json".to_owned()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_file_in_a_directory_that_cannot_be_written_is_not_writable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let restore = || {
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        if std::fs::File::create(dir.path().join("probe")).is_ok() {
            restore();
            eprintln!("skipped: running as a user that ignores directory permissions (root)");
            return;
        }
        let store = SettingsStore::open(dir.path().join("settings.json"));
        let status = store.status();
        restore();
        assert!(!status.writable, "{status:?}");
        assert!(status.error.is_some());
    }

    /// An `agentAccess` this version cannot read: a field it does not know could narrow a rule.
    fn unrecognised_access() -> serde_json::Value {
        serde_json::json!({
            "preset": "custom",
            "rules": [{
                "namespaces": { "type": "only", "namespaces": ["prod"] },
                "kinds": { "type": "all" },
                "actions": ["read"],
                "confirm": true,
                "expires": "2027-01-01"
            }]
        })
    }

    fn file_json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn unrecognised_agent_access_acts_as_off_and_is_written_back_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = unrecognised_access();
        std::fs::write(
            &path,
            serde_json::json!({ "theme": "dark", "clusters": { "c1": { "displayName": "prod", "agentAccess": original } } })
                .to_string(),
        )
        .unwrap();

        let store = SettingsStore::open(path.clone());
        let c1 = store.get().clusters["c1"].clone();
        assert_eq!(c1.agent_access, ClusterAccess::default(), "closed");
        assert_eq!(c1.agent_access_unrecognised.as_ref(), Some(&original));

        // Any other settings write keeps the value as found, under its own key and without extra keys.
        store.update(|s| s.theme = Theme::Light).unwrap();
        let written = file_json(&path);
        assert_eq!(written["clusters"]["c1"]["agentAccess"], original);
        assert!(
            written["clusters"]["c1"]
                .get("agentAccessUnrecognised")
                .is_none()
        );
        assert_eq!(written["clusters"]["c1"]["displayName"], "prod");

        // And it survives another start, still closed.
        let reopened = SettingsStore::open(path).get().clusters["c1"].clone();
        assert_eq!(reopened.agent_access, ClusterAccess::default());
        assert_eq!(reopened.agent_access_unrecognised.as_ref(), Some(&original));
    }

    #[test]
    fn the_frontend_gets_the_unrecognised_value_beside_a_closed_access_and_sends_it_back() {
        let original = unrecognised_access();
        let c1: ClusterSettings =
            serde_json::from_value(serde_json::json!({ "agentAccess": original })).unwrap();
        let to_frontend = serde_json::to_value(&c1).unwrap();
        assert_eq!(
            to_frontend["agentAccess"],
            serde_json::json!({ "preset": "off", "rules": [] })
        );
        assert_eq!(to_frontend["agentAccessUnrecognised"], original);

        // A copy that went through the frontend (and came back unchanged) is the same.
        let back: ClusterSettings = serde_json::from_value(to_frontend).unwrap();
        assert_eq!(back, c1);

        // Whatever `agentAccess` says next to a kept value, nothing is allowed: it never widens.
        let both: ClusterSettings = serde_json::from_value(serde_json::json!({
            "agentAccess": { "preset": "full", "rules": [] },
            "agentAccessUnrecognised": original
        }))
        .unwrap();
        assert_eq!(both.agent_access, ClusterAccess::default());
        assert_eq!(both.agent_access_unrecognised.as_ref(), Some(&original));
    }

    #[test]
    fn choosing_access_after_an_unrecognised_value_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            serde_json::json!({ "clusters": { "c1": { "agentAccess": unrecognised_access() } } })
                .to_string(),
        )
        .unwrap();
        let store = SettingsStore::open(path.clone());
        // What the frontend sends after "Reset to Off" or choosing a set: `agentAccess` only.
        let chosen: ClusterSettings = serde_json::from_value(serde_json::json!({
            "agentAccess": { "preset": "readOnly", "rules": [] }
        }))
        .unwrap();
        assert_eq!(chosen.agent_access_unrecognised, None);
        store
            .update(|s| {
                s.clusters.insert("c1".to_owned(), chosen);
            })
            .unwrap();
        assert_eq!(
            file_json(&path)["clusters"]["c1"]["agentAccess"],
            serde_json::json!({ "preset": "readOnly", "rules": [] })
        );
        assert_eq!(
            SettingsStore::open(path).get().clusters["c1"]
                .agent_access
                .preset,
            crate::access::AccessPreset::ReadOnly
        );
    }

    #[test]
    fn readable_agent_access_is_stored_as_before() {
        let c1: ClusterSettings = serde_json::from_value(serde_json::json!({
            "agentAccess": { "preset": "readWrite", "rules": [] }
        }))
        .unwrap();
        assert_eq!(
            c1.agent_access.preset,
            crate::access::AccessPreset::ReadWrite
        );
        assert_eq!(c1.agent_access_unrecognised, None);
        assert!(
            serde_json::to_value(&c1)
                .unwrap()
                .get("agentAccessUnrecognised")
                .is_none()
        );
    }
}
