//! Saving files chosen in a `tauri-plugin-dialog` save dialog (e.g. logs), and copying files to and from containers
//! (`kubectl cp`, see `sextant_core::files`).
//!
//! A transfer (`files_download_start`, `files_upload_start`) runs under a stream id the frontend chose and already
//! listens to (`files:<streamId>`, [`TransferEvent`]): progress at most every [`PROGRESS_INTERVAL`], then `done` or
//! `error`. It is a subscription of its cluster in `AppState`, so `files_transfer_stop` (cancel), disconnecting the
//! cluster, `streams_reset` and closing the window stop it; a stopped download leaves no partial file. Never offered to
//! AI agents or extensions.

use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sextant_core::files::{self, RemoteEntry, RemoteKind, TransferProgress};
use sextant_core::{ClusterId, CoreError, CoreResult, ErrorCode, ObjectRef};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::time::Instant;
use ts_rs::TS;

use crate::state::{AppState, Subscription, check_stream_id};

/// Progress of a transfer goes out at most this often.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// How long `files_stat` may take.
const STAT_TIMEOUT: Duration = Duration::from_secs(30);

/// `files:<streamId>` — payload [`TransferEvent`].
pub fn transfer_event(stream_id: &str) -> String {
    format!("files:{stream_id}")
}

/// What a transfer reports. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum TransferEvent {
    /// Bytes so far; `total` when known (a folder's is an estimate).
    Progress {
        #[ts(type = "number")]
        transferred: u64,
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    /// Finished: bytes written to the local file (download) or sent (upload).
    Done {
        #[ts(type = "number")]
        bytes: u64,
    },
    Error {
        error: CoreError,
    },
}

/// What `path` in a container is: a file (with its size), a folder (with an estimate), a link (with its target).
#[tauri::command]
pub async fn files_stat(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    pod: ObjectRef,
    container: Option<String>,
    path: String,
) -> Result<RemoteEntry, CoreError> {
    let stat = files::stat(
        &state.clusters,
        &cluster_id,
        &pod,
        container.as_deref(),
        &path,
    );
    tokio::time::timeout(STAT_TIMEOUT, stat)
        .await
        .map_err(|_| CoreError::new(ErrorCode::Timeout, format!("no answer about {path}")))?
}

/// Downloads `path` from the container to `destination` (an absolute path from the save dialog) under `stream_id`:
/// a file's content, or a folder as `.tar.gz`. `kind` is what `files_stat` said the path is; a path that turned into
/// something else since is refused.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn files_download_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    pod: ObjectRef,
    container: Option<String>,
    path: String,
    kind: RemoteKind,
    destination: PathBuf,
    stream_id: String,
) -> Result<(), CoreError> {
    absolute(&destination)?;
    let mgr = state.clusters.clone();
    let cluster = cluster_id.clone();
    let mut reporter = Reporter::new(&app, &stream_id);
    let work = async move {
        let result = files::download(
            &mgr,
            &cluster,
            &pod,
            container.as_deref(),
            &path,
            Some(kind),
            &destination,
            &mut |p| reporter.progress(p),
        )
        .await
        .map(|done| done.bytes);
        reporter.finish(result);
    };
    start_transfer(&app, &state, stream_id, cluster_id, work)
}

/// Uploads the local file `source` into the container as `path` (the file's full path there) under `stream_id`. The
/// window asked the user first: it changes the container.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn files_upload_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    pod: ObjectRef,
    container: Option<String>,
    source: PathBuf,
    path: String,
    stream_id: String,
) -> Result<(), CoreError> {
    absolute(&source)?;
    let mgr = state.clusters.clone();
    let cluster = cluster_id.clone();
    let mut reporter = Reporter::new(&app, &stream_id);
    let work = async move {
        let result = files::upload(
            &mgr,
            &cluster,
            &pod,
            container.as_deref(),
            &source,
            &path,
            &mut |p| reporter.progress(p),
        )
        .await;
        reporter.finish(result);
    };
    start_transfer(&app, &state, stream_id, cluster_id, work)
}

/// Cancels a transfer. Stopping one that already ended (or never existed) is not an error.
#[tauri::command]
pub async fn files_transfer_stop(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), CoreError> {
    state.subscriptions.stop(&stream_id);
    Ok(())
}

fn absolute(path: &Path) -> Result<(), CoreError> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Invalid,
            format!("not an absolute path: {}", path.display()),
        ))
    }
}

/// Emits a transfer's events as `files:<id>`: progress at most every [`PROGRESS_INTERVAL`] (the first and the last
/// always), then the result.
pub struct Reporter<R: Runtime> {
    app: AppHandle<R>,
    event: String,
    last: Option<Instant>,
    latest: Option<TransferProgress>,
    finished: bool,
}

impl<R: Runtime> Drop for Reporter<R> {
    /// A transfer stopped before it finished (cancelled, its cluster disconnected) says so.
    fn drop(&mut self) {
        if !self.finished {
            let error = CoreError::other("the transfer was stopped");
            let _ = self.app.emit(&self.event, TransferEvent::Error { error });
        }
    }
}

impl<R: Runtime> Reporter<R> {
    pub fn new(app: &AppHandle<R>, id: &str) -> Self {
        Self {
            app: app.clone(),
            event: transfer_event(id),
            last: None,
            latest: None,
            finished: false,
        }
    }

    pub fn progress(&mut self, progress: TransferProgress) {
        self.latest = Some(progress);
        if self.last.is_none_or(|t| t.elapsed() >= PROGRESS_INTERVAL) {
            self.emit_progress();
        }
    }

