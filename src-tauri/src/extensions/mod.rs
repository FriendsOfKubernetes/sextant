//! Extensions on the Tauri side: their files served to the window over the `sextant-ext` protocol ([`protocol`]),
//! install, consent, enable and remove ([`manage`]), the extension catalog ([`catalog`], ADR-0130), and development
//! folders polled for changes ([`dev`]).
//!
//! [`ExtensionHost`] is managed state (`app.manage`) shared by the commands, the protocol handler and the poller. The
//! list of installed extensions and what was granted is `AppSettings::extensions`, written only here.
//!
//! An extension is *active* — its files are served and (ticket 05) its API calls considered — only when it is
//! installed, enabled, its manifest reads, and the permissions the manifest asks for are within what the user
//! granted. A development folder whose manifest starts asking for more is paused (`needsConsent`) until the user
//! agrees again (`extension_inspect_folder` + `extension_install`).

pub mod api;
pub mod backend;
pub mod catalog;
pub mod dev;
pub mod manage;
pub mod problems;
pub mod protocol;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sextant_core::SettingsStore;
use sextant_core::access::KindPattern;
use sextant_core::extensions::{
    BackendGrant, ExtensionManifest, ExtensionPermissions, ExtensionSource, InstalledExtension,
    MANIFEST_FILE, asks_within, inspect_folder, parse_manifest, resolve_package_file,
    sweep_leftovers, version_dir,
};
use ts_rs::TS;

pub use manage::{Downloader, PendingInstall};

/// Where an installed extension stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ExtensionState {
    /// Enabled and within what was granted: its files are served and its contributions shown.
    Active,
    /// Turned off by the user.
    Disabled,
    /// Its manifest asks for more than was granted (a development folder changed): paused until the user agrees.
    NeedsConsent,
    /// Its manifest or files cannot be read (`error` says why).
    Failed,
}

/// One installed extension as the window sees it (`extensions_list`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExtensionInfo {
    pub id: String,
    /// From the manifest when it reads, otherwise the name stored at install.
    pub name: String,
    pub version: String,
    pub source: ExtensionSource,
    /// Runs from a folder (development mode): reloads when its files change.
    pub dev: bool,
    /// The user's switch; `state` says whether it actually runs.
    pub enabled: bool,
    pub state: ExtensionState,
    /// The manifest asks for more than `granted` (shown whether or not it is enabled).
    pub needs_consent: bool,
    /// Why the manifest or the files cannot be read (`state` is `failed`).
    pub error: Option<String>,
    /// The manifest as it reads now: contributions, requested permissions; `None` when it does not read.
    pub manifest: Option<ExtensionManifest>,
    /// What the user agreed to; API calls are decided against this.
    pub granted: ExtensionPermissions,
    #[ts(type = "number")]
    pub installed_at: u64,
    /// Where its files are served from, ending with `/` (per OS, see [`protocol::base_url`]).
    pub base_url: String,
    /// `base_url` + the manifest's `entry`; `None` when the manifest does not read.
    pub entry_url: Option<String>,
}

/// What the host tells the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostEvent {
    /// `extensions-changed`: the list, a state or a manifest changed.
    ListChanged,
    /// `extension-files-changed {id}`: files of a development folder changed (reload its frames).
    FilesChanged { id: String },
}

type Emitter = Arc<dyn Fn(HostEvent) + Send + Sync>;

/// A manifest read for one installed entry, kept until the entry's source or version changes (or a reload).
struct Loaded {
    key: String,
    manifest: Result<ExtensionManifest, String>,
    /// `asks_within(manifest, granted, granted_backend, granted_problems)` for these grants.
    granted: ExtensionPermissions,
    granted_backend: Option<BackendGrant>,
    granted_problems: Option<Vec<KindPattern>>,
    within: bool,
}

/// Manifests read so far. A read runs outside the lock (a development folder is walked whole); `epoch` grows with every
/// [`ExtensionHost::forget`], so a read that began before one is answered but not kept.
#[derive(Default)]
struct LoadedCache {
    map: HashMap<String, Loaded>,
    epoch: u64,
}

/// Called between reading a manifest and keeping it (tests: a slow folder).
#[cfg(test)]
type ReadHook = Arc<dyn Fn(&str) + Send + Sync>;

