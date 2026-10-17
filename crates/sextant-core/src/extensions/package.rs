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
/// - the path is walked part by part from an open handle of `root`, never following a link: a symbolic link in any
///   part below `root` is refused (on Windows: a name-surrogate reparse point — symbolic link, junction, mount point;
///   other reparse points such as OneDrive placeholders or deduplicated files are ordinary files); folders then a
///   regular file. The handle returned is the one the walk opened.
///   - Unix: each part is opened with `openat` relative to the folder opened before it (`O_NOFOLLOW`, plus
///     `O_DIRECTORY` for folders), and the folder listings are read from those handles, so a part swapped for a link
///     at any moment is either refused or not used: the walk never leaves the folders it opened.
///   - Windows: each part is opened by its full path (no handle-relative open without `NtCreateFile`), the reparse
///     point itself, and must then be exactly where the walk expects it: the final path of the opened handle
///     (`GetFinalPathNameByHandleW`, normalized: long names, the case on disk) is the final path of `root` plus the
///     requested parts. A part swapped for a link around the open, a short-name alias (even one that only appeared
///     after the listing was read) or another case is refused that way; what is served is a file that sat at the
///     requested place inside `root` after it was opened. The listings are read by path.
/// - the file has a single name: a regular file with more than one hard link is refused (another of its names may be
///   outside the package, and a hard link cannot be told apart from the original). Packages from archives never
///   contain hard links; a development folder with a hard-linked file gets this error for that file.
/// - Windows only: a file whose file system gives it no identity (`FileIdInfo` unsupported or all zeros, as on some
///   network file systems) is not served.
///
/// `invalid` for an unsafe path, another spelling, a link or a hard link; `notFound` when a part is missing (or a
/// folder where a file is expected).
pub fn resolve_package_file(root: &Path, request: &str) -> CoreResult<std::fs::File> {
    resolve_package_file_with(root, request, &mut Listings::default(), &mut |_| {})
}

/// What a folder entry is (not following a link).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    File,
    Dir,
    Link,
    Other,
}

/// Why one part of the walk was not opened.
#[derive(Debug)]
enum StepError {
    Link,
    NotAFile,
    Missing,
    HardLink,
    /// Not the entry the walk expects at this place (moved, swapped, another spelling; Windows).
    #[cfg_attr(not(windows), allow(dead_code))]
    Changed,
    /// The file system gives the file no identity or no normalized final path (Windows).
    #[cfg_attr(not(windows), allow(dead_code))]
    NoIdentity,
    /// A part on another file system than the root: a mount point inside the package (Unix).
    #[cfg_attr(not(unix), allow(dead_code))]
    OtherDevice,
    Io(std::io::Error),
}

fn step_error(err: StepError, request: &str, path: &Path) -> CoreError {
    match err {
        StepError::Link => link_refused(request),
        StepError::NotAFile => not_a_file(request),
        StepError::Missing => not_in_extension(request),
        StepError::HardLink => invalid(format!(
            "`{request}` has more than one hard link (another name of it may be outside the extension); extensions \
             cannot use links"
        )),
        StepError::Changed => invalid(format!(
            "`{request}` changed while it was being opened; extensions cannot use links"
        )),
        StepError::NoIdentity => invalid(format!(
            "`{request}` cannot be served: the file system of {} does not tell where a file is or which file it is \
             (likely a network share or a FAT/exFAT drive); keep the extension in a folder on a local NTFS or ReFS \
             drive",
            path.display()
        )),
        StepError::OtherDevice => invalid(format!(
            "`{request}` is on another file system than the extension folder (a mount point inside it); extensions \
             cannot use mount points"
        )),
        StepError::Io(err) => io_error("cannot read", path, err),
    }
}

