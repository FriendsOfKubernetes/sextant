//! Copying files to and from containers, as `kubectl cp` does: `tar` runs in the container over exec.
//!
//! - [`stat`] says what a path in the container is (file, folder, link) and how big, from the first header of
//!   `tar cf - -C <parent> <name>` (the rest is not read); a folder's size is `du -sk`'s estimate when the container
//!   has `du`.
//! - [`download`] streams `tar cf - -C <parent> <name>` to a local path. A file is unpacked (its content alone is
//!   written); a folder is kept as the tar stream, gzip-compressed (`.tar.gz`), and never unpacked here. The single
//!   file is checked before anything is written: exactly one regular-file entry named as asked, never an absolute path,
//!   `..`, a link, or a second entry. It is written to a temporary file next to the destination, which is renamed over
//!   the destination when complete (a link at the destination is replaced, never followed); a transfer that fails or
//!   is dropped (cancelled) removes the temporary file and leaves the destination as it was.
//! - [`upload`] sends one local file into the container as a tar stream on the stdin of `tar xf - -C <parent>`.
//!
//! Both report progress (bytes so far and the total when known) through a callback, and stop when their future is
//! dropped. A container without `tar` is a clear `notFound`. The user's own tool: AI agents and extensions are never
//! offered it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use flate2::Compression;
use flate2::write::GzEncoder;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::Api;
use kube::api::AttachParams;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::exec::{
    self, default_container, exec_error, exit_code, is_missing_binary, status_message,
};
use crate::kubeconfig::ClusterId;
use crate::resources::ObjectRef;

const BLOCK: usize = 512;
/// Tar writers pad an archive to whole records of 20 blocks; a reader may stop after the end marker without waiting
/// for the end of its input.
const RECORD: usize = 20 * BLOCK;
const CHUNK: usize = 64 * 1024;
/// Long-name and pax records before one entry may take at most this much.
const MAX_HEADER_BYTES: u64 = 2 * 1024 * 1024;
/// How much of `tar`'s stderr is kept for an error message.
const MAX_STDERR: usize = 4 * 1024;
/// `du` may take this long before a folder's size is left unknown.
const DU_TIMEOUT: Duration = Duration::from_secs(10);
/// After an upload is written, how long `tar` may take to finish before its stdin is closed.
const UPLOAD_GRACE: Duration = Duration::from_secs(5);
/// How long `tar` may take to finish an upload once its stdin is closed.
const UPLOAD_FINISH: Duration = Duration::from_secs(60);

/// What a path in a container is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RemoteKind {
    File,
    Directory,
    Symlink,
    Other,
}

/// A path in a container ([`stat`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteEntry {
    /// The path as asked.
    pub path: String,
    /// Its last part: the default name to save it as (a folder: `<name>.tar.gz`).
    pub name: String,
    pub kind: RemoteKind,
    /// A file's size; a folder's estimate (`du -sk`), `None` when unknown.
    #[ts(type = "number | null")]
    pub size: Option<u64>,
    /// Where a symbolic link points.
    pub link_target: Option<String>,
}

/// How far a transfer got: bytes so far and the total when known (a folder's total is an estimate).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TransferProgress {
    #[ts(type = "number")]
    pub transferred: u64,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
}

/// What [`download`] wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Downloaded {
    pub kind: RemoteKind,
    /// Bytes written to the destination.
    pub bytes: u64,
}

/// The error of a container without `tar`.
fn no_tar(container: &str) -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        format!(
            "Container {container} has no tar: Sextant copies files with tar, like kubectl cp. Use a debug container \
             or an image that has tar"
        ),
    )
}

/// Splits a path in the container into the folder `tar` runs in and the name it archives. `/` is the folder `/` and
/// the name `.`; a name `..` or `.` (other than for `/`) and an empty path are `invalid`.
pub fn split_remote_path(path: &str) -> CoreResult<(String, String)> {
    let trimmed = path.trim();
    let invalid = || {
        CoreError::new(
            ErrorCode::Invalid,
            format!("not a path in the container: {path:?}"),
        )
    };
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(invalid());
    }
    let without_slash = trimmed.trim_end_matches('/');
    if without_slash.is_empty() {
        return Ok(("/".into(), ".".into()));
    }
    let (parent, name) = match without_slash.rsplit_once('/') {
        Some(("", name)) => ("/".to_owned(), name.to_owned()),
        Some((parent, name)) => (parent.to_owned(), name.to_owned()),
        None => (".".to_owned(), without_slash.to_owned()),
    };
    if name == "." || name == ".." {
        return Err(invalid());
    }
    Ok((parent, name))
}

/// `name` as `tar` gets it: `./<name>`, so a name starting with `-` is never read as an option.
fn member(name: &str) -> String {
    if name == "." {
        ".".to_owned()
    } else {
        format!("./{name}")
    }
}

/// The container to use: the one named, or the one `kubectl` would pick.
async fn container_of(
    api: &Api<Pod>,
    pod: &ObjectRef,
    container: Option<&str>,
) -> CoreResult<String> {
    match container.map(str::trim).filter(|c| !c.is_empty()) {
        Some(name) => Ok(name.to_owned()),
        None => default_container(api, &pod.name).await,
    }
}

fn pods(mgr: &ClusterManager, cluster: &ClusterId, pod: &ObjectRef) -> CoreResult<Api<Pod>> {
    let client = mgr.client(cluster)?;
    Ok(Api::namespaced(client, pod.required_namespace()?))
}

/// `tar` with its output streams.
struct TarProcess {
    attached: kube::api::AttachedProcess,
    stdout: Option<Box<dyn AsyncRead + Send + Unpin>>,
    stdin: Option<Box<dyn AsyncWrite + Send + Unpin>>,
    stderr: Box<dyn AsyncRead + Send + Unpin>,
    status: std::pin::Pin<Box<dyn Future<Output = Option<Status>> + Send>>,
}

