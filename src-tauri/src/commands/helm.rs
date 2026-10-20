//! Helm: releases are read natively, changes go through the `helm` binary.
//!
//! Every call that reaches a cluster gets a temporary kubeconfig (0600) with only that cluster's context; it is
//! deleted as soon as `helm` exits. The `helm` binary and its environment come from a managed `HelmCli` when the
//! app (or a test) registers one with `app.manage(..)`, otherwise `HelmCli::default()` (looked up in `PATH`); the
//! path chosen in Settings (`AppSettings::helm_path`) replaces the binary.

use sextant_core::helm::cli::{self, ChartHit, HelmCli, HelmRepo, HelmStatus};
use sextant_core::helm::diff::HelmManifestDiff;
use sextant_core::helm::revisions::{self, HelmRevisionDiff};
use sextant_core::helm::updates::{self, ChartUpdates, InstalledChart};
use sextant_core::helm::{self, HelmRelease, HelmReleaseDetail};
use std::future::Future;
use std::time::Duration;

use sextant_core::error::with_timeout;
use sextant_core::{ClusterId, CoreError, CoreResult};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::state::{AppState, Subscription, check_stream_id};

/// The managed (or default) `HelmCli`, with the binary chosen in Settings (`helmPath`) if there is one.
fn helm_cli<R: Runtime>(app: &AppHandle<R>) -> HelmCli {
    let cli = app
        .try_state::<HelmCli>()
        .map(|cli| cli.inner().clone())
        .unwrap_or_default();
    let chosen = app
        .try_state::<AppState>()
        .and_then(|state| state.settings.get().helm_path)
        .filter(|path| !path.trim().is_empty());
    match chosen {
        Some(path) => cli.with_binary(path.trim()),
        None => cli,
    }
}

#[tauri::command]
pub async fn helm_status<R: Runtime>(app: AppHandle<R>) -> Result<HelmStatus, CoreError> {
    let cli = helm_cli(&app);
    tauri::async_runtime::spawn_blocking(move || cli.status())
        .await
        .map_err(|e| CoreError::other(e.to_string()))
}

#[tauri::command]
pub async fn helm_releases(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespaces: Option<Vec<String>>,
) -> Result<Vec<HelmRelease>, CoreError> {
    helm::list_releases(&state.clusters, &cluster_id, namespaces).await
}

#[tauri::command]
pub async fn helm_release_detail(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    revision: Option<i32>,
) -> Result<HelmReleaseDetail, CoreError> {
    helm::release_detail(&state.clusters, &cluster_id, &namespace, &name, revision).await
}

#[tauri::command]
pub async fn helm_release_history(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
) -> Result<Vec<HelmRelease>, CoreError> {
    helm::release_history(&state.clusters, &cluster_id, &namespace, &name).await
}

/// Two stored revisions of a release compared (#209): values, manifest object by object (Secrets by key names and
/// value hashes only), notes. Read natively; `helm` is not needed. A window command only: neither the MCP server nor
/// the extension API offers it.
#[tauri::command]
pub async fn helm_revision_diff(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
    left: i32,
    right: i32,
) -> Result<HelmRevisionDiff, CoreError> {
    revisions::compare_revisions(&state.clusters, &cluster_id, &namespace, &name, left, right).await
}

/// The newest version of each installed chart in the repositories Helm has (#209), from Helm's local copies of their
/// indexes (`helm search repo`); nothing is downloaded (that is `helm_repo_update`). A window command only.
#[tauri::command]
pub async fn helm_chart_updates<R: Runtime>(
    app: AppHandle<R>,
    charts: Vec<InstalledChart>,
) -> Result<ChartUpdates, CoreError> {
    updates::chart_updates(&helm_cli(&app), &charts).await
}

/// New user values for a release. An empty `chart_ref` reuses the chart stored in the release; otherwise `chart_ref`
/// (e.g. `repo/chart`) is used at `version` (a newer chart picked in the window, #209), else at the release's chart
/// version.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn helm_upgrade<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    release: String,
    chart_ref: String,
    values_yaml: String,
    version: Option<String>,
) -> Result<(), CoreError> {
    cli::upgrade_release_to(
        &helm_cli(&app),
        &state.clusters,
        &cluster_id,
        &namespace,
        &release,
        &chart_ref,
        version.as_deref(),
        &values_yaml,
    )
    .await
}

