//! Kubeconfig sources and the clusters (contexts) they describe.
//!
//! Stage 01 skeleton: the types are final, the functions are filled in by the clusters stage.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult};

/// Where a kubeconfig file came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SourceKind {
    /// `~/.kube/config`
    Default,
    /// A file listed in `KUBECONFIG`.
    Env,
    /// A file the user added with "Add kubeconfig file".
    AddedFile,
    /// Text the user pasted; stored in the app data directory.
    Pasted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KubeconfigSource {
    pub id: String,
    pub path: PathBuf,
    pub kind: SourceKind,
}

/// Stable cluster id: hex `sha256(source path + "\0" + context)[..16]`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ClusterId(pub String);

impl ClusterId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ClusterId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for ClusterId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for ClusterId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

/// One kubeconfig context as shown in the cluster rail. Never carries credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClusterInfo {
    pub id: ClusterId,
    pub context: String,
    pub cluster_name: String,
    pub server: String,
    pub user: String,
    pub namespace: Option<String>,
    pub source_id: String,
}

/// All kubeconfig sources: `KUBECONFIG` / `~/.kube/config` plus files the user added or pasted.
#[derive(Debug, Clone)]
pub struct KubeconfigRegistry {
    extra_sources: Vec<KubeconfigSource>,
    pasted_dir: PathBuf,
}

impl KubeconfigRegistry {
    pub fn new(extra_sources: Vec<KubeconfigSource>, pasted_dir: PathBuf) -> Self {
        Self {
            extra_sources,
            pasted_dir,
        }
    }

    pub fn sources(&self) -> Vec<KubeconfigSource> {
        self.extra_sources.clone()
    }

    /// Re-reads the files and lists every context.
    pub fn clusters(&self) -> CoreResult<Vec<ClusterInfo>> {
        Err(CoreError::not_implemented())
    }

    pub fn add_file(&mut self, _path: PathBuf) -> CoreResult<KubeconfigSource> {
        Err(CoreError::not_implemented())
    }

    pub fn add_pasted(&mut self, _text: &str) -> CoreResult<KubeconfigSource> {
        let _ = &self.pasted_dir;
        Err(CoreError::not_implemented())
    }

    pub fn remove_source(&mut self, _source_id: &str) -> CoreResult<()> {
        Err(CoreError::not_implemented())
    }

    /// A kubeconfig with just this context, `current-context` set to it.
    pub fn kubeconfig_for(&self, _id: &ClusterId) -> CoreResult<kube::config::Kubeconfig> {
        Err(CoreError::not_implemented())
    }

    /// Writes [`Self::kubeconfig_for`] to a temporary file with mode 0600 (for the terminal and `helm`).
    pub fn write_temp_kubeconfig(&self, _id: &ClusterId) -> CoreResult<tempfile::TempPath> {
        Err(CoreError::not_implemented())
    }
}