async fn run_tar(
    api: &Api<Pod>,
    pod: &ObjectRef,
    container: &str,
    args: &[&str],
    input: bool,
) -> CoreResult<TarProcess> {
    let params = AttachParams::default()
        .container(container)
        .stdin(input)
        .stdout(!input)
        .stderr(true)
        .max_stdout_buf_size(CHUNK)
        .max_stdin_buf_size(CHUNK)
        .max_stderr_buf_size(MAX_STDERR);
    let mut command = vec!["tar"];
    command.extend_from_slice(args);
    let mut attached = api
        .exec(&pod.name, command, &params)
        .await
        .map_err(|e| exec_error(e, pod, container, "copy files"))?;
    let stdout = attached
        .stdout()
        .map(|s| Box::new(s) as Box<dyn AsyncRead + Send + Unpin>);
    let stdin = attached
        .stdin()
        .map(|s| Box::new(s) as Box<dyn AsyncWrite + Send + Unpin>);
    let (Some(stderr), Some(status)) = (attached.stderr(), attached.take_status()) else {
        return Err(CoreError::other("exec session without output streams"));
    };
    Ok(TarProcess {
        attached,
        stdout,
        stdin,
        stderr: Box::new(stderr),
        status: Box::pin(status),
    })
}

/// Reads at most [`MAX_STDERR`] bytes of `reader` (the rest is dropped) until it ends.
async fn collect_stderr(mut reader: impl AsyncRead + Unpin) -> String {
    let mut kept = Vec::new();
    let mut buf = vec![0u8; 4096];
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let room = MAX_STDERR.saturating_sub(kept.len());
        kept.extend_from_slice(&buf[..n.min(room)]);
    }
    String::from_utf8_lossy(&kept).trim().to_owned()
}

/// The error of a `tar` that failed (or never ran) in `container`, for `path`.
fn tar_failed(status: Option<&Status>, stderr: &str, container: &str, path: &str) -> CoreError {
    if is_missing_binary(status) && !stderr.contains("tar:") {
        return no_tar(container);
    }
    let reason = if stderr.is_empty() {
        status_message(status)
    } else {
        stderr.to_owned()
    };
    let lower = reason.to_lowercase();
    let code = if lower.contains("no such file") || lower.contains("not found") {
        ErrorCode::NotFound
    } else if lower.contains("permission denied") {
        ErrorCode::Forbidden
    } else {
        ErrorCode::Other
    };
    CoreError::new(code, format!("cannot copy {path}: {reason}"))
}

fn succeeded(status: Option<&Status>) -> bool {
    status.and_then(exit_code) == Some(0)
}

/// What `path` in `container` of `pod` is ([`RemoteEntry`]). `container` `None`: the one `kubectl` would pick.
pub async fn stat(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    pod: &ObjectRef,
    container: Option<&str>,
    path: &str,
) -> CoreResult<RemoteEntry> {
    let (parent, name) = split_remote_path(path)?;
    let api = pods(mgr, cluster, pod)?;
    let container = container_of(&api, pod, container).await?;
    let mut tar = run_tar(
        &api,
        pod,
        &container,
        &["cf", "-", "-C", &parent, &member(&name)],
        false,
    )
    .await?;
    let stdout = tar.stdout.take().expect("stdout was asked for");
    let mut reader = TarReader::new(stdout);
    let entry = match reader.next_entry().await {
        Ok(Some(entry)) => {
            tar.attached.abort();
            entry
        }
        other => {
            let (stderr, status) = tokio::join!(collect_stderr(tar.stderr), tar.status);
            let failed = tar_failed(status.as_ref(), &stderr, &container, path);
            return Err(match other {
                Err(err) if failed.code == ErrorCode::Other => err,
                _ => failed,
            });
        }
    };
    let display_name = if name == "." {
        "root".to_owned()
    } else {
        name.clone()
    };
    let (kind, size, link_target) = match entry.kind {
        EntryKind::Regular => (RemoteKind::File, Some(entry.size), None),
        EntryKind::Directory => {
            let size = folder_size(mgr, cluster, pod, &container, path).await;
            (RemoteKind::Directory, size, None)
        }
        EntryKind::Symlink => (RemoteKind::Symlink, None, entry.link.clone()),
        _ => (RemoteKind::Other, None, None),
    };
    Ok(RemoteEntry {
        path: path.trim().to_owned(),
        name: display_name,
        kind,
        size,
        link_target,
    })
}

/// `du -sk <path>` in bytes, `None` when the container has no `du` or it fails.
async fn folder_size(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    pod: &ObjectRef,
    container: &str,
    path: &str,
) -> Option<u64> {
    let command = [
        "du".to_owned(),
        "-sk".to_owned(),
        "--".to_owned(),
        path.trim().to_owned(),
    ];
    let out = exec::run_command(
        mgr,
        cluster,
        pod,
        Some(container),
        &command,
        DU_TIMEOUT,
        4096,
    )
    .await
    .ok()?;
    let kib: u64 = out.stdout.split_whitespace().next()?.parse().ok()?;
    Some(kib * 1024)
}

/// Downloads `path` from `container` of `pod` (`None`: the one `kubectl` would pick) to `destination`: a file's
/// content, or a folder as `.tar.gz` (see the module docs). With `expected` (what [`stat`] saw), a path that turned
/// into something else meanwhile is refused before anything is written. `progress` gets the bytes received so far.
#[allow(clippy::too_many_arguments)]
pub async fn download(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    pod: &ObjectRef,
    container: Option<&str>,
    path: &str,
    expected: Option<RemoteKind>,
    destination: &Path,
    progress: &mut (dyn FnMut(TransferProgress) + Send),
) -> CoreResult<Downloaded> {
    let (parent, name) = split_remote_path(path)?;
    let api = pods(mgr, cluster, pod)?;
    let container = container_of(&api, pod, container).await?;
    let mut tar = run_tar(
        &api,
        pod,
        &container,
        &["cf", "-", "-C", &parent, &member(&name)],
        false,
    )
    .await?;
    let stdout = tar.stdout.take().expect("stdout was asked for");
    let estimate = folder_size(mgr, cluster, pod, &container, path);
    let stderr = collect_stderr(tar.stderr);
    let attached = &tar.attached;
    let receiving = async {
        let received = receive(stdout, &name, expected, destination, estimate, progress).await;
        if received.is_err() {
            // Refused or broken: tar is stopped rather than left writing to nobody.
            attached.abort();
        }
        received
    };
    let (received, stderr) = tokio::join!(receiving, stderr);
    let status = tar.status.await;
    match received {
        Ok(Some(done)) if succeeded(status.as_ref()) => Ok(done.commit()?),
        Ok(Some(_)) | Ok(None) => Err(tar_failed(status.as_ref(), &stderr, &container, path)),
        Err(err) if status.as_ref().is_some_and(|s| !succeeded(Some(s))) => {
            // The stream broke because tar failed: its reason says more.
            let failed = tar_failed(status.as_ref(), &stderr, &container, path);
            Err(if failed.code == ErrorCode::Other {
                err
            } else {
                failed
            })
        }
        Err(err) => Err(err),
    }
}

