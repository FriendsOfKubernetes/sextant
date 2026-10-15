//! Development mode: an extension loaded from a folder runs from that folder, and the folder is looked at every
//! [`DEV_POLL_INTERVAL`] (sizes and modification times of its files; no file-watching crate). A change sends
//! `extension-files-changed {id}` (its frames reload) and, when the manifest or the state changed,
//! `extensions-changed` (contributions are registered again). A manifest that now asks for more than was granted
//! pauses the extension ([`ExtensionState::NeedsConsent`](super::ExtensionState)) until the user agrees again; one that
//! asks for less is granted only that from then on (what was granted narrows, never widens, without the user).

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use sextant_core::extensions::{
    ExtensionPermissions, ExtensionSource, InstalledExtension, MAX_FILES,
};

use super::{ExtensionHost, HostEvent, lock};

/// How often development folders are looked at.
pub const DEV_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// At most this many entries of a folder are looked at (a package has at most [`MAX_FILES`] files).
const MAX_ENTRIES: usize = MAX_FILES * 4;

/// The last look at each development folder.
#[derive(Default)]
pub(crate) struct DevWatch {
    fingerprints: HashMap<String, u64>,
}

impl DevWatch {
    /// Stops looking at `id` (removed).
    pub(crate) fn forget(&mut self, id: &str) {
        self.fingerprints.remove(id);
    }
}

/// Records how the folder of `id` looks now (installed, consented or reloaded: the window reads it fresh anyway),
/// so the next look reports only what changes after this.
pub(crate) fn remember(host: &ExtensionHost, id: &str) {
    let Some(entry) = host.installed_one(id) else {
        lock(&host.inner.dev).forget(id);
        return;
    };
    let ExtensionSource::Folder { path } = &entry.source else {
        lock(&host.inner.dev).forget(id);
        return;
    };
    let print = fingerprint(Path::new(path));
    lock(&host.inner.dev)
        .fingerprints
        .insert(id.to_owned(), print);
}

/// Names, sizes and modification times of what a package folder holds (entries starting with `.` and
/// `node_modules` are not part of the package, as in `inspect_folder`); links are not followed. A missing folder has
/// its own value.
fn fingerprint(root: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    let mut seen = 0usize;
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            (prefix.as_str(), "unreadable").hash(&mut hasher);
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            seen += 1;
            if seen > MAX_ENTRIES {
                return hasher.finish();
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") {
                continue;
            }
            let relative = format!("{prefix}/{name}");
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            (
                &relative,
                meta.len(),
                modified,
                meta.is_dir(),
                meta.is_symlink(),
            )
                .hash(&mut hasher);
            if meta.is_dir() {
                pending.push((entry.path(), relative));
            }
        }
    }
    hasher.finish()
}

/// One look at every development folder; returns the events to send.
pub fn poll(host: &ExtensionHost) -> Vec<HostEvent> {
    let folders: Vec<_> = host
        .installed()
        .into_iter()
        .filter(|e| matches!(e.source, ExtensionSource::Folder { .. }))
        .collect();
    let prints: Vec<u64> = folders
        .iter()
        .map(|entry| match &entry.source {
            ExtensionSource::Folder { path } => fingerprint(Path::new(path)),
            _ => 0,
        })
        .collect();
    let mut changed = Vec::new();
    {
        let mut watch = lock(&host.inner.dev);
        watch
            .fingerprints
            .retain(|id, _| folders.iter().any(|e| &e.id == id));
        for (entry, print) in folders.iter().zip(prints) {
            let before = watch.fingerprints.insert(entry.id.clone(), print);
            if before.is_some_and(|before| before != print) {
                changed.push(entry);
            }
        }
    }
    let mut events = Vec::new();
    let mut list_changed = false;
    for entry in changed {
        let before = host.info_of(entry);
        host.forget(&entry.id);
        let after = host.info_of(entry);
        list_changed |= before != after;
        events.push(HostEvent::FilesChanged {
            id: entry.id.clone(),
        });
    }
    // Every folder, not only the changed ones: a manifest read again by `extension_reload` counts too.
    for entry in &folders {
        let info = host.info_of(entry);
        if let Some(manifest) = info.manifest.filter(|_| !info.needs_consent) {
            list_changed |= narrow_grant(host, entry, &manifest.permissions);
        }
    }
    if list_changed {
        events.push(HostEvent::ListChanged);
    }
    events
}

/// A manifest that asks for less than was granted (within it, not equal) becomes what is granted, so the extension
/// never keeps more than it asks for; streams opened under the wider grant stop on the `extensions-changed` that
/// follows. Only while the entry is still the one that was read (no install, consent or removal meanwhile). `true`
/// when the grant was narrowed.
fn narrow_grant(
    host: &ExtensionHost,
    entry: &InstalledExtension,
    asked: &ExtensionPermissions,
) -> bool {
    if *asked == entry.granted || !asked.is_within(&entry.granted) {
        return false;
    }
    let _changes = lock(&host.inner.changes);
    let mut narrowed = false;
    let saved = host.inner.settings.update(|settings| {
        if let Some(slot) = settings.extensions.iter_mut().find(|e| {
            e.id == entry.id
                && e.source == entry.source
                && e.version == entry.version
                && e.granted == entry.granted
        }) {
            slot.granted = asked.clone();
            narrowed = true;
        }
    });
    saved.is_ok() && narrowed
}