/// Folder listings read while resolving paths: each folder is read from disk at most once, however many parts or
/// files go through it. Only names (and their types as listed) are taken from here; what each part is gets checked
/// again on the handle the walk opens.
#[derive(Default)]
struct Listings {
    /// Folder → its entries by exact name; the type is `None` when the folder listing could not tell it.
    folders: HashMap<PathBuf, HashMap<OsString, Option<EntryKind>>>,
    /// How many folders were read from disk.
    reads: usize,
}

impl Listings {
    fn entries(
        &mut self,
        dir: &walk::Dir,
        folder: &Path,
        request: &str,
    ) -> CoreResult<&HashMap<OsString, Option<EntryKind>>> {
        match self.folders.entry(folder.to_path_buf()) {
            std::collections::hash_map::Entry::Occupied(entry) => Ok(entry.into_mut()),
            std::collections::hash_map::Entry::Vacant(slot) => {
                let entries = walk::list(dir, folder).map_err(|err| {
                    if err.kind() == std::io::ErrorKind::NotFound {
                        not_a_file(request)
                    } else {
                        io_error("cannot read", folder, err)
                    }
                })?;
                self.reads += 1;
                Ok(slot.insert(entries))
            }
        }
    }
}

/// [`resolve_package_file`]; `at(index)` runs just before part `index` of the path is opened (a test seam).
fn resolve_package_file_with(
    root: &Path,
    request: &str,
    listings: &mut Listings,
    at: &mut dyn FnMut(usize),
) -> CoreResult<std::fs::File> {
    if !is_servable_path(request) {
        return Err(invalid(format!(
            "`{request}` is not a plain relative path inside the extension"
        )));
    }
    let mut dir = walk::open_root(root).map_err(|err| step_error(err, request, root))?;
    let segments: Vec<&str> = request.split('/').collect();
    let mut folder = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        let last = index + 1 == segments.len();
        let kind = exact_entry(listings, &dir, &folder, segment, request)?;
        if kind == EntryKind::Link {
            return Err(link_refused(request));
        }
        if (last && kind != EntryKind::File) || (!last && kind != EntryKind::Dir) {
            return Err(not_a_file(request));
        }
        at(index);
        let path = folder.join(segment);
        if last {
            return walk::open_file(&dir, &path, segment)
                .map_err(|err| step_error(err, request, &path));
        }
        dir =
            walk::open_dir(&dir, &path, segment).map_err(|err| step_error(err, request, &path))?;
        folder = path;
    }
    Err(not_a_file(request))
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

fn not_in_extension(request: &str) -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        format!("`{request}` is not in the extension"),
    )
}

/// The type (not following a link) of the entry of the open folder `dir` (at `folder`) named exactly `name`. No such
/// entry: either another spelling of an existing one (case, 8.3 short name) — `invalid` — or nothing — `notFound`.
fn exact_entry(
    listings: &mut Listings,
    dir: &walk::Dir,
    folder: &Path,
    name: &str,
    request: &str,
) -> CoreResult<EntryKind> {
    let listed = listings
        .entries(dir, folder, request)?
        .get(std::ffi::OsStr::new(name))
        .copied();
    match listed {
        Some(Some(kind)) => Ok(kind),
        Some(None) => walk::kind_at(dir, folder, name)
            .map_err(|err| io_error("cannot read", &folder.join(name), err)),
        None if walk::kind_at(dir, folder, name).is_ok() => Err(invalid(format!(
            "`{request}` does not name `{name}` exactly as it is on disk (another case or a short name)"
        ))),
        None => Err(not_in_extension(request)),
    }
}

/// The walk on Unix: every part opened relative to the folder handle before it, never following a link, and never
/// onto another file system than the root's.
#[cfg(unix)]
mod walk {
    use super::{EntryKind, StepError};
    use rustix::fs::{AtFlags, CWD, Dev, FileType, Mode, OFlags};
    use rustix::io::Errno;
    use std::collections::HashMap;
    use std::ffi::{OsStr, OsString};
    use std::os::fd::OwnedFd;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    /// An open folder of the walk and the device of the root it was reached from.
    pub(super) struct Dir {
        fd: OwnedFd,
        pub(super) root_dev: Dev,
    }