/// A download written to its temporary file, renamed over the destination by [`Received::commit`] (dropping it removes
/// the temporary file).
#[derive(Debug)]
pub struct Received {
    temp: tempfile::TempPath,
    destination: PathBuf,
    kind: RemoteKind,
    bytes: u64,
}

impl Received {
    pub fn commit(self) -> CoreResult<Downloaded> {
        self.temp
            .persist(&self.destination)
            .map_err(|e| local_error(&self.destination, &e.error))?;
        Ok(Downloaded {
            kind: self.kind,
            bytes: self.bytes,
        })
    }
}

fn local_error(path: &Path, err: &std::io::Error) -> CoreError {
    let code = match err.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::Forbidden,
        _ => ErrorCode::Other,
    };
    CoreError::new(code, format!("cannot write {}: {err}", path.display()))
}

/// Receives the tar stream of `name` into a temporary file next to `destination`: a regular file is unpacked, a folder
/// is kept as `.tar.gz` (its total is `estimate`). `Ok(None)`: the stream was empty (tar failed; its status says why).
/// Anything else in the stream — an absolute path, `..`, a link, a second entry, another name — is refused and nothing
/// is kept.
pub async fn receive(
    stream: impl AsyncRead + Unpin,
    name: &str,
    expected: Option<RemoteKind>,
    destination: &Path,
    estimate: impl Future<Output = Option<u64>>,
    progress: &mut (dyn FnMut(TransferProgress) + Send),
) -> CoreResult<Option<Received>> {
    let mut reader = TarReader::new(stream).recording();
    let Some(entry) = reader.next_entry().await? else {
        return Ok(None);
    };
    let path = checked_path(&entry.path)?;
    if path != name {
        return Err(hostile(format!(
            "the archive holds {:?} instead of {name:?}",
            entry.path
        )));
    }
    let actual = match entry.kind {
        EntryKind::Regular => RemoteKind::File,
        EntryKind::Directory => RemoteKind::Directory,
        EntryKind::Symlink => RemoteKind::Symlink,
        EntryKind::Hardlink | EntryKind::Other(_) => RemoteKind::Other,
    };
    if let Some(expected) = expected
        && expected != actual
    {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "{name} changed since it was checked: it was a {expected:?} and is now a {actual:?}"
            ),
        ));
    }
    let folder = destination.parent().filter(|p| !p.as_os_str().is_empty());
    let temp = tempfile::Builder::new()
        .prefix(".sextant-download-")
        .suffix(".part")
        .tempfile_in(folder.unwrap_or_else(|| Path::new(".")))
        .map_err(|e| local_error(destination, &e))?;
    let (file, temp) = temp.into_parts();
    let mut file = tokio::fs::File::from_std(file);
    let (kind, bytes) = match entry.kind {
        EntryKind::Regular => {
            let total = Some(entry.size);
            progress(TransferProgress {
                transferred: 0,
                total,
            });
            let bytes = reader
                .copy_data(entry.size, &mut file, &mut |transferred| {
                    progress(TransferProgress { transferred, total })
                })
                .await
                .map_err(|e| e.into_core(destination))?;
            if let Some(extra) = reader.next_entry().await? {
                return Err(hostile(format!(
                    "the archive holds more than one entry ({:?})",
                    extra.path
                )));
            }
            (RemoteKind::File, bytes)
        }
        EntryKind::Directory => {
            let total = estimate.await;
            let (head, mut rest) = reader.into_parts();
            let bytes = gzip_into(&head, &mut rest, &mut file, &mut |transferred| {
                progress(TransferProgress { transferred, total })
            })
            .await
            .map_err(|e| e.into_core(destination))?;
            (RemoteKind::Directory, bytes)
        }
        EntryKind::Symlink => {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!(
                    "{name} is a symbolic link to {}; download the file it points to",
                    entry.link.unwrap_or_default()
                ),
            ));
        }
        EntryKind::Hardlink => return Err(hostile("the archive holds a hard link".into())),
        EntryKind::Other(_) => {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!("{name} is neither a file nor a folder"),
            ));
        }
    };
    file.flush()
        .await
        .map_err(|e| local_error(destination, &e))?;
    file.sync_all()
        .await
        .map_err(|e| local_error(destination, &e))?;
    drop(file);
    Ok(Some(Received {
        temp,
        destination: destination.to_owned(),
        kind,
        bytes,
    }))
}

fn hostile(reason: String) -> CoreError {
    CoreError::new(
        ErrorCode::Invalid,
        format!("refused the archive from the container: {reason}"),
    )
}

/// An entry's path without `./` and a trailing `/`; absolute paths and `..` are refused.
fn checked_path(path: &str) -> CoreResult<String> {
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\0') {
        return Err(hostile(format!("absolute path {path:?}")));
    }
    let parts: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.contains(&"..") {
        return Err(hostile(format!("path {path:?} leaves its folder")));
    }
    if parts
        .first()
        .is_some_and(|p| p.len() == 2 && p.ends_with(':'))
    {
        return Err(hostile(format!("absolute path {path:?}")));
    }
    Ok(if parts.is_empty() {
        ".".to_owned()
    } else {
        parts.join("/")
    })
}