/// One look at every development folder, its events sent (the poller runs it off the async runtime: the host's
/// emitter reads manifests again to stop streams).
pub fn look(host: &ExtensionHost) {
    for event in poll(host) {
        host.emit(event);
    }
}

/// Looks at the development folders every [`DEV_POLL_INTERVAL`] for as long as the app runs.
pub fn spawn_poller(host: ExtensionHost) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(DEV_POLL_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let looked = host.clone();
            let _ = tokio::task::spawn_blocking(move || look(&looked)).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::ExtensionState;
    use crate::extensions::test_support::*;

    #[test]
    fn a_changed_file_reloads_frames_and_a_wider_manifest_pauses_until_consent() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("src");
        write_folder(&folder, "widgets", "1.0.0", read_all());
        let host = host_in(dir.path());
        host.install(&host.inspect_folder(&folder).unwrap().token)
            .unwrap();
        assert!(host.list()[0].dev);
        assert!(poll(&host).is_empty(), "nothing changed since the install");

        std::fs::write(folder.join("js/app.js"), "console.log('changed')").unwrap();
        assert_eq!(
            poll(&host),
            vec![HostEvent::FilesChanged {
                id: "widgets".into()
            }]
        );
        std::fs::write(folder.join(".git-like"), "ignored").unwrap();
        assert!(
            poll(&host).is_empty(),
            "dot files are not part of the package"
        );

        write_folder(&folder, "widgets", "1.0.1", modify_all());
        assert_eq!(
            poll(&host),
            vec![
                HostEvent::FilesChanged {
                    id: "widgets".into()
                },
                HostEvent::ListChanged
            ]
        );
        let info = host.info("widgets").unwrap();
        assert!(info.needs_consent && info.enabled);
        assert_eq!(info.state, ExtensionState::NeedsConsent);
        assert!(!host.is_active("widgets"));

        let consent = host.inspect_folder(&folder).unwrap();
        assert!(consent.new_permissions);
        assert_eq!(consent.replaces.as_deref(), Some("1.0.0"));
        let info = host.install(&consent.token).unwrap();
        assert_eq!(info.state, ExtensionState::Active);
        assert!(host.is_active("widgets"));

        std::fs::remove_file(folder.join("sextant-extension.json")).unwrap();
        assert_eq!(
            poll(&host),
            vec![
                HostEvent::FilesChanged {
                    id: "widgets".into()
                },
                HostEvent::ListChanged
            ]
        );
        assert_eq!(host.info("widgets").unwrap().state, ExtensionState::Failed);
    }

    #[test]
    fn a_manifest_that_asks_for_less_is_granted_only_that_also_after_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("src");
        write_folder(&folder, "widgets", "1.0.0", modify_all());
        let host = host_in(dir.path());
        host.install(&host.inspect_folder(&folder).unwrap().token)
            .unwrap();
        let granted = |host: &ExtensionHost| host.info("widgets").unwrap().granted;
        let as_perms =
            |v: serde_json::Value| serde_json::from_value::<ExtensionPermissions>(v).unwrap();
        assert_eq!(granted(&host), as_perms(modify_all()));

        write_folder(&folder, "widgets", "1.0.1", read_all());
        assert_eq!(
            poll(&host),
            vec![
                HostEvent::FilesChanged {
                    id: "widgets".into()
                },
                HostEvent::ListChanged
            ]
        );
        assert_eq!(granted(&host), as_perms(read_all()));
        assert_eq!(host.info("widgets").unwrap().state, ExtensionState::Active);
        let saved = sextant_core::SettingsStore::open(dir.path().join("config/settings.json"));
        assert_eq!(saved.get().extensions[0].granted, as_perms(read_all()));
        assert!(poll(&host).is_empty(), "narrowed once");

        // Read again by `extension_reload` (no change left for the poller to see): narrowed on the next look.
        let team_a = serde_json::json!({ "clusters": { "type": "all" }, "rules": [
            { "namespaces": { "type": "only", "namespaces": ["team-a"] }, "kinds": { "type": "all" },
              "actions": ["read"], "confirm": false }
        ] });
        write_folder(&folder, "widgets", "1.0.2", team_a.clone());
        host.reload("widgets").unwrap();
        assert_eq!(poll(&host), vec![HostEvent::ListChanged]);
        assert_eq!(granted(&host), as_perms(team_a));

        // Wider again: paused, the grant stays as narrowed.
        write_folder(&folder, "widgets", "1.0.3", read_all());
        poll(&host);
        let info = host.info("widgets").unwrap();
        assert_eq!(info.state, ExtensionState::NeedsConsent);
        assert_ne!(info.granted, as_perms(read_all()));
    }

    #[tokio::test]
    async fn the_poller_sends_the_change_within_about_a_second() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("src");
        write_folder(&folder, "widgets", "1.0.0", read_all());
        let host = host_in(dir.path());
        host.install(&host.inspect_folder(&folder).unwrap().token)
            .unwrap();
        let events = record(&host);
        let poller = spawn_poller(host.clone());
        std::fs::write(folder.join("index.html"), "<p>changed!</p>").unwrap();
        let deadline = std::time::Instant::now() + DEV_POLL_INTERVAL * 3;
        let expected = HostEvent::FilesChanged {
            id: "widgets".into(),
        };
        while !events.lock().unwrap().contains(&expected) {
            assert!(std::time::Instant::now() < deadline, "no event in time");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        poller.abort();
    }
}
