//! Extension packages: a `.zip` / `.sextant-ext` archive or an unpacked folder, checked before the user is asked
//! anything, and installed into `<extensions dir>/<id>/<version>/`.
//!
//! Checks (story 12): every path is relative and stays inside the package (no `..`, `.`, empty segment, absolute
//! path, drive letter, `\` or `:`), no symbolic links, no names that collide on a case-insensitive file system, at most
//! [`MAX_FILES`] files and [`MAX_UNPACKED_BYTES`] unpacked (counted while unpacking, not from what the archive
//! claims), `sextant-extension.json` at the top and valid, its `entry` present. An archive is unpacked into memory
//! only; nothing touches the disk until [`install`].

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::manifest::{
    ExtensionManifest, MANIFEST_FILE, is_extension_id, is_package_path, is_semver,
    is_servable_path, parse_manifest,
};
use crate::error::{CoreError, CoreResult, ErrorCode};

/// At most this many files in a package.
pub const MAX_FILES: usize = 2000;

/// At most this many bytes unpacked (50 MB).
pub const MAX_UNPACKED_BYTES: u64 = 50 * 1024 * 1024;

/// Prefixes of the temporary entries [`install`] and [`remove`] create; [`sweep_leftovers`] deletes what a crash
/// left behind.
const STAGING_PREFIX: &str = ".staging-";
const REMOVING_PREFIX: &str = ".removing-";
const OLD_PREFIX: &str = ".old-";

#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    files: usize,
    bytes: u64,
}

const LIMITS: Limits = Limits {
    files: MAX_FILES,
    bytes: MAX_UNPACKED_BYTES,
};

/// One file of a package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageFile {
    /// `/`-separated, relative to the package root.
    pub path: String,
    pub size: u64,
}

/// A package that passed every check, with its manifest; ready for the consent dialog and [`install`].
#[derive(Clone)]
pub struct Package {
    pub manifest: ExtensionManifest,
    pub files: Vec<PackageFile>,
    content: Content,
}

#[derive(Clone)]
enum Content {
    /// Unpacked archive: one buffer per entry of `files`.
    Archive(Vec<Vec<u8>>),
    /// A folder on disk (canonical path), read in place.
    Folder(PathBuf),
}

impl std::fmt::Debug for Package {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Package")
            .field("id", &self.manifest.id)
            .field("version", &self.manifest.version)
            .field("files", &self.files.len())
            .field("folder", &self.folder())
            .finish()
    }
}

impl Package {
    /// The folder the package was read from (canonical); `None` for an archive.
    pub fn folder(&self) -> Option<&Path> {
        match &self.content {
            Content::Folder(path) => Some(path),
            Content::Archive(_) => None,
        }
    }

    /// Unpacked size of all files.
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// What [`install`] wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledFiles {
    /// `<extensions dir>/<id>/<version>`.
    pub dir: PathBuf,
    pub files: usize,
    pub bytes: u64,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

fn io_error(what: &str, path: &Path, err: std::io::Error) -> CoreError {
    let base = CoreError::from(err);
    CoreError::new(
        base.code,
        format!("{what} {}: {}", path.display(), base.message),
    )
}

/// Names seen so far, compared ignoring case (Windows and macOS file systems): a second file with the same name, or
/// a file where a folder is (and the other way round), is refused.
#[derive(Default)]
struct Names {
    files: HashSet<String>,
    dirs: HashSet<String>,
}

impl Names {
    fn add_dir(&mut self, path: &str) -> CoreResult<()> {
        let lower = path.to_lowercase();
        if self.files.contains(&lower) {
            return Err(invalid(format!(
                "the package has both a file and a folder named `{path}`"
            )));
        }
        self.dirs.insert(lower);
        Ok(())
    }

    fn add_file(&mut self, path: &str) -> CoreResult<()> {
        let lower = path.to_lowercase();
        if self.files.contains(&lower) {
            return Err(invalid(format!(
                "the package has `{path}` twice (names are compared ignoring case)"
            )));
        }
        if self.dirs.contains(&lower) {
            return Err(invalid(format!(
                "the package has both a file and a folder named `{path}`"
            )));
        }
        let segments: Vec<&str> = lower.split('/').collect();
        let folders = segments
            .split_last()
            .map_or(&[][..], |(_, folders)| folders);
        let mut prefix = String::new();
        for segment in folders {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(segment);
            if self.files.contains(&prefix) {
                return Err(invalid(format!(
                    "the package has both a file and a folder named `{prefix}` (in `{path}`)"
                )));
            }
            self.dirs.insert(prefix.clone());
        }
        self.files.insert(lower);
        Ok(())
    }
}

fn check_path(path: &str) -> CoreResult<()> {
    if is_package_path(path) {
        Ok(())
    } else {
        Err(invalid(format!(
            "the package is not safe to install: `{path}` is not a plain relative path inside the package"
        )))
    }
}

/// Opens the file `request` (a `/`-separated path, e.g. `dist/app.js`) inside an installed version folder or a
/// development folder `root`, checked now, at the time of the request, and returns it open, so nothing can be swapped
/// in between the check and the read:
/// - a [plain relative path](is_package_path) Sextant serves: no part starting with `.`, no `node_modules` (any case);
/// - every part is exactly the name on disk (read from its folder, each folder listed once per request): another
///   spelling of an existing name — other case on a case-insensitive file system, a Windows 8.3 short name such as
///   `GIT~1` — is refused;
/// - no symbolic link in any part below `root` (on Windows: no name-surrogate reparse point — symbolic link, junction,
///   mount point; other reparse points such as OneDrive placeholders or deduplicated files are ordinary files); the
///   last part is a regular file;
/// - the file is opened without following a link in the last part (`O_NOFOLLOW` on Unix, the reparse point itself on
///   Windows), then every part of the path is checked again (not a link, folders then a file) and the path must still
///   lead to the file that was opened (same device and inode on Unix, same volume serial number and file index on
///   Windows), so a folder swapped for a link around the open is refused too.
///
/// `invalid` for an unsafe path, another spelling or a link; `notFound` when a part is missing (or a folder where a
/// file is expected).
pub fn resolve_package_file(root: &Path, request: &str) -> CoreResult<std::fs::File> {
    resolve_package_file_with(root, request, &mut Listings::default(), &mut |_| {})
}

/// The moments of [`resolve_package_file`] a test can act at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenStage {
    BeforeOpen,
    AfterOpen,
}

/// Folder listings read while resolving paths: each folder is read from disk at most once, however many parts or
/// files go through it. Only names (and their types as listed) are taken from here; whether a part is a link is
/// checked again on disk after the open ([`current_metadata`]).
#[derive(Default)]
struct Listings {
    /// Folder → its entries by exact name; the type is `None` when the folder listing could not tell it.
    folders: HashMap<PathBuf, HashMap<OsString, Option<std::fs::FileType>>>,
    /// How many folders were read from disk.
    reads: usize,
}