/// Writes `head` and then everything `rest` gives, gzip-compressed, to `out`; `on_bytes` gets the uncompressed bytes
/// so far. Returns the compressed size.
async fn gzip_into(
    head: &[u8],
    rest: &mut (impl AsyncRead + Unpin),
    out: &mut (impl AsyncWrite + Unpin),
    on_bytes: &mut (dyn FnMut(u64) + Send),
) -> Result<u64, IoFailure> {
    use std::io::Write as _;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut written = 0u64;
    let mut transferred = head.len() as u64;
    encoder.write_all(head).map_err(IoFailure::Local)?;
    on_bytes(transferred);
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = rest.read(&mut buf).await.map_err(IoFailure::Remote)?;
        if n == 0 {
            break;
        }
        encoder.write_all(&buf[..n]).map_err(IoFailure::Local)?;
        transferred += n as u64;
        let chunk = std::mem::take(encoder.get_mut());
        if !chunk.is_empty() {
            out.write_all(&chunk).await.map_err(IoFailure::Local)?;
            written += chunk.len() as u64;
        }
        on_bytes(transferred);
    }
    let tail = encoder.finish().map_err(IoFailure::Local)?;
    out.write_all(&tail).await.map_err(IoFailure::Local)?;
    Ok(written + tail.len() as u64)
}

/// Uploads the local file `source` into `container` of `pod` (`None`: the one `kubectl` would pick) as `path` (the
/// file's full path in the container; its folder must exist). `progress` gets the bytes sent so far. Returns the size.
pub async fn upload(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    pod: &ObjectRef,
    container: Option<&str>,
    source: &Path,
    path: &str,
    progress: &mut (dyn FnMut(TransferProgress) + Send),
) -> CoreResult<u64> {
    let (parent, name) = split_remote_path(path)?;
    let local = LocalFile::open(source).await?;
    let api = pods(mgr, cluster, pod)?;
    let container = container_of(&api, pod, container).await?;
    let mut tar = run_tar(&api, pod, &container, &["xf", "-", "-C", &parent], true).await?;
    let mut stdin = tar.stdin.take().expect("stdin was asked for");
    let stderr = collect_stderr(tar.stderr);
    let mut status = tar.status;
    let send = async {
        let sent = send_file(&mut stdin, &name, local, progress).await;
        if sent.is_ok() {
            // `tar` stops after the end marker; a `tar` that waits for the end of its input gets it after a while.
            if let Ok(status) = tokio::time::timeout(UPLOAD_GRACE, &mut status).await {
                return (sent, Some(status));
            }
            let _ = stdin.shutdown().await;
        }
        let status = tokio::time::timeout(UPLOAD_FINISH, &mut status).await;
        (sent, status.ok())
    };
    let ((sent, status), stderr) = tokio::join!(send, stderr);
    let Some(status) = status else {
        tar.attached.abort();
        return Err(CoreError::new(
            ErrorCode::Timeout,
            format!("tar in container {container} did not finish the upload of {path}"),
        ));
    };
    if !succeeded(status.as_ref()) {
        return Err(tar_failed(status.as_ref(), &stderr, &container, path));
    }
    sent.map_err(|e| e.into_core(source))
}

/// A local file opened for an upload.
pub struct LocalFile {
    file: tokio::fs::File,
    size: u64,
    mode: u32,
    mtime: u64,
}

impl LocalFile {
    /// Opens `path`, which must be a regular file (a link is followed: the user chose it).
    pub async fn open(path: &Path) -> CoreResult<Self> {
        let not_a_file = || {
            CoreError::new(
                ErrorCode::Invalid,
                format!("{} is not a file", path.display()),
            )
        };
        let file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            // Windows refuses to open a folder as a file with "access denied": say what it is.
            Err(_) if tokio::fs::metadata(path).await.is_ok_and(|m| m.is_dir()) => {
                return Err(not_a_file());
            }
            Err(e) => return Err(read_error(path, &e)),
        };
        let meta = file.metadata().await.map_err(|e| read_error(path, &e))?;
        if !meta.is_file() {
            return Err(not_a_file());
        }
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt as _;
            meta.permissions().mode() & 0o777
        };
        #[cfg(not(unix))]
        let mode = 0o644;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        Ok(Self {
            file,
            size: meta.len(),
            mode,
            mtime,
        })
    }

    pub fn size(&self) -> u64 {
        self.size
    }
}

fn read_error(path: &Path, err: &std::io::Error) -> CoreError {
    let code = match err.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::Forbidden,
        _ => ErrorCode::Other,
    };
    CoreError::new(code, format!("cannot read {}: {err}", path.display()))
}

/// Writes a tar archive with one regular file `name` (the content of `local`) to `out`, padded to whole records, and
/// flushes it. `progress` gets the content bytes so far. Returns the content size.
pub async fn send_file(
    out: &mut (impl AsyncWrite + Unpin),
    name: &str,
    mut local: LocalFile,
    progress: &mut (dyn FnMut(TransferProgress) + Send),
) -> Result<u64, IoFailure> {
    let total = Some(local.size);
    let mut written = 0usize;
    for block in file_headers(name, local.size, local.mode, local.mtime) {
        out.write_all(&block).await.map_err(IoFailure::Remote)?;
        written += block.len();
    }
    progress(TransferProgress {
        transferred: 0,
        total,
    });
    let mut sent = 0u64;
    let mut buf = vec![0u8; CHUNK];
    while sent < local.size {
        let want = usize::try_from(local.size - sent).map_or(CHUNK, |left| left.min(CHUNK));
        let n = local
            .file
            .read(&mut buf[..want])
            .await
            .map_err(IoFailure::Local)?;
        if n == 0 {
            return Err(IoFailure::Local(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "the file got shorter while it was sent",
            )));
        }
        out.write_all(&buf[..n]).await.map_err(IoFailure::Remote)?;
        sent += n as u64;
        written += n;
        progress(TransferProgress {
            transferred: sent,
            total,
        });
    }
    // Padding of the content, the end marker (two zero blocks), and the rest of the last record.
    let padded = written.div_ceil(BLOCK) * BLOCK + 2 * BLOCK;
    let end = padded.div_ceil(RECORD) * RECORD;
    out.write_all(&vec![0u8; end - written])
        .await
        .map_err(IoFailure::Remote)?;
    out.flush().await.map_err(IoFailure::Remote)?;
    Ok(sent)
}

