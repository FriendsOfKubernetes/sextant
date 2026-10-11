//! Helm releases read natively from `sh.helm.release.v1.*` Secrets; changes go through the `helm` binary
//! (`cli`, behind the `desktop` feature).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::ClusterId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: i32,
    pub chart: String,
    pub chart_version: String,
    pub app_version: String,
    pub status: String,
    pub updated: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmReleaseDetail {
    pub release: HelmRelease,
    pub values_yaml: String,
    pub manifest: String,
    pub notes: String,
}

/// Latest revision of every release.
pub async fn list_releases(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _namespaces: Option<Vec<String>>,
) -> CoreResult<Vec<HelmRelease>> {
    Err(CoreError::not_implemented())
}

pub async fn release_detail(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _ns: &str,
    _name: &str,
    _revision: Option<i32>,
) -> CoreResult<HelmReleaseDetail> {
    Err(CoreError::not_implemented())
}

pub async fn release_history(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _ns: &str,
    _name: &str,
) -> CoreResult<Vec<HelmRelease>> {
    Err(CoreError::not_implemented())
}

/// Calls to the `helm` binary. Every call passes `--kubeconfig <temp> --kube-context <ctx>`;
/// a non-zero exit gives `CoreError { Other, stderr }`.
#[cfg(feature = "desktop")]
pub mod cli {
    use std::path::Path;

    use serde::{Deserialize, Serialize};
    use ts_rs::TS;

    use crate::error::{CoreError, CoreResult};

    #[derive(Debug, Clone, Default)]
    pub struct HelmCli {
        _private: (),
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    #[ts(export)]
    pub struct HelmStatus {
        pub available: bool,
        pub version: Option<String>,
        pub path: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    #[ts(export)]
    pub struct HelmRepo {
        pub name: String,
        pub url: String,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
    #[serde(rename_all = "camelCase")]
    #[ts(export)]
    pub struct ChartHit {
        /// `repo/chart`
        pub name: String,
        pub version: String,
        pub app_version: String,
        pub description: String,
    }

    impl HelmCli {
        pub fn detect() -> HelmStatus {
            HelmStatus {
                available: false,
                version: None,
                path: None,
            }
        }

        pub async fn upgrade(
            &self,
            _kc: &Path,
            _ctx: &str,
            _ns: &str,
            _release: &str,
            _chart_ref: &str,
            _values_yaml: &str,
        ) -> CoreResult<()> {
            Err(CoreError::not_implemented())
        }

        pub async fn rollback(
            &self,
            _kc: &Path,
            _ctx: &str,
            _ns: &str,
            _release: &str,
            _revision: i32,
        ) -> CoreResult<()> {
            Err(CoreError::not_implemented())
        }

        pub async fn uninstall(
            &self,
            _kc: &Path,
            _ctx: &str,
            _ns: &str,
            _release: &str,
        ) -> CoreResult<()> {
            Err(CoreError::not_implemented())
        }

        #[allow(clippy::too_many_arguments)]
        pub async fn install(
            &self,
            _kc: &Path,
            _ctx: &str,
            _ns: &str,
            _release: &str,
            _chart: &str,
            _version: Option<&str>,
            _values_yaml: &str,
        ) -> CoreResult<()> {
            Err(CoreError::not_implemented())
        }

        pub async fn repos(&self) -> CoreResult<Vec<HelmRepo>> {
            Err(CoreError::not_implemented())
        }

        pub async fn repo_add(&self, _name: &str, _url: &str) -> CoreResult<()> {
            Err(CoreError::not_implemented())
        }

        pub async fn repo_remove(&self, _name: &str) -> CoreResult<()> {
            Err(CoreError::not_implemented())
        }

        pub async fn repo_update(&self) -> CoreResult<()> {
            Err(CoreError::not_implemented())
        }

        pub async fn search(&self, _query: &str) -> CoreResult<Vec<ChartHit>> {
            Err(CoreError::not_implemented())
        }

        pub async fn show_values(
            &self,
            _chart: &str,
            _version: Option<&str>,
        ) -> CoreResult<String> {
            Err(CoreError::not_implemented())
        }
    }
}
