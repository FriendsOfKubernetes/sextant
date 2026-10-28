//! Installing and managing extensions: a package is checked first (`extension_inspect_*` → [`PendingInstall`]), shown
//! to the user with what it asks for, and installed only on consent (`extension_install(token)`). A package waits for
//! consent for [`PENDING_TTL`] in `<data>/extensions-pending/` (the user's own file is not read again), until an
//! install with its token succeeds or the user cancels (`extension_install_cancel`); a failed install keeps it.
//!
//! Downloads come only from GitHub Releases (`https://github.com/<owner>/<repo>/releases/download/…`, redirects
//! only to GitHub's asset hosts), at most [`MAX_DOWNLOAD_BYTES`], within [`DOWNLOAD_TIMEOUT`]; the catalog's index
//! only from [`super::catalog::INDEX_URL`], with no redirect.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sextant_core::extensions::{
    ExtensionManifest, ExtensionSource, InstalledExtension, MAX_UNPACKED_BYTES, Package,
    inspect_folder, inspect_zip, prune_versions, remove, version_dir,
};
use sextant_core::{CoreError, CoreResult, ErrorCode};
use tauri::State;
use ts_rs::TS;

use super::{ExtensionHost, ExtensionInfo, HostEvent, lock};
use crate::download::{Connect, Fetch, is_asset_host, plain_https};

/// How long a checked package waits for the user's consent.
pub const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// At most this many packages wait for consent at once; a new one pushes out the oldest.
const MAX_PENDING: usize = 8;
/// A package file larger than this is not read (an archive is not larger than what it unpacks to, plus headers).
const MAX_ARCHIVE_BYTES: u64 = MAX_UNPACKED_BYTES + 8 * 1024 * 1024;
/// A download larger than this is refused (spec story 12).
pub const MAX_DOWNLOAD_BYTES: u64 = 20 * 1024 * 1024;
/// A download that takes longer is cancelled.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// A checked package waiting for the user's consent (`extension_inspect_*`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PendingInstall {
    /// Pass to `extension_install` to install it; valid for 10 minutes, until an install with it succeeds or
    /// `extension_install_cancel` drops it.
    pub token: String,
    pub manifest: ExtensionManifest,
    pub source: ExtensionSource,
    /// The version installed now under the same id, when this replaces it (an update, or new consent for a folder).
    pub replaces: Option<String>,
    /// The manifest asks for something not granted yet (for a new install: asks for anything at all).
    pub new_permissions: bool,
    /// Not from the catalog, but the catalog lists an extension with this id: who publishes that one (ADR-0130).
    pub listed_in_catalog: Option<CatalogNamesake>,
}

/// The catalog's extension of the same id as a package from elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogNamesake {
    pub name: String,
    pub author: String,
}

enum Content {
    /// The archive copied into `<data>/extensions-pending/`.
    Archive(PathBuf),
    /// A development folder (canonical), read again at install.
    Folder(PathBuf),
}

struct Pending {
    created: Instant,
    manifest: ExtensionManifest,
    source: ExtensionSource,
    content: Content,
}

impl Pending {
    fn discard(self) {
        if let Content::Archive(path) = self.content {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[derive(Default)]
pub(crate) struct PendingInstalls {
    entries: HashMap<String, Pending>,
}

impl PendingInstalls {
    fn purge_expired(&mut self) {
        let expired: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, p)| p.created.elapsed() >= PENDING_TTL)
            .map(|(token, _)| token.clone())
            .collect();
        for token in expired {
            if let Some(pending) = self.entries.remove(&token) {
                pending.discard();
            }
        }
    }

    fn insert(&mut self, token: String, pending: Pending) {
        self.purge_expired();
        while self.entries.len() >= MAX_PENDING {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(token, _)| token.clone());
            match oldest.and_then(|token| self.entries.remove(&token)) {
                Some(pending) => pending.discard(),
                None => break,
            }
        }
        self.entries.insert(token, pending);
    }