/// A failed read or write of a transfer: on this machine (`Local`) or of the stream to the container (`Remote`).
#[derive(Debug)]
pub enum IoFailure {
    Local(std::io::Error),
    Remote(std::io::Error),
    Core(CoreError),
}

impl IoFailure {
    fn into_core(self, local: &Path) -> CoreError {
        match self {
            IoFailure::Local(err) => local_error(local, &err),
            IoFailure::Remote(err) => CoreError::new(
                ErrorCode::Unreachable,
                format!("the connection to the container broke: {err}"),
            ),
            IoFailure::Core(err) => err,
        }
    }
}

/// The header blocks of a regular file `name` (a GNU long-name record first when the name does not fit in 100 bytes).
fn file_headers(name: &str, size: u64, mode: u32, mtime: u64) -> Vec<[u8; BLOCK]> {
    let mut blocks = Vec::new();
    let bytes = name.as_bytes();
    if bytes.len() > 100 {
        let mut long = bytes.to_vec();
        long.push(0);
        blocks.push(header(b"././@LongLink", long.len() as u64, 0o644, 0, b'L'));
        for chunk in long.chunks(BLOCK) {
            let mut block = [0u8; BLOCK];
            block[..chunk.len()].copy_from_slice(chunk);
            blocks.push(block);
        }
    }
    blocks.push(header(
        &bytes[..bytes.len().min(100)],
        size,
        mode,
        mtime,
        b'0',
    ));
    blocks
}

fn header(name: &[u8], size: u64, mode: u32, mtime: u64, kind: u8) -> [u8; BLOCK] {
    let mut h = [0u8; BLOCK];
    h[..name.len()].copy_from_slice(name);
    put_octal(&mut h[100..108], u64::from(mode));
    put_octal(&mut h[108..116], 0);
    put_octal(&mut h[116..124], 0);
    put_number(&mut h[124..136], size);
    put_number(&mut h[136..148], mtime);
    h[156] = kind;
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    h[148..156].fill(b' ');
    let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
    put_octal(&mut h[148..155], u64::from(sum));
    h[155] = b' ';
    h
}

/// `value` as zero-padded octal ending in NUL.
fn put_octal(field: &mut [u8], value: u64) {
    let digits = field.len() - 1;
    let text = format!("{value:0digits$o}");
    field[..digits].copy_from_slice(&text.as_bytes()[text.len() - digits..]);
    field[digits] = 0;
}

/// Octal when it fits, else the base-256 form (GNU) for big sizes.
fn put_number(field: &mut [u8], value: u64) {
    let digits = field.len() - 1;
    if value < 8u64.pow(digits as u32) {
        put_octal(field, value);
        return;
    }
    field.fill(0);
    let bytes = value.to_be_bytes();
    let len = field.len();
    field[len - 8..].copy_from_slice(&bytes);
    field[0] = 0x80;
}

/// What a tar entry is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Regular,
    Directory,
    Symlink,
    Hardlink,
    Other(u8),
}

/// One entry of a tar stream: its header, as long names and pax records say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TarEntry {
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub link: Option<String>,
}

/// Reads a tar stream (ustar, GNU long names, pax headers) entry by entry. With [`TarReader::recording`], every byte read
/// is kept until [`TarReader::into_parts`].
pub struct TarReader<R> {
    inner: R,
    recorded: Option<Vec<u8>>,
    /// Data of the current entry not read yet (padding included).
    pending: u64,
}