struct Inner {
    settings: Arc<SettingsStore>,
    /// `<data>/extensions`: installed versions.
    extensions_dir: PathBuf,
    /// `<data>/extensions-pending`: archives waiting for consent.
    pending_dir: PathBuf,
    /// `<data>/extensions-data`: an extension's `storage` (`<id>.json`).
    data_dir: PathBuf,
    loaded: Mutex<LoadedCache>,
    pending: Mutex<manage::PendingInstalls>,
    /// Serializes install, enable and remove.
    changes: Mutex<()>,
    dev: Mutex<dev::DevWatch>,
    emitter: Mutex<Option<Emitter>>,
    downloader: Downloader,
    /// The catalog's index as last fetched (`<data>/extension-catalog`).
    catalog: catalog::CatalogCache,
    /// Backends: the runtime, what is compiled, running calls, logs, credentials (ADR-0131).
    backends: backend::Backends,
    #[cfg(test)]
    read_hook: Mutex<Option<ReadHook>>,
}

/// Managed state of the extension host. Cheap to clone.
#[derive(Clone)]
pub struct ExtensionHost {
    inner: Arc<Inner>,
}

/// An [`ExtensionHost`] that does not keep it alive (for its own emitter, which the host keeps).
#[derive(Clone)]
pub struct WeakExtensionHost {
    inner: std::sync::Weak<Inner>,
}

impl WeakExtensionHost {
    pub fn upgrade(&self) -> Option<ExtensionHost> {
        self.inner.upgrade().map(|inner| ExtensionHost { inner })
    }
}

impl ExtensionHost {
    /// Installed versions go to `<data_dir>/extensions`. Leftovers of an interrupted install or remove, and archives
    /// that were waiting for consent when the app stopped, are deleted.
    pub fn new(data_dir: &Path, settings: Arc<SettingsStore>) -> Self {
        Self::with_downloader(data_dir, settings, Downloader::github())
    }

    /// [`ExtensionHost::new`] with another downloader (tests: a local fake server).
    pub fn with_downloader(
        data_dir: &Path,
        settings: Arc<SettingsStore>,
        downloader: Downloader,
    ) -> Self {
        let extensions_dir = data_dir.join("extensions");
        let pending_dir = data_dir.join("extensions-pending");
        sweep_leftovers(&extensions_dir);
        let _ = std::fs::remove_dir_all(&pending_dir);
        Self {
            inner: Arc::new(Inner {
                settings,
                extensions_dir,
                pending_dir,
                data_dir: data_dir.join("extensions-data"),
                loaded: Mutex::new(LoadedCache::default()),
                pending: Mutex::new(manage::PendingInstalls::default()),
                changes: Mutex::new(()),
                dev: Mutex::new(dev::DevWatch::default()),
                emitter: Mutex::new(None),
                downloader,
                catalog: catalog::CatalogCache::new(data_dir.join("extension-catalog")),
                backends: backend::Backends::new(data_dir, credential_store()),
                #[cfg(test)]
                read_hook: Mutex::new(None),
            }),
        }
    }

    /// A handle that does not keep the host alive.
    pub fn downgrade(&self) -> WeakExtensionHost {
        WeakExtensionHost {
            inner: Arc::downgrade(&self.inner),
        }
    }

    /// Where the window's events go (`extensions-changed`, `extension-files-changed`).
    pub fn set_emitter(&self, emitter: Emitter) {
        *lock(&self.inner.emitter) = Some(emitter);
    }

    /// Runs `hook` with the id between reading a manifest and keeping it (tests).
    #[cfg(test)]
    pub(crate) fn set_read_hook(&self, hook: ReadHook) {
        *lock(&self.inner.read_hook) = Some(hook);
    }

    fn emit(&self, event: HostEvent) {
        let emitter = lock(&self.inner.emitter).clone();
        if let Some(emitter) = emitter {
            emitter(event);
        }
    }

    /// `<data>/extensions`.
    pub fn extensions_dir(&self) -> &Path {
        &self.inner.extensions_dir
    }

    /// `<data>/extensions-data`: one `<id>.json` per extension for its `storage`; deleted with the extension.
    pub fn storage_dir(&self) -> &Path {
        &self.inner.data_dir
    }

    fn installed(&self) -> Vec<InstalledExtension> {
        self.inner.settings.get().extensions
    }

    fn installed_one(&self, id: &str) -> Option<InstalledExtension> {
        self.installed().into_iter().find(|e| e.id == id)
    }

    /// Every installed extension, in install order.
    pub fn list(&self) -> Vec<ExtensionInfo> {
        self.installed().iter().map(|e| self.info_of(e)).collect()
    }

    /// One installed extension.
    pub fn info(&self, id: &str) -> Option<ExtensionInfo> {
        self.installed_one(id).map(|e| self.info_of(&e))
    }

