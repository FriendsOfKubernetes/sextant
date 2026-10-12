//! Helm: releases are read natively, changes go through the `helm` binary.
//!
//! Every call that reaches a cluster gets a temporary kubeconfig (0600) with only that cluster's context; it is
//! deleted as soon as `helm` exits. The `helm` binary and its environment come from a managed `HelmCli` when the
//! app (or a test) registers one with `app.manage(..)`, otherwise `HelmCli::default()` (looked up in `PATH`); the
//! path chosen in Settings (`AppSettings::helm_path`) replaces the binary.

use sextant_core::helm::cli::{self, ChartHit, HelmCli, HelmRepo, HelmStatus};
use sextant_core::helm::{self, HelmRelease, HelmReleaseDetail};
use sextant_core::{ClusterId, CoreError};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::state::AppState;

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

/// New user values for a release, same chart and chart version. An empty `chart_ref` reuses the chart stored in
/// the release; otherwise `chart_ref` (e.g. `repo/chart`) is used at the release's chart version.
#[tauri::command]
pub async fn helm_upgrade<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    release: String,
    chart_ref: String,
    values_yaml: String,
) -> Result<(), CoreError> {
    cli::upgrade_release(
        &helm_cli(&app),
        &state.clusters,
        &cluster_id,
        &namespace,
        &release,
        &chart_ref,
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
    let target = cli::kube_target(&state.clusters, &cluster_id)?;
    helm_cli(&app)
        .install(
            &target.kubeconfig,
            &target.context,
            &namespace,
            &release,
            &chart,
            version.as_deref(),
            &values_yaml,
        )
        .await
}

#[tauri::command]
pub async fn helm_repos<R: Runtime>(app: AppHandle<R>) -> Result<Vec<HelmRepo>, CoreError> {
    helm_cli(&app).repos().await
}

#[tauri::command]
pub async fn helm_repo_add<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    url: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), CoreError> {
    // A repository with a login is not supported yet.
    if username.is_some() || password.is_some() {
        return Err(CoreError::not_implemented());
    }
    helm_cli(&app).repo_add(&name, &url).await
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