impl<R: AsyncRead + Unpin> TarReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            recorded: None,
            pending: 0,
        }
    }

    pub fn recording(mut self) -> Self {
        self.recorded = Some(Vec::new());
        self
    }

    /// The bytes read so far (when recording) and the rest of the stream.
    pub fn into_parts(self) -> (Vec<u8>, R) {
        (self.recorded.unwrap_or_default(), self.inner)
    }

    async fn read_exact_or_end(&mut self, buf: &mut [u8]) -> CoreResult<bool> {
        let mut filled = 0;
        while filled < buf.len() {
            let n = self
                .inner
                .read(&mut buf[filled..])
                .await
                .map_err(|e| truncated(&e.to_string()))?;
            if n == 0 {
                if filled == 0 {
                    return Ok(false);
                }
                return Err(truncated("the stream ended inside a block"));
            }
            filled += n;
        }
        if let Some(recorded) = self.recorded.as_mut() {
            recorded.extend_from_slice(buf);
        }
        Ok(true)
    }

    async fn read_block(&mut self) -> CoreResult<Option<[u8; BLOCK]>> {
        let mut block = [0u8; BLOCK];
        Ok(self.read_exact_or_end(&mut block).await?.then_some(block))
    }

    /// Reads the small data of a long name or pax record (at most 1 MiB).
    async fn read_small(&mut self, size: u64) -> CoreResult<Vec<u8>> {
        if size > 1024 * 1024 {
            return Err(hostile("an oversized header record".into()));
        }
        let padded = (size as usize).div_ceil(BLOCK) * BLOCK;
        let mut data = vec![0u8; padded];
        if !self.read_exact_or_end(&mut data).await? {
            return Err(truncated("the stream ended inside a header record"));
        }
        data.truncate(size as usize);
        Ok(data)
    }

    /// Skips what is left of the current entry's data.
    async fn skip_pending(&mut self) -> CoreResult<()> {
        let mut buf = vec![0u8; BLOCK];
        while self.pending > 0 {
            if !self.read_exact_or_end(&mut buf).await? {
                return Err(truncated("the stream ended inside an entry"));
            }
            self.pending -= BLOCK as u64;
        }
        Ok(())
    }

    /// The next entry, `None` at the end marker or the end of the stream. Its data is skipped by the next call unless
    /// read with [`TarReader::copy_data`].
    pub async fn next_entry(&mut self) -> CoreResult<Option<TarEntry>> {
        self.skip_pending().await?;
        let mut long_name: Option<String> = None;
        let mut long_link: Option<String> = None;
        let mut pax_path: Option<String> = None;
        let mut pax_link: Option<String> = None;
        let mut pax_size: Option<u64> = None;
        let mut header_bytes: u64 = 0;
        loop {
            let Some(block) = self.read_block().await? else {
                return Ok(None);
            };
            if block.iter().all(|&b| b == 0) {
                return Ok(None);
            }
            if !checksum_ok(&block) {
                return Err(CoreError::new(
                    ErrorCode::Invalid,
                    "the container did not send a tar stream",
                ));
            }
            let size = parse_number(&block[124..136])?;
            let flag = block[156];
            if matches!(flag, b'L' | b'K' | b'x' | b'g') {
                header_bytes = header_bytes
                    .saturating_add(BLOCK as u64)
                    .saturating_add(size.div_ceil(BLOCK as u64) * BLOCK as u64);
                if header_bytes > MAX_HEADER_BYTES {
                    return Err(hostile("header records too large before an entry".into()));
                }
            }
            match flag {
                b'L' => long_name = Some(text(&self.read_small(size).await?)),
                b'K' => long_link = Some(text(&self.read_small(size).await?)),
                b'x' => {
                    let data = self.read_small(size).await?;
                    for (key, value) in pax_records(&data) {
                        match key.as_str() {
                            "path" => pax_path = Some(value),
                            "linkpath" => pax_link = Some(value),
                            "size" => pax_size = value.parse().ok(),
                            _ => {}
                        }
                    }
                }
                b'g' => {
                    self.read_small(size).await?;
                }
                _ => {
                    let ustar = &block[257..263] == b"ustar\0";
                    let name = text(&block[..100]);
                    let prefix = if ustar {
                        text(&block[345..500])
                    } else {
                        String::new()
                    };
                    let short = if prefix.is_empty() {
                        name
                    } else {
                        format!("{prefix}/{name}")
                    };
                    let path = pax_path.or(long_name).unwrap_or(short);
                    let link = pax_link
                        .or(long_link)
                        .or_else(|| Some(text(&block[157..257])).filter(|l| !l.is_empty()));
                    let size = pax_size.unwrap_or(size);
                    let kind = match flag {
                        b'0' | 0 | b'7' => {
                            if path.ends_with('/') {
                                EntryKind::Directory
                            } else {
                                EntryKind::Regular
                            }
                        }
                        b'5' => EntryKind::Directory,
                        b'2' => EntryKind::Symlink,
                        b'1' => EntryKind::Hardlink,
                        other => EntryKind::Other(other),
                    };
                    // Only regular files carry data (other entries' size fields are not data).
                    let data = if matches!(kind, EntryKind::Regular)
                        || matches!(kind, EntryKind::Other(_))
                    {
                        size
                    } else {
                        0
                    };
                    self.pending = data.div_ceil(BLOCK as u64) * BLOCK as u64;
                    return Ok(Some(TarEntry {
                        path,
                        kind,
                        size,
                        link,
                    }));
                }
            }
        }
    }

    /// Copies the current entry's `size` bytes of data to `out` (its padding is skipped); `on_bytes` gets the bytes so
    /// far. Returns `size`.
    pub async fn copy_data(
        &mut self,
        size: u64,
        out: &mut (impl AsyncWrite + Unpin),
        on_bytes: &mut (dyn FnMut(u64) + Send),
    ) -> Result<u64, IoFailure> {
        let mut left = size;
        let mut buf = vec![0u8; CHUNK];
        while left > 0 {
            let want = usize::try_from(left).map_or(CHUNK, |l| l.min(CHUNK));
            let n = self
                .inner
                .read(&mut buf[..want])
                .await
                .map_err(IoFailure::Remote)?;
            if n == 0 {
                return Err(IoFailure::Core(truncated(
                    "the stream ended inside the file",
                )));
            }
            out.write_all(&buf[..n]).await.map_err(IoFailure::Local)?;
            left -= n as u64;
            on_bytes(size - left);
        }
        self.pending = self
            .pending
            .saturating_sub(size.div_ceil(BLOCK as u64) * BLOCK as u64);
        let padding = size.div_ceil(BLOCK as u64) * BLOCK as u64 - size;
        let mut pad = vec![0u8; padding as usize];
        if padding > 0 {
            self.inner
                .read_exact(&mut pad)
                .await
                .map_err(IoFailure::Remote)?;
        }
        Ok(size)
    }
}

fn truncated(reason: &str) -> CoreError {
    CoreError::new(
        ErrorCode::Unreachable,
        format!("the tar stream from the container broke: {reason}"),
    )
}