    /// Whether `id` is installed, enabled and within what was granted (its files are served, its calls considered).
    pub fn is_active(&self, id: &str) -> bool {
        self.info(id)
            .is_some_and(|i| i.state == ExtensionState::Active)
    }

    /// The installed entry of an active extension (what was granted), for the API (ticket 05).
    pub fn active(&self, id: &str) -> Option<InstalledExtension> {
        let entry = self.installed_one(id)?;
        (self.info_of(&entry).state == ExtensionState::Active).then_some(entry)
    }

    /// The folder files of an active extension are served from, and its entry file.
    pub(crate) fn serving_root(&self, id: &str) -> Option<(PathBuf, String)> {
        let entry = self.installed_one(id)?;
        let info = self.info_of(&entry);
        if info.state != ExtensionState::Active {
            return None;
        }
        Some((self.root_of(&entry)?, info.manifest?.entry))
    }

    /// The installed version folder, or the development folder.
    fn root_of(&self, entry: &InstalledExtension) -> Option<PathBuf> {
        match &entry.source {
            ExtensionSource::Folder { path } => Some(PathBuf::from(path)),
            ExtensionSource::File { .. }
            | ExtensionSource::Url { .. }
            | ExtensionSource::Catalog { .. } => {
                version_dir(&self.inner.extensions_dir, &entry.id, &entry.version)
            }
        }
    }

    /// Forgets the manifest read for `id` (and its compiled backend): the next look reads it again.
    fn forget(&self, id: &str) {
        {
            let mut loaded = lock(&self.inner.loaded);
            loaded.epoch += 1;
            loaded.map.remove(id);
        }
        self.forget_backend(id);
    }

    /// The manifest of `entry` and whether it is within `entry.granted`: kept from an earlier read while the entry's
    /// source and version stay the same, otherwise read again — outside the lock, so a slow folder holds up nobody
    /// else — and kept unless the manifest was forgotten (or read by someone else) meanwhile.
    fn manifest_of(&self, entry: &InstalledExtension) -> (Result<ExtensionManifest, String>, bool) {
        let key = format!("{:?}|{}", entry.source, entry.version);
        let answer = |current: &mut Loaded| {
            if current.granted != entry.granted
                || current.granted_backend != entry.granted_backend
                || current.granted_problems != entry.granted_problems
            {
                current.within = within(&current.manifest, entry);
                current.granted = entry.granted.clone();
                current.granted_backend = entry.granted_backend.clone();
                current.granted_problems = entry.granted_problems.clone();
            }
            (current.manifest.clone(), current.within)
        };
        let epoch = {
            let mut loaded = lock(&self.inner.loaded);
            if let Some(current) = loaded.map.get_mut(&entry.id).filter(|l| l.key == key) {
                return answer(current);
            }
            loaded.epoch
        };
        let manifest = self.read_manifest(entry);
        #[cfg(test)]
        {
            let hook = lock(&self.inner.read_hook).clone();
            if let Some(hook) = hook {
                hook(&entry.id);
            }
        }
        let mut read = Loaded {
            key,
            within: within(&manifest, entry),
            manifest,
            granted: entry.granted.clone(),
            granted_backend: entry.granted_backend.clone(),
            granted_problems: entry.granted_problems.clone(),
        };
        let mut loaded = lock(&self.inner.loaded);
        if let Some(current) = loaded.map.get_mut(&entry.id).filter(|l| l.key == read.key) {
            // Read by someone else meanwhile: theirs is as fresh as this one, or fresher.
            return answer(current);
        }
        if loaded.epoch == epoch {
            let answered = answer(&mut read);
            loaded.map.insert(entry.id.clone(), read);
            return answered;
        }
        answer(&mut read)
    }

    fn info_of(&self, entry: &InstalledExtension) -> ExtensionInfo {
        let (manifest, within) = self.manifest_of(entry);
        let (manifest, error) = match manifest {
            Ok(manifest) => (Some(manifest), None),
            Err(error) => (None, Some(error)),
        };
        let needs_consent = manifest.is_some() && !within;
        let state = if !entry.enabled {
            ExtensionState::Disabled
        } else if error.is_some() {
            ExtensionState::Failed
        } else if needs_consent {
            ExtensionState::NeedsConsent
        } else {
            ExtensionState::Active
        };
        let base_url = protocol::base_url(&entry.id);
        ExtensionInfo {
            id: entry.id.clone(),
            name: manifest
                .as_ref()
                .map_or_else(|| entry.name.clone(), |m| m.name.clone()),
            version: manifest
                .as_ref()
                .map_or_else(|| entry.version.clone(), |m| m.version.clone()),
            source: entry.source.clone(),
            dev: matches!(entry.source, ExtensionSource::Folder { .. }),
            enabled: entry.enabled,
            state,
            needs_consent,
            error,
            entry_url: manifest
                .as_ref()
                .map(|m| format!("{base_url}{}", protocol::encode_path(&m.entry))),
            manifest,
            granted: entry.granted.clone(),
            installed_at: entry.installed_at,
            base_url,
        }
    }