    fn emit_progress(&mut self) {
        if let Some(TransferProgress { transferred, total }) = self.latest.take() {
            let _ = self
                .app
                .emit(&self.event, TransferEvent::Progress { transferred, total });
            self.last = Some(Instant::now());
        }
    }

    pub fn finish(mut self, result: CoreResult<u64>) {
        self.finished = true;
        let event = match result {
            Ok(bytes) => {
                self.emit_progress();
                TransferEvent::Done { bytes }
            }
            Err(error) => TransferEvent::Error { error },
        };
        let _ = self.app.emit(&self.event, event);
    }
}

/// Registers `work` (a transfer that reports through a [`Reporter`]) in `state.subscriptions` under `id` and `cluster`
/// and starts it once registered; it forgets itself when done. A taken or malformed `id` is `invalid` and nothing
/// starts; a `streams_reset` that came meanwhile stops it again.
pub fn start_transfer<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    work: impl Future<Output = ()> + Send + 'static,
) -> Result<(), CoreError> {
    check_stream_id(&id)?;
    let generation = state.streams_generation();
    let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = app.clone();
    let own_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        if registered_rx.await.is_err() {
            return;
        }
        work.await;
        if let Some(state) = handle.try_state::<AppState>() {
            state.subscriptions.remove(&own_id);
        }
    });
    state.subscriptions.insert(
        id.clone(),
        Subscription {
            cluster,
            task: task.inner().abort_handle(),
        },
    )?;
    let _ = registered_tx.send(());
    state.undo_if_reset(generation, || {
        state.subscriptions.stop(&id);
    })
}

/// Writes `contents` to `path` (created or replaced). The path comes from the system save dialog.
#[tauri::command]
pub async fn file_save(path: PathBuf, contents: String) -> Result<(), CoreError> {
    write_file(&path, &contents).await
}

async fn write_file(path: &Path, contents: &str) -> Result<(), CoreError> {
    tokio::fs::write(path, contents).await.map_err(|err| {
        let code = match err.kind() {
            ErrorKind::NotFound => ErrorCode::NotFound,
            ErrorKind::PermissionDenied => ErrorCode::Forbidden,
            _ => ErrorCode::Other,
        };
        CoreError::new(code, format!("cannot write {}: {err}", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;
    use tauri::Listener;

    fn app() -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(
            &dir.path().join("config"),
            &dir.path().join("data"),
        ));
        (app, dir)
    }

    fn listen<R: Runtime>(app: &tauri::App<R>, id: &str) -> std_mpsc::Receiver<serde_json::Value> {
        let (tx, rx) = std_mpsc::channel();
        app.listen_any(transfer_event(id), move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).unwrap());
        });
        rx
    }

    fn next(rx: &std_mpsc::Receiver<serde_json::Value>) -> serde_json::Value {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .expect("a transfer event")
    }

    #[test]
    fn a_transfer_reports_progress_and_its_result_and_forgets_itself() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let events = listen(&app, "t-1");
        let mut reporter = Reporter::new(app.handle(), "t-1");
        let work = async move {
            for transferred in [0, 10, 20] {
                reporter.progress(TransferProgress {
                    transferred,
                    total: Some(20),
                });
            }
            reporter.finish(Ok(20));
        };
        tauri::async_runtime::block_on(async {
            start_transfer(app.handle(), &state, "t-1".into(), "c".into(), work)
        })
        .unwrap();
        // The first progress goes at once; the ones within the interval are gathered into the last one.
        assert_eq!(
            next(&events),
            serde_json::json!({ "type": "progress", "transferred": 0, "total": 20 })
        );
        assert_eq!(
            next(&events),
            serde_json::json!({ "type": "progress", "transferred": 20, "total": 20 })
        );
        assert_eq!(
            next(&events),
            serde_json::json!({ "type": "done", "bytes": 20 })
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !state.subscriptions.is_empty() {
            assert!(
                std::time::Instant::now() < deadline,
                "the transfer stays registered"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn a_cancelled_transfer_stops_and_says_so_and_a_taken_id_is_invalid() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let events = listen(&app, "t-2");
        let reporter = Reporter::new(app.handle(), "t-2");
        let work = async move {
            let _reporter = reporter;
            std::future::pending::<()>().await;
        };
        tauri::async_runtime::block_on(async {
            start_transfer(app.handle(), &state, "t-2".into(), "c".into(), work)
        })
        .unwrap();
        let taken = tauri::async_runtime::block_on(async {
            start_transfer(app.handle(), &state, "t-2".into(), "c".into(), async {})
        })
        .unwrap_err();
        assert_eq!(taken.code, ErrorCode::Invalid);
        assert_eq!(state.subscriptions.len(), 1);

        // Disconnecting the cluster stops it like a cancel.
        state.close_cluster(&"c".into());
        let event = next(&events);
        assert_eq!(event["type"], "error");
        assert_eq!(event["error"]["message"], "the transfer was stopped");
        assert!(state.subscriptions.is_empty());
    }

    #[test]
    fn transfers_need_absolute_local_paths() {
        assert_eq!(
            absolute(Path::new("relative/file")).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert!(absolute(&std::env::temp_dir().join("x")).is_ok());
    }

    #[tokio::test]
    async fn saves_the_contents_and_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pod.log");
        file_save(path.clone(), "one\ntwo\n".into()).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");
        file_save(path.clone(), "three\n".into()).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "three\n");
    }

    #[tokio::test]
    async fn a_missing_directory_is_a_not_found_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = file_save(dir.path().join("no/such/dir/x.log"), "x".into())
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
