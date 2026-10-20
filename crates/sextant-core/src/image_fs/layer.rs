//! Reading one layer stream (ADR-0103): the compressed bytes are counted, hashed and bounded ([`limits`]), decompressed
//! (gzip, zstd) under a ratio limit, and read as tar into a [`LayerIndex`] — or searched for one file's data
//! ([`extract_file`]). Nothing is written to disk here.

pub mod tar;

use std::cell::{Cell, RefCell};
use std::io::{BufRead, BufReader, Read, Write};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use flate2::read::MultiGzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use self::tar::{RawEntry, TarStream};
use super::manifest::{Compression, hex_digest};
use super::{EntryKind, limits, refused};
use crate::{CoreError, CoreResult, ErrorCode};

/// The largest zstd window accepted (zstd's default limit without `--long`).
const MAX_ZSTD_WINDOW: u64 = 128 * 1024 * 1024;

/// One entry of a layer, its path normalised (no leading `/`, no `.` or `..` components, never empty).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerEntry {
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub mode: u32,
    pub uid: u64,
    pub gid: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub mtime: u64,
    /// A symlink's target as written; a hard link's normalised path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// What one layer adds and removes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerIndex {
    pub entries: Vec<LayerEntry>,
    /// Paths removed from lower layers (`.wh.<name>`).
    pub whiteouts: Vec<String>,
    /// Folders whose lower-layer entries are hidden (`.wh..wh..opq`); `""` is the root.
    pub opaque: Vec<String>,
    /// Entries left out: a `..` component, an empty or over-long path or link.
    pub skipped: u32,
}

/// How to read one layer stream.
#[derive(Debug, Clone)]
pub struct StreamOptions {
    pub compression: Compression,
    /// `sha256:<hex>` the compressed bytes must hash to.
    pub digest: String,
    /// Compressed bytes allowed (the descriptor's size, capped by [`limits::MAX_LAYER_COMPRESSED`]).
    pub max_compressed: u64,
    pub cancel: Arc<AtomicBool>,
}

/// Normalises a tar path: `./` and `/` prefixes and `.` components dropped; `None` for `..`, empty or too long.
pub fn normalize(raw: &str) -> Option<String> {
    if raw.len() > limits::MAX_PATH_BYTES {
        return None;
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

#[derive(Default)]
struct Guard {
    compressed: Cell<u64>,
    decompressed: Cell<u64>,
    reason: RefCell<Option<CoreError>>,
}

impl Guard {
    fn fail(&self, err: CoreError) -> std::io::Error {
        let mut reason = self.reason.borrow_mut();
        if reason.is_none() {
            *reason = Some(err);
        }
        std::io::Error::other("stopped")
    }

    fn error(&self, err: std::io::Error) -> CoreError {
        self.reason.borrow_mut().take().unwrap_or_else(|| {
            CoreError::new(
                ErrorCode::Unreachable,
                format!("the layer could not be read: {err}"),
            )
        })
    }
}

struct Raw<'a, R> {
    inner: R,
    hasher: Sha256,
    max: u64,
    cancel: Arc<AtomicBool>,
    guard: Rc<Guard>,
    progress: &'a mut dyn FnMut(u64),
}

impl<R: Read> Read for Raw<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(self.guard.fail(CoreError::other("stopped")));
        }
        let n = self.inner.read(buf)?;
        let total = self.guard.compressed.get() + n as u64;
        if total > self.max {
            return Err(self
                .guard
                .fail(refused("a layer is larger than its descriptor allows")));
        }
        self.guard.compressed.set(total);
        self.hasher.update(&buf[..n]);
        if n > 0 {
            (self.progress)(total);
        }
        Ok(n)
    }
}

/// The compressed reader shared by the decompressor and the final drain.
struct Shared<'a, R>(Rc<RefCell<Raw<'a, R>>>);

impl<R: Read> Read for Shared<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.borrow_mut().read(buf)
    }
}

/// Decompressed bytes under the ratio and size limits.
struct Expanded<D> {
    inner: D,
    guard: Rc<Guard>,
}

impl<D: Read> Read for Expanded<D> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        let total = self.guard.decompressed.get() + n as u64;
        let allowed = limits::RATIO_SLACK.saturating_add(
            self.guard
                .compressed
                .get()
                .saturating_mul(limits::MAX_RATIO),
        );
        if total > limits::MAX_LAYER_UNCOMPRESSED {
            return Err(self
                .guard
                .fail(refused("a layer is larger than 16 GiB unpacked")));
        }
        if total > allowed {
            return Err(self.guard.fail(refused(
                "a layer unpacks to far more than its compressed size (a compression bomb)",
            )));
        }
        self.guard.decompressed.set(total);
        Ok(n)
    }
}