fn text(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn checksum_ok(block: &[u8; BLOCK]) -> bool {
    let stored = text(&block[148..156]);
    let Ok(stored) = u32::from_str_radix(stored.trim(), 8) else {
        return false;
    };
    let sum: u32 = block
        .iter()
        .enumerate()
        .map(|(i, &b)| {
            if (148..156).contains(&i) {
                u32::from(b' ')
            } else {
                u32::from(b)
            }
        })
        .sum();
    sum == stored
}

/// An octal number field, or GNU's base-256 form.
fn parse_number(field: &[u8]) -> CoreResult<u64> {
    if field[0] & 0x80 != 0 {
        let mut value: u64 = u64::from(field[0] & 0x7f);
        for &b in &field[1..] {
            value = value
                .checked_mul(256)
                .and_then(|v| v.checked_add(u64::from(b)))
                .ok_or_else(|| hostile("a size too large".into()))?;
        }
        return Ok(value);
    }
    let digits = text(field);
    let digits = digits.trim_matches(|c: char| c == ' ' || c == '\0');
    if digits.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(digits, 8).map_err(|_| hostile("a malformed size".into()))
}

/// `<len> <key>=<value>\n` records of a pax header.
fn pax_records(data: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let Some(space) = rest.iter().position(|&b| b == b' ') else {
            break;
        };
        let Some(len) = std::str::from_utf8(&rest[..space])
            .ok()
            .and_then(|l| l.parse::<usize>().ok())
        else {
            break;
        };
        if len <= space + 1 || len > rest.len() {
            break;
        }
        let record = &rest[space + 1..len];
        let record = record.strip_suffix(b"\n").unwrap_or(record);
        if let Some(eq) = record.iter().position(|&b| b == b'=') {
            out.push((
                String::from_utf8_lossy(&record[..eq]).into_owned(),
                String::from_utf8_lossy(&record[eq + 1..]).into_owned(),
            ));
        }
        rest = &rest[len..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tar archive of `entries`: (path, type flag, content, link).
    fn archive(entries: &[(&str, u8, &[u8], &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (path, flag, content, link) in entries {
            let mut h = header(path.as_bytes(), content.len() as u64, 0o644, 0, *flag);
            h[157..157 + link.len()].copy_from_slice(link.as_bytes());
            h[148..156].fill(b' ');
            let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
            put_octal(&mut h[148..155], u64::from(sum));
            h[155] = b' ';
            out.extend_from_slice(&h);
            out.extend_from_slice(content);
            out.resize(out.len().div_ceil(BLOCK) * BLOCK, 0);
        }
        out.extend_from_slice(&[0u8; 2 * BLOCK]);
        out
    }

    async fn receive_into(
        dir: &Path,
        stream: Vec<u8>,
        name: &str,
    ) -> (CoreResult<Option<Received>>, Vec<TransferProgress>) {
        let mut seen = Vec::new();
        let dest = dir.join("saved");
        let result = receive(
            stream.as_slice(),
            name,
            None,
            &dest,
            async { Some(4096) },
            &mut |p| seen.push(p),
        )
        .await;
        (result, seen)
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn remote_paths_split_into_the_folder_and_the_name() {
        assert_eq!(
            split_remote_path("/etc/hostname").unwrap(),
            ("/etc".into(), "hostname".into())
        );
        assert_eq!(
            split_remote_path("/var/log/").unwrap(),
            ("/var".into(), "log".into())
        );
        assert_eq!(
            split_remote_path("/tmp").unwrap(),
            ("/".into(), "tmp".into())
        );
        assert_eq!(split_remote_path("/").unwrap(), ("/".into(), ".".into()));
        assert_eq!(
            split_remote_path("data.txt").unwrap(),
            (".".into(), "data.txt".into())
        );
        for bad in ["", "  ", "/tmp/..", "/tmp/.", "a\0b"] {
            assert_eq!(
                split_remote_path(bad).unwrap_err().code,
                ErrorCode::Invalid,
                "{bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_single_file_is_unpacked_with_its_progress_and_replaces_a_link_at_the_destination() {
        let dir = tempfile::tempdir().unwrap();
        let content = vec![7u8; 3 * CHUNK + 5];
        let stream = archive(&[("./hostname", b'0', &content, "")]);
        // The destination is a link to a file elsewhere: the link is replaced, its target untouched.
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("precious");
        std::fs::write(&target, "keep").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, dir.path().join("saved")).unwrap();

        let (result, seen) = receive_into(dir.path(), stream, "hostname").await;
        let done = result.unwrap().expect("an entry").commit().unwrap();

        assert_eq!(done.kind, RemoteKind::File);
        assert_eq!(done.bytes, content.len() as u64);
        assert_eq!(std::fs::read(dir.path().join("saved")).unwrap(), content);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        assert_eq!(seen.first().unwrap().transferred, 0);
        assert_eq!(
            *seen.last().unwrap(),
            TransferProgress {
                transferred: content.len() as u64,
                total: Some(content.len() as u64)
            }
        );
        assert!(
            seen.windows(2)
                .all(|w| w[0].transferred <= w[1].transferred)
        );
        assert_eq!(leftovers(dir.path()), ["saved"]);
    }

    #[tokio::test]
    async fn hostile_archives_are_refused_and_leave_nothing_behind() {
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("absolute", archive(&[("/etc/passwd", b'0', b"x", "")])),
            ("dot-dot", archive(&[("../../.bashrc", b'0', b"x", "")])),
            (
                "dot-dot inside",
                archive(&[("hostname/../../x", b'0', b"x", "")]),
            ),
            ("other name", archive(&[("evil", b'0', b"x", "")])),
            (
                "symlink",
                archive(&[("hostname", b'2', b"", "/etc/shadow")]),
            ),
            (
                "hard link",
                archive(&[("hostname", b'1', b"", "/etc/shadow")]),
            ),
            (
                "second entry",
                archive(&[("hostname", b'0', b"x", ""), ("../evil", b'0', b"y", "")]),
            ),
            ("windows drive", archive(&[("C:/x", b'0', b"x", "")])),
            ("not tar", vec![b'x'; 2048]),
        ];
        for (label, stream) in cases {
            let dir = tempfile::tempdir().unwrap();
            let (result, _) = receive_into(dir.path(), stream, "hostname").await;
            let err = result.expect_err(label);
            assert_eq!(err.code, ErrorCode::Invalid, "{label}: {}", err.message);
            assert!(
                leftovers(dir.path()).is_empty(),
                "{label}: {:?}",
                leftovers(dir.path())
            );
            let parent = dir.path().parent().unwrap();
            assert!(!parent.join(".bashrc").exists() && !parent.join("evil").exists());
        }
    }

    #[tokio::test]
    async fn a_path_that_changed_kind_since_it_was_checked_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("saved");
        let stream = archive(&[("logs/", b'5', b"", ""), ("logs/a", b'0', b"x", "")]);
        let err = receive(
            stream.as_slice(),
            "logs",
            Some(RemoteKind::File),
            &dest,
            async { None },
            &mut |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(
            err.message.contains("changed since it was checked"),
            "{}",
            err.message
        );
        assert!(leftovers(dir.path()).is_empty());
    }

    #[tokio::test]
    async fn oversized_header_records_before_an_entry_are_refused() {
        // Global pax records of 1 MiB each (each within the per-record limit), more than 2 MiB in all.
        let mut stream = Vec::new();
        for _ in 0..3 {
            let data = vec![b'\n'; 1024 * 1024 - BLOCK];
            stream.extend_from_slice(&header(
                b"pax_global_header",
                data.len() as u64,
                0o644,
                0,
                b'g',
            ));
            stream.extend_from_slice(&data);
            stream.resize(stream.len().div_ceil(BLOCK) * BLOCK, 0);
        }
        stream.extend_from_slice(&archive(&[("hostname", b'0', b"x", "")]));
        let mut reader = TarReader::new(stream.as_slice()).recording();
        let err = reader.next_entry().await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(
            err.message.contains("header records too large"),
            "{}",
            err.message
        );
    }

    #[test]
    fn names_are_never_options() {
        assert_eq!(member("-rf"), "./-rf");
        assert_eq!(member("."), ".");
    }

    #[test]
    fn entry_paths_are_checked() {
        assert_eq!(checked_path("./a/b/").unwrap(), "a/b");
        assert_eq!(checked_path("./").unwrap(), ".");
        assert!(checked_path("/a").is_err());
        assert!(checked_path("a/../../b").is_err());
        assert!(checked_path("\\\\server\\x").is_err());
    }

    #[tokio::test]
    async fn a_folder_is_kept_as_tar_gz_with_every_byte() {
        let dir = tempfile::tempdir().unwrap();
        let stream = archive(&[
            ("logs/", b'5', b"", ""),
            ("logs/a.log", b'0', b"alpha", ""),
            // Not unpacked here, so even a hostile entry inside a folder's archive is only data.
            ("logs/../../b", b'0', b"beta", ""),
        ]);
        let (result, seen) = receive_into(dir.path(), stream.clone(), "logs").await;
        let done = result.unwrap().unwrap().commit().unwrap();
        assert_eq!(done.kind, RemoteKind::Directory);
        let gz = std::fs::read(dir.path().join("saved")).unwrap();
        let mut plain = Vec::new();
        std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(gz.as_slice()), &mut plain)
            .unwrap();
        assert_eq!(plain, stream);
        assert_eq!(
            *seen.last().unwrap(),
            TransferProgress {
                transferred: stream.len() as u64,
                total: Some(4096)
            }
        );
        assert_eq!(leftovers(dir.path()), ["saved"]);
        assert!(!dir.path().join("logs").exists());
    }

    #[tokio::test]
    async fn a_symlink_is_named_with_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let stream = archive(&[("localtime", b'2', b"", "/usr/share/zoneinfo/UTC")]);
        let (result, _) = receive_into(dir.path(), stream, "localtime").await;
        let err = result.unwrap_err();
        assert!(
            err.message.contains("/usr/share/zoneinfo/UTC"),
            "{}",
            err.message
        );
        assert!(leftovers(dir.path()).is_empty());
    }

    /// A stream that gives `first` and then never ends (a transfer in flight).
    struct Stalled(Option<Vec<u8>>);

    impl AsyncRead for Stalled {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            match self.0.as_mut().filter(|b| !b.is_empty()) {
                Some(bytes) => {
                    let n = bytes.len().min(buf.remaining());
                    buf.put_slice(&bytes[..n]);
                    bytes.drain(..n);
                    std::task::Poll::Ready(Ok(()))
                }
                None => std::task::Poll::Pending,
            }
        }
    }

    #[tokio::test]
    async fn a_cancelled_download_removes_its_partial_file_and_keeps_the_destination() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("saved");
        std::fs::write(&dest, "old").unwrap();
        let mut stream = archive(&[("big", b'0', &vec![1u8; 4 * BLOCK], "")]);
        stream.truncate(3 * BLOCK);
        let progressed = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let seen = std::sync::Arc::clone(&progressed);
        let dest_clone = dest.clone();
        let task = tokio::spawn(async move {
            receive(
                Stalled(Some(stream)),
                "big",
                Some(RemoteKind::File),
                &dest_clone,
                async { None },
                &mut |p| seen.store(p.transferred, std::sync::atomic::Ordering::SeqCst),
            )
            .await
            .map(|_| ())
        });
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while progressed.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            assert!(tokio::time::Instant::now() < deadline, "no progress");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            leftovers(dir.path()).len() == 2,
            "a partial file while in flight"
        );
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(leftovers(dir.path()), ["saved"]);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old");
    }

    #[tokio::test]
    async fn an_upload_is_one_regular_file_padded_to_whole_records() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("report.txt");
        let content = b"hello from sextant\n".repeat(1000);
        std::fs::write(&source, &content).unwrap();
        for name in ["report.txt".to_owned(), "n".repeat(150)] {
            let local = LocalFile::open(&source).await.unwrap();
            let mut out = Vec::new();
            let mut seen = Vec::new();
            let sent = send_file(&mut out, &name, local, &mut |p| seen.push(p))
                .await
                .unwrap();
            assert_eq!(sent, content.len() as u64);
            assert_eq!(out.len() % RECORD, 0);
            assert_eq!(seen.last().unwrap().transferred, content.len() as u64);

            let mut reader = TarReader::new(out.as_slice());
            let entry = reader.next_entry().await.unwrap().unwrap();
            assert_eq!(entry.path, name);
            assert_eq!(entry.kind, EntryKind::Regular);
            assert_eq!(entry.size, content.len() as u64);
            let mut copied = Vec::new();
            reader
                .copy_data(entry.size, &mut copied, &mut |_| {})
                .await
                .unwrap();
            assert_eq!(copied, content);
            assert!(reader.next_entry().await.unwrap().is_none());
        }
        let err = LocalFile::open(dir.path()).await.err().unwrap();
        assert_eq!(err.code, ErrorCode::Invalid);
    }

    #[test]
    fn big_sizes_use_the_base_256_form() {
        let mut field = [0u8; 12];
        put_number(&mut field, 1 << 40);
        assert_eq!(parse_number(&field).unwrap(), 1 << 40);
        put_number(&mut field, 0o755);
        assert_eq!(parse_number(&field).unwrap(), 0o755);
    }

    #[test]
    fn pax_records_are_read() {
        let data = b"20 path=a/long/name\n11 size=42\n";
        assert_eq!(
            pax_records(data),
            [
                ("path".to_owned(), "a/long/name".to_owned()),
                ("size".to_owned(), "42".to_owned())
            ]
        );
    }
}