impl Listings {
    fn entries(
        &mut self,
        folder: &Path,
        request: &str,
    ) -> CoreResult<&HashMap<OsString, Option<std::fs::FileType>>> {
        match self.folders.entry(folder.to_path_buf()) {
            std::collections::hash_map::Entry::Occupied(entry) => Ok(entry.into_mut()),
            std::collections::hash_map::Entry::Vacant(slot) => {
                let read = std::fs::read_dir(folder).map_err(|err| {
                    if err.kind() == std::io::ErrorKind::NotFound {
                        not_a_file(request)
                    } else {
                        io_error("cannot read", folder, err)
                    }
                })?;
                let mut entries = HashMap::new();
                for entry in read {
                    let entry = entry.map_err(|err| io_error("cannot read", folder, err))?;
                    entries.insert(entry.file_name(), entry.file_type().ok());
                }
                self.reads += 1;
                Ok(slot.insert(entries))
            }
        }
    }
}

fn resolve_package_file_with(
    root: &Path,
    request: &str,
    listings: &mut Listings,
    at: &mut dyn FnMut(OpenStage),
) -> CoreResult<std::fs::File> {
    if !is_servable_path(request) {
        return Err(invalid(format!(
            "`{request}` is not a plain relative path inside the extension"
        )));
    }
    check_names(root, request, listings)?;
    at(OpenStage::BeforeOpen);
    let path = request
        .split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment));
    let file = open_no_follow(&path).map_err(|err| {
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            link_refused(request)
        } else {
            io_error("cannot read", &path, err)
        }
    })?;
    at(OpenStage::AfterOpen);
    let opened = file
        .metadata()
        .map_err(|err| io_error("cannot read", &path, err))?;
    if opened.file_type().is_symlink() {
        return Err(link_refused(request));
    }
    if !opened.is_file() {
        return Err(not_a_file(request));
    }
    let now = current_metadata(root, request)?;
    let same = same_file(&file, &opened, &path, &now)
        .map_err(|err| io_error("cannot read", &path, err))?;
    if !same {
        return Err(invalid(format!(
            "`{request}` changed while it was being opened; extensions cannot use links"
        )));
    }
    Ok(file)
}

fn link_refused(request: &str) -> CoreError {
    invalid(format!(
        "`{request}` goes through a symbolic link; extensions cannot use links"
    ))
}

fn not_a_file(request: &str) -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        format!("`{request}` is not a file in the extension"),
    )
}

/// Checks, from the folder listings, that every part of `request` below `root` is exactly a name on disk, not a link,
/// folders then a regular file.
fn check_names(root: &Path, request: &str, listings: &mut Listings) -> CoreResult<()> {
    let segments: Vec<&str> = request.split('/').collect();
    let mut path = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        let kind = exact_entry(listings, &path, segment, request)?;
        path.push(segment);
        if kind.is_symlink() {
            return Err(link_refused(request));
        }
        let last = index + 1 == segments.len();
        if (last && !kind.is_file()) || (!last && !kind.is_dir()) {
            return Err(not_a_file(request));
        }
    }
    Ok(())
}

/// What every part of `request` below `root` is on disk now (not following a link; no folder listing): refused if a
/// part is a link, or not a folder then a regular file. Returns what the last part is.
fn current_metadata(root: &Path, request: &str) -> CoreResult<std::fs::Metadata> {
    let segments: Vec<&str> = request.split('/').collect();
    let mut path = root.to_path_buf();
    let mut meta = None;
    for (index, segment) in segments.iter().enumerate() {
        path.push(segment);
        let part =
            std::fs::symlink_metadata(&path).map_err(|err| io_error("cannot read", &path, err))?;
        if part.file_type().is_symlink() {
            return Err(link_refused(request));
        }
        let last = index + 1 == segments.len();
        if (last && !part.is_file()) || (!last && !part.is_dir()) {
            return Err(not_a_file(request));
        }
        meta = Some(part);
    }
    meta.ok_or_else(|| not_a_file(request))
}

/// The type (not following a link) of the entry of `folder` named exactly `name`. No such entry: either another
/// spelling of an existing one (case, 8.3 short name) — `invalid` — or nothing — `notFound`.
fn exact_entry(
    listings: &mut Listings,
    folder: &Path,
    name: &str,
    request: &str,
) -> CoreResult<std::fs::FileType> {
    let listed = listings
        .entries(folder, request)?
        .get(std::ffi::OsStr::new(name))
        .copied();
    let path = folder.join(name);
    match listed {
        Some(Some(kind)) => Ok(kind),
        Some(None) => std::fs::symlink_metadata(&path)
            .map(|meta| meta.file_type())
            .map_err(|err| io_error("cannot read", &path, err)),
        None if std::fs::symlink_metadata(&path).is_ok() => Err(invalid(format!(
            "`{request}` does not name `{name}` exactly as it is on disk (another case or a short name)"
        ))),
        None => Err(CoreError::new(
            ErrorCode::NotFound,
            format!("`{request}` is not in the extension"),
        )),
    }
}

/// `O_NOFOLLOW` where its value is known without the `libc` crate; elsewhere 0, and the check after opening
/// ([`same_file`]) still refuses a link.
#[cfg(all(
    any(target_os = "linux", target_os = "android"),
    any(target_arch = "x86", target_arch = "x86_64")
))]
const O_NOFOLLOW: i32 = 0x20000;
#[cfg(all(
    any(target_os = "linux", target_os = "android"),
    any(target_arch = "arm", target_arch = "aarch64")
))]
const O_NOFOLLOW: i32 = 0x8000;
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
const O_NOFOLLOW: i32 = 0x100;
#[cfg(all(
    unix,
    not(any(
        all(
            any(target_os = "linux", target_os = "android"),
            any(
                target_arch = "x86",
                target_arch = "x86_64",
                target_arch = "arm",
                target_arch = "aarch64"
            )
        ),
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd",
        target_os = "dragonfly"
    ))
))]
const O_NOFOLLOW: i32 = 0;

/// Opens for reading without following a link in the last part.
///
/// On Windows the reparse point itself is opened; one that is not a link (`FileType::is_symlink` there means a
/// name-surrogate reparse point: symbolic link, junction, mount point) — a OneDrive placeholder, a deduplicated file —
/// is opened again normally, so the file system filter behind it serves the contents. Whatever ends up open is
/// checked against the path afterwards ([`same_file`]).
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        let file = options.open(path)?;
        let meta = file.metadata()?;
        if meta.file_type().is_symlink()
            || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
        {
            return Ok(file);
        }
        drop(file);
        options.custom_flags(0);
    }
    options.open(path)
}

/// Whether the open file (`file`, its metadata `opened`) and what `path` leads to now (`now`, not following a link)
/// are the same file.
#[cfg(unix)]
fn same_file(
    _file: &std::fs::File,
    opened: &std::fs::Metadata,
    _path: &Path,
    now: &std::fs::Metadata,
) -> std::io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(opened.dev() == now.dev() && opened.ino() == now.ino())
}