    fn take(&mut self, token: &str) -> Option<Pending> {
        self.purge_expired();
        self.entries.remove(token)
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// Reads at most `limit` bytes of an open file.
pub(crate) fn read_limited(file: std::fs::File, limit: u64) -> CoreResult<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn new_token() -> CoreResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| CoreError::other(e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn absolute(path: &Path) -> CoreResult<()> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(invalid(format!(
            "{} is not an absolute path",
            path.display()
        )))
    }
}

fn describe(source: &ExtensionSource) -> String {
    match source {
        ExtensionSource::Folder { path } => format!("the folder {path}"),
        ExtensionSource::File { name } => format!("the file {name}"),
        ExtensionSource::Url { url } => url.clone(),
        ExtensionSource::Catalog { repository, .. } => format!("the catalog ({repository})"),
    }
}

/// Whether a package from `source` may replace what is installed under its id: a file or a URL replaces a file or a
/// URL; a folder replaces only the same folder; a catalog install replaces only a catalog install pinned to the same
/// repository and key (ADR-0130). Anything else is a duplicate id from another source.
fn check_replace(
    existing: Option<&InstalledExtension>,
    source: &ExtensionSource,
) -> CoreResult<()> {
    let Some(existing) = existing else {
        return Ok(());
    };
    let allowed = match (&existing.source, source) {
        (ExtensionSource::Folder { path: old }, ExtensionSource::Folder { path: new }) => {
            old == new
        }
        (ExtensionSource::Folder { .. }, _) | (_, ExtensionSource::Folder { .. }) => false,
        (
            ExtensionSource::Catalog {
                repository: old_repository,
                public_key: old_key,
                ..
            },
            ExtensionSource::Catalog {
                repository,
                public_key,
                ..
            },
        ) => old_repository == repository && old_key == public_key,
        (ExtensionSource::Catalog { .. }, _) | (_, ExtensionSource::Catalog { .. }) => false,
        _ => true,
    };
    if allowed {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Conflict,
            format!(
                "An extension with the id `{}` is already installed from {}; remove it before installing this one",
                existing.id,
                describe(&existing.source)
            ),
        ))
    }
}

impl ExtensionHost {
    fn pending_of(
        &self,
        package: &Package,
        source: ExtensionSource,
        content: Content,
    ) -> CoreResult<PendingInstall> {
        let manifest = package.manifest.clone();
        let existing = self.installed_one(&manifest.id);
        if let Err(err) = check_replace(existing.as_ref(), &source) {
            Pending {
                created: Instant::now(),
                manifest,
                source,
                content,
            }
            .discard();
            return Err(err);
        }
        let granted = existing
            .as_ref()
            .map_or_else(sextant_core::extensions::ExtensionPermissions::none, |e| {
                e.granted.clone()
            });
        let token = new_token()?;
        let listed_in_catalog = if matches!(source, ExtensionSource::Catalog { .. }) {
            None
        } else {
            self.catalog_entry(&manifest.id)
                .map(|entry| CatalogNamesake {
                    name: entry.name,
                    author: entry.author,
                })
        };
        let shown = PendingInstall {
            token: token.clone(),
            replaces: existing.map(|e| e.version),
            new_permissions: !manifest.permissions.is_within(&granted),
            manifest: manifest.clone(),
            source: source.clone(),
            listed_in_catalog,
        };
        lock(&self.inner.pending).insert(
            token,
            Pending {
                created: Instant::now(),
                manifest,
                source,
                content,
            },
        );
        Ok(shown)
    }

    /// Checks an archive (read or downloaded) and keeps a copy until consent.
    fn inspect_archive(&self, bytes: &[u8], source: ExtensionSource) -> CoreResult<PendingInstall> {
        self.inspect_archive_checked(bytes, source, |_| Ok(()))
    }

    /// [`Self::inspect_archive`] with one more check of the read package before anything is kept.
    pub(super) fn inspect_archive_checked(
        &self,
        bytes: &[u8],
        source: ExtensionSource,
        check: impl FnOnce(&Package) -> CoreResult<()>,
    ) -> CoreResult<PendingInstall> {
        let package = inspect_zip(bytes)?;
        check(&package)?;
        let dir = &self.inner.pending_dir;
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{}.zip", new_token()?));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        std::io::Write::write_all(&mut file, bytes)?;
        self.pending_of(&package, source, Content::Archive(path))
    }

    /// `extension_inspect_file`: a `.sextant-ext` / `.zip` file.
    pub fn inspect_file(&self, path: &Path) -> CoreResult<PendingInstall> {
        absolute(path)?;
        let file = std::fs::File::open(path)?;
        if file.metadata()?.len() > MAX_ARCHIVE_BYTES {
            return Err(invalid(format!(
                "{} is larger than {} MB",
                path.display(),
                MAX_ARCHIVE_BYTES / 1024 / 1024
            )));
        }
        let bytes = read_limited(file, MAX_ARCHIVE_BYTES + 1)?;
        let name = path.file_name().map_or_else(
            || path.display().to_string(),
            |n| n.to_string_lossy().into_owned(),
        );
        self.inspect_archive(&bytes, ExtensionSource::File { name })
    }

    /// `extension_inspect_folder`: an unpacked folder, which will run in place (development mode).
    pub fn inspect_folder(&self, path: &Path) -> CoreResult<PendingInstall> {
        absolute(path)?;
        let package = inspect_folder(path)?;
        let Some(folder) = package.folder().map(Path::to_path_buf) else {
            return Err(CoreError::other("the folder was read as an archive"));
        };
        let source = ExtensionSource::Folder {
            path: folder.to_string_lossy().into_owned(),
        };
        self.pending_of(&package, source, Content::Folder(folder))
    }

