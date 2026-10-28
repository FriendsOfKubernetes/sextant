//! The extension catalog on the Tauri side (ADR-0130): its index fetched from [`INDEX_URL`] alone, by the rules of
//! [`crate::download`] (no redirect, at most `MAX_INDEX_BYTES`, within [`INDEX_TIMEOUT`]), kept in memory and in
//! `<data>/extension-catalog/index.json` so it can be browsed offline, and fetched again only when the window asks for
//! the catalog and the copy is older than [`INDEX_MAX_AGE`], or on "Refresh". With the catalog turned off in the
//! settings, nothing is requested.
//!
//! Installing from it (`extension_inspect_catalog`) takes only an id: the entry comes from this cache, the URLs are
//! built by the core from checked parts, and the package is checked against the index and the publisher's signature
//! before it is unpacked; then the usual consent follows.
//!
//! Window only: neither agents nor extensions can read or install from the catalog (a test below).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sextant_core::extensions::SUPPORTED_API;
use sextant_core::extensions::catalog::{
    self, CatalogEntry, CatalogIndex, CatalogStatus, MAX_SIGNATURE_BYTES,
};
use sextant_core::{CoreError, CoreResult, ErrorCode};
use tauri::State;
use ts_rs::TS;

use super::manage::PendingInstall;
use super::{ExtensionHost, lock};

/// The one address the catalog is read from.
pub const INDEX_URL: &str =
    "https://raw.githubusercontent.com/FriendsOfKubernetes/sextant-extensions/main/index.json";
/// A copy older than this is fetched again when the window asks for the catalog.
pub const INDEX_MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// The index's download is cancelled after this long.
pub const INDEX_TIMEOUT: Duration = Duration::from_secs(30);
const CACHE_FILE: &str = "index.json";

/// An installed catalog extension against the index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledCatalogStatus {
    pub id: String,
    pub status: CatalogStatus,
}

/// What the window shows of the catalog (`extension_catalog`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CatalogView {
    /// The settings' switch; when off, nothing else is filled and nothing was requested.
    pub enabled: bool,
    /// The index as last fetched (from this run or an earlier one); `None` before the first successful fetch.
    pub index: Option<CatalogIndex>,
    /// When that copy was fetched, in milliseconds since the Unix epoch.
    #[ts(type = "number | null")]
    pub fetched_at: Option<u64>,
    /// Why this call's fetch failed (the copy above, if any, is older).
    pub error: Option<CoreError>,
    /// Every installed catalog extension against `index`.
    pub installed: Vec<InstalledCatalogStatus>,
}

struct Cached {
    index: CatalogIndex,
    fetched_at: u64,
}

/// The cached index: memory first, the file after a restart.
pub(super) struct CatalogCache {
    dir: PathBuf,
    cached: Mutex<Option<Cached>>,
    /// One fetch at a time; a caller that waited for another one uses its result.
    fetching: tokio::sync::Mutex<()>,
    /// Grows with every stored fetch.
    stored: std::sync::atomic::AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn modified_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let ms = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    u64::try_from(ms).ok()
}

impl CatalogCache {
    pub(super) fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            cached: Mutex::new(None),
            fetching: tokio::sync::Mutex::new(()),
            stored: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// The index and its fetch time, read from the file when this run has none yet (a file that does not read is
    /// ignored and replaced by the next fetch).
    fn current(&self) -> Option<(CatalogIndex, u64)> {
        let mut cached = lock(&self.cached);
        if cached.is_none() {
            let path = self.dir.join(CACHE_FILE);
            let read = std::fs::read(&path)
                .ok()
                .filter(|bytes| bytes.len() as u64 <= catalog::MAX_INDEX_BYTES)
                .and_then(|bytes| catalog::parse_index(&bytes).ok());
            if let (Some(index), Some(fetched_at)) = (read, modified_ms(&path)) {
                *cached = Some(Cached { index, fetched_at });
            }
        }
        cached.as_ref().map(|c| (c.index.clone(), c.fetched_at))
    }

    /// Keeps a freshly fetched index: in memory, and in the file through a temporary file and a rename.
    fn store(&self, bytes: &[u8], index: CatalogIndex) {
        let fetched_at = now_ms();
        // A temporary file of this process, renamed over the copy: a reader never sees half an index.
        let temp = self
            .dir
            .join(format!("{CACHE_FILE}.{}.tmp", std::process::id()));
        let written = std::fs::create_dir_all(&self.dir)
            .and_then(|()| std::fs::write(&temp, bytes))
            .and_then(|()| std::fs::rename(&temp, self.dir.join(CACHE_FILE)));
        if let Err(err) = written {
            let _ = std::fs::remove_file(&temp);
            eprintln!("Sextant: the extension catalog could not be cached on disk: {err}");
        }
        *lock(&self.cached) = Some(Cached { index, fetched_at });
        self.stored
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn stored(&self) -> u64 {
        self.stored.load(std::sync::atomic::Ordering::SeqCst)
    }
}

fn stale(fetched_at: u64) -> bool {
    now_ms().saturating_sub(fetched_at)
        > u64::try_from(INDEX_MAX_AGE.as_millis()).unwrap_or(u64::MAX)
}

fn turned_off() -> CoreError {
    CoreError::new(
        ErrorCode::Invalid,
        "The extension catalog is turned off in Settings → Extensions",
    )
}

impl ExtensionHost {
    fn catalog_enabled(&self) -> bool {
        self.inner.settings.get().extension_catalog.enabled
    }