/// Whether the open file and what `path` leads to now (opened without following a link and without reading it) are
/// the same file: the same volume serial number and file index.
#[cfg(windows)]
fn same_file(
    file: &std::fs::File,
    _opened: &std::fs::Metadata,
    path: &Path,
    _now: &std::fs::Metadata,
) -> std::io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_OPEN_REPARSE_POINT, GetFileInformationByHandle,
    };
    fn file_id(file: &std::fs::File) -> std::io::Result<(u32, u64)> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: the handle is open for the lifetime of `file`; `info` is a valid out pointer.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok((
            info.dwVolumeSerialNumber,
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        ))
    }
    let now = std::fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    Ok(file_id(file)? == file_id(&now)?)
}

/// No file identity known on this system: never the same, so nothing is served.
#[cfg(not(any(unix, windows)))]
fn same_file(
    _file: &std::fs::File,
    _opened: &std::fs::Metadata,
    _path: &Path,
    _now: &std::fs::Metadata,
) -> std::io::Result<bool> {
    Ok(false)
}

/// Reads at most `limit` bytes of an open file.
fn read_open(mut file: std::fs::File, limit: u64, request: &str) -> CoreResult<Vec<u8>> {
    let mut buffer = Vec::new();
    (&mut file)
        .take(limit)
        .read_to_end(&mut buffer)
        .map_err(|err| invalid(format!("`{request}` cannot be read: {err}")))?;
    Ok(buffer)
}

fn too_many_files(limits: Limits) -> CoreError {
    invalid(format!("the package has more than {} files", limits.files))
}

fn too_large(limits: Limits) -> CoreError {
    invalid(format!(
        "the package unpacks to more than {} bytes",
        limits.bytes
    ))
}

/// Reads a `.zip` / `.sextant-ext` archive into memory and checks it.
pub fn inspect_zip(bytes: &[u8]) -> CoreResult<Package> {
    inspect_zip_with(bytes, LIMITS)
}

pub(crate) fn inspect_zip_with(bytes: &[u8], limits: Limits) -> CoreResult<Package> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|err| invalid(format!("the file is not a zip archive: {err}")))?;
    // Folder entries count too, but cannot be more than the files they hold (plus one per level, roughly).
    if archive.len() > limits.files.saturating_mul(2) {
        return Err(too_many_files(limits));
    }
    let mut names = Names::default();
    let mut files = Vec::new();
    let mut contents = Vec::new();
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| invalid(format!("the archive cannot be read: {err}")))?;
        let name = entry.name().to_owned();
        if entry.is_symlink() {
            return Err(invalid(format!(
                "the package is not safe to install: `{name}` is a symbolic link"
            )));
        }
        if entry.encrypted() {
            return Err(invalid(format!(
                "`{name}` is encrypted; encrypted archives are not supported"
            )));
        }
        if entry.is_dir() {
            let dir = name.strip_suffix('/').unwrap_or(&name);
            check_path(dir)?;
            names.add_dir(dir)?;
            continue;
        }
        check_path(&name)?;
        names.add_file(&name)?;
        if files.len() >= limits.files {
            return Err(too_many_files(limits));
        }
        let remaining = limits.bytes - total;
        if entry.size() > remaining {
            return Err(too_large(limits));
        }
        // What the archive declares may lie: read at most one byte past what is left.
        let mut buffer = Vec::new();
        (&mut entry)
            .take(remaining + 1)
            .read_to_end(&mut buffer)
            .map_err(|err| invalid(format!("`{name}` cannot be unpacked: {err}")))?;
        let size = buffer.len() as u64;
        if size > remaining {
            return Err(too_large(limits));
        }
        total += size;
        files.push(PackageFile { path: name, size });
        contents.push(buffer);
    }
    let manifest = {
        let position = files.iter().position(|f| f.path == MANIFEST_FILE);
        let Some(position) = position else {
            return Err(missing_manifest(&files));
        };
        parse_manifest(&contents[position])?
    };
    check_entry(&manifest, &files)?;
    Ok(Package {
        manifest,
        files,
        content: Content::Archive(contents),
    })
}

fn missing_manifest(files: &[PackageFile]) -> CoreError {
    let nested = files
        .iter()
        .any(|f| f.path.rsplit('/').next() == Some(MANIFEST_FILE));
    if nested {
        invalid(format!(
            "{MANIFEST_FILE} must be at the top of the package, not in a folder inside it"
        ))
    } else {
        invalid(format!("the package has no {MANIFEST_FILE}"))
    }
}

fn check_entry(manifest: &ExtensionManifest, files: &[PackageFile]) -> CoreResult<()> {
    if files.iter().any(|f| f.path == manifest.entry) {
        Ok(())
    } else {
        Err(invalid(format!(
            "{MANIFEST_FILE}: entry: `{}` is not in the package",
            manifest.entry
        )))
    }
}

/// Reads an unpacked extension folder in place and checks it. Entries whose name starts with `.` (`.git`, …) and
/// `node_modules` folders are not part of the package and are skipped.
pub fn inspect_folder(path: &Path) -> CoreResult<Package> {
    inspect_folder_with(path, LIMITS)
}

pub(crate) fn inspect_folder_with(path: &Path, limits: Limits) -> CoreResult<Package> {
    let root = std::fs::canonicalize(path).map_err(|err| io_error("cannot open", path, err))?;
    if !root.is_dir() {
        return Err(invalid(format!("{} is not a folder", path.display())));
    }
    let mut names = Names::default();
    let mut files = Vec::new();
    let mut total: u64 = 0;
    let mut pending = vec![(root.clone(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(&dir)
            .map_err(|err| io_error("cannot read", &dir, err))?
            .collect::<Result<_, _>>()
            .map_err(|err| io_error("cannot read", &dir, err))?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                return Err(invalid(format!(
                    "{} has a file name that is not valid Unicode",
                    dir.display()
                )));
            };
            if name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") {
                continue;
            }
            let relative = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            let meta = std::fs::symlink_metadata(entry.path())
                .map_err(|err| io_error("cannot read", &entry.path(), err))?;
            let kind = meta.file_type();
            if kind.is_symlink() {
                return Err(invalid(format!(
                    "the package is not safe to install: `{relative}` is a symbolic link"
                )));
            }
            check_path(&relative)?;
            if kind.is_dir() {
                names.add_dir(&relative)?;
                pending.push((entry.path(), relative));
            } else if kind.is_file() {
                names.add_file(&relative)?;
                if files.len() >= limits.files {
                    return Err(too_many_files(limits));
                }
                total = total.saturating_add(meta.len());
                if total > limits.bytes {
                    return Err(too_large(limits));
                }
                files.push(PackageFile {
                    path: relative,
                    size: meta.len(),
                });
            } else {
                return Err(invalid(format!("`{relative}` is not a regular file")));
            }
        }
    }
    if !files.iter().any(|f| f.path == MANIFEST_FILE) {
        return Err(missing_manifest(&files));
    }
    let bytes = read_open(
        resolve_package_file(&root, MANIFEST_FILE)?,
        super::manifest::MAX_MANIFEST_BYTES as u64 + 1,
        MANIFEST_FILE,
    )?;
    let manifest = parse_manifest(&bytes)?;
    check_entry(&manifest, &files)?;
    Ok(Package {
        manifest,
        files,
        content: Content::Folder(root),
    })
}