    /// `extension_inspect_url`: downloads a GitHub release asset and checks it.
    pub async fn inspect_url(&self, url: &str) -> CoreResult<PendingInstall> {
        let bytes = self.inner.downloader.download(url).await?;
        let host = self.clone();
        let source = ExtensionSource::Url {
            url: url.trim().to_owned(),
        };
        tokio::task::spawn_blocking(move || host.inspect_archive(&bytes, source))
            .await
            .map_err(|e| CoreError::other(e.to_string()))?
    }

    /// `extension_install`: the user agreed to what `token`'s package asks for. Installs (or updates) it, grants
    /// exactly the manifest's permissions and enables it (an update keeps the user's on/off switch).
    ///
    /// The token is spent only by a successful install. A failure after the package was read again as it was checked
    /// (a full disk, an unwritable settings file, a conflict with another install) keeps it waiting, so the same
    /// consent can be tried again. A package that cannot be read again or changed since its check is dropped: that
    /// error, like an expired or used token, is `notFound`, and only it is (the window of consent relies on that).
    pub fn install(&self, token: &str) -> CoreResult<ExtensionInfo> {
        let _changes = lock(&self.inner.changes);
        let pending = lock(&self.inner.pending).take(token).ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                "This install has expired or was already used; choose the package again",
            )
        })?;
        let package = match &pending.content {
            Content::Archive(path) => std::fs::File::open(path)
                .map_err(CoreError::from)
                .and_then(|f| read_limited(f, MAX_ARCHIVE_BYTES + 1))
                .and_then(|bytes| inspect_zip(&bytes)),
            Content::Folder(path) => inspect_folder(path),
        };
        let package = match package {
            Ok(package) if package.manifest == pending.manifest => package,
            Ok(_) => {
                pending.discard();
                return Err(CoreError::new(
                    ErrorCode::NotFound,
                    "The package changed after it was checked; choose it again to see what it asks for now",
                ));
            }
            Err(err) => {
                pending.discard();
                return Err(CoreError::new(
                    ErrorCode::NotFound,
                    format!(
                        "The package can no longer be read ({}); choose it again",
                        err.message
                    ),
                ));
            }
        };
        let entry = match self.install_checked(&package, &pending.source) {
            Ok(entry) => entry,
            Err(mut err) => {
                lock(&self.inner.pending).insert(token.to_owned(), pending);
                if err.code == ErrorCode::NotFound {
                    // `notFound` means "this install is gone"; this one is still there.
                    err.code = ErrorCode::Other;
                }
                return Err(err);
            }
        };
        pending.discard();
        self.info(&entry)
            .ok_or_else(|| CoreError::other("the extension was installed but is not in the list"))
    }

    /// Installs a package read again for its install; returns its id. Undoes its files when the settings are not
    /// saved, so nothing is half installed when it fails.
    fn install_checked(&self, package: &Package, source: &ExtensionSource) -> CoreResult<String> {
        let manifest = package.manifest.clone();
        let existing = self.installed_one(&manifest.id);
        check_replace(existing.as_ref(), source)?;
        let packaged = !matches!(source, ExtensionSource::Folder { .. });
        if packaged {
            sextant_core::extensions::install(package, &self.inner.extensions_dir)?;
        }
        let entry = InstalledExtension {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            name: manifest.name.clone(),
            source: source.clone(),
            enabled: existing.as_ref().is_none_or(|e| e.enabled),
            granted: manifest.permissions.clone(),
            installed_at: now_ms(),
        };
        let saved = self.inner.settings.update(|settings| {
            match settings.extensions.iter_mut().find(|e| e.id == entry.id) {
                Some(slot) => *slot = entry.clone(),
                None => settings.extensions.push(entry.clone()),
            }
        });
        if let Err(err) = saved {
            let replaced_same_version = existing
                .as_ref()
                .is_some_and(|e| e.version == entry.version);
            let new_dir = version_dir(&self.inner.extensions_dir, &entry.id, &entry.version);
            if packaged
                && !replaced_same_version
                && let Some(dir) = new_dir
            {
                let _ = std::fs::remove_dir_all(dir);
            }
            return Err(err);
        }
        if packaged {
            // Older versions are not served any more; a failure leaves them for the next update.
            let _ = prune_versions(&self.inner.extensions_dir, &entry.id, &entry.version);
        }
        self.forget(&entry.id);
        super::dev::remember(self, &entry.id);
        if existing.is_some() {
            self.emit(HostEvent::FilesChanged {
                id: entry.id.clone(),
            });
        }
        self.emit(HostEvent::ListChanged);
        Ok(entry.id)
    }

    /// `extension_install_cancel`: the user closed the window of consent; the package waits no longer (its copy is
    /// deleted now, not when it expires). An unknown, expired or used token is not an error. Waits for an install
    /// in progress, so a failed install cannot put back what was cancelled during it.
    pub fn cancel_install(&self, token: &str) {
        let _changes = lock(&self.inner.changes);
        if let Some(pending) = lock(&self.inner.pending).take(token) {
            pending.discard();
        }
    }

    fn not_installed(id: &str) -> CoreError {
        CoreError::new(
            ErrorCode::NotFound,
            format!("No extension `{id}` is installed"),
        )
    }

    /// `extension_set_enabled`.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> CoreResult<ExtensionInfo> {
        let _changes = lock(&self.inner.changes);
        if self.installed_one(id).is_none() {
            return Err(Self::not_installed(id));
        }
        self.inner.settings.update(|settings| {
            if let Some(entry) = settings.extensions.iter_mut().find(|e| e.id == id) {
                entry.enabled = enabled;
            }
        })?;
        self.emit(HostEvent::ListChanged);
        self.info(id).ok_or_else(|| Self::not_installed(id))
    }

    /// `extension_remove`: its installed files (never a development folder) and its `storage` data go too.
    pub fn remove(&self, id: &str) -> CoreResult<()> {
        let _changes = lock(&self.inner.changes);
        let Some(entry) = self.installed_one(id) else {
            return Err(Self::not_installed(id));
        };
        if !matches!(entry.source, ExtensionSource::Folder { .. }) {
            remove(&self.inner.extensions_dir, id)?;
        }
        self.inner
            .settings
            .update(|settings| settings.extensions.retain(|e| e.id != id))?;
        match std::fs::remove_file(self.storage_dir().join(format!("{id}.json"))) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        self.forget(id);
        lock(&self.inner.dev).forget(id);
        self.emit(HostEvent::ListChanged);
        Ok(())
    }

    /// `extension_reload`: reads the manifest again and tells its frames to reload.
    pub fn reload(&self, id: &str) -> CoreResult<ExtensionInfo> {
        if self.installed_one(id).is_none() {
            return Err(Self::not_installed(id));
        }
        self.forget(id);
        super::dev::remember(self, id);
        self.emit(HostEvent::FilesChanged { id: id.to_owned() });
        self.emit(HostEvent::ListChanged);
        self.info(id).ok_or_else(|| Self::not_installed(id))
    }

    #[cfg(test)]
    pub(crate) fn age_pending(&self, token: &str, by: Duration) {
        if let Some(p) = lock(&self.inner.pending).entries.get_mut(token) {
            p.created = p.created.checked_sub(by).unwrap_or(p.created);
        }
    }
}