    /// Reads the manifest of an installed entry: a development folder is checked whole (as at install), an installed
    /// version only its manifest, which must still name the same id (and version).
    fn read_manifest(&self, entry: &InstalledExtension) -> Result<ExtensionManifest, String> {
        let manifest = match &entry.source {
            ExtensionSource::Folder { path } => inspect_folder(Path::new(path))
                .map(|p| p.manifest)
                .map_err(|e| e.message)?,
            ExtensionSource::File { .. }
            | ExtensionSource::Url { .. }
            | ExtensionSource::Catalog { .. } => {
                let root = self
                    .root_of(entry)
                    .ok_or_else(|| format!("`{}` {} is not installed", entry.id, entry.version))?;
                let file = resolve_package_file(&root, MANIFEST_FILE).map_err(|e| {
                    format!(
                        "the installed files cannot be read ({}); install it again",
                        e.message
                    )
                })?;
                let limit = sextant_core::extensions::manifest::MAX_MANIFEST_BYTES as u64 + 1;
                let bytes = manage::read_limited(file, limit).map_err(|e| e.message)?;
                let manifest = parse_manifest(&bytes).map_err(|e| e.to_string())?;
                if manifest.version != entry.version {
                    return Err(format!(
                        "the installed files are version {}, not {}; install it again",
                        manifest.version, entry.version
                    ));
                }
                manifest
            }
        };
        if manifest.id != entry.id {
            return Err(format!(
                "{MANIFEST_FILE} now names the id `{}`, not `{}`",
                manifest.id, entry.id
            ));
        }
        Ok(manifest)
    }
}

fn within(manifest: &Result<ExtensionManifest, String>, entry: &InstalledExtension) -> bool {
    manifest.as_ref().is_ok_and(|m| {
        asks_within(
            m,
            &entry.granted,
            entry.granted_backend.as_ref(),
            entry.granted_problems.as_deref(),
        )
    })
}