    fn kind_of(kind: FileType) -> EntryKind {
        match kind {
            FileType::RegularFile => EntryKind::File,
            FileType::Directory => EntryKind::Dir,
            FileType::Symlink => EntryKind::Link,
            _ => EntryKind::Other,
        }
    }

    /// `root` itself may be reached through links (it is the trusted starting point).
    pub(super) fn open_root(root: &Path) -> Result<Dir, StepError> {
        let fd = rustix::fs::openat(
            CWD,
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|errno| {
            if errno == Errno::NOENT {
                StepError::Missing
            } else {
                StepError::Io(errno.into())
            }
        })?;
        let root_dev = rustix::fs::fstat(&fd)
            .map_err(|errno| StepError::Io(errno.into()))?
            .st_dev;
        Ok(Dir { fd, root_dev })
    }

    /// The entries of the open folder (read from the handle, not the path).
    pub(super) fn list(
        dir: &Dir,
        _folder: &Path,
    ) -> std::io::Result<HashMap<OsString, Option<EntryKind>>> {
        let mut entries = HashMap::new();
        for entry in rustix::fs::Dir::read_from(&dir.fd)? {
            let entry = entry?;
            let name = OsStr::from_bytes(entry.file_name().to_bytes());
            if name == "." || name == ".." {
                continue;
            }
            let kind = match entry.file_type() {
                FileType::Unknown => None,
                kind => Some(kind_of(kind)),
            };
            entries.insert(name.to_os_string(), kind);
        }
        Ok(entries)
    }

    pub(super) fn kind_at(dir: &Dir, _folder: &Path, name: &str) -> std::io::Result<EntryKind> {
        let stat = rustix::fs::statat(&dir.fd, name, AtFlags::SYMLINK_NOFOLLOW)?;
        Ok(kind_of(FileType::from_raw_mode(stat.st_mode)))
    }

    /// Why `name` in `dir` could not be opened as `expected`.
    fn refused(dir: &Dir, name: &str, errno: Errno, expected: EntryKind) -> StepError {
        if errno == Errno::LOOP {
            return StepError::Link;
        }
        match rustix::fs::statat(&dir.fd, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(stat) => match kind_of(FileType::from_raw_mode(stat.st_mode)) {
                EntryKind::Link => StepError::Link,
                kind if kind != expected => StepError::NotAFile,
                _ => StepError::Io(errno.into()),
            },
            Err(err) if err == Errno::NOENT => StepError::Missing,
            Err(_) => StepError::Io(errno.into()),
        }
    }

    /// What was opened, checked: of the `expected` kind and on the root's file system (a mount point inside the
    /// package — FUSE, a disk image — could hold anything).
    fn checked(
        fd: &OwnedFd,
        dir: &Dir,
        expected: EntryKind,
    ) -> Result<rustix::fs::Stat, StepError> {
        let stat = rustix::fs::fstat(fd).map_err(|errno| StepError::Io(errno.into()))?;
        if kind_of(FileType::from_raw_mode(stat.st_mode)) != expected {
            return Err(StepError::NotAFile);
        }
        if stat.st_dev != dir.root_dev {
            return Err(StepError::OtherDevice);
        }
        Ok(stat)
    }

    pub(super) fn open_dir(dir: &Dir, _path: &Path, name: &str) -> Result<Dir, StepError> {
        let fd = rustix::fs::openat(
            &dir.fd,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|errno| refused(dir, name, errno, EntryKind::Dir))?;
        checked(&fd, dir, EntryKind::Dir)?;
        Ok(Dir {
            fd,
            root_dev: dir.root_dev,
        })
    }