#[tauri::command]
pub async fn helm_rollback<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    release: String,
    revision: i32,
) -> Result<(), CoreError> {
    let target = cli::kube_target(&state.clusters, &cluster_id)?;
    helm_cli(&app)
        .rollback(
            &target.kubeconfig,
            &target.context,
            &namespace,
            &release,
            revision,
        )
        .await
}

#[tauri::command]
pub async fn helm_uninstall<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    release: String,
) -> Result<(), CoreError> {
    let target = cli::kube_target(&state.clusters, &cluster_id)?;
    helm_cli(&app)
        .uninstall(&target.kubeconfig, &target.context, &namespace, &release)
        .await
}

/// Installs `chart`; of `values_yaml` (the dialog starts from the chart's defaults) only what differs from the
/// chart's default values is kept as the release's user values.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn helm_install<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    release: String,
    chart: String,
    version: Option<String>,
    values_yaml: String,
) -> Result<(), CoreError> {
    cli::install_chart(
        &helm_cli(&app),
        &state.clusters,
        &cluster_id,
        &namespace,
        &release,
        &chart,
        version.as_deref(),
        &values_yaml,
    )
    .await
}

/// How long a preview may render before it is stopped (its `helm` is killed).
pub const PREVIEW_TIMEOUT: Duration = Duration::from_secs(120);

/// Runs a preview as a task registered in `AppState.subscriptions` under `preview_id` (chosen by the frontend, like a
/// stream id) for `cluster`: `helm_preview_stop`, closing the cluster, a page reload (`streams_reset`) and exit stop
/// it, which drops the call and kills its `helm`. Limited to [`PREVIEW_TIMEOUT`].
async fn tracked_preview<F>(
    state: &AppState,
    preview_id: String,
    cluster: ClusterId,
    render: F,
) -> Result<HelmManifestDiff, CoreError>
where
    F: Future<Output = CoreResult<HelmManifestDiff>> + Send + 'static,
{
    check_stream_id(&preview_id)?;
    let generation = state.streams_generation();
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        let result = with_timeout(PREVIEW_TIMEOUT, "rendering the preview", render).await;
        let _ = done_tx.send(result);
    });
    let subscription = Subscription {
        cluster,
        task: task.inner().abort_handle(),
    };
    if let Err(err) = state.subscriptions.insert(preview_id.clone(), subscription) {
        task.abort();
        return Err(err);
    }
    state.undo_if_reset(generation, || {
        state.subscriptions.stop(&preview_id);
    })?;
    let result = done_rx
        .await
        .unwrap_or_else(|_| Err(CoreError::other("the preview was stopped")));
    state.subscriptions.remove(&preview_id);
    result
}

/// What `helm_upgrade` with the same arguments would change: the release's current manifest against the one Helm
/// renders (`--dry-run=server`), Secrets without their values. Installs nothing (#141). Tracked under `preview_id`
/// (see [`tracked_preview`]).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn helm_upgrade_preview<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    release: String,
    chart_ref: String,
    values_yaml: String,
    preview_id: String,
    version: Option<String>,
) -> Result<HelmManifestDiff, CoreError> {
    let (cli, mgr, cluster) = (helm_cli(&app), state.clusters.clone(), cluster_id.clone());
    let render = async move {
        cli::preview_upgrade_to(
            &cli,
            &mgr,
            &cluster,
            &namespace,
            &release,
            &chart_ref,
            version.as_deref(),
            &values_yaml,
        )
        .await
    };
    tracked_preview(&state, preview_id, cluster_id, render).await
}

/// What `helm_install` with the same arguments would apply, against a release of that name already in the namespace
/// (empty when there is none). Installs nothing (#141). Tracked under `preview_id` (see [`tracked_preview`]).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn helm_install_preview<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    release: String,
    chart: String,
    version: Option<String>,
    values_yaml: String,
    preview_id: String,
) -> Result<HelmManifestDiff, CoreError> {
    let (cli, mgr, cluster) = (helm_cli(&app), state.clusters.clone(), cluster_id.clone());
    let render = async move {
        cli::preview_install(
            &cli,
            &mgr,
            &cluster,
            &namespace,
            &release,
            &chart,
            version.as_deref(),
            &values_yaml,
        )
        .await
    };
    tracked_preview(&state, preview_id, cluster_id, render).await
}