/// Downloads extension packages from GitHub Releases (the rules of [`crate::download`]).
#[derive(Clone)]
pub struct Downloader {
    max_bytes: u64,
    timeout: Duration,
    connect: Option<Connect>,
}

/// `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`, nothing else (no other port, no user, no query).
pub fn is_release_url(url: &Url) -> bool {
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments: Vec<&str> = segments.collect();
    plain_https(url, "github.com")
        && url.query().is_none()
        && segments.len() >= 6
        && segments[2] == "releases"
        && segments[3] == "download"
        && segments
            .iter()
            .all(|s| !s.is_empty() && *s != ".." && *s != ".")
}

/// Where a release download may be redirected: another release URL, or GitHub's asset hosts.
fn is_allowed_redirect(url: &Url) -> bool {
    is_release_url(url) || is_asset_host(url)
}

impl Downloader {
    /// The real one: GitHub over HTTPS, [`MAX_DOWNLOAD_BYTES`], [`DOWNLOAD_TIMEOUT`].
    pub fn github() -> Self {
        Self {
            max_bytes: MAX_DOWNLOAD_BYTES,
            timeout: DOWNLOAD_TIMEOUT,
            connect: None,
        }
    }

    /// Sends every request to `connect(url)` instead of `url` (a local fake server in tests), with other limits.
    pub fn redirected(connect: Connect, max_bytes: u64, timeout: Duration) -> Self {
        Self {
            max_bytes,
            timeout,
            connect: Some(connect),
        }
    }

    /// Downloads `url` (a GitHub release asset) into memory.
    pub async fn download(&self, url: &str) -> CoreResult<Vec<u8>> {
        self.download_at_most(url, self.max_bytes).await
    }

    /// [`Self::download`] refusing more than `max_bytes` (and never more than this downloader's own cap).
    pub async fn download_at_most(&self, url: &str, max_bytes: u64) -> CoreResult<Vec<u8>> {
        let url = Url::parse(url.trim()).map_err(|e| invalid(format!("Not a link: {e}")))?;
        if !is_release_url(&url) {
            return Err(invalid(
                "Only links to GitHub release files can be installed: https://github.com/<owner>/<repo>/releases/download/<tag>/<file>",
            ));
        }
        Fetch {
            max_bytes: max_bytes.min(self.max_bytes),
            timeout: self.timeout,
            connect: self.connect.as_ref(),
            allowed_redirect: &is_allowed_redirect,
            accept: None,
        }
        .get(url)
        .await
    }