/// A name no other call in this process (or another process, by the pid) uses.
fn unique_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// `<extensions dir>/<id>/<version>`, or `None` when `id` or `version` is not one a manifest could have (so never a
/// path outside the extensions folder).
pub fn version_dir(extensions_dir: &Path, id: &str, version: &str) -> Option<PathBuf> {
    (is_extension_id(id) && is_semver(version)).then(|| extensions_dir.join(id).join(version))
}

/// Writes the package to `<extensions dir>/<id>/<version>/`, atomically: the files go to a temporary folder next to
/// it, which is then renamed into place, so the version folder is either the old copy or the whole new one. Another
/// installed version of the same id is left alone ([`prune_versions`]).
pub fn install(package: &Package, extensions_dir: &Path) -> CoreResult<InstalledFiles> {
    install_with(package, extensions_dir, &mut Listings::default())
}

/// [`install`], with the folder listings of a folder package shared by all its files, so each folder of the package
/// is read once for the whole install rather than once per file in it.
fn install_with(
    package: &Package,
    extensions_dir: &Path,
    listings: &mut Listings,
) -> CoreResult<InstalledFiles> {
    let id = &package.manifest.id;
    let version = &package.manifest.version;
    let target = version_dir(extensions_dir, id, version)
        .ok_or_else(|| invalid(format!("`{id}` {version} is not a valid id and version")))?;
    let id_dir = extensions_dir.join(id);
    std::fs::create_dir_all(&id_dir).map_err(|err| io_error("cannot create", &id_dir, err))?;
    let staging = tempfile::Builder::new()
        .prefix(STAGING_PREFIX)
        .tempdir_in(extensions_dir)
        .map_err(|err| io_error("cannot create a folder in", extensions_dir, err))?;
    let mut bytes = 0u64;
    for (index, file) in package.files.iter().enumerate() {
        check_path(&file.path)?;
        let destination = file
            .path
            .split('/')
            .fold(staging.path().to_path_buf(), |path, segment| {
                path.join(segment)
            });
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| io_error("cannot create", parent, err))?;
        }
        let contents = match &package.content {
            Content::Archive(contents) => contents[index].clone(),
            Content::Folder(root) => {
                // Checked again now, part by part: the folder may have changed since it was inspected.
                let source = resolve_package_file_with(root, &file.path, listings, &mut |_| {})?;
                let contents = read_open(source, file.size.saturating_add(1), &file.path)?;
                if contents.len() as u64 != file.size {
                    return Err(invalid(format!(
                        "`{}` changed while it was being installed; try again",
                        file.path
                    )));
                }
                contents
            }
        };
        write_new(&destination, &contents, &file.path)?;
        bytes += contents.len() as u64;
    }
    let staged = staging.keep();
    let old = if target.exists() {
        let old = id_dir.join(format!("{OLD_PREFIX}{}", unique_suffix()));
        if let Err(err) = std::fs::rename(&target, &old) {
            let _ = std::fs::remove_dir_all(&staged);
            return Err(io_error("cannot replace", &target, err));
        }
        Some(old)
    } else {
        None
    };
    if let Err(err) = std::fs::rename(&staged, &target) {
        if let Some(old) = &old {
            let _ = std::fs::rename(old, &target);
        }
        let _ = std::fs::remove_dir_all(&staged);
        return Err(io_error("cannot install into", &target, err));
    }
    if let Some(old) = old {
        let _ = std::fs::remove_dir_all(old);
    }
    Ok(InstalledFiles {
        dir: target,
        files: package.files.len(),
        bytes,
    })
}

/// Creates `destination` (never opening a file that is there already) and writes `contents`. A file that exists means
/// two entries of the package are one file on this disk (a file system that folds case or Unicode forms the check by
/// name did not): refused, rather than one silently overwriting the other.
fn write_new(destination: &Path, contents: &[u8], name: &str) -> CoreResult<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|err| {
            if err.kind() == std::io::ErrorKind::AlreadyExists {
                invalid(format!(
                    "the package is not safe to install: `{name}` is the same file on this disk as another file of \
                     the package"
                ))
            } else {
                io_error("cannot write", destination, err)
            }
        })?;
    file.write_all(contents)
        .map_err(|err| io_error("cannot write", destination, err))
}

/// Deletes every installed version of `id` but `keep`.
pub fn prune_versions(extensions_dir: &Path, id: &str, keep: &str) -> CoreResult<()> {
    if !is_extension_id(id) {
        return Err(invalid(format!("`{id}` is not an extension id")));
    }
    let id_dir = extensions_dir.join(id);
    let entries = match std::fs::read_dir(&id_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(io_error("cannot read", &id_dir, err)),
    };
    for entry in entries.flatten() {
        if entry.file_name() != keep {
            let path = entry.path();
            std::fs::remove_dir_all(&path).map_err(|err| io_error("cannot delete", &path, err))?;
        }
    }
    Ok(())
}

/// Deletes everything installed for `id` (all versions). Nothing installed is fine. The folder is first renamed
/// aside, so it disappears at once even if deleting its files takes a while or fails half-way.
pub fn remove(extensions_dir: &Path, id: &str) -> CoreResult<()> {
    if !is_extension_id(id) {
        return Err(invalid(format!("`{id}` is not an extension id")));
    }
    let dir = extensions_dir.join(id);
    if std::fs::symlink_metadata(&dir).is_err() {
        return Ok(());
    }
    let trash = extensions_dir.join(format!("{REMOVING_PREFIX}{id}-{}", unique_suffix()));
    std::fs::rename(&dir, &trash).map_err(|err| io_error("cannot remove", &dir, err))?;
    // What cannot be deleted now is deleted by `sweep_leftovers` on the next start.
    let _ = std::fs::remove_dir_all(&trash);
    Ok(())
}