    /// The cached entry of `id`, if the catalog is on and lists it (no request).
    pub(super) fn catalog_entry(&self, id: &str) -> Option<CatalogEntry> {
        if !self.catalog_enabled() {
            return None;
        }
        let (index, _) = self.inner.catalog.current()?;
        index.entries.into_iter().find(|e| e.id == id)
    }

    /// `extension_catalog`: the cached index, fetched again first when `refresh` or when it is older than
    /// [`INDEX_MAX_AGE`] (or missing).
    pub async fn catalog_view(&self, refresh: bool) -> CatalogView {
        if !self.catalog_enabled() {
            return CatalogView {
                enabled: false,
                index: None,
                fetched_at: None,
                error: None,
                installed: Vec::new(),
            };
        }
        let cache = &self.inner.catalog;
        let mut error = None;
        let wanted = |current: &Option<(CatalogIndex, u64)>| {
            refresh || current.as_ref().is_none_or(|(_, at)| stale(*at))
        };
        if wanted(&cache.current()) {
            let before = cache.stored();
            let _one = cache.fetching.lock().await;
            // Another call fetched while this one waited: its answer is this one's.
            if cache.stored() == before && wanted(&cache.current()) {
                match self.fetch_index().await {
                    Ok((bytes, index)) => cache.store(&bytes, index),
                    Err(err) => error = Some(err),
                }
            }
        }
        let current = cache.current();
        let installed = current
            .as_ref()
            .map(|(index, _)| {
                self.installed()
                    .iter()
                    .filter_map(|e| {
                        catalog::status_of(e, index).map(|status| InstalledCatalogStatus {
                            id: e.id.clone(),
                            status,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let (index, fetched_at) = current.map_or((None, None), |(i, at)| (Some(i), Some(at)));
        CatalogView {
            enabled: true,
            index,
            fetched_at,
            error,
            installed,
        }
    }

    async fn fetch_index(&self) -> CoreResult<(Vec<u8>, CatalogIndex)> {
        let bytes = self.inner.downloader.catalog_index().await?;
        let index = catalog::parse_index(&bytes)?;
        Ok((bytes, index))
    }

    /// `extension_inspect_catalog`: downloads the listed release of `id`, checks it against the index and the
    /// publisher's signature, then as any package; the source pins the entry's repository and key.
    pub async fn inspect_catalog(&self, id: &str) -> CoreResult<PendingInstall> {
        if !self.catalog_enabled() {
            return Err(turned_off());
        }
        let (index, _) = self.inner.catalog.current().ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                "The catalog has not been read yet; open it first",
            )
        })?;
        let entry = index
            .entries
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    format!("The catalog has no extension `{id}`"),
                )
            })?;
        if let Some(reason) = &entry.withdrawn {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!("{} was withdrawn from the catalog: {reason}", entry.name),
            ));
        }
        let release = entry.latest.clone().ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("{} has no release in the catalog yet", entry.name),
            )
        })?;
        if release.sextant_api != u64::from(SUPPORTED_API) {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!("{} {} needs a newer Sextant", entry.name, release.version),
            ));
        }
        if let Some(existing) = self.installed_one(&entry.id) {
            catalog::check_update(&existing, &entry, &release)?;
        }
        let (package_url, signature_url) = catalog::release_urls(&entry, &release)?;
        let package = self.inner.downloader.download(&package_url).await?;
        let signature = self
            .inner
            .downloader
            .download_at_most(&signature_url, MAX_SIGNATURE_BYTES as u64)
            .await?;
        catalog::verify_package(&entry, &release, &package, &signature)?;
        let host = self.clone();
        tokio::task::spawn_blocking(move || {
            let source = catalog::catalog_source(&entry);
            host.inspect_archive_checked(&package, source, |read| {
                catalog::check_manifest(&entry, &release, &read.manifest)
            })
        })
        .await
        .map_err(|e| CoreError::other(e.to_string()))?
    }
}

/// The catalog as the window shows it; `refresh` fetches the index again whatever its age.
#[tauri::command]
pub async fn extension_catalog(
    host: State<'_, ExtensionHost>,
    refresh: bool,
) -> CoreResult<CatalogView> {
    Ok(host.inner().clone().catalog_view(refresh).await)
}

/// Checks the catalog's release of `id` and keeps it for consent, like `extension_inspect_url`.
#[tauri::command]
pub async fn extension_inspect_catalog(
    host: State<'_, ExtensionHost>,
    id: String,
) -> CoreResult<PendingInstall> {
    host.inner().clone().inspect_catalog(&id).await
}

#[cfg(test)]
mod tests;