/// Backends' credentials: the OS keyring, or memory in tests.
fn credential_store() -> Arc<dyn backend::CredentialStore> {
    #[cfg(test)]
    {
        Arc::new(backend::MemoryCredentials::default())
    }
    #[cfg(not(test))]
    {
        Arc::new(backend::KeyringCredentials)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Packages, folders and hosts for the tests of this module.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use serde_json::{Value, json};

    /// Permissions: read everything everywhere.
    pub fn read_all() -> Value {
        json!({ "clusters": { "type": "all" }, "rules": [
            { "namespaces": { "type": "all" }, "kinds": { "type": "all" }, "actions": ["read"], "confirm": false }
        ] })
    }

    /// Permissions: read and modify everything everywhere (wider than [`read_all`]).
    pub fn modify_all() -> Value {
        json!({ "clusters": { "type": "all" }, "rules": [
            { "namespaces": { "type": "all" }, "kinds": { "type": "all" }, "actions": ["read", "modify"], "confirm": true }
        ] })
    }

    pub fn manifest(id: &str, version: &str, permissions: Value) -> String {
        json!({
            "id": id, "name": format!("Ext {id}"), "version": version, "description": "", "author": "Me",
            "sextantApi": 1, "entry": "index.html", "permissions": permissions, "contributes": {}
        })
        .to_string()
    }

    /// A package folder: the manifest, `index.html` and `js/app.js`.
    pub fn write_folder(dir: &Path, id: &str, version: &str, permissions: Value) {
        std::fs::create_dir_all(dir.join("js")).unwrap();
        std::fs::write(dir.join(MANIFEST_FILE), manifest(id, version, permissions)).unwrap();
        std::fs::write(dir.join("index.html"), "<p>hello</p>").unwrap();
        std::fs::write(dir.join("js/app.js"), "console.log(1)").unwrap();
    }

    /// The files of [`write_folder`] as an archive.
    pub fn package_zip(id: &str, version: &str, permissions: Value) -> Vec<u8> {
        let manifest = manifest(id, version, permissions);
        stored_zip(&[
            (MANIFEST_FILE, manifest.as_bytes()),
            ("index.html", b"<p>hello</p>"),
            ("js/app.js", b"console.log(1)"),
        ])
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for byte in data {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    /// A zip archive without compression (the format by hand: this crate has no zip writer).
    pub fn stored_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data) in files {
            let offset = out.len() as u32;
            let crc = crc32(data);
            let size = data.len() as u32;
            let name_len = name.len() as u16;
            let header = |sig: u32, central_entry: bool| {
                let mut h = Vec::new();
                h.extend_from_slice(&sig.to_le_bytes());
                if central_entry {
                    h.extend_from_slice(&20u16.to_le_bytes()); // made by
                }
                h.extend_from_slice(&20u16.to_le_bytes()); // needed
                h.extend_from_slice(&0u16.to_le_bytes()); // flags
                h.extend_from_slice(&0u16.to_le_bytes()); // stored
                h.extend_from_slice(&0u32.to_le_bytes()); // time, date
                h.extend_from_slice(&crc.to_le_bytes());
                h.extend_from_slice(&size.to_le_bytes());
                h.extend_from_slice(&size.to_le_bytes());
                h.extend_from_slice(&name_len.to_le_bytes());
                h.extend_from_slice(&0u16.to_le_bytes()); // extra
                if central_entry {
                    h.extend_from_slice(&0u16.to_le_bytes()); // comment
                    h.extend_from_slice(&0u16.to_le_bytes()); // disk
                    h.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
                    h.extend_from_slice(&0u32.to_le_bytes()); // external attributes
                    h.extend_from_slice(&offset.to_le_bytes());
                }
                h.extend_from_slice(name.as_bytes());
                h
            };
            let local = header(0x0403_4b50, false);
            let entry = header(0x0201_4b50, true);
            out.extend_from_slice(&local);
            out.extend_from_slice(data);
            central.extend_from_slice(&entry);
        }
        let central_offset = out.len() as u32;
        let count = files.len() as u16;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&central_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    /// A host with its settings and data inside `dir`.
    pub fn host_in(dir: &Path) -> ExtensionHost {
        host_with(dir, Downloader::github())
    }

    pub fn host_with(dir: &Path, downloader: Downloader) -> ExtensionHost {
        let settings = Arc::new(SettingsStore::open(
            dir.join("config").join("settings.json"),
        ));
        ExtensionHost::with_downloader(&dir.join("data"), settings, downloader)
    }

    /// Events the host emitted, in order.
    pub fn record(host: &ExtensionHost) -> Arc<Mutex<Vec<HostEvent>>> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        host.set_emitter(Arc::new(move |e| sink.lock().unwrap().push(e)));
        events
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::test_support::*;
    use super::*;

    #[test]
    fn a_slow_folder_read_holds_up_no_other_extension_and_a_stale_read_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let host = host_in(dir.path());
        for id in ["slow", "fast"] {
            let folder = dir.path().join(id);
            write_folder(&folder, id, "1.0.0", read_all());
            host.install(&host.inspect_folder(&folder).unwrap().token)
                .unwrap();
        }
        let (entered_tx, entered) = mpsc::channel();
        let (release, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        host.set_read_hook(Arc::new(move |id| {
            if id == "slow" {
                let _ = entered_tx.send(());
                let _ = lock(&release_rx).recv();
            }
        }));

        // `slow`'s folder is being read: `fast` is answered meanwhile.
        let slow = {
            let host = host.clone();
            std::thread::spawn(move || host.reload("slow").map(|i| i.state))
        };
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let (done_tx, done) = mpsc::channel();
        {
            let host = host.clone();
            std::thread::spawn(move || {
                let _ = done_tx.send(host.reload("fast").map(|i| i.state));
            });
        }
        let fast = done.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        assert_eq!(
            fast,
            Ok(Ok(ExtensionState::Active)),
            "another extension waited for a slow folder"
        );
        assert_eq!(slow.join().unwrap(), Ok(ExtensionState::Active));

        // The folder changes while it is read (and the read is forgotten): the old reading is not kept.
        let reading = {
            let host = host.clone();
            std::thread::spawn(move || host.reload("slow").map(|i| i.state))
        };
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        write_folder(&dir.path().join("slow"), "slow", "1.0.0", modify_all());
        host.forget("slow");
        release.send(()).unwrap();
        let _ = reading.join().unwrap();
        *lock(&host.inner.read_hook) = None;
        assert_eq!(
            host.info("slow").unwrap().state,
            ExtensionState::NeedsConsent,
            "the reading from before the change was kept"
        );
    }
}