/// Deletes what an interrupted [`install`] or [`remove`] left behind. For application start, before any install
/// runs.
pub fn sweep_leftovers(extensions_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(extensions_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(STAGING_PREFIX) || name.starts_with(REMOVING_PREFIX) {
            let _ = std::fs::remove_dir_all(entry.path());
        } else if let Ok(versions) = std::fs::read_dir(entry.path()) {
            for version in versions.flatten() {
                if version
                    .file_name()
                    .to_string_lossy()
                    .starts_with(OLD_PREFIX)
                {
                    let _ = std::fs::remove_dir_all(version.path());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn manifest(id: &str, version: &str, entry: &str) -> String {
        serde_json::json!({
            "id": id,
            "name": "Hello",
            "version": version,
            "description": "",
            "author": "Me",
            "sextantApi": 1,
            "entry": entry,
            "permissions": { "clusters": { "type": "all" }, "rules": [] },
            "contributes": {}
        })
        .to_string()
    }

    /// A zip of `(name, contents)`; names ending with `/` are directories.
    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, contents) in entries {
            if let Some(dir) = name.strip_suffix('/') {
                writer.add_directory(dir, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(contents).unwrap();
            }
        }
        writer.finish().unwrap().into_inner()
    }

    fn good_zip() -> Vec<u8> {
        let m = manifest("hello", "1.0.0", "dist/index.html");
        zip_of(&[
            (MANIFEST_FILE, m.as_bytes()),
            ("dist/", b""),
            ("dist/index.html", b"<!doctype html><p>hi</p>"),
            ("dist/app.js", b"console.log(1)"),
        ])
    }

    fn invalid_message(result: CoreResult<Package>) -> String {
        let err = result.expect_err("must be refused");
        assert_eq!(err.code, ErrorCode::Invalid, "{err:?}");
        err.message
    }

    #[test]
    fn a_good_archive_is_read_and_installed_into_id_and_version() {
        let package = inspect_zip(&good_zip()).unwrap();
        assert_eq!(package.manifest.id, "hello");
        let mut paths: Vec<&str> = package.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["dist/app.js", "dist/index.html", MANIFEST_FILE]);
        assert_eq!(package.folder(), None);

        let data = tempfile::tempdir().unwrap();
        let extensions = data.path().join("extensions");
        let installed = install(&package, &extensions).unwrap();
        let dir = extensions.join("hello").join("1.0.0");
        assert_eq!(installed.dir, dir);
        assert_eq!(installed.files, 3);
        assert_eq!(
            std::fs::read(dir.join("dist").join("index.html")).unwrap(),
            b"<!doctype html><p>hi</p>"
        );
        assert!(dir.join(MANIFEST_FILE).is_file());
        // Nothing is left beside it.
        let names: Vec<String> = std::fs::read_dir(&extensions)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["hello"]);
    }

    #[test]
    fn installing_the_same_version_again_replaces_it_whole() {
        let data = tempfile::tempdir().unwrap();
        install(&inspect_zip(&good_zip()).unwrap(), data.path()).unwrap();
        let m = manifest("hello", "1.0.0", "index.html");
        let second = zip_of(&[(MANIFEST_FILE, m.as_bytes()), ("index.html", b"v2")]);
        install(&inspect_zip(&second).unwrap(), data.path()).unwrap();
        let dir = data.path().join("hello").join("1.0.0");
        assert_eq!(std::fs::read(dir.join("index.html")).unwrap(), b"v2");
        assert!(!dir.join("dist").exists(), "files of the old copy are gone");
        let names: Vec<String> = std::fs::read_dir(data.path().join("hello"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["1.0.0"]);

        // Another version goes next to it; pruning keeps only the one asked for.
        let m = manifest("hello", "1.1.0", "index.html");
        let newer = zip_of(&[(MANIFEST_FILE, m.as_bytes()), ("index.html", b"v3")]);
        install(&inspect_zip(&newer).unwrap(), data.path()).unwrap();
        assert!(data.path().join("hello").join("1.0.0").is_dir());
        prune_versions(data.path(), "hello", "1.1.0").unwrap();
        assert!(!data.path().join("hello").join("1.0.0").exists());
        assert!(
            data.path()
                .join("hello")
                .join("1.1.0")
                .join("index.html")
                .is_file()
        );
    }

    #[test]
    fn zip_slip_and_absolute_paths_are_refused() {
        let m = manifest("hello", "1.0.0", "index.html");
        for evil in [
            "../evil.html",
            "a/../../evil.html",
            "a/../evil.html",
            "/etc/evil",
            "C:/evil.html",
            "C:\\evil.html",
            "\\\\server\\share\\evil",
            "a\\..\\..\\evil",
            "./index2.html",
            "a//b.html",
        ] {
            let bytes = zip_of(&[
                (MANIFEST_FILE, m.as_bytes()),
                ("index.html", b"x"),
                (evil, b"x"),
            ]);
            let message = invalid_message(inspect_zip(&bytes));
            assert!(message.contains(evil), "{evil}: {message}");
        }
    }

    #[test]
    fn symlinks_in_an_archive_are_refused() {
        let m = manifest("hello", "1.0.0", "index.html");
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        writer.start_file(MANIFEST_FILE, options).unwrap();
        writer.write_all(m.as_bytes()).unwrap();
        writer.start_file("index.html", options).unwrap();
        writer.write_all(b"x").unwrap();
        writer
            .add_symlink("secrets", "/home/user/.kube/config", options)
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let message = invalid_message(inspect_zip(&bytes));
        assert!(
            message.contains("symbolic link") && message.contains("secrets"),
            "{message}"
        );
    }

    #[test]
    fn too_many_files_or_bytes_are_refused() {
        assert_eq!(MAX_FILES, 2000);
        assert_eq!(MAX_UNPACKED_BYTES, 50 * 1024 * 1024);
        let m = manifest("hello", "1.0.0", "index.html");
        let limits = Limits {
            files: 3,
            bytes: 10_000,
        };
        let fits = zip_of(&[
            (MANIFEST_FILE, m.as_bytes()),
            ("index.html", b"x"),
            ("a.js", b"x"),
        ]);
        assert!(inspect_zip_with(&fits, limits).is_ok());
        let many = zip_of(&[
            (MANIFEST_FILE, m.as_bytes()),
            ("index.html", b"x"),
            ("a.js", b"x"),
            ("b.js", b"x"),
        ]);
        let message = invalid_message(inspect_zip_with(&many, limits));
        assert!(message.contains("more than 3 files"), "{message}");
        // A small archive that unpacks big (a zip bomb).
        let zeros = vec![0u8; 20_000];
        let bomb = zip_of(&[
            (MANIFEST_FILE, m.as_bytes()),
            ("index.html", b"x"),
            ("big.bin", &zeros),
        ]);
        assert!(bomb.len() < 10_000);
        let message = invalid_message(inspect_zip_with(&bomb, limits));
        assert!(message.contains("10000 bytes"), "{message}");
    }

    #[test]
    fn the_manifest_and_its_entry_must_be_in_the_package() {
        let message = invalid_message(inspect_zip(&zip_of(&[("index.html", b"x")])));
        assert!(message.contains(MANIFEST_FILE), "{message}");
        // Only at the top: a manifest in a sub-folder does not count.
        let m = manifest("hello", "1.0.0", "index.html");
        let nested = zip_of(&[
            ("hello/sextant-extension.json", m.as_bytes()),
            ("hello/index.html", b"x"),
        ]);
        let message = invalid_message(inspect_zip(&nested));
        assert!(message.contains("top of the package"), "{message}");

        let no_entry = zip_of(&[(MANIFEST_FILE, m.as_bytes()), ("main.html", b"x")]);
        let message = invalid_message(inspect_zip(&no_entry));
        assert!(message.contains("`index.html`"), "{message}");
    }

    #[test]
    fn a_bad_manifest_names_the_field() {
        let bad = manifest("hello", "1.0.0", "index.html")
            .replace("\"author\":\"Me\"", "\"author\":\"\"");
        let bytes = zip_of(&[(MANIFEST_FILE, bad.as_bytes()), ("index.html", b"x")]);
        let message = invalid_message(inspect_zip(&bytes));
        assert!(message.contains("author: must not be empty"), "{message}");
    }

    #[test]
    fn duplicate_and_colliding_names_are_refused() {
        let m = manifest("hello", "1.0.0", "index.html");
        for (a, b) in [
            ("app.js", "APP.js"),
            ("lib", "lib/x.js"),
            ("Lib/x.js", "lib"),
        ] {
            let bytes = zip_of(&[
                (MANIFEST_FILE, m.as_bytes()),
                ("index.html", b"x"),
                (a, b"1"),
                (b, b"2"),
            ]);
            let message = invalid_message(inspect_zip(&bytes));
            assert!(message.contains(b), "{a} / {b}: {message}");
        }
    }

    /// Two entries that are one file on disk (`café.js` composed and decomposed on macOS, which folds them; made
    /// here as one name twice, as such a disk sees it): the second would overwrite the first, so nothing is installed.
    #[test]
    fn two_entries_that_are_one_file_on_disk_are_not_installed() {
        let m = manifest("hello", "1.0.0", "index.html");
        let composed = "caf\u{e9}.js";
        let decomposed = "cafe\u{301}.js";
        let bytes = zip_of(&[
            (MANIFEST_FILE, m.as_bytes()),
            ("index.html", b"x"),
            (composed, b"1"),
            (decomposed, b"2"),
        ]);
        let mut package = inspect_zip(&bytes).expect("other names on this check");
        for file in &mut package.files {
            if file.path == decomposed {
                file.path = composed.to_owned();
            }
        }
        let data = tempfile::tempdir().unwrap();
        let extensions = data.path().join("extensions");
        let err = install(&package, &extensions).expect_err("one file written twice");
        assert_eq!(err.code, ErrorCode::Invalid, "{err:?}");
        assert!(err.message.contains(composed), "{err}");
        assert!(!extensions.join("hello").join("1.0.0").exists());
        let left: Vec<_> = std::fs::read_dir(&extensions)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .filter(|name| name != "hello")
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn not_a_zip_is_refused() {
        let message = invalid_message(inspect_zip(b"MZ\x90\x00 definitely not a zip"));
        assert!(message.contains("zip"), "{message}");
    }

    #[test]
    fn a_refused_archive_writes_nothing() {
        let data = tempfile::tempdir().unwrap();
        let m = manifest("hello", "1.0.0", "index.html");
        let bytes = zip_of(&[
            (MANIFEST_FILE, m.as_bytes()),
            ("index.html", b"x"),
            ("../../evil", b"x"),
        ]);
        assert!(inspect_zip(&bytes).is_err());
        assert_eq!(std::fs::read_dir(data.path()).unwrap().count(), 0);
    }

    #[test]
    fn remove_deletes_the_extension_and_refuses_a_path() {
        let data = tempfile::tempdir().unwrap();
        let extensions = data.path().join("extensions");
        install(&inspect_zip(&good_zip()).unwrap(), &extensions).unwrap();
        let outside = data.path().join("keep.txt");
        std::fs::write(&outside, "keep").unwrap();

        for bad in ["..", "../extensions", "", "a/b", "/tmp", "Hello"] {
            let err = remove(&extensions, bad).unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{bad}");
        }
        assert!(outside.is_file());
        remove(&extensions, "hello").unwrap();
        assert!(!extensions.join("hello").exists());
        assert_eq!(
            std::fs::read_dir(&extensions).unwrap().count(),
            0,
            "no trash left"
        );
        // Removing what is not there is fine.
        remove(&extensions, "hello").unwrap();
    }

    fn write_tree(root: &Path, files: &[(&str, &[u8])]) {
        for (path, contents) in files {
            let full = root.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, contents).unwrap();
        }
    }

    #[test]
    fn a_folder_is_read_in_place_without_dot_folders_and_node_modules() {
        let dir = tempfile::tempdir().unwrap();
        let m = manifest("hello", "0.1.0", "index.html");
        write_tree(
            dir.path(),
            &[
                (MANIFEST_FILE, m.as_bytes()),
                ("index.html", b"<p>dev</p>"),
                ("js/app.js", b"1"),
                (".git/HEAD", b"ref"),
                ("node_modules/x/index.js", b"1"),
                ("Node_Modules/y/index.js", b"1"),
            ],
        );
        let package = inspect_folder(dir.path()).unwrap();
        let mut paths: Vec<&str> = package.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["index.html", "js/app.js", MANIFEST_FILE]);
        assert_eq!(
            package.folder(),
            Some(std::fs::canonicalize(dir.path()).unwrap().as_path())
        );
        assert_eq!(package.total_bytes(), m.len() as u64 + 10 + 1);

        // A folder package can be installed as a copy too.
        let data = tempfile::tempdir().unwrap();
        let installed = install(&package, data.path()).unwrap();
        assert_eq!(
            std::fs::read(installed.dir.join("js").join("app.js")).unwrap(),
            b"1"
        );
        assert!(!installed.dir.join(".git").exists());
    }

    #[test]
    fn a_folder_without_its_entry_or_over_the_limits_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let m = manifest("hello", "0.1.0", "index.html");
        write_tree(
            dir.path(),
            &[(MANIFEST_FILE, m.as_bytes()), ("main.html", b"x")],
        );
        let message = invalid_message(inspect_folder(dir.path()));
        assert!(message.contains("`index.html`"), "{message}");

        write_tree(dir.path(), &[("index.html", b"x"), ("a.js", b"x")]);
        let message = invalid_message(inspect_folder_with(
            dir.path(),
            Limits {
                files: 3,
                bytes: 10_000,
            },
        ));
        assert!(message.contains("more than 3 files"), "{message}");
        let message = invalid_message(inspect_folder_with(
            dir.path(),
            Limits {
                files: 10,
                bytes: 100,
            },
        ));
        assert!(message.contains("100 bytes"), "{message}");

        let missing = dir.path().join("nope");
        assert!(inspect_folder(&missing).is_err());
        let message = invalid_message(inspect_folder(&dir.path().join("index.html")));
        assert!(message.contains("not a folder"), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_in_a_folder_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let m = manifest("hello", "0.1.0", "index.html");
        write_tree(
            dir.path(),
            &[(MANIFEST_FILE, m.as_bytes()), ("index.html", b"x")],
        );
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("passwd")).unwrap();
        let message = invalid_message(inspect_folder(dir.path()));
        assert!(
            message.contains("symbolic link") && message.contains("passwd"),
            "{message}"
        );
    }

    #[test]
    fn windows_device_names_and_trailing_dots_or_spaces_are_refused_on_every_os() {
        let m = manifest("hello", "1.0.0", "index.html");
        for evil in [
            "CON",
            "nul.js",
            "com1.html",
            "LPT9.txt",
            "com0.js",
            "Lpt0/x.js",
            "aux/x.js",
            "js/Nul .js",
            "index.html.",
            "dist./app.js",
            "dist /app.js",
            "app.js ",
            "a?b.js",
            "a*b.js",
            "a<b>.js",
            "a|b.js",
            "a\"b.js",
        ] {
            let bytes = zip_of(&[
                (MANIFEST_FILE, m.as_bytes()),
                ("index.html", b"x"),
                (evil, b"x"),
            ]);
            let message = invalid_message(inspect_zip(&bytes));
            assert!(message.contains(evil), "{evil}: {message}");
        }
        // Names that only look alike are fine.
        let fine = zip_of(&[
            (MANIFEST_FILE, m.as_bytes()),
            ("index.html", b"x"),
            ("console.js", b"x"),
            ("com10.js", b"x"),
            ("nullable/auxiliary.js", b"x"),
            ("a.b.c.js", b"x"),
        ]);
        assert!(inspect_zip(&fine).is_ok());
    }

    #[test]
    fn an_archive_that_under_declares_a_size_is_refused_by_the_real_size() {
        let m = manifest("hello", "1.0.0", "index.html");
        let zeros = vec![0u8; 20_000];
        let mut bytes = zip_of(&[
            (MANIFEST_FILE, m.as_bytes()),
            ("index.html", b"x"),
            ("big.bin", &zeros),
        ]);
        // Rewrite the uncompressed size of `big.bin` to 10 bytes in its local header (offset 22) and in the central
        // directory (offset 24).
        let mut patched = 0;
        for (signature, size_at, name_len_at, header_len) in [
            (b"PK\x03\x04", 22usize, 26usize, 30usize),
            (b"PK\x01\x02", 24, 28, 46),
        ] {
            let mut at = 0;
            while let Some(found) = bytes[at..].windows(4).position(|w| w == signature) {
                let start = at + found;
                let name_len = u16::from_le_bytes([
                    bytes[start + name_len_at],
                    bytes[start + name_len_at + 1],
                ]) as usize;
                let name = &bytes[start + header_len..start + header_len + name_len];
                if name == b"big.bin" {
                    bytes[start + size_at..start + size_at + 4]
                        .copy_from_slice(&10u32.to_le_bytes());
                    patched += 1;
                }
                at = start + 4;
            }
        }
        assert_eq!(patched, 2);
        let limits = Limits {
            files: 10,
            bytes: 10_000,
        };
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes[..])).unwrap();
        assert_eq!(
            archive.by_name("big.bin").unwrap().size(),
            10,
            "the archive claims 10 bytes"
        );
        let message = invalid_message(inspect_zip_with(&bytes, limits));
        assert!(message.contains("10000 bytes"), "{message}");
    }

    #[test]
    fn a_requested_file_resolves_inside_the_folder_only() {
        let dir = tempfile::tempdir().unwrap();
        write_tree(
            dir.path(),
            &[
                ("index.html", b"x"),
                ("js/app.js", b"1"),
                (".env", b"SECRET"),
                ("node_modules/x/index.js", b"1"),
            ],
        );
        let root = dir.path();
        assert_eq!(
            read_all(resolve_package_file(root, "index.html").unwrap()),
            b"x"
        );
        assert_eq!(
            read_all(resolve_package_file(root, "js/app.js").unwrap()),
            b"1"
        );
        for bad in [
            "../index.html",
            "/etc/passwd",
            "js/../index.html",
            "js\\app.js",
            "C:/x",
            ".env",
            "node_modules/x/index.js",
            "NODE_MODULES/x/index.js",
            "Node_Modules/x/index.js",
            "js/.hidden",
            "nul.js",
            "index.html.",
            "",
        ] {
            let err = resolve_package_file(root, bad).unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{bad:?}: {err:?}");
        }
        assert_eq!(
            resolve_package_file(root, "missing.js").unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            resolve_package_file(root, "js").unwrap_err().code,
            ErrorCode::NotFound,
            "a folder"
        );
        assert_eq!(
            resolve_package_file(root, "index.html/x").unwrap_err().code,
            ErrorCode::NotFound,
            "a file used as a folder"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_swapped_in_after_the_check_is_refused_at_request_and_at_install() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_tree(outside.path(), &[("app.js", b"stolen")]);
        let m = manifest("hello", "0.1.0", "index.html");
        write_tree(
            dir.path(),
            &[
                (MANIFEST_FILE, m.as_bytes()),
                ("index.html", b"x"),
                ("js/app.js", b"stolen"),
            ],
        );
        let package = inspect_folder(dir.path()).unwrap();

        // The folder `js` is replaced by a link to a folder outside, with the same file name and size.
        std::fs::remove_dir_all(dir.path().join("js")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("js")).unwrap();
        let err = resolve_package_file(dir.path(), "js/app.js").unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err:?}");
        assert!(err.message.contains("symbolic link"), "{err:?}");

        let data = tempfile::tempdir().unwrap();
        let err = install(&package, data.path()).unwrap_err();
        assert!(err.message.contains("symbolic link"), "{err:?}");
        assert!(!data.path().join("hello").join("0.1.0").exists());

        // A link as the last part too.
        std::fs::remove_file(dir.path().join("js")).unwrap();
        std::fs::create_dir(dir.path().join("js")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("app.js"),
            dir.path().join("js").join("app.js"),
        )
        .unwrap();
        assert_eq!(
            resolve_package_file(dir.path(), "js/app.js")
                .unwrap_err()
                .code,
            ErrorCode::Invalid
        );
    }

    fn read_all(mut file: std::fs::File) -> Vec<u8> {
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).unwrap();
        buffer
    }

    #[test]
    fn another_spelling_of_a_name_on_disk_is_never_served() {
        let dir = tempfile::tempdir().unwrap();
        write_tree(dir.path(), &[("js/app.js", b"1"), ("Index.html", b"x")]);
        let case_insensitive = dir.path().join("JS").exists();
        for other in ["JS/app.js", "js/APP.js", "index.html"] {
            let err = resolve_package_file(dir.path(), other).unwrap_err();
            let expected = if case_insensitive {
                ErrorCode::Invalid
            } else {
                ErrorCode::NotFound
            };
            assert_eq!(err.code, expected, "{other}: {err:?}");
        }
        // The check itself: an entry that exists under another spelling is refused, whatever the file system.
        let listings = &mut Listings::default();
        let err = exact_entry(listings, dir.path(), "INDEX.HTML", "INDEX.HTML");
        if case_insensitive {
            assert_eq!(err.unwrap_err().code, ErrorCode::Invalid);
        } else {
            assert_eq!(err.unwrap_err().code, ErrorCode::NotFound);
        }
        assert!(
            exact_entry(listings, dir.path(), "Index.html", "Index.html")
                .unwrap()
                .is_file()
        );
        // A spelling the system resolves but the folder does not list (here a trailing `/`; on Windows and macOS
        // also other case and short names) is refused on every file system.
        assert_eq!(
            exact_entry(listings, dir.path(), "js/", "js/")
                .unwrap_err()
                .code,
            ErrorCode::Invalid
        );
        // Windows 8.3 short names never match the long name read from the folder: wherever the short name opens the
        // file, it is refused as another spelling; where there are no short names it is simply not there.
        let short_name_resolves = std::fs::symlink_metadata(dir.path().join("INDEX~1.HTM")).is_ok();
        let expected = if short_name_resolves {
            ErrorCode::Invalid
        } else {
            ErrorCode::NotFound
        };
        let err = exact_entry(listings, dir.path(), "INDEX~1.HTM", "INDEX~1.HTM").unwrap_err();
        assert_eq!(err.code, expected, "{err:?}");
        let err = resolve_package_file(dir.path(), "INDEX~1.HTM").unwrap_err();
        assert_eq!(err.code, expected, "{err:?}");
        #[cfg(windows)]
        if short_name_resolves {
            assert!(err.message.contains("short name"), "{err:?}");
        }
    }

    /// Resolving a path reads each folder on it once (a flat folder of the maximum size used to be listed twice per
    /// part per request); an install reads each folder of the package once in all.
    #[test]
    fn each_folder_is_listed_once_per_resolution_and_once_per_install() {
        let dir = tempfile::tempdir().unwrap();
        let m = manifest("hello", "0.1.0", "index.html");
        let mut files: Vec<(String, Vec<u8>)> = vec![
            (MANIFEST_FILE.to_owned(), m.into_bytes()),
            ("index.html".to_owned(), b"x".to_vec()),
            ("js/app.js".to_owned(), b"1".to_vec()),
        ];
        for index in 0..MAX_FILES - 3 {
            files.push((format!("f{index}.js"), b"1".to_vec()));
        }
        let borrowed: Vec<(&str, &[u8])> = files
            .iter()
            .map(|(path, contents)| (path.as_str(), contents.as_slice()))
            .collect();
        write_tree(dir.path(), &borrowed);

        let listings = &mut Listings::default();
        let file = resolve_package_file_with(dir.path(), "f17.js", listings, &mut |_| {}).unwrap();
        assert_eq!(read_all(file), b"1");
        assert_eq!(listings.reads, 1, "the root, once");

        let listings = &mut Listings::default();
        resolve_package_file_with(dir.path(), "js/app.js", listings, &mut |_| {}).unwrap();
        assert_eq!(listings.reads, 2, "the root and `js`, once each");

        // Refusals read no more than that either.
        let listings = &mut Listings::default();
        let err =
            resolve_package_file_with(dir.path(), "missing.js", listings, &mut |_| {}).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(listings.reads, 1);

        let package = inspect_folder(dir.path()).unwrap();
        assert_eq!(package.files.len(), MAX_FILES);
        let data = tempfile::tempdir().unwrap();
        let listings = &mut Listings::default();
        let installed = install_with(&package, data.path(), listings).unwrap();
        assert_eq!(installed.files, MAX_FILES);
        assert_eq!(
            listings.reads, 2,
            "the root and `js`, once for the whole install"
        );
        assert_eq!(std::fs::read(installed.dir.join("f1996.js")).unwrap(), b"1");
    }

    #[cfg(unix)]
    #[test]
    fn opening_never_follows_a_link_in_the_last_part() {
        let dir = tempfile::tempdir().unwrap();
        write_tree(dir.path(), &[("real.js", b"1")]);
        std::os::unix::fs::symlink(dir.path().join("real.js"), dir.path().join("link.js")).unwrap();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        assert_ne!(O_NOFOLLOW, 0, "known on the systems Sextant ships for");
        if O_NOFOLLOW != 0 {
            assert!(open_no_follow(&dir.path().join("link.js")).is_err());
        }
        assert!(open_no_follow(&dir.path().join("real.js")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_swapped_in_around_the_open_is_refused() {
        let setup = || {
            let dir = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            write_tree(dir.path(), &[("js/app.js", b"mine")]);
            write_tree(outside.path(), &[("app.js", b"stolen")]);
            (dir, outside)
        };
        let swap_folder = |dir: &Path, outside: &Path| {
            std::fs::rename(dir.join("js"), dir.join("js-real")).unwrap();
            std::os::unix::fs::symlink(outside, dir.join("js")).unwrap();
        };

        // A folder becomes a link just before the open.
        let (dir, outside) = setup();
        let err = resolve_package_file_with(
            dir.path(),
            "js/app.js",
            &mut Listings::default(),
            &mut |stage| {
                if stage == OpenStage::BeforeOpen {
                    swap_folder(dir.path(), outside.path());
                }
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err:?}");

        // … and back again right after it: the file opened is not the one the path leads to.
        let (dir, outside) = setup();
        let err = resolve_package_file_with(
            dir.path(),
            "js/app.js",
            &mut Listings::default(),
            &mut |stage| match stage {
                OpenStage::BeforeOpen => swap_folder(dir.path(), outside.path()),
                OpenStage::AfterOpen => {
                    std::fs::remove_file(dir.path().join("js")).unwrap();
                    std::fs::rename(dir.path().join("js-real"), dir.path().join("js")).unwrap();
                }
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err:?}");
        assert!(
            err.message.contains("changed while it was being opened"),
            "{err:?}"
        );

        // The file itself becomes a link just before the open.
        let (dir, outside) = setup();
        let err = resolve_package_file_with(
            dir.path(),
            "js/app.js",
            &mut Listings::default(),
            &mut |stage| {
                if stage == OpenStage::BeforeOpen {
                    std::fs::remove_file(dir.path().join("js").join("app.js")).unwrap();
                    std::os::unix::fs::symlink(
                        outside.path().join("app.js"),
                        dir.path().join("js").join("app.js"),
                    )
                    .unwrap();
                }
            },
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err:?}");

        // Nothing swapped: the file opened is read.
        let (dir, _outside) = setup();
        let file = resolve_package_file_with(
            dir.path(),
            "js/app.js",
            &mut Listings::default(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(read_all(file), b"mine");
    }
}
