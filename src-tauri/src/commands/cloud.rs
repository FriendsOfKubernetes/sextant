//! Cloud clusters (EKS, GKE, AKS) through the user's own `aws`, `gcloud` and `az` (`sextant_core::cloud`).
//!
//! The CLIs and their environment come from a managed `CloudCli` when the app (or a test) registers one with
//! `app.manage(..)`, otherwise the app's environment as a local terminal gets it (`pty::shell_environment`: without
//! `KUBECONFIG`, Helm overrides and AppImage variables). Imported clusters go to Sextant's own
//! `kubeconfigs/cloud-<provider>.yaml` and are saved as kubeconfig sources.

use std::ffi::OsString;

use sextant_core::cloud::{
    CloudAccounts, CloudCli, CloudCliStatus, CloudCluster, CloudImport, CloudProblem,
    CloudProvider, CloudQuery, CloudSearch,
};
use sextant_core::{ClusterId, CoreError};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::pty::{self, Platform};
use crate::state::AppState;

fn cloud_cli<R: Runtime>(app: &AppHandle<R>) -> CloudCli {
    app.try_state::<CloudCli>()
        .map(|cli| cli.inner().clone())
        .unwrap_or_else(|| cli_with_env(std::env::vars_os()))
}

/// The CLIs with the environment a local terminal gets from `base` (this process's environment in the app): without
/// the AppImage's variables and paths into the mounted image, which would break the Python of `az`, `gcloud`, `aws`.
fn cli_with_env(base: impl IntoIterator<Item = (OsString, OsString)>) -> CloudCli {
    CloudCli::default().with_env(pty::shell_environment(Platform::current(), base))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clis_get_no_appimage_variables_or_paths_into_the_image() {
        let image = "/tmp/.mount_SextaXyZ";
        let joined = |paths: &[&str]| std::env::join_paths(paths).unwrap();
        let base: Vec<(OsString, OsString)> = vec![
            ("APPIMAGE".into(), "/home/u/Sextant.AppImage".into()),
            ("APPDIR".into(), image.into()),
            ("ARGV0".into(), "Sextant.AppImage".into()),
            (
                "PATH".into(),
                joined(&[&format!("{image}/usr/bin"), "/usr/bin"]),
            ),
            (
                "LD_LIBRARY_PATH".into(),
                joined(&[&format!("{image}/usr/lib")]),
            ),
            ("PYTHONHOME".into(), format!("{image}/usr").into()),
            ("HOME".into(), "/home/u".into()),
            ("KUBECONFIG".into(), "/elsewhere".into()),
        ];
        let env = cli_with_env(base).child_env();
        let name_of = |k: &OsString| k.to_string_lossy().to_ascii_uppercase();
        for (key, value) in &env {
            assert!(
                !["APPIMAGE", "APPDIR", "ARGV0", "KUBECONFIG"].contains(&name_of(key).as_str()),
                "{key:?}"
            );
            assert!(
                !value.to_string_lossy().contains(image),
                "{key:?}={value:?}"
            );
        }
        let path = env.iter().find(|(k, _)| name_of(k) == "PATH").unwrap();
        assert_eq!(path.1, joined(&["/usr/bin"]));
        assert!(env.iter().any(|(k, _)| name_of(k) == "HOME"));
    }
}
