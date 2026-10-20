//! Every bound of the image file viewer (ADR-0103) in one place.

use std::time::Duration;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// An image index, a manifest or an image config.
pub const MAX_MANIFEST_BYTES: u64 = 4 * MIB;
/// A token realm's answer.
pub const MAX_TOKEN_RESPONSE_BYTES: u64 = 64 * 1024;
/// Layers of one image.
pub const MAX_LAYERS: usize = 128;
/// A layer's compressed size, by its descriptor and by the bytes read.
pub const MAX_LAYER_COMPRESSED: u64 = 4 * GIB;
/// A layer's tar stream after decompression.
pub const MAX_LAYER_UNCOMPRESSED: u64 = 16 * GIB;
/// Bytes downloaded for one open (cached layers are not downloaded).
pub const MAX_TOTAL_COMPRESSED: u64 = 8 * GIB;
/// Decompressed bytes may be at most this plus [`MAX_RATIO`] × the compressed bytes read so far.
pub const RATIO_SLACK: u64 = 64 * MIB;
/// See [`RATIO_SLACK`]: stops gzip and zstd bombs early.
pub const MAX_RATIO: u64 = 200;
/// Entries over all layers of an image (whiteouts included).
pub const MAX_ENTRIES: usize = 300_000;
/// A path or a link target, in bytes.
pub const MAX_PATH_BYTES: usize = 4096;
/// Long-name and pax header records before one entry.
pub const MAX_HEADER_BYTES: u64 = 2 * MIB;
/// Entries listed for one folder.
pub const MAX_DIR_ENTRIES: usize = 10_000;
/// Matches of one search.
pub const MAX_SEARCH_RESULTS: usize = 500;
/// The searched text, in characters.
pub const MAX_SEARCH_CHARS: usize = 256;
/// Bytes of a file the text view shows.
pub const MAX_TEXT_BYTES: u64 = 1024 * 1024;
/// Bytes looked at for a NUL to call a file binary.
pub const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// A single downloaded file.
pub const MAX_DOWNLOAD_BYTES: u64 = 4 * GIB;
/// Links followed to resolve a symbolic link inside the image.
pub const MAX_SYMLINK_HOPS: usize = 40;
/// Path and link bytes over all layers' entries of an image.
pub const MAX_INDEX_BYTES: u64 = 64 * MIB;
/// Path bytes of the merged tree (implicit parent folders included).
pub const MAX_TREE_BYTES: u64 = 128 * MIB;
/// One cached layer index.
pub const MAX_CACHE_ENTRY_BYTES: u64 = 64 * MIB;
/// The whole index cache.
pub const MAX_CACHE_BYTES: u64 = 256 * MIB;
/// Images open at once.
pub const MAX_OPEN_IMAGES: usize = 4;
/// No data from the registry for this long ends a download.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Opening one image (manifests and every layer).
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Reading one file (the text view or a download).
pub const READ_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Redirects of a blob download.
pub const MAX_BLOB_REDIRECTS: usize = 5;
/// A credential helper's run.
pub const HELPER_TIMEOUT: Duration = Duration::from_secs(10);
/// A credential helper's output.
pub const MAX_HELPER_OUTPUT: usize = 64 * 1024;
/// An image reference, in bytes.
pub const MAX_REFERENCE_BYTES: usize = 512;
