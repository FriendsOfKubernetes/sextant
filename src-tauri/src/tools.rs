//! Terminal tools on the Tauri side (ADR-0132): the newest version from each tool's own source, the download checked
//! against its published SHA-256, the install into `<app data>/tools/<tool>/<version>/` (a temporary folder renamed
//! into place), the folders a terminal gets in front of its `PATH`, and the kubectl offer of a cluster's terminal.
//!
//! Every URL is built by [`sextant_core::tools`] from checked parts and checked again here ([`is_tool_source`]):
//! dl.k8s.io, get.helm.sh, api.github.com and github.com for the two GitHub-released tools only; redirects only to
//! GitHub's asset hosts and cdn.dl.k8s.io; the rules of [`crate::download`]. The window names a tool and, for kubectl,
//! a cluster: never a URL and never a version to install. Window only.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sextant_core::tools::{
    self, Checksums, HELM_LATEST_URL, InstalledTool, MAX_DOWNLOAD_BYTES, MAX_SMALL_BYTES, Packing,
    Platform, Tool, Version,
};
use sextant_core::{ClusterId, CoreError, CoreResult, ErrorCode};
use tauri::State;
use ts_rs::TS;

use crate::download::{Connect, Fetch, is_asset_host, plain_https};
use crate::state::AppState;

/// A version or checksum file, or the GitHub API, within this.
const SMALL_TIMEOUT: Duration = Duration::from_secs(30);
/// One tool file within this.
const FILE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long a newest version is remembered.
const LATEST_TTL: Duration = Duration::from_secs(10 * 60);
/// `kubectl version --client` within this.
const KUBECTL_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const GITHUB_JSON: &str = "application/vnd.github+json";

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// A URL Sextant fetches for a tool: one of the tools' own sources, nothing else.
pub fn is_tool_source(url: &Url) -> bool {
    let path = url.path();
    url.query().is_none()
        && ((plain_https(url, "dl.k8s.io") && path.starts_with("/release/"))
            || plain_https(url, "get.helm.sh")
            || (plain_https(url, "api.github.com")
                && [Tool::K9s, Tool::Kubectx]
                    .iter()
                    .filter_map(|t| t.github_repository())
                    .any(|r| path == format!("/repos/{r}/releases/latest")))
            || (plain_https(url, "github.com")
                && [Tool::K9s, Tool::Kubectx]
                    .iter()
                    .filter_map(|t| t.github_repository())
                    .any(|r| path.starts_with(&format!("/{r}/releases/download/")))))
        && !path.split('/').any(|p| p == ".." || p == ".")
}

fn allowed_redirect(url: &Url) -> bool {
    is_asset_host(url) || plain_https(url, "cdn.dl.k8s.io")
}

/// The reason a cluster's terminal offers kubectl.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum KubectlNeed {
    /// No kubectl in the terminal's `PATH`.
    Missing,
    /// The kubectl found is more than one minor version from the server.
    OutOfSkew { found: String },
}

/// What a cluster's terminal offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KubectlOffer {
    pub need: KubectlNeed,
    /// The server's `major.minor`, e.g. `1.37`: the install takes that minor's newest patch.
    pub server: String,
}

/// What is installed, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolsView {
    /// `<app data>/tools`.
    pub dir: String,
    pub installed: Vec<InstalledTool>,
    /// `false` where Sextant offers no tool (an OS or processor the projects do not build for).
    pub supported: bool,
}

/// A tool and, for kubectl, the server's `(major, minor)`.
type LatestKey = (Tool, Option<(u32, u32)>);

