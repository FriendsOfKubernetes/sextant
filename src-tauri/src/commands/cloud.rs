//! Cloud clusters (EKS, GKE, AKS) through the user's own `aws`, `gcloud` and `az` (`sextant_core::cloud`).
//!
//! The CLIs and their environment come from a managed `CloudCli` when the app (or a test) registers one with
//! `app.manage(..)`, otherwise `CloudCli::default()` (the app's `PATH`, without `KUBECONFIG`/`HELM_*`). Imported
//! clusters go to Sextant's own `kubeconfigs/cloud-<provider>.yaml` and are saved as kubeconfig sources.

use sextant_core::cloud::{
    CloudAccounts, CloudCli, CloudCliStatus, CloudCluster, CloudImport, CloudProblem,
    CloudProvider, CloudQuery, CloudSearch,
};
use sextant_core::{ClusterId, CoreError};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::state::AppState;

fn cloud_cli<R: Runtime>(app: &AppHandle<R>) -> CloudCli {
    app.try_state::<CloudCli>()
        .map(|cli| cli.inner().clone())
        .unwrap_or_default()
}

/// `aws`, `gcloud`, `az`: installed or not, their versions and credential plugins.
#[tauri::command]
pub async fn cloud_status<R: Runtime>(app: AppHandle<R>) -> Result<Vec<CloudCliStatus>, CoreError> {
    Ok(cloud_cli(&app).status().await)
}

/// AWS profiles and regions, GCP projects or Azure subscriptions; a problem (not installed, not signed in) instead
/// of an error.
#[tauri::command]
pub async fn cloud_accounts<R: Runtime>(
    app: AppHandle<R>,
    provider: CloudProvider,
) -> Result<CloudAccounts, CoreError> {
    Ok(cloud_cli(&app).accounts(provider).await)
}

/// The clusters of an account (in the chosen regions for AWS), with the problems of the regions that failed.
#[tauri::command]
pub async fn cloud_find<R: Runtime>(
    app: AppHandle<R>,
    query: CloudQuery,
) -> Result<CloudSearch, CoreError> {
    cloud_cli(&app).find_clusters(&query).await
}

/// Writes the clusters to Sextant's own kubeconfig files (exec authentication) and saves the sources.
#[tauri::command]
pub async fn cloud_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    clusters: Vec<CloudCluster>,
) -> Result<CloudImport, CoreError> {
    let prepared = cloud_cli(&app).prepare_import(&clusters).await;
    let (import, sources) = {
        let mut registry = state.registry.write().unwrap_or_else(|e| e.into_inner());
        let import = prepared.apply(&mut registry)?;
        (import, registry.added_sources())
    };
    state
        .settings
        .update(move |s| s.kubeconfig_sources = sources)?;
    Ok(import)
}

/// After a failed sign-in (`authPlugin`/`unauthorized`): the command that signs in with the cluster's cloud CLI, or
/// how to install the missing CLI or plugin. `null` when the cluster does not sign in through a cloud CLI.
#[tauri::command]
pub async fn cloud_login_hint<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> Result<Option<CloudProblem>, CoreError> {
    let config = {
        let registry = state.registry.read().unwrap_or_else(|e| e.into_inner());
        registry.kubeconfig_for(&cluster_id)?
    };
    Ok(cloud_cli(&app).login_hint(&config).await)
}
