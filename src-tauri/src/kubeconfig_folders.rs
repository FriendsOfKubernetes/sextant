//! Kubeconfig folders followed while Sextant runs (#329, ADR-0148): every [`POLL_INTERVAL`] the folders the user added
//! are looked at (the names, sizes and modification times of their kubeconfig files; no file-watching crate). A change
//! tells the window `kubeconfig-folders-changed`, which reads the clusters again. A cluster whose file moved to another
//! subfolder of the same folder is kept as a pending move: the window applies it with `kubeconfig_folder_moves_apply`
//! between its own settings writes, so a stale copy of the settings never undoes it.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use sextant_core::kubeconfig::folders::{self, Moved};
use sextant_core::kubeconfig::{ClusterInfo, SourceKind};
use tauri::{Emitter, Manager, Runtime};

use crate::state::AppState;

/// How often the folders are looked at.
pub const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// The event the window gets when a folder's files changed.
pub const KUBECONFIG_FOLDERS_CHANGED: &str = "kubeconfig-folders-changed";

/// The moves found and not yet applied.
#[derive(Default)]
pub struct FolderWatch {
    pending: Mutex<Vec<Moved>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl FolderWatch {
    /// Takes the pending moves.
    pub fn take(&self) -> Vec<Moved> {
        std::mem::take(&mut *lock(&self.pending))
    }

    fn add(&self, moved: Vec<Moved>) {
        lock(&self.pending).extend(moved);
    }
}

/// What the folders hold now: a fingerprint of their files, and the clusters read from them (only when the fingerprint
/// is new). Blocking: files are listed and read.
fn look(state: &AppState, last: Option<u64>) -> (u64, Option<Vec<ClusterInfo>>) {
    let registry = state.registry.read().unwrap_or_else(|e| e.into_inner());
    let mut hasher = DefaultHasher::new();
    for folder in registry
        .added_sources()
        .iter()
        .filter(|s| s.kind == SourceKind::Folder)
    {
        folder.path.hash(&mut hasher);
        for (path, subfolder) in folders::scan(&folder.path).files {
            path.hash(&mut hasher);
            subfolder.hash(&mut hasher);
            if let Ok(meta) = std::fs::metadata(&path) {
                meta.len().hash(&mut hasher);
                meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .hash(&mut hasher);
            }
        }
    }
    let fingerprint = hasher.finish();
    if last == Some(fingerprint) {
        return (fingerprint, None);
    }
    (fingerprint, Some(registry.clusters().unwrap_or_default()))
}

/// Starts looking at the folders for as long as the app runs.
pub fn spawn_poller<R: Runtime>(app: &tauri::AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last: Option<u64> = None;
        let mut clusters: Option<Vec<ClusterInfo>> = None;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let looked = {
                let handle = handle.clone();
                let seen = last;
                tokio::task::spawn_blocking(move || look(&handle.state::<AppState>(), seen)).await
            };
            let Ok((fingerprint, now)) = looked else {
                continue;
            };
            last = Some(fingerprint);
            let Some(now) = now else {
                continue;
            };
            if let Some(before) = &clusters {
                let moved = folders::moved_clusters(before, &now);
                let any_moved = !moved.is_empty();
                handle.state::<AppState>().kubeconfig_folders.add(moved);
                let _ = handle.emit(KUBECONFIG_FOLDERS_CHANGED, any_moved);
            }
            clusters = Some(now);
        }
    });
}
