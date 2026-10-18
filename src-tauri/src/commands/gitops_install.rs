//! Installing Flux or Argo CD from the window (`crate::gitops_install`): the versions, the prepared preview with its
//! token, the install as a stream (its events through the channel `onEvent`), its stop, and whether each tool is
//! installed. Plain window commands: no MCP tool and no extension method reaches them.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use sextant_core::gitops_install::{self, GitopsTool, InstallPlan};
use sextant_core::{ClusterId, CoreError, CoreResult};
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

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

/// Starts the prepared install of `token` (once) under `stream_id`, which the window chose; its events (`InstallEvent`)
/// go through `on_event`, the channel the window created before the start. The install is registered before it begins;
/// `gitops_install_stop`, disconnecting the cluster, `streams_reset` and quitting stop it.
#[tauri::command]
pub async fn gitops_install_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    token: String,
    stream_id: String,
    on_event: Channel<InstallEvent>,
) -> Result<(), CoreError> {
    check_stream_id(&stream_id)?;
    // Not connected: the plan stays for a retry.
    state.clusters.client(&cluster_id)?;
    let generation = state.streams_generation();
    let stop = Arc::new(AtomicBool::new(false));
    // Objects in the plan and applied so far, for the final event of an install that is aborted.
    let total = Arc::new(AtomicU32::new(0));
    let applied = Arc::new(AtomicU32::new(0));
    // The task starts once the install is registered and its plan taken; it gets the plan then.
    let (plan_tx, plan_rx) = tokio::sync::oneshot::channel::<Arc<InstallPlan>>();
    let mgr = state.clusters.clone();
    let handle = app.clone();
    let id = stream_id.clone();
    let flag = Arc::clone(&stop);
    let counted = Arc::clone(&applied);
    let cluster = cluster_id.clone();
    let channel = on_event.clone();
    let task = tauri::async_runtime::spawn(async move {
        let Ok(plan) = plan_rx.await else {
            return;
        };
        install::run(&mgr, &cluster, &plan, &flag, Timing::default(), |e| {
            if matches!(e, InstallEvent::Applied { .. }) {
                counted.fetch_add(1, Ordering::SeqCst);
            }
            let _ = channel.send(e);
        })
        .await;
        if let Some(state) = tauri::Manager::try_state::<AppState>(&handle) {
            state.gitops.finished(&id);
        }
    });
    let planned = Arc::clone(&total);
    let on_abort: OnAbort = Box::new(move |why: &str| {
        let last = install::aborted(
            why,
            applied.load(Ordering::SeqCst),
            planned.load(Ordering::SeqCst),
        );
        let _ = on_event.send(last);
    });
    // Registered first, the plan taken after: a stream id in use does not spend the token.
    let plan = state.gitops.begin(
        &stream_id,
        &cluster_id,
        &token,
        stop,
        task.inner().abort_handle(),
        on_abort,
    )?;
    total.store(plan.objects.len() as u32, Ordering::SeqCst);
    let _ = plan_tx.send(plan);
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

/// Whether Flux and Argo CD are in the cluster: installed, partly installed (some CRDs or the namespace, or not every
/// controller of the standard set) or missing, read from the cluster (`gitops_install::installed`).
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
