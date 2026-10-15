//! Installing Flux or Argo CD from the window (`crate::gitops_install`): the versions, the prepared preview with its
//! token, the install as a stream `gitops-install:<streamId>`, its stop, and whether each tool is installed. Plain
//! window commands: no MCP tool and no extension method reaches them.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use sextant_core::gitops_install::{self, GitopsTool};
use sextant_core::{ClusterId, CoreError, CoreResult};
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::events::gitops_install_event;
use crate::gitops_install::download::GitopsVersions;
use crate::gitops_install::{
    self as install, GitopsStatus, InstallEvent, InstallPreview, OnAbort, Timing,
};
use crate::state::{AppState, check_stream_id};

/// The stable releases of `tool`, newest first; the bundled version and the reason when GitHub cannot be asked.
#[tauri::command]
pub async fn gitops_install_versions(
    state: State<'_, AppState>,
    tool: GitopsTool,
) -> CoreResult<GitopsVersions> {
    Ok(state.gitops.downloader().versions(tool).await)
}

/// Downloads and checks the official manifest of `version`, plans the install and answers the preview; the plan
/// waits ten minutes for `gitops_install_start` under the preview's token.
#[tauri::command]
pub async fn gitops_install_prepare(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    tool: GitopsTool,
    version: String,
) -> CoreResult<InstallPreview> {
    install::prepare(&state.gitops, &state.clusters, &cluster_id, tool, &version).await
}

/// Starts the prepared install of `token` (once) under `stream_id`, which the window chose and already listens to
/// (`gitops-install:<streamId>`, `InstallEvent`). The install is registered before it begins; `gitops_install_stop`,
/// disconnecting the cluster, `streams_reset` and quitting stop it.
#[tauri::command]
pub async fn gitops_install_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    token: String,
    stream_id: String,
) -> Result<(), CoreError> {
    check_stream_id(&stream_id)?;
    // Not connected: the plan stays for a retry.
    state.clusters.client(&cluster_id)?;
    let generation = state.streams_generation();
    let plan = state.gitops.take(&cluster_id, &token)?;
    let stop = Arc::new(AtomicBool::new(false));
    let total = plan.objects.len() as u32;
    // Objects applied so far, for the final event of an install that is aborted.
    let applied = Arc::new(AtomicU32::new(0));
    let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
    let mgr = state.clusters.clone();
    let handle = app.clone();
    let id = stream_id.clone();
    let flag = Arc::clone(&stop);
    let counted = Arc::clone(&applied);
    let cluster = cluster_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        if registered_rx.await.is_err() {
            return;
        }
        let event = gitops_install_event(&id);
        install::run(&mgr, &cluster, &plan, &flag, Timing::default(), |e| {
            if matches!(e, InstallEvent::Applied { .. }) {
                counted.fetch_add(1, Ordering::SeqCst);
            }
            let _ = handle.emit(&event, &e);
        })
        .await;
        if let Some(state) = tauri::Manager::try_state::<AppState>(&handle) {
            state.gitops.finished(&id);
        }
    });
    let event = gitops_install_event(&stream_id);
    let window = app.clone();
    let on_abort: OnAbort = Box::new(move |why: &str| {
        let last = install::aborted(why, applied.load(Ordering::SeqCst), total);
        let _ = window.emit(&event, &last);
    });
    state.gitops.register(
        &stream_id,
        cluster_id,
        stop,
        task.inner().abort_handle(),
        on_abort,
    )?;
    let _ = registered_tx.send(());
    state.undo_if_reset(generation, || {
        state.gitops.abort(&stream_id);
    })
}

/// Stops the install `stream_id` after the object being applied (or its wait for readiness). Stopping one that
/// ended (or never existed) is not an error.
#[tauri::command]
pub async fn gitops_install_stop(state: State<'_, AppState>, stream_id: String) -> CoreResult<()> {
    state.gitops.stop(&stream_id);
    Ok(())
}

/// Whether Flux and Argo CD are in the cluster (their CRDs, read from the cluster).
#[tauri::command]
pub async fn gitops_install_status(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> CoreResult<GitopsStatus> {
    let (flux, argo_cd) = tokio::try_join!(
        gitops_install::installed(&state.clusters, &cluster_id, GitopsTool::Flux),
        gitops_install::installed(&state.clusters, &cluster_id, GitopsTool::ArgoCd),
    )?;
    Ok(GitopsStatus { flux, argo_cd })
}