    /// `O_NONBLOCK`: a FIFO swapped in for the file does not hang the open (it is refused right after); reading a
    /// regular file is not affected by it.
    pub(super) fn open_file(
        dir: &Dir,
        _path: &Path,
        name: &str,
    ) -> Result<std::fs::File, StepError> {
        let fd = rustix::fs::openat(
            &dir.fd,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK | OFlags::NOCTTY,
            Mode::empty(),
        )
        .map_err(|errno| refused(dir, name, errno, EntryKind::File))?;
        if checked(&fd, dir, EntryKind::File)?.st_nlink > 1 {
            return Err(StepError::HardLink);
        }
        Ok(std::fs::File::from(fd))
    }
}

/// The walk on Windows: every part opened by path as the reparse point itself, then checked to be exactly where the
/// walk expects it by the final path of its handle.
#[cfg(windows)]
mod walk {
    use super::{EntryKind, StepError};
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::fs::File;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
        FILE_INFO_BY_HANDLE_CLASS, FILE_NAME_NORMALIZED, FILE_STANDARD_INFO, FileAttributeTagInfo,
        FileIdInfo, FileStandardInfo, GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
    };

    /// An open folder of the walk: its final path (UTF-16, as the system names it).
    pub(super) struct Dir {
        final_path: Vec<u16>,
    }

    /// `IsReparseTagNameSurrogate`: symbolic links, junctions, mount points.
    const NAME_SURROGATE: u32 = 0x2000_0000;
    const ERROR_INVALID_PARAMETER: i32 = 87;
    const ERROR_NOT_SUPPORTED: i32 = 50;

    fn kind_of(kind: std::fs::FileType) -> EntryKind {
        // `is_symlink` on Windows is a name-surrogate reparse point.
        if kind.is_symlink() {
            EntryKind::Link
        } else if kind.is_dir() {
            EntryKind::Dir
        } else if kind.is_file() {
            EntryKind::File
        } else {
            EntryKind::Other
        }
    }

    pub(super) fn open_root(root: &Path) -> Result<Dir, StepError> {
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(root)
            .map_err(io_step)?;
        Ok(Dir {
            final_path: final_path(&handle)?,
        })
    }

    pub(super) fn list(
        _dir: &Dir,
        folder: &Path,
    ) -> std::io::Result<HashMap<OsString, Option<EntryKind>>> {
        let mut entries = HashMap::new();
        for entry in std::fs::read_dir(folder)? {
            let entry = entry?;
            entries.insert(entry.file_name(), entry.file_type().ok().map(kind_of));
        }
        Ok(entries)
    }

    pub(super) fn kind_at(_dir: &Dir, folder: &Path, name: &str) -> std::io::Result<EntryKind> {
        std::fs::symlink_metadata(folder.join(name)).map(|meta| kind_of(meta.file_type()))
    }

    /// Reads one `FILE_INFO_BY_HANDLE_CLASS` into `T`, which must be the structure of that class.
    fn info<T: Default>(file: &File, class: FILE_INFO_BY_HANDLE_CLASS) -> std::io::Result<T> {
        let mut info = T::default();
        // SAFETY: the handle is open for the lifetime of `file`; `info` is a writable `T` of the size passed, and
        // every caller pairs `class` with its own structure.
        let ok = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                class,
                std::ptr::from_mut(&mut info).cast(),
                std::mem::size_of::<T>() as u32,
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(info)
        }
    }

    /// The identity of an open file: the 64-bit volume serial number and the 128-bit file id (`FileIdInfo`; unique
    /// on ReFS too, unlike `nFileIndex`). A file system that has none, or reports all zeros, is refused.
    pub(super) fn file_id(file: &File) -> Result<(u64, [u8; 16]), StepError> {
        let id: FILE_ID_INFO = info(file, FileIdInfo).map_err(|err| match err.raw_os_error() {
            Some(ERROR_INVALID_PARAMETER | ERROR_NOT_SUPPORTED) => StepError::NoIdentity,
            _ => StepError::Io(err),
        })?;
        if id.FileId.Identifier == [0; 16] {
            return Err(StepError::NoIdentity);
        }
        Ok((id.VolumeSerialNumber, id.FileId.Identifier))
    }

    /// The normalized final path of an open handle (long names, the case on disk, links resolved). A file system that
    /// cannot tell it (some network shares) is refused like one without file identity.
    fn final_path(file: &File) -> Result<Vec<u16>, StepError> {
        let mut buffer = vec![0u16; 512];
        loop {
            // SAFETY: the handle is open for the lifetime of `file`; the buffer holds `buffer.len()` elements.
            let len = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    // With `VOLUME_NAME_DOS`, which is 0 too (a drive letter or `\\?\UNC\…`).
                    FILE_NAME_NORMALIZED,
                )
            } as usize;
            if len == 0 {
                return Err(StepError::NoIdentity);
            }
            if len < buffer.len() {
                buffer.truncate(len);
                return Ok(buffer);
            }
            // Too small: `len` is the size needed, with the terminating null.
            buffer.resize(len, 0);
        }
    }

    fn child_path(parent: &[u16], name: &str) -> Vec<u16> {
        let separator = u16::from(b'\\');
        let mut path = parent.to_vec();
        if path.last() != Some(&separator) {
            path.push(separator);
        }
        path.extend(name.encode_utf16());
        path
    }

    fn io_step(err: std::io::Error) -> StepError {
        if err.kind() == std::io::ErrorKind::NotFound {
            StepError::Missing
        } else {
            StepError::Io(err)
        }
    }

    /// Opens `path` as the reparse point itself (if it is one) and refuses a link.
    fn open_no_follow(path: &Path) -> Result<(File, FILE_ATTRIBUTE_TAG_INFO), StepError> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(io_step)?;
        let tag: FILE_ATTRIBUTE_TAG_INFO =
            info(&file, FileAttributeTagInfo).map_err(StepError::Io)?;
        if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            && tag.ReparseTag & NAME_SURROGATE != 0
        {
            return Err(StepError::Link);
        }
        Ok((file, tag))
    }

    /// The opened handle must be exactly at `expected`: no link on the way, no other spelling.
    fn check_place(file: &File, expected: &[u16]) -> Result<(), StepError> {
        if final_path(file)? == expected {
            Ok(())
        } else {
            Err(StepError::Changed)
        }
    }

    pub(super) fn open_dir(dir: &Dir, path: &Path, name: &str) -> Result<Dir, StepError> {
        let (file, tag) = open_no_follow(path)?;
        if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(StepError::NotAFile);
        }
        let expected = child_path(&dir.final_path, name);
        check_place(&file, &expected)?;
        Ok(Dir {
            final_path: expected,
        })
    }

    /// A reparse point that is not a link (a OneDrive placeholder, a deduplicated file) is opened again normally, so
    /// the file system filter behind it serves the contents; it must be the same file.
    pub(super) fn open_file(dir: &Dir, path: &Path, name: &str) -> Result<File, StepError> {
        let (mut file, tag) = open_no_follow(path)?;
        if tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            return Err(StepError::NotAFile);
        }
        let id = file_id(&file)?;
        if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            let reopened = std::fs::OpenOptions::new()
                .read(true)
                .open(path)
                .map_err(io_step)?;
            if file_id(&reopened)? != id {
                return Err(StepError::Changed);
            }
            file = reopened;
        }
        let standard: FILE_STANDARD_INFO = info(&file, FileStandardInfo).map_err(StepError::Io)?;
        if standard.Directory {
            return Err(StepError::NotAFile);
        }
        if standard.NumberOfLinks > 1 {
            return Err(StepError::HardLink);
        }
        check_place(&file, &child_path(&dir.final_path, name))?;
        Ok(file)
    }
}