    /// The catalog's index from [`super::catalog::INDEX_URL`]: no redirect, at most
    /// [`sextant_core::extensions::catalog::MAX_INDEX_BYTES`], within [`super::catalog::INDEX_TIMEOUT`].
    pub async fn catalog_index(&self) -> CoreResult<Vec<u8>> {
        let url = Url::parse(super::catalog::INDEX_URL)
            .map_err(|e| CoreError::other(format!("the catalog's address does not read: {e}")))?;
        Fetch {
            max_bytes: sextant_core::extensions::catalog::MAX_INDEX_BYTES,
            timeout: self.timeout.min(super::catalog::INDEX_TIMEOUT),
            connect: self.connect.as_ref(),
            allowed_redirect: &|_| false,
            accept: None,
        }
        .get(url)
        .await
    }
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> CoreResult<T> + Send + 'static,
) -> CoreResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| CoreError::other(e.to_string()))?
}

/// Installed extensions with their manifests and states.
#[tauri::command]
pub async fn extensions_list(host: State<'_, ExtensionHost>) -> CoreResult<Vec<ExtensionInfo>> {
    let host = host.inner().clone();
    blocking(move || Ok(host.list())).await
}

/// Checks a `.sextant-ext` / `.zip` file; installs nothing.
#[tauri::command]
pub async fn extension_inspect_file(
    host: State<'_, ExtensionHost>,
    path: String,
) -> CoreResult<PendingInstall> {
    let host = host.inner().clone();
    blocking(move || host.inspect_file(Path::new(&path))).await
}

/// Downloads a GitHub release asset and checks it; installs nothing.
#[tauri::command]
pub async fn extension_inspect_url(
    host: State<'_, ExtensionHost>,
    url: String,
) -> CoreResult<PendingInstall> {
    host.inner().clone().inspect_url(&url).await
}

/// Checks an unpacked folder (development mode); installs nothing.
#[tauri::command]
pub async fn extension_inspect_folder(
    host: State<'_, ExtensionHost>,
    path: String,
) -> CoreResult<PendingInstall> {
    let host = host.inner().clone();
    blocking(move || host.inspect_folder(Path::new(&path))).await
}

/// The user's consent: installs the checked package and grants what its manifest asks for.
#[tauri::command]
pub async fn extension_install(
    host: State<'_, ExtensionHost>,
    token: String,
) -> CoreResult<ExtensionInfo> {
    let host = host.inner().clone();
    blocking(move || host.install(&token)).await
}

