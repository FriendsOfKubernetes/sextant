//! The disk cache of layer indexes (ADR-0103): `<dir>/<sha256 hex>.json` per verified layer — its file list, never
//! its content — at most [`limits::MAX_CACHE_ENTRY_BYTES`] each and [`limits::MAX_CACHE_BYTES`] in all, the least
//! recently used removed first. A file that does not read (another version, damage) is deleted. Blocking file I/O:
//! callers run it off the async runtime.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::layer::LayerIndex;
use super::limits;
use super::reference::check_digest;

const FORMAT: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Cached {
    format: u32,
    digest: String,
    index: LayerIndex,
}

#[derive(Debug, Clone)]
pub struct IndexCache {
    dir: PathBuf,
    max_total: u64,
}

impl IndexCache {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            max_total: limits::MAX_CACHE_BYTES,
        }
    }

    pub fn with_max_total(mut self, bytes: u64) -> Self {
        self.max_total = bytes;
        self
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file(&self, digest: &str) -> Option<PathBuf> {
        check_digest(digest).ok()?;
        Some(self.dir.join(format!("{}.json", &digest[7..])))
    }

    /// The cached index of the layer `digest`, if any; marks it as just used.
    pub fn get(&self, digest: &str) -> Option<LayerIndex> {
        let path = self.file(digest)?;
        let meta = std::fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > limits::MAX_CACHE_ENTRY_BYTES {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        let bytes = std::fs::read(&path).ok()?;
        match serde_json::from_slice::<Cached>(&bytes) {
            Ok(cached) if cached.format == FORMAT && cached.digest == digest => {
                if let Ok(file) = std::fs::File::options().append(true).open(&path) {
                    let _ = file.set_modified(SystemTime::now());
                }
                Some(cached.index)
            }
            _ => {
                let _ = std::fs::remove_file(&path);
                None
            }
        }
    }

    /// Keeps the index of the verified layer `digest`, then trims the cache to its size. Failures are ignored: the
    /// cache only saves downloads.
    pub fn put(&self, digest: &str, index: &LayerIndex) {
        let Some(path) = self.file(digest) else {
            return;
        };
        let cached = Cached {
            format: FORMAT,
            digest: digest.to_owned(),
            index: index.clone(),
        };
        let Ok(bytes) = serde_json::to_vec(&cached) else {
            return;
        };
        if bytes.len() as u64 > limits::MAX_CACHE_ENTRY_BYTES
            || std::fs::create_dir_all(&self.dir).is_err()
        {
            return;
        }
        let Ok(mut temp) = tempfile::Builder::new()
            .prefix(".index-")
            .suffix(".tmp")
            .tempfile_in(&self.dir)
        else {
            return;
        };
        if std::io::Write::write_all(&mut temp, &bytes).is_err() || temp.persist(&path).is_err() {
            return;
        }
        self.prune();
    }

    /// Removes the least recently used indexes until the cache fits its size.
    pub fn prune(&self) {
        let Ok(dir) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = dir
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                let meta = std::fs::symlink_metadata(&path).ok()?;
                (meta.is_file() && path.extension().is_some_and(|x| x == "json")).then(|| {
                    (
                        meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        meta.len(),
                        path,
                    )
                })
            })
            .collect();
        let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
        files.sort_by_key(|f| f.0);
        for (_, len, path) in files {
            if total <= self.max_total {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                total -= len;
            }
        }
    }
}