/// No safe walk known on this system: nothing is served.
#[cfg(not(any(unix, windows)))]
mod walk {
    use super::{EntryKind, StepError};
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::path::Path;

    pub(super) struct Dir;

    fn unsupported() -> std::io::Error {
        std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "extension files cannot be served safely on this system",
        )
    }

    pub(super) fn open_root(_root: &Path) -> Result<Dir, StepError> {
        Err(StepError::Io(unsupported()))
    }

    pub(super) fn list(
        _dir: &Dir,
        _folder: &Path,
    ) -> std::io::Result<HashMap<OsString, Option<EntryKind>>> {
        Err(unsupported())
    }

    pub(super) fn kind_at(_dir: &Dir, _folder: &Path, _name: &str) -> std::io::Result<EntryKind> {
        Err(unsupported())
    }

    pub(super) fn open_dir(_dir: &Dir, _path: &Path, _name: &str) -> Result<Dir, StepError> {
        Err(StepError::Io(unsupported()))
    }

    pub(super) fn open_file(
        _dir: &Dir,
        _path: &Path,
        _name: &str,
    ) -> Result<std::fs::File, StepError> {
        Err(StepError::Io(unsupported()))
    }
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
        let root = walk::open_root(dir.path()).unwrap();
        let err = exact_entry(listings, &root, dir.path(), "INDEX.HTML", "INDEX.HTML");
        if case_insensitive {
            assert_eq!(err.unwrap_err().code, ErrorCode::Invalid);
        } else {
            assert_eq!(err.unwrap_err().code, ErrorCode::NotFound);
        }
        assert!(
            exact_entry(listings, &root, dir.path(), "Index.html", "Index.html").unwrap()
                == EntryKind::File
        );
        // A spelling the system resolves but the folder does not list (here a trailing `/`; on Windows and macOS
        // also other case and short names) is refused on every file system.
        assert_eq!(
            exact_entry(listings, &root, dir.path(), "js/", "js/")
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
        let err =
            exact_entry(listings, &root, dir.path(), "INDEX~1.HTM", "INDEX~1.HTM").unwrap_err();
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
        write_tree(dir.path(), &[("real.js", b"1"), ("lib/x.js", b"2")]);
        std::os::unix::fs::symlink(dir.path().join("real.js"), dir.path().join("link.js")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("lib"), dir.path().join("lib2")).unwrap();
        let root = walk::open_root(dir.path()).unwrap();
        let open_file = |name: &str| walk::open_file(&root, &dir.path().join(name), name);
        let open_dir = |name: &str| walk::open_dir(&root, &dir.path().join(name), name);
        assert!(matches!(open_file("link.js"), Err(StepError::Link)));
        assert!(matches!(open_dir("lib2"), Err(StepError::Link)));
        assert!(matches!(open_file("lib"), Err(StepError::NotAFile)));
        assert!(matches!(open_dir("real.js"), Err(StepError::NotAFile)));
        assert!(matches!(open_file("nope.js"), Err(StepError::Missing)));
        assert_eq!(read_all(open_file("real.js").unwrap()), b"1");
        assert!(open_dir("lib").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_part_swapped_for_a_link_during_the_walk_is_refused_or_never_used() {
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
        let resolve = |dir: &Path, at: &mut dyn FnMut(usize)| {
            resolve_package_file_with(dir, "js/app.js", &mut Listings::default(), at)
        };

        // `js` becomes a link after its name was checked, just before it is opened.
        let (dir, outside) = setup();
        let err = resolve(dir.path(), &mut |part| {
            if part == 0 {
                swap_folder(dir.path(), outside.path());
            }
        })
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err:?}");
        assert!(err.message.contains("symbolic link"), "{err:?}");

        // `js` becomes a link once it is open: the walk goes on in the folder it opened and never through the link.
        let (dir, outside) = setup();
        let file = resolve(dir.path(), &mut |part| {
            if part == 1 {
                swap_folder(dir.path(), outside.path());
            }
        })
        .unwrap();
        assert_eq!(read_all(file), b"mine");

        // The file itself becomes a link just before it is opened.
        let (dir, outside) = setup();
        let err = resolve(dir.path(), &mut |part| {
            if part == 1 {
                let file = dir.path().join("js").join("app.js");
                std::fs::remove_file(&file).unwrap();
                std::os::unix::fs::symlink(outside.path().join("app.js"), &file).unwrap();
            }
        })
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err:?}");
        assert!(err.message.contains("symbolic link"), "{err:?}");

        // Nothing swapped: the file opened is read.
        let (dir, _outside) = setup();
        assert_eq!(read_all(resolve(dir.path(), &mut |_| {}).unwrap()), b"mine");
    }

    /// A FIFO put in place of the file between the check and the open neither hangs the request nor is served.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_fifo_swapped_in_for_the_file_does_not_hang_and_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        write_tree(dir.path(), &[("app.js", b"1")]);
        let err =
            resolve_package_file_with(dir.path(), "app.js", &mut Listings::default(), &mut |_| {
                std::fs::remove_file(dir.path().join("app.js")).unwrap();
                let parent = std::fs::File::open(dir.path()).unwrap();
                rustix::fs::mknodat(
                    &parent,
                    "app.js",
                    rustix::fs::FileType::Fifo,
                    rustix::fs::Mode::from_raw_mode(0o600),
                    0,
                )
                .unwrap();
            })
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{err:?}");
    }

    /// Another name of a hard-linked file may be outside the package: such a file is neither served nor installed.
    #[cfg(any(unix, windows))]
    #[test]
    fn a_hard_linked_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir_in(dir.path().parent().unwrap()).unwrap();
        let m = manifest("hello", "0.1.0", "index.html");
        write_tree(
            dir.path(),
            &[(MANIFEST_FILE, m.as_bytes()), ("index.html", b"x")],
        );
        write_tree(outside.path(), &[("secret.txt", b"stolen")]);
        if let Err(err) =
            std::fs::hard_link(outside.path().join("secret.txt"), dir.path().join("app.js"))
        {
            eprintln!("skipped: hard links cannot be made here: {err}");
            return;
        }
        let err = resolve_package_file(dir.path(), "app.js").unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{err:?}");
        assert!(err.message.contains("hard link"), "{err:?}");
        assert_eq!(
            read_all(resolve_package_file(dir.path(), "index.html").unwrap()),
            b"x"
        );

        let package = inspect_folder(dir.path()).unwrap();
        let data = tempfile::tempdir().unwrap();
        let err = install(&package, data.path()).unwrap_err();
        assert!(err.message.contains("hard link"), "{err:?}");
        assert!(!data.path().join("hello").join("0.1.0").exists());
    }

    /// `mklink /J`: junctions need no symbolic-link privilege.
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(windows)]
    #[test]
    fn junctions_and_symbolic_links_are_refused_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let m = manifest("hello", "0.1.0", "index.html");
        write_tree(
            dir.path(),
            &[(MANIFEST_FILE, m.as_bytes()), ("index.html", b"x")],
        );
        write_tree(outside.path(), &[("app.js", b"stolen")]);
        let refused = |request: &str| {
            let err = resolve_package_file(dir.path(), request).unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{request}: {err:?}");
            assert!(err.message.contains("symbolic link"), "{request}: {err:?}");
            let message = invalid_message(inspect_folder(dir.path()));
            assert!(message.contains("symbolic link"), "{request}: {message}");
        };

        let js = dir.path().join("js");
        if junction(&js, outside.path()) {
            refused("js/app.js");
            std::fs::remove_dir(&js).unwrap();
        } else {
            eprintln!("skipped junction: `mklink /J` failed here");
        }
        let lib = dir.path().join("lib");
        match std::os::windows::fs::symlink_dir(outside.path(), &lib) {
            Ok(()) => {
                refused("lib/app.js");
                std::fs::remove_dir(&lib).unwrap();
            }
            Err(err) => eprintln!("skipped directory symlink: {err}"),
        }
        let app = dir.path().join("app.js");
        match std::os::windows::fs::symlink_file(outside.path().join("app.js"), &app) {
            Ok(()) => {
                refused("app.js");
                std::fs::remove_file(&app).unwrap();
            }
            Err(err) => eprintln!("skipped file symlink: {err}"),
        }
        assert!(inspect_folder(dir.path()).is_ok(), "nothing left behind");
    }

    #[cfg(windows)]
    #[test]
    fn file_identity_tells_files_apart_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        write_tree(dir.path(), &[("a.js", b"1"), ("b.js", b"1")]);
        let open = |name: &str| std::fs::File::open(dir.path().join(name)).unwrap();
        let a = walk::file_id(&open("a.js")).unwrap();
        assert_ne!(a.1, [0; 16]);
        assert_eq!(a, walk::file_id(&open("a.js")).unwrap(), "the same file");
        assert_ne!(a, walk::file_id(&open("b.js")).unwrap(), "another file");
    }

    /// A part on another device than the root (a mount point inside the package) is refused; the root's device is
    /// what every part is compared with, so a walk started from a root on "another device" refuses everything.
    #[cfg(unix)]
    #[test]
    fn a_part_on_another_file_system_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        write_tree(dir.path(), &[("a.js", b"1"), ("js/b.js", b"2")]);
        let mut root = walk::open_root(dir.path()).unwrap();
        assert!(walk::open_dir(&root, &dir.path().join("js"), "js").is_ok());
        assert!(walk::open_file(&root, &dir.path().join("a.js"), "a.js").is_ok());
        root.root_dev = root.root_dev.wrapping_add(1);
        assert!(matches!(
            walk::open_dir(&root, &dir.path().join("js"), "js"),
            Err(StepError::OtherDevice)
        ));
        assert!(matches!(
            walk::open_file(&root, &dir.path().join("a.js"), "a.js"),
            Err(StepError::OtherDevice)
        ));
        let err = step_error(StepError::OtherDevice, "js/b.js", dir.path());
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(err.message.contains("mount point"), "{err:?}");
    }

    #[test]
    fn a_file_system_without_identity_is_named_with_the_fix() {
        let err = step_error(StepError::NoIdentity, "app.js", Path::new("dev"));
        assert_eq!(err.code, ErrorCode::Invalid);
        for part in ["network share", "FAT/exFAT", "NTFS or ReFS"] {
            assert!(err.message.contains(part), "{part}: {err:?}");
        }
    }

    /// `js` is swapped for a junction (or a directory link) to a folder outside after it was checked and opened: the
    /// file opened through it is not where the walk expects it (final path), so it is refused.
    #[cfg(windows)]
    #[test]
    fn a_folder_swapped_for_a_junction_during_the_walk_is_refused_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_tree(dir.path(), &[("js/app.js", b"mine")]);
        write_tree(outside.path(), &[("app.js", b"stolen")]);
        let js = dir.path().join("js");
        let mut linked = None;
        let result = resolve_package_file_with(
            dir.path(),
            "js/app.js",
            &mut Listings::default(),
            &mut |part| {
                if part == 1 {
                    std::fs::rename(&js, dir.path().join("js-real")).unwrap();
                    linked = Some(if junction(&js, outside.path()) {
                        Ok("junction")
                    } else {
                        std::os::windows::fs::symlink_dir(outside.path(), &js).map(|()| "symlink")
                    });
                }
            },
        );
        match linked {
            Some(Ok(kind)) => {
                let err = result.expect_err(kind);
                assert_eq!(err.code, ErrorCode::Invalid, "{kind}: {err:?}");
                assert!(
                    err.message.contains("changed while it was being opened"),
                    "{kind}: {err:?}"
                );
            }
            Some(Err(err)) => {
                eprintln!("skipped: neither a junction nor a directory link can be made: {err}")
            }
            None => panic!("the walk never reached the file"),
        }
    }
}