/// The user declined: the checked package is dropped (its copy deleted) at once.
#[tauri::command]
pub async fn extension_install_cancel(
    host: State<'_, ExtensionHost>,
    token: String,
) -> CoreResult<()> {
    let host = host.inner().clone();
    blocking(move || {
        host.cancel_install(&token);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn extension_set_enabled(
    host: State<'_, ExtensionHost>,
    id: String,
    enabled: bool,
) -> CoreResult<ExtensionInfo> {
    let host = host.inner().clone();
    blocking(move || host.set_enabled(&id, enabled)).await
}

#[tauri::command]
pub async fn extension_remove(host: State<'_, ExtensionHost>, id: String) -> CoreResult<()> {
    let host = host.inner().clone();
    blocking(move || host.remove(&id)).await
}

#[tauri::command]
pub async fn extension_reload(
    host: State<'_, ExtensionHost>,
    id: String,
) -> CoreResult<ExtensionInfo> {
    let host = host.inner().clone();
    blocking(move || host.reload(&id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::ExtensionState;
    use crate::extensions::test_support::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn write_package(dir: &Path, name: &str, zip: Vec<u8>) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, zip).unwrap();
        path
    }

    #[test]
    fn a_file_is_checked_shown_and_installed_only_on_consent() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let events = record(&host);
        let file = write_package(
            dir.path(),
            "w.sextant-ext",
            package_zip("widgets", "1.0.0", read_all()),
        );
        let pending = host.inspect_file(&file).unwrap();
        assert_eq!(pending.manifest.id, "widgets");
        assert_eq!(
            pending.source,
            ExtensionSource::File {
                name: "w.sextant-ext".into()
            }
        );
        assert_eq!(pending.replaces, None);
        assert!(pending.new_permissions);
        assert!(
            host.list().is_empty(),
            "nothing is installed before consent"
        );
        assert!(events.lock().unwrap().is_empty());

        let info = host.install(&pending.token).unwrap();
        assert_eq!(info.state, ExtensionState::Active);
        assert!(!info.dev && info.enabled && !info.needs_consent);
        assert_eq!(info.granted, pending.manifest.permissions);
        assert!(info.entry_url.unwrap().ends_with("widgets/index.html"));
        assert!(
            dir.path()
                .join("data/extensions/widgets/1.0.0/index.html")
                .is_file()
        );
        assert_eq!(*events.lock().unwrap(), vec![HostEvent::ListChanged]);
        let err = host.install(&pending.token).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "a token is used once");
        assert!(
            std::fs::read_dir(dir.path().join("data/extensions-pending"))
                .unwrap()
                .next()
                .is_none(),
            "the waiting copy is gone"
        );
    }

    fn pending_files(dir: &Path) -> usize {
        std::fs::read_dir(dir.join("data/extensions-pending")).map_or(0, |d| d.count())
    }

    #[test]
    fn a_failed_install_keeps_the_package_so_the_same_consent_can_be_retried() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let file = write_package(
            dir.path(),
            "w.sextant-ext",
            package_zip("widgets", "1.0.0", read_all()),
        );
        let pending = host.inspect_file(&file).unwrap();
        // Where installed extensions go cannot be written: the install fails after the package was read.
        let extensions = dir.path().join("data/extensions");
        let _ = std::fs::remove_dir_all(&extensions);
        std::fs::write(&extensions, "not a folder").unwrap();
        let err = host.install(&pending.token).unwrap_err();
        assert_ne!(
            err.code,
            ErrorCode::NotFound,
            "a failure that keeps the install is not `notFound`: {}",
            err.message
        );
        assert!(host.list().is_empty());
        assert_eq!(pending_files(dir.path()), 1, "the waiting copy stays");

        std::fs::remove_file(&extensions).unwrap();
        let info = host.install(&pending.token).unwrap();
        assert_eq!(info.state, ExtensionState::Active);
        assert_eq!(pending_files(dir.path()), 0, "used on success");
        assert_eq!(
            host.install(&pending.token).unwrap_err().code,
            ErrorCode::NotFound,
            "still used once on success"
        );
    }

    #[test]
    fn cancelling_drops_the_waiting_package_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let file = write_package(
            dir.path(),
            "w.zip",
            package_zip("widgets", "1.0.0", read_all()),
        );
        let pending = host.inspect_file(&file).unwrap();
        let other = host.inspect_file(&file).unwrap();
        assert_eq!(pending_files(dir.path()), 2);
        host.cancel_install(&pending.token);
        assert_eq!(pending_files(dir.path()), 1, "its archive is deleted");
        assert_eq!(
            host.install(&pending.token).unwrap_err().code,
            ErrorCode::NotFound
        );
        // Cancelling an unknown or used token is not an error, and touches no other install.
        host.cancel_install(&pending.token);
        host.cancel_install("nope");
        host.install(&other.token).unwrap();
    }

    #[test]
    fn a_package_that_changed_after_the_check_is_dropped_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let folder = dir.path().join("src");
        write_folder(&folder, "devext", "0.1.0", read_all());
        let pending = host.inspect_folder(&folder).unwrap();
        write_folder(&folder, "devext", "0.1.0", modify_all());
        let err = host.install(&pending.token).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{}", err.message);
        assert!(err.message.contains("changed"), "{}", err.message);
        // Back as it was checked: the consent is gone all the same, the user looks at the package again.
        write_folder(&folder, "devext", "0.1.0", read_all());
        assert_eq!(
            host.install(&pending.token).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert!(host.list().is_empty());
    }

    #[test]
    fn a_pending_install_expires_after_ten_minutes() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let file = write_package(
            dir.path(),
            "w.zip",
            package_zip("widgets", "1.0.0", read_all()),
        );
        let fresh = host.inspect_file(&file).unwrap();
        host.age_pending(&fresh.token, Duration::from_secs(9 * 60));
        let stale = host.inspect_file(&file).unwrap();
        host.age_pending(&stale.token, PENDING_TTL);
        assert_eq!(
            host.install(&stale.token).unwrap_err().code,
            ErrorCode::NotFound
        );
        host.install(&fresh.token).unwrap();
    }

    #[test]
    fn an_update_of_the_same_id_says_what_it_replaces_and_whether_it_asks_for_more() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let v1 = write_package(
            dir.path(),
            "v1.zip",
            package_zip("widgets", "1.0.0", read_all()),
        );
        host.install(&host.inspect_file(&v1).unwrap().token)
            .unwrap();
        host.set_enabled("widgets", false).unwrap();

        let same = write_package(
            dir.path(),
            "v2.zip",
            package_zip("widgets", "1.1.0", read_all()),
        );
        let pending = host.inspect_file(&same).unwrap();
        assert_eq!(pending.replaces.as_deref(), Some("1.0.0"));
        assert!(!pending.new_permissions);

        let wider = write_package(
            dir.path(),
            "v3.zip",
            package_zip("widgets", "2.0.0", modify_all()),
        );
        let pending = host.inspect_file(&wider).unwrap();
        assert_eq!(pending.replaces.as_deref(), Some("1.0.0"));
        assert!(pending.new_permissions);
        let events = record(&host);
        let info = host.install(&pending.token).unwrap();
        assert_eq!(info.version, "2.0.0");
        assert!(!info.enabled, "an update keeps the user's switch");
        assert_eq!(info.granted, pending.manifest.permissions);
        assert!(
            !dir.path().join("data/extensions/widgets/1.0.0").exists(),
            "the old version is pruned"
        );
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                HostEvent::FilesChanged {
                    id: "widgets".into()
                },
                HostEvent::ListChanged
            ]
        );
    }

    #[test]
    fn the_same_id_from_another_source_is_refused_with_a_clear_message() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let folder = dir.path().join("src");
        write_folder(&folder, "widgets", "1.0.0", read_all());
        host.install(&host.inspect_folder(&folder).unwrap().token)
            .unwrap();
        let file = write_package(
            dir.path(),
            "w.zip",
            package_zip("widgets", "1.0.0", read_all()),
        );
        let err = host.inspect_file(&file).unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(
            err.message.contains("already installed from the folder"),
            "{}",
            err.message
        );
        let other = dir.path().join("copy");
        write_folder(&other, "widgets", "1.0.0", read_all());
        assert_eq!(
            host.inspect_folder(&other).unwrap_err().code,
            ErrorCode::Conflict
        );
        // The same folder again is new consent, not a duplicate.
        assert_eq!(
            host.inspect_folder(&folder).unwrap().replaces.as_deref(),
            Some("1.0.0")
        );
    }

    #[test]
    fn broken_packages_and_relative_paths_are_refused_before_anything_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let bad = write_package(dir.path(), "bad.zip", b"not a zip".to_vec());
        assert_eq!(
            host.inspect_file(&bad).unwrap_err().code,
            ErrorCode::Invalid
        );
        let api2 = manifest("widgets", "1.0.0", read_all())
            .replace("\"sextantApi\":1", "\"sextantApi\":2");
        let zip = stored_zip(&[
            ("sextant-extension.json", api2.as_bytes()),
            ("index.html", b"x"),
        ]);
        let api2 = write_package(dir.path(), "api2.zip", zip);
        let err = host.inspect_file(&api2).unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(err.message.contains("sextantApi"), "{}", err.message);
        assert_eq!(
            host.inspect_file(Path::new("w.zip")).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert_eq!(
            host.inspect_folder(Path::new("src")).unwrap_err().code,
            ErrorCode::Invalid
        );
    }

    #[test]
    fn removing_deletes_installed_files_and_storage_but_never_a_development_folder() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        let file = write_package(
            dir.path(),
            "w.zip",
            package_zip("widgets", "1.0.0", read_all()),
        );
        host.install(&host.inspect_file(&file).unwrap().token)
            .unwrap();
        let folder = dir.path().join("src");
        write_folder(&folder, "devext", "0.1.0", read_all());
        host.install(&host.inspect_folder(&folder).unwrap().token)
            .unwrap();
        std::fs::create_dir_all(host.storage_dir()).unwrap();
        std::fs::write(host.storage_dir().join("widgets.json"), "{}").unwrap();

        host.remove("widgets").unwrap();
        host.remove("devext").unwrap();
        assert!(host.list().is_empty());
        assert!(!dir.path().join("data/extensions/widgets").exists());
        assert!(!host.storage_dir().join("widgets.json").exists());
        assert!(
            folder.join("index.html").is_file(),
            "the user's folder stays"
        );
        assert_eq!(
            host.remove("widgets").unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            host.set_enabled("widgets", true).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            host.reload("widgets").unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn only_github_release_links_are_accepted() {
        for good in [
            "https://github.com/o/r/releases/download/v1.0.0/w.sextant-ext",
            "https://github.com/FriendsOfKubernetes/sextant/releases/download/v1/a/b.zip",
        ] {
            assert!(is_release_url(&Url::parse(good).unwrap()), "{good}");
        }
        for bad in [
            "http://github.com/o/r/releases/download/v1/w.zip",
            "https://github.com:8443/o/r/releases/download/v1/w.zip",
            "https://user@github.com/o/r/releases/download/v1/w.zip",
            "https://github.com.evil.example/o/r/releases/download/v1/w.zip",
            "https://evil.example/o/r/releases/download/v1/w.zip",
            "https://github.com/o/r/archive/v1.zip",
            "https://github.com/o/r/releases/latest",
            "https://github.com/o/r/releases/download/v1/",
            "https://github.com/o/r/releases/download/v1/w.zip?x=1",
            "https://objects.githubusercontent.com/o/r/releases/download/v1/w.zip",
        ] {
            assert!(!is_release_url(&Url::parse(bad).unwrap()), "{bad}");
        }
        assert!(is_allowed_redirect(
            &Url::parse("https://objects.githubusercontent.com/x/y?sig=1").unwrap()
        ));
        assert!(is_allowed_redirect(
            &Url::parse("https://release-assets.githubusercontent.com/x").unwrap()
        ));
        assert!(!is_allowed_redirect(
            &Url::parse("http://objects.githubusercontent.com/x").unwrap()
        ));
        assert!(!is_allowed_redirect(
            &Url::parse("https://evil.example/x").unwrap()
        ));
    }

    /// A one-request-at-a-time HTTP server on 127.0.0.1: `answer(path)` gives the raw response (`None`: never
    /// answer). Returns its address.
    async fn fake_server(
        answer: impl Fn(&str) -> Option<Vec<u8>> + Send + Sync + 'static,
    ) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let answer = Arc::new(answer);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let answer = Arc::clone(&answer);
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => request.extend_from_slice(&buf[..n]),
                        }
                    }
                    let text = String::from_utf8_lossy(&request);
                    let path = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    match answer(&path) {
                        Some(response) => {
                            let _ = socket.write_all(&response).await;
                        }
                        None => tokio::time::sleep(Duration::from_secs(30)).await,
                    }
                });
            }
        });
        addr
    }

    fn ok(body: &[u8]) -> Vec<u8> {
        let mut r = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(body);
        r
    }

    fn redirect(to: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    /// Every request goes to the fake server, keeping the original host as the first part of the path.
    fn via(addr: std::net::SocketAddr, max_bytes: u64, timeout: Duration) -> Downloader {
        Downloader::redirected(
            Arc::new(move |url: &Url| {
                let mut target = Url::parse(&format!("http://{addr}/")).unwrap();
                target.set_path(&format!("{}{}", url.host_str().unwrap_or(""), url.path()));
                target.set_query(url.query());
                target
            }),
            max_bytes,
            timeout,
        )
    }

    const RELEASE: &str = "https://github.com/o/r/releases/download/v1/w.sextant-ext";

    #[tokio::test]
    async fn a_release_asset_is_downloaded_through_a_github_redirect_and_installed() {
        let zip = package_zip("widgets", "1.0.0", read_all());
        let body = zip.clone();
        let addr = fake_server(move |path| match path {
            "/github.com/o/r/releases/download/v1/w.sextant-ext" => Some(redirect(
                "https://objects.githubusercontent.com/assets/1?sig=abc",
            )),
            "/objects.githubusercontent.com/assets/1?sig=abc" => Some(ok(&body)),
            _ => Some(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec()),
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let host = host_with(dir.path(), via(addr, MAX_DOWNLOAD_BYTES, DOWNLOAD_TIMEOUT));
        let pending = host.inspect_url(RELEASE).await.unwrap();
        assert_eq!(
            pending.source,
            ExtensionSource::Url {
                url: RELEASE.into()
            }
        );
        let info = host.install(&pending.token).unwrap();
        assert_eq!(info.state, ExtensionState::Active);

        let missing = host
            .inspect_url("https://github.com/o/r/releases/download/v1/missing.zip")
            .await
            .unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn other_hosts_large_files_and_slow_servers_are_refused() {
        let addr = fake_server(|path| match path {
            "/github.com/o/r/releases/download/v1/evil.zip" => {
                Some(redirect("https://evil.example/w.zip"))
            }
            "/github.com/o/r/releases/download/v1/plain.zip" => {
                Some(redirect("http://objects.githubusercontent.com/w.zip"))
            }
            "/github.com/o/r/releases/download/v1/big.zip" => Some(ok(&[0u8; 2048])),
            "/github.com/o/r/releases/download/v1/chunked.zip" => {
                let mut r =
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                        .to_vec();
                for _ in 0..4 {
                    r.extend_from_slice(b"200\r\n");
                    r.extend_from_slice(&[0u8; 512]);
                    r.extend_from_slice(b"\r\n");
                }
                r.extend_from_slice(b"0\r\n\r\n");
                Some(r)
            }
            _ => None,
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let downloader = via(addr, 1024, Duration::from_millis(500));
        let at = |file: &str| format!("https://github.com/o/r/releases/download/v1/{file}");
        let err = downloader.download(&at("evil.zip")).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(err.message.contains("evil.example"), "{}", err.message);
        assert_eq!(
            downloader
                .download(&at("plain.zip"))
                .await
                .unwrap_err()
                .code,
            ErrorCode::Invalid
        );
        for file in ["big.zip", "chunked.zip"] {
            let err = downloader.download(&at(file)).await.unwrap_err();
            assert!(
                err.message.contains("larger than"),
                "{file}: {}",
                err.message
            );
        }
        assert_eq!(
            downloader.download(&at("slow.zip")).await.unwrap_err().code,
            ErrorCode::Timeout
        );
        let host = host_with(dir.path(), downloader);
        let err = host
            .inspect_url("https://example.com/w.zip")
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(err.message.contains("GitHub release"), "{}", err.message);
    }
}
