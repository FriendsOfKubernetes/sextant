//! The image file viewer (#216, ADR-0103): browsing a container image's files from its registry. Window only — never
//! an MCP tool or an extension method (a test below keeps it so).
//!
//! Opening (`image_files_open_start`), reading a file for the viewer (`image_files_read_start`) and downloading one
//! (`image_files_download_start`) are streams under ids the window chose, reporting through the channel it created,
//! registered in `AppState.subscriptions` (stopped by `image_files_stop`, closing a pod's cluster, `streams_reset` and
//! exit). An opened image stays in `AppState.image_files` under its open stream's id until `image_files_stop` of that
//! id, its cluster closes (pod sources), or the page reloads.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use sextant_core::image_fs::cache::IndexCache;
use sextant_core::image_fs::manifest::ImagePlatform;
use sextant_core::image_fs::{ImageDir, ImageSearch, limits};
use sextant_core::{ClusterId, CoreError, ErrorCode};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::files::{Reporter, TransferEvent, start_transfer};
use crate::image_files::{
    DockerAccess, ImageOpenEvent, ImageReadEvent, ImageSource, OpenContext, open, read_text, save,
};
use crate::state::{AppState, check_stream_id};

/// Sets the flag when the work is dropped (stopped): the blocking reader then ends at its next read.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn no_cluster() -> ClusterId {
    ClusterId(String::new())
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CoreError> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join("image-files"))
        .map_err(|e| CoreError::other(format!("no cache folder: {e}")))
}

/// Opens an image under `stream_id`: progress, then `opened` (the image stays open under that id) or `error`.
#[tauri::command]
pub async fn image_files_open_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    source: ImageSource,
    platform: Option<ImagePlatform>,
    stream_id: String,
    on_event: Channel<ImageOpenEvent>,
) -> Result<(), CoreError> {
    check_stream_id(&stream_id)?;
    if state.image_files.len() >= limits::MAX_OPEN_IMAGES {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "at most {} images can be open at once: close one first",
                limits::MAX_OPEN_IMAGES
            ),
        ));
    }
    let docker = state
        .settings
        .get()
        .image_files
        .docker_credentials
        .then(|| {
            sextant_core::image_fs::helper::default_config_path().map(|config| DockerAccess {
                config,
                cli: crate::commands::cloud::cloud_cli(&app),
            })
        });
    let cancel = Arc::new(AtomicBool::new(false));
    let ctx = OpenContext {
        clusters: state.clusters.clone(),
        docker: docker.flatten(),
        cache: IndexCache::new(cache_dir(&app)?),
        connect: None,
        cancel: Arc::clone(&cancel),
    };
    let cluster = match &source {
        ImageSource::Pod { cluster_id, .. } => cluster_id.clone(),
        ImageSource::Reference { .. } => no_cluster(),
    };
    let handle = app.clone();
    let id = stream_id.clone();
    let work = async move {
        let _cancel = CancelOnDrop(cancel);
        let channel = on_event.clone();
        let emit: crate::image_files::Emit<ImageOpenEvent> = Arc::new(move |event| {
            let _ = channel.send(event);
        });
        let opened = tokio::time::timeout(
            limits::OPEN_TIMEOUT,
            open(&ctx, &source, platform, &id, emit),
        )
        .await;
        let event = match opened {
            Ok(Ok((session, summary))) => match handle.try_state::<AppState>() {
                Some(state) => match state.image_files.insert(id.clone(), session) {
                    Ok(()) => ImageOpenEvent::Opened {
                        summary: Box::new(summary),
                    },
                    Err(error) => ImageOpenEvent::Error { error },
                },
                None => return,
            },
            Ok(Err(error)) => ImageOpenEvent::Error { error },
            Err(_) => ImageOpenEvent::Error {
                error: CoreError::new(
                    ErrorCode::Timeout,
                    "opening the image took longer than 30 minutes",
                ),
            },
        };
        let _ = on_event.send(event);
    };
    start_transfer(&app, &state, stream_id, cluster, work)
}