/// The tools' folder, the newest versions asked lately, and the servers' minor versions seen.
pub struct Tools {
    root: PathBuf,
    latest: Mutex<HashMap<LatestKey, (Instant, Version)>>,
    servers: Mutex<HashMap<ClusterId, (u32, u32)>>,
    /// Where requests really go (tests); `None` sends them to the URL itself.
    connect: Option<Connect>,
    /// One install at a time.
    installing: tokio::sync::Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Tools {
    /// The tools under `<data_dir>/tools`; folders left by an install that did not finish are removed.
    pub fn new(data_dir: &Path) -> Self {
        let tools = Self::with_connect(data_dir, None);
        tools.sweep();
        tools
    }

    /// [`Tools::new`] sending every request to `connect(url)` (tests).
    pub fn with_connect(data_dir: &Path, connect: Option<Connect>) -> Self {
        let root = data_dir.join("tools");
        // Where Sextant's own Helm features look when no helm is in PATH.
        sextant_core::helm::cli::set_fallback_tools_dir(root.clone());
        Self {
            root,
            latest: Mutex::new(HashMap::new()),
            servers: Mutex::new(HashMap::new()),
            connect,
            installing: tokio::sync::Mutex::new(()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn sweep(&self) {
        for tool in Tool::ALL {
            let Ok(entries) = std::fs::read_dir(self.root.join(tool.dir_name())) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().ends_with(".tmp") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    async fn fetch(
        &self,
        url: &str,
        max_bytes: u64,
        timeout: Duration,
        accept: Option<&'static str>,
    ) -> CoreResult<Vec<u8>> {
        let url = Url::parse(url)
            .map_err(|e| CoreError::other(format!("a tool URL does not read: {e}")))?;
        if !is_tool_source(&url) {
            return Err(invalid(
                "Sextant downloads tools only from their own release sources",
            ));
        }
        Fetch {
            max_bytes,
            timeout,
            connect: self.connect.as_ref(),
            allowed_redirect: &allowed_redirect,
            accept,
        }
        .get(url)
        .await
    }

    async fn text(&self, url: &str, accept: Option<&'static str>) -> CoreResult<String> {
        let bytes = self
            .fetch(url, MAX_SMALL_BYTES, SMALL_TIMEOUT, accept)
            .await?;
        String::from_utf8(bytes).map_err(|_| invalid("a version or checksum file is not text"))
    }

    /// The newest version of `tool` (for kubectl, of the server's minor version `server`).
    pub async fn latest(&self, tool: Tool, server: Option<(u32, u32)>) -> CoreResult<Version> {
        let key = (tool, if tool == Tool::Kubectl { server } else { None });
        if let Some((at, version)) = lock(&self.latest).get(&key)
            && at.elapsed() < LATEST_TTL
        {
            return Ok(*version);
        }
        let read = match tool {
            Tool::Kubectl => {
                let (major, minor) = server
                    .ok_or_else(|| invalid("kubectl is installed for a cluster's version"))?;
                self.text(&tools::kubectl_stable_url(major, minor), None)
                    .await?
            }
            Tool::Helm => self.text(HELM_LATEST_URL, None).await?,
            Tool::K9s | Tool::Kubectx => {
                let repository = tool.github_repository().unwrap_or_default();
                let json = self
                    .text(&tools::latest_release_url(repository), Some(GITHUB_JSON))
                    .await?;
                let value: serde_json::Value = serde_json::from_str(&json)
                    .map_err(|_| invalid("GitHub's answer is not JSON"))?;
                value
                    .get("tag_name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            }
        };
        let version = Version::parse(&read).ok_or_else(|| {
            invalid(format!(
                "the {} source named no version vX.Y.Z",
                tool.dir_name()
            ))
        })?;
        lock(&self.latest).insert(key, (Instant::now(), version));
        Ok(version)
    }

    /// Installs `tool` at `version`: every file downloaded, checked against its published SHA-256, its binaries taken
    /// and put into place. An installed version is left as it is.
    pub async fn install(&self, tool: Tool, version: Version) -> CoreResult<InstalledTool> {
        let platform = Platform::current().ok_or_else(|| {
            invalid("Sextant offers no tools for this operating system or processor")
        })?;
        let _one = self.installing.lock().await;
        let target = tools::version_dir(&self.root, tool, version);
        if !target.exists() {
            let (files, checksums) = tools::downloads(tool, version, platform);
            let release_sums = match &checksums {
                Checksums::Release(url) => Some(self.text(url, None).await?),
                Checksums::PerFile(_) => None,
            };
            let mut binaries: Vec<(String, Vec<u8>)> = Vec::new();
            for file in &files {
                let sums = match (&checksums, &release_sums) {
                    (Checksums::PerFile(suffix), _) => {
                        self.text(&format!("{}{suffix}", file.url), None).await?
                    }
                    (Checksums::Release(_), Some(text)) => text.clone(),
                    (Checksums::Release(_), None) => String::new(),
                };
                let expected = tools::checksum_for(&sums, &file.name)
                    .ok_or_else(|| invalid(format!("no published checksum for {}", file.name)))?;
                let bytes = self
                    .fetch(&file.url, MAX_DOWNLOAD_BYTES, FILE_TIMEOUT, None)
                    .await?;
                if !tools::matches_checksum(&bytes, &expected) {
                    return Err(invalid(format!(
                        "{} does not match its published checksum; nothing was installed",
                        file.name
                    )));
                }
                for (member, command) in &file.binaries {
                    let data = match file.packing {
                        Packing::Plain => bytes.clone(),
                        Packing::TarGz => tools::extract_from_tar_gz(&bytes, member).await?,
                        Packing::Zip => tools::extract_from_zip(&bytes, member)?,
                    };
                    binaries.push((command.clone(), data));
                }
            }
            write_version(&target, &binaries)?;
        }
        tools::installed(&self.root, platform)
            .into_iter()
            .find(|i| i.tool == tool && Version::parse(&i.version) == Some(version))
            .ok_or_else(|| CoreError::other("the installed tool cannot be found"))
    }

    /// Removes one installed version.
    pub fn remove(&self, tool: Tool, version: Version) -> CoreResult<()> {
        let dir = tools::version_dir(&self.root, tool, version);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn view(&self) -> ToolsView {
        let platform = Platform::current();
        ToolsView {
            dir: self.root.display().to_string(),
            installed: platform
                .map(|p| tools::installed(&self.root, p))
                .unwrap_or_default(),
            supported: platform.is_some(),
        }
    }

    /// The `PATH` of a terminal: Sextant's tools (the kubectl of `cluster`'s server version when known) in front of
    /// `base`. `None` when nothing is installed.
    pub fn terminal_path(
        &self,
        cluster: Option<&ClusterId>,
        base: Option<OsString>,
    ) -> Option<OsString> {
        let platform = Platform::current()?;
        let installed = tools::installed(&self.root, platform);
        let server = cluster.and_then(|c| lock(&self.servers).get(c).copied());
        let dirs = tools::path_dirs(&self.root, &installed, server);
        if dirs.is_empty() {
            return None;
        }
        let rest = base
            .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
            .unwrap_or_default();
        std::env::join_paths(dirs.into_iter().chain(rest)).ok()
    }

    /// Remembers a cluster's server version (for its terminals' kubectl).
    pub fn remember_server(&self, cluster: &ClusterId, server: (u32, u32)) {
        lock(&self.servers).insert(cluster.clone(), server);
    }
}

/// Writes the binaries into a temporary folder next to `target`, then renames it into place.
fn write_version(target: &Path, binaries: &[(String, Vec<u8>)]) -> CoreResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| CoreError::other("no tools folder"))?;
    std::fs::create_dir_all(parent)?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("version");
    let temp = parent.join(format!(".{name}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp)?;
    let written = (|| -> std::io::Result<()> {
        for (command, data) in binaries {
            let path = temp.join(command);
            std::fs::write(&path, data)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
            }
        }
        std::fs::rename(&temp, target)
    })();
    if let Err(err) = written {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(err.into());
    }
    Ok(())
}

/// The kubectl a terminal would run: the first `kubectl` in `path`.
fn find_kubectl(path: &OsString) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "kubectl.exe"
    } else {
        "kubectl"
    };
    std::env::split_paths(path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// `kubectl version --client -o json` of `binary`, within [`KUBECTL_VERSION_TIMEOUT`]; `None` when it does not say.
async fn kubectl_version(binary: &Path) -> Option<Version> {
    let mut command = tokio::process::Command::new(binary);
    command
        .args(["version", "--client", "--output=json"])
        .env_remove("KUBECONFIG")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(KUBECTL_VERSION_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    tools::kubectl_client_version(&String::from_utf8_lossy(&output.stdout))
}

fn tool_of(name: &str) -> CoreResult<Tool> {
    serde_json::from_value(serde_json::Value::String(name.to_owned()))
        .map_err(|_| invalid(format!("Sextant offers no tool `{name}`")))
}

async fn server_minor(state: &AppState, cluster: &ClusterId) -> CoreResult<(u32, u32)> {
    let client = state.clusters.client(cluster)?;
    let info =
        sextant_core::error::with_timeout(SMALL_TIMEOUT, "reading the server version", async {
            client.apiserver_version().await.map_err(CoreError::from)
        })
        .await?;
    let minor = Version::minor_of_server(&info.git_version).ok_or_else(|| {
        invalid(format!(
            "the server's version `{}` does not read",
            info.git_version
        ))
    })?;
    state.tools.remember_server(cluster, minor);
    Ok(minor)
}

/// Installed tools and their folder.
#[tauri::command]
pub async fn tools_list(state: State<'_, AppState>) -> CoreResult<ToolsView> {
    Ok(state.tools.view())
}

/// The newest version of `tool` (kubectl: for `clusterId`'s server), from its source.
#[tauri::command]
pub async fn tools_latest(
    state: State<'_, AppState>,
    tool: String,
    cluster_id: Option<ClusterId>,
) -> CoreResult<String> {
    let tool = tool_of(&tool)?;
    let server = match (&cluster_id, tool) {
        (Some(cluster), Tool::Kubectl) => Some(server_minor(&state, cluster).await?),
        _ => None,
    };
    Ok(state.tools.latest(tool, server).await?.to_string())
}

/// Installs the newest version of `tool` (kubectl: of `clusterId`'s server minor version).
#[tauri::command]
pub async fn tools_install(
    state: State<'_, AppState>,
    tool: String,
    cluster_id: Option<ClusterId>,
) -> CoreResult<InstalledTool> {
    let tool = tool_of(&tool)?;
    let server = match (&cluster_id, tool) {
        (Some(cluster), Tool::Kubectl) => Some(server_minor(&state, cluster).await?),
        (None, Tool::Kubectl) => {
            return Err(invalid("kubectl is installed for a cluster's version"));
        }
        _ => None,
    };
    let version = state.tools.latest(tool, server).await?;
    state.tools.install(tool, version).await
}

/// Removes one installed version.
#[tauri::command]
pub async fn tools_remove(
    state: State<'_, AppState>,
    tool: String,
    version: String,
) -> CoreResult<()> {
    let tool = tool_of(&tool)?;
    let version = Version::parse(&version).ok_or_else(|| invalid("not a version vX.Y.Z"))?;
    state.tools.remove(tool, version)
}

/// What a cluster's terminal should offer: nothing when the offer is turned off, the cluster cannot say its version,
/// or the kubectl its terminal would run is within the supported skew.
#[tauri::command]
pub async fn tools_kubectl_offer(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
) -> CoreResult<Option<KubectlOffer>> {
    if !state.settings.get().terminal_tools.offer_kubectl || Platform::current().is_none() {
        return Ok(None);
    }
    let Ok(server) = server_minor(&state, &cluster_id).await else {
        return Ok(None);
    };
    let path = state
        .tools
        .terminal_path(Some(&cluster_id), std::env::var_os("PATH"))
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
    let need = match find_kubectl(&path) {
        None => KubectlNeed::Missing,
        Some(binary) => match kubectl_version(&binary).await {
            Some(found) if found.in_skew(server) => return Ok(None),
            Some(found) => KubectlNeed::OutOfSkew {
                found: found.to_string(),
            },
            // A kubectl that does not say its version is left alone.
            None => return Ok(None),
        },
    };
    Ok(Some(KubectlOffer {
        need,
        server: format!("{}.{}", server.0, server.1),
    }))
}

#[cfg(test)]
mod tests;