/// zstd frames one after another (a layer may hold several).
struct ZstdFrames<R: Read> {
    source: Option<BufReader<R>>,
    decoder:
        Option<ruzstd::decoding::StreamingDecoder<BufReader<R>, ruzstd::decoding::FrameDecoder>>,
}

impl<R: Read> Read for ZstdFrames<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if let Some(decoder) = self.decoder.as_mut() {
                let n = decoder.read(buf)?;
                if n > 0 || buf.is_empty() {
                    return Ok(n);
                }
                self.source = self.decoder.take().map(|d| d.into_inner());
            }
            let Some(mut source) = self.source.take() else {
                return Ok(0);
            };
            if source.fill_buf()?.is_empty() {
                return Ok(0);
            }
            let decoder = ruzstd::decoding::StreamingDecoder::new_with_max_window_size(
                source,
                MAX_ZSTD_WINDOW,
            )
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
            self.decoder = Some(decoder);
        }
    }
}

/// A layer stream being read: its tar entries, then [`Layer::finish`] drains and verifies it.
struct Layer<'a, R: Read> {
    tar: TarStream<Box<dyn Read + 'a>>,
    raw: Rc<RefCell<Raw<'a, R>>>,
    guard: Rc<Guard>,
    digest: String,
}

impl<'a, R: Read + 'a> Layer<'a, R> {
    fn open(inner: R, options: &StreamOptions, progress: &'a mut dyn FnMut(u64)) -> Self {
        let guard = Rc::new(Guard::default());
        let raw = Rc::new(RefCell::new(Raw {
            inner,
            hasher: Sha256::new(),
            max: options.max_compressed.min(limits::MAX_LAYER_COMPRESSED),
            cancel: Arc::clone(&options.cancel),
            guard: Rc::clone(&guard),
            progress,
        }));
        let shared = Shared(Rc::clone(&raw));
        let decoded: Box<dyn Read + 'a> = match options.compression {
            Compression::None => Box::new(shared),
            Compression::Gzip => Box::new(MultiGzDecoder::new(shared)),
            Compression::Zstd => Box::new(ZstdFrames {
                source: Some(BufReader::new(shared)),
                decoder: None,
            }),
        };
        let expanded: Box<dyn Read + 'a> = Box::new(Expanded {
            inner: decoded,
            guard: Rc::clone(&guard),
        });
        Self {
            tar: TarStream::new(expanded),
            raw,
            guard,
            digest: options.digest.clone(),
        }
    }

    fn next(&mut self) -> CoreResult<Option<RawEntry>> {
        match self.tar.next_entry() {
            Ok(result) => result,
            Err(e) => Err(self.guard.error(e)),
        }
    }

    /// Reads the rest (decompressed, then any compressed bytes after the end) and checks the digest.
    fn finish(self) -> CoreResult<()> {
        let mut decoded = self.tar.into_inner();
        std::io::copy(&mut decoded, &mut std::io::sink()).map_err(|e| self.guard.error(e))?;
        drop(decoded);
        let mut raw = self.raw.borrow_mut();
        std::io::copy(&mut *raw, &mut std::io::sink()).map_err(|e| self.guard.error(e))?;
        let actual = hex_digest(&raw.hasher.clone().finalize());
        if actual != self.digest {
            return Err(refused("a layer does not match its digest"));
        }
        Ok(())
    }
}

fn kind_of(entry: &RawEntry) -> EntryKind {
    match entry.flag {
        b'0' | 0 | b'7' if entry.path.ends_with('/') => EntryKind::Directory,
        b'0' | 0 | b'7' => EntryKind::File,
        b'5' => EntryKind::Directory,
        b'2' => EntryKind::Symlink,
        b'1' => EntryKind::Hardlink,
        _ => EntryKind::Other,
    }
}

/// What is left of an image's index budget: entries ([`limits::MAX_ENTRIES`]) and path bytes
/// ([`limits::MAX_INDEX_BYTES`]) over all its layers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub entries: usize,
    pub bytes: u64,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            entries: limits::MAX_ENTRIES,
            bytes: limits::MAX_INDEX_BYTES,
        }
    }
}