/// Stops a running preview (the dialog closed or asked again); an unknown id is not an error.
#[tauri::command]
pub async fn helm_preview_stop(
    state: State<'_, AppState>,
    preview_id: String,
) -> Result<(), CoreError> {
    state.subscriptions.stop(&preview_id);
    Ok(())
}

#[tauri::command]
pub async fn helm_repos<R: Runtime>(app: AppHandle<R>) -> Result<Vec<HelmRepo>, CoreError> {
    helm_cli(&app).repos().await
}

/// Adds a chart repository, optionally with a login: the password reaches `helm` only through its stdin. A URL
/// with `user:password@` is refused (`invalid`).
#[tauri::command]
pub async fn helm_repo_add<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    url: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), CoreError> {
    helm_cli(&app)
        .repo_add(&name, &url, username.as_deref(), password.as_deref())
        .await
}

#[tauri::command]
pub async fn helm_repo_remove<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<(), CoreError> {
    helm_cli(&app).repo_remove(&name).await
}

#[tauri::command]
pub async fn helm_repo_update<R: Runtime>(app: AppHandle<R>) -> Result<(), CoreError> {
    helm_cli(&app).repo_update().await
}

#[tauri::command]
pub async fn helm_search<R: Runtime>(
    app: AppHandle<R>,
    query: String,
) -> Result<Vec<ChartHit>, CoreError> {
    helm_cli(&app).search(&query).await
}

#[tauri::command]
pub async fn helm_show_values<R: Runtime>(
    app: AppHandle<R>,
    chart: String,
    version: Option<String>,
) -> Result<String, CoreError> {
    helm_cli(&app).show_values(&chart, version.as_deref()).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    /// Sets the flag when dropped: the render was given up.
    struct Dropped(Arc<AtomicBool>);

    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    fn app() -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(
            &dir.path().join("config"),
            &dir.path().join("data"),
        ));
        (app, dir)
    }

    /// A render that never ends: until it is stopped by `helm_preview_stop` or by closing its cluster.
    async fn endless(dropped: Arc<AtomicBool>) -> CoreResult<HelmManifestDiff> {
        let _guard = Dropped(dropped);
        std::future::pending::<()>().await;
        Err(CoreError::other("unreachable"))
    }

    #[test]
    fn neither_agents_nor_extensions_compare_revisions_or_look_for_chart_updates() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        let hidden = |name: &str| {
            let name = name.to_lowercase();
            name.contains("revision_diff")
                || name.contains("revisiondiff")
                || name.contains("chart_update")
                || name.contains("chartupdate")
                || name.contains("search")
        };
        assert!(!tools.iter().any(|t| hidden(t)), "{tools:?}");
        let methods = crate::extensions::api::METHODS;
        assert!(!methods.iter().any(|m| hidden(m)), "{methods:?}");
    }

    #[test]
    fn a_preview_is_tracked_and_stops_with_its_id_or_its_cluster() {
        for by_cluster in [false, true] {
            let (app, _dir) = app();
            let handle = app.handle().clone();
            let dropped = Arc::new(AtomicBool::new(false));
            let render = endless(Arc::clone(&dropped));
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let result =
                    tracked_preview(&state, "p-1".into(), ClusterId::from("c"), render).await;
                let _ = done_tx.send(result);
            });
            let state = app.state::<AppState>();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while state.subscriptions.is_empty() {
                assert!(std::time::Instant::now() < deadline, "never registered");
                std::thread::sleep(Duration::from_millis(5));
            }
            if by_cluster {
                state.close_cluster(&ClusterId::from("c"));
            } else {
                tauri::async_runtime::block_on(helm_preview_stop(
                    app.state::<AppState>(),
                    "p-1".into(),
                ))
                .unwrap();
            }
            let result = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(result.unwrap_err().message.contains("stopped"));
            assert!(dropped.load(Ordering::SeqCst));
            assert!(state.subscriptions.is_empty());
        }
    }
}