/// Reads the first MiB of a file of an open image for the viewer under `stream_id`: progress, then `text` or `error`.
#[tauri::command]
pub async fn image_files_read_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    stream_id: String,
    on_event: Channel<ImageReadEvent>,
) -> Result<(), CoreError> {
    let session = state.image_files.get(&session_id)?;
    let cluster = session.cluster.clone().unwrap_or_else(no_cluster);
    let work = async move {
        let cancel = Arc::new(AtomicBool::new(false));
        let _cancel = CancelOnDrop(Arc::clone(&cancel));
        let channel = on_event.clone();
        let emit: crate::image_files::Emit<ImageReadEvent> = Arc::new(move |event| {
            let _ = channel.send(event);
        });
        let read = tokio::time::timeout(
            limits::READ_TIMEOUT,
            read_text(&session, &path, cancel, emit),
        )
        .await;
        let event = match read {
            Ok(Ok(file)) => ImageReadEvent::Text { file },
            Ok(Err(error)) => ImageReadEvent::Error { error },
            Err(_) => ImageReadEvent::Error {
                error: CoreError::new(ErrorCode::Timeout, "reading the file took too long"),
            },
        };
        let _ = on_event.send(event);
    };
    start_transfer(&app, &state, stream_id, cluster, work)
}

/// Shows the save dialog (`title`, the file's name proposed) and downloads the file of an open image to the path the
/// user picked, under `stream_id`; `false` when the dialog was cancelled (nothing started).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn image_files_download_start<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    title: String,
    stream_id: String,
    on_event: Channel<TransferEvent>,
) -> Result<bool, CoreError> {
    check_stream_id(&stream_id)?;
    let session = state.image_files.get(&session_id)?;
    let entry = session.tree.entry(&path)?;
    let name = entry.name.clone();
    let picked = tokio::task::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title)
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|err| CoreError::other(format!("the save dialog failed: {err}")))?;
    let Some(destination) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(false);
    };
    let cluster = session.cluster.clone().unwrap_or_else(no_cluster);
    let mut reporter = Reporter::new(on_event);
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel::<(u64, u64)>();
    let work = async move {
        let cancel = Arc::new(AtomicBool::new(false));
        let _cancel = CancelOnDrop(Arc::clone(&cancel));
        let progress = Box::new(move |bytes: u64, total: u64| {
            let _ = progress_tx.send((bytes, total));
        });
        let saving = save(&session, &path, destination, cancel, progress);
        tokio::pin!(saving);
        let result = loop {
            tokio::select! {
                result = &mut saving => break result,
                Some((transferred, total)) = progress_rx.recv() => {
                    reporter.progress(sextant_core::files::TransferProgress { transferred, total: Some(total) });
                }
            }
        };
        reporter.finish(result);
    };
    start_transfer(&app, &state, stream_id, cluster, work)?;
    Ok(true)
}

/// A folder of an open image.
#[tauri::command]
pub async fn image_files_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<ImageDir, CoreError> {
    let session = state.image_files.get(&session_id)?;
    tokio::task::spawn_blocking(move || session.tree.list(&path))
        .await
        .map_err(|e| CoreError::other(e.to_string()))?
}

/// Paths of an open image that contain `query`.
#[tauri::command]
pub async fn image_files_search(
    state: State<'_, AppState>,
    session_id: String,
    query: String,
) -> Result<ImageSearch, CoreError> {
    let session = state.image_files.get(&session_id)?;
    tokio::task::spawn_blocking(move || session.tree.search(&query))
        .await
        .map_err(|e| CoreError::other(e.to_string()))?
}

/// Where a symbolic link of an open image leads inside the image; `None` when nowhere.
#[tauri::command]
pub async fn image_files_resolve(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Option<String>, CoreError> {
    state.image_files.get(&session_id)?.tree.resolve(&path)
}

/// Stops a stream of the viewer and closes the image opened under that id. Stopping what is gone is not an error.
#[tauri::command]
pub async fn image_files_stop(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), CoreError> {
    state.subscriptions.stop(&stream_id);
    state.image_files.remove(&stream_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_can_browse_images() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools.iter().any(|t| {
                let t = t.to_lowercase();
                t.contains("image_file") || t.contains("registry") || t.contains("layer")
            }),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| {
                let m = m.to_lowercase();
                m.contains("image") || m.contains("registry") || m.contains("layer")
            }),
            "{methods:?}"
        );
    }
}