impl Budget {
    fn take(&mut self, bytes: usize) -> CoreResult<()> {
        if self.entries == 0 {
            return Err(refused(format!(
                "the image has more than {} files",
                limits::MAX_ENTRIES
            )));
        }
        if self.bytes < bytes as u64 {
            return Err(refused("the image's file names take more than 64 MiB"));
        }
        self.entries -= 1;
        self.bytes -= bytes as u64;
        Ok(())
    }

    /// Charges a layer index read from the cache as if it had been read now.
    pub fn charge(&mut self, index: &LayerIndex) -> CoreResult<()> {
        for entry in &index.entries {
            self.take(entry.path.len() + entry.link.as_ref().map_or(0, String::len))?;
        }
        for path in index.whiteouts.iter().chain(&index.opaque) {
            self.take(path.len())?;
        }
        Ok(())
    }
}

/// Indexes a layer stream (verifying its digest) within the image's `budget`; `progress` gets the compressed bytes
/// read so far.
pub fn index_layer<R: Read>(
    inner: R,
    options: &StreamOptions,
    budget: &mut Budget,
    progress: &mut dyn FnMut(u64),
) -> CoreResult<LayerIndex> {
    let mut layer = Layer::open(inner, options, progress);
    let mut index = LayerIndex::default();
    while let Some(raw) = layer.next()? {
        budget.take(raw.path.len() + raw.link.as_ref().map_or(0, String::len))?;
        let kind = kind_of(&raw);
        let Some(path) = normalize(&raw.path) else {
            // The root folder's own entry (`./`) is no entry of the tree.
            if !matches!(raw.path.trim_matches('/'), "" | ".") {
                index.skipped += 1;
            }
            continue;
        };
        let (parent, name) = match path.rsplit_once('/') {
            Some((parent, name)) => (parent, name),
            None => ("", path.as_str()),
        };
        if let Some(hidden) = name.strip_prefix(".wh.") {
            if hidden == ".wh..opq" {
                index.opaque.push(parent.to_owned());
            } else if !hidden.is_empty() && hidden != "." && hidden != ".." {
                index.whiteouts.push(if parent.is_empty() {
                    hidden.to_owned()
                } else {
                    format!("{parent}/{hidden}")
                });
            } else {
                index.skipped += 1;
            }
            continue;
        }
        let link = match kind {
            EntryKind::Symlink => match raw.link.as_deref() {
                Some(l) if !l.is_empty() && l.len() <= limits::MAX_PATH_BYTES => Some(l.to_owned()),
                _ => {
                    index.skipped += 1;
                    continue;
                }
            },
            EntryKind::Hardlink => match raw.link.as_deref().and_then(normalize) {
                Some(target) => Some(target),
                None => {
                    index.skipped += 1;
                    continue;
                }
            },
            _ => None,
        };
        index.entries.push(LayerEntry {
            path,
            kind,
            size: if kind == EntryKind::File { raw.size } else { 0 },
            mode: raw.mode,
            uid: raw.uid,
            gid: raw.gid,
            user: raw.user,
            group: raw.group,
            mtime: raw.mtime,
            link,
        });
    }
    layer.finish()?;
    Ok(index)
}

/// What [`extract_file`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Extracted {
    /// The file's size in the layer.
    pub size: u64,
    /// Bytes written (at most the `max` asked for).
    pub written: u64,
}

/// Writes up to `max` bytes of the regular file `path` (normalised) of a layer stream to `out`. With `verify`, the
/// whole layer is read and its digest checked before returning (a download); without, reading stops at the file.
pub fn extract_file<R: Read>(
    inner: R,
    options: &StreamOptions,
    path: &str,
    max: u64,
    verify: bool,
    out: &mut dyn Write,
    progress: &mut dyn FnMut(u64),
) -> CoreResult<Extracted> {
    let mut layer = Layer::open(inner, options, progress);
    let mut found = None;
    while let Some(raw) = layer.next()? {
        if found.is_some()
            || kind_of(&raw) != EntryKind::File
            || normalize(&raw.path).as_deref() != Some(path)
        {
            continue;
        }
        let written = layer
            .tar
            .copy_data(raw.size, max, out)
            .map_err(|e| layer.guard.error(e))?;
        let extracted = Extracted {
            size: raw.size,
            written,
        };
        if !verify {
            return Ok(extracted);
        }
        found = Some(extracted);
    }
    if verify {
        layer.finish()?;
    }
    found.ok_or_else(|| CoreError::new(ErrorCode::NotFound, "the file is not in its layer"))
}
