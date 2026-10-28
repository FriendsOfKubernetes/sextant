//! Terminal tools (ADR-0132): kubectl for a cluster's version, helm, k9s and kubectx/kubens, installed into Sextant's
//! own folder and put in front of the `PATH` of Sextant's terminals. This module has no network: the versions, the
//! platform names, the URLs Sextant builds, the checksum files, the archives and the folder layout. The downloads are
//! the Tauri layer's (`src-tauri/src/tools/`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::{CoreError, CoreResult, ErrorCode};

/// A downloaded file is refused when larger.
pub const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;
/// An archive is refused when it unpacks to more than this.
pub const MAX_UNPACKED_BYTES: u64 = 512 * 1024 * 1024;
/// A checksum file or a version file is refused when larger.
pub const MAX_SMALL_BYTES: u64 = 256 * 1024;

/// A tool Sextant can install.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Tool {
    Kubectl,
    Helm,
    K9s,
    /// kubectx and kubens, from one project.
    Kubectx,
}

impl Tool {
    pub const ALL: [Tool; 4] = [Tool::Kubectl, Tool::Helm, Tool::K9s, Tool::Kubectx];

    /// The folder under the tools directory.
    pub fn dir_name(self) -> &'static str {
        match self {
            Tool::Kubectl => "kubectl",
            Tool::Helm => "helm",
            Tool::K9s => "k9s",
            Tool::Kubectx => "kubectx",
        }
    }

    /// The commands it installs (without `.exe`).
    pub fn binaries(self) -> &'static [&'static str] {
        match self {
            Tool::Kubectl => &["kubectl"],
            Tool::Helm => &["helm"],
            Tool::K9s => &["k9s"],
            Tool::Kubectx => &["kubectx", "kubens"],
        }
    }

    /// The GitHub repository whose latest release it comes from, for the tools released there.
    pub fn github_repository(self) -> Option<&'static str> {
        match self {
            Tool::K9s => Some("derailed/k9s"),
            Tool::Kubectx => Some("ahmetb/kubectx"),
            Tool::Kubectl | Tool::Helm => None,
        }
    }
}

/// `vX.Y.Z`, nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    /// `vX.Y.Z` (a leading `v` required, numbers without leading zeros, at most 6 digits each).
    pub fn parse(text: &str) -> Option<Version> {
        let mut parts = text.trim().strip_prefix('v')?.split('.');
        let mut number = || {
            let part = parts.next()?;
            (!part.is_empty()
                && part.len() <= 6
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part == "0" || !part.starts_with('0')))
            .then(|| part.parse().ok())
            .flatten()
        };
        let version = Version {
            major: number()?,
            minor: number()?,
            patch: number()?,
        };
        parts.next().is_none().then_some(version)
    }

    /// The `major.minor` of a server's `gitVersion` (`v1.37.2`, `v1.30.5-eks-1234`, `v1.29.3+k3s1`).
    pub fn minor_of_server(git_version: &str) -> Option<(u32, u32)> {
        let core = git_version.trim().split(['-', '+']).next()?;
        Version::parse(core).map(|v| (v.major, v.minor))
    }

    /// Within the skew Kubernetes supports between kubectl and the server: the same major, at most one minor apart.
    pub fn in_skew(self, server: (u32, u32)) -> bool {
        self.major == server.0 && self.minor.abs_diff(server.1) <= 1
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// The operating system and processor the tools are for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Platform {
    pub os: Os,
    pub arch: Arch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    MacOs,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    X86_64,
    Arm64,
}

impl Platform {
    /// This build's platform; `None` where no tool is offered.
    pub fn current() -> Option<Platform> {
        let os = if cfg!(target_os = "linux") {
            Os::Linux
        } else if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            return None;
        };
        let arch = if cfg!(target_arch = "x86_64") {
            Arch::X86_64
        } else if cfg!(target_arch = "aarch64") {
            Arch::Arm64
        } else {
            return None;
        };
        Some(Platform { os, arch })
    }

    fn exe(self) -> &'static str {
        if self.os == Os::Windows { ".exe" } else { "" }
    }

    /// `linux` / `darwin` / `windows` (Kubernetes, Helm, kubectx).
    fn go_os(self) -> &'static str {
        match self.os {
            Os::Linux => "linux",
            Os::MacOs => "darwin",
            Os::Windows => "windows",
        }
    }

    /// `amd64` / `arm64` (Kubernetes, Helm, k9s).
    fn go_arch(self) -> &'static str {
        match self.arch {
            Arch::X86_64 => "amd64",
            Arch::Arm64 => "arm64",
        }
    }
}

/// How a download is packed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Packing {
    /// The binary itself (kubectl).
    Plain,
    TarGz,
    Zip,
}

/// What to download for one tool at one version: the files, the checksum file, how to read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Download {
    /// The URL of the file.
    pub url: String,
    /// The file's name as its checksum file names it.
    pub name: String,
    pub packing: Packing,
    /// The binaries to take from it: (path inside the archive, command name).
    pub binaries: Vec<(String, String)>,
}

/// Where the checksums of a tool's files are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checksums {
    /// One file per download: its URL with this suffix (`.sha256`, `.sha256sum`).
    PerFile(&'static str),
    /// One file for the release: its URL (k9s `checksums.sha256`, kubectx `checksums.txt`).
    Release(String),
}

/// The URL of the newest patch of a Kubernetes minor version.
pub fn kubectl_stable_url(major: u32, minor: u32) -> String {
    format!("https://dl.k8s.io/release/stable-{major}.{minor}.txt")
}

/// The URL of Helm's latest version.
pub const HELM_LATEST_URL: &str = "https://get.helm.sh/helm-latest-version";

/// The GitHub API URL of a tool's latest release.
pub fn latest_release_url(repository: &str) -> String {
    format!("https://api.github.com/repos/{repository}/releases/latest")
}

/// The downloads of `tool` at `version` for `platform`, and where their checksums are.
pub fn downloads(tool: Tool, version: Version, platform: Platform) -> (Vec<Download>, Checksums) {
    let exe = platform.exe();
    let (os, arch) = (platform.go_os(), platform.go_arch());
    let archive = if platform.os == Os::Windows {
        "zip"
    } else {
        "tar.gz"
    };
    let packing = if platform.os == Os::Windows {
        Packing::Zip
    } else {
        Packing::TarGz
    };
    match tool {
        Tool::Kubectl => {
            let name = format!("kubectl{exe}");
            (
                vec![Download {
                    url: format!("https://dl.k8s.io/release/{version}/bin/{os}/{arch}/{name}"),
                    name: name.clone(),
                    packing: Packing::Plain,
                    binaries: vec![(name.clone(), name)],
                }],
                Checksums::PerFile(".sha256"),
            )
        }
        Tool::Helm => {
            let name = format!("helm-{version}-{os}-{arch}.{archive}");
            (
                vec![Download {
                    url: format!("https://get.helm.sh/{name}"),
                    name,
                    packing,
                    binaries: vec![(format!("{os}-{arch}/helm{exe}"), format!("helm{exe}"))],
                }],
                Checksums::PerFile(".sha256sum"),
            )
        }
        Tool::K9s => {
            let k9s_os = match platform.os {
                Os::Linux => "Linux",
                Os::MacOs => "Darwin",
                Os::Windows => "Windows",
            };
            let name = format!("k9s_{k9s_os}_{arch}.{archive}");
            let base = format!("https://github.com/derailed/k9s/releases/download/{version}");
            (
                vec![Download {
                    url: format!("{base}/{name}"),
                    name,
                    packing,
                    binaries: vec![(format!("k9s{exe}"), format!("k9s{exe}"))],
                }],
                Checksums::Release(format!("{base}/checksums.sha256")),
            )
        }
        Tool::Kubectx => {
            let kubectx_arch = match platform.arch {
                Arch::X86_64 => "x86_64",
                Arch::Arm64 => "arm64",
            };
            let base = format!("https://github.com/ahmetb/kubectx/releases/download/{version}");
            let files = ["kubectx", "kubens"]
                .into_iter()
                .map(|command| {
                    let name = format!("{command}_{version}_{os}_{kubectx_arch}.{archive}");
                    Download {
                        url: format!("{base}/{name}"),
                        name,
                        packing,
                        binaries: vec![(format!("{command}{exe}"), format!("{command}{exe}"))],
                    }
                })
                .collect();
            (files, Checksums::Release(format!("{base}/checksums.txt")))
        }
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// The SHA-256 a checksum file gives for `name`: a bare digest (kubectl's `.sha256`), or `<digest>  <name>` lines
/// (`sha256sum`'s format; a `*` before the name, binary mode, is accepted).
pub fn checksum_for(text: &str, name: &str) -> Option<String> {
    let is_digest = |d: &str| d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit());
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if let [only] = lines.as_slice()
        && is_digest(only)
    {
        return Some(only.to_ascii_lowercase());
    }
    lines.iter().find_map(|line| {
        let (digest, file) = line.split_once(char::is_whitespace)?;
        let file = file.trim().trim_start_matches('*');
        (is_digest(digest) && file == name).then(|| digest.to_ascii_lowercase())
    })
}

/// Whether `bytes` have the SHA-256 `expected` (lower-case hex).
pub fn matches_checksum(bytes: &[u8], expected: &str) -> bool {
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex == expected
}

/// A path inside an archive that may be taken: relative, `/`-separated, no `..`, no empty part.
fn plain_member(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

/// Takes `member` (a regular file, exactly that path, optionally under `./`) out of a gzipped tar archive.
pub async fn extract_from_tar_gz(archive: &[u8], member: &str) -> CoreResult<Vec<u8>> {
    use std::io::Read as _;
    if !plain_member(member) {
        return Err(invalid(format!("`{member}` is not a plain path")));
    }
    let mut tar = Vec::new();
    flate2::read::GzDecoder::new(archive)
        .take(MAX_UNPACKED_BYTES + 1)
        .read_to_end(&mut tar)
        .map_err(|e| invalid(format!("the archive cannot be unpacked: {e}")))?;
    if tar.len() as u64 > MAX_UNPACKED_BYTES {
        return Err(invalid("the archive unpacks to too much"));
    }
    let mut reader = crate::files::TarReader::new(std::io::Cursor::new(tar));
    while let Some(entry) = reader.next_entry().await? {
        let path = entry.path.strip_prefix("./").unwrap_or(&entry.path);
        if path != member {
            continue;
        }
        if entry.kind != crate::files::EntryKind::Regular {
            return Err(invalid(format!(
                "`{member}` in the archive is not a regular file"
            )));
        }
        let mut out = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut out);
        reader
            .copy_data(entry.size, &mut cursor, &mut |_| {})
            .await
            .map_err(|e| invalid(format!("`{member}` cannot be read: {e:?}")))?;
        return Ok(out);
    }
    Err(invalid(format!("the archive has no `{member}`")))
}

/// Takes `member` (a file, exactly that path) out of a zip archive.
pub fn extract_from_zip(archive: &[u8], member: &str) -> CoreResult<Vec<u8>> {
    use std::io::Read as _;
    if !plain_member(member) {
        return Err(invalid(format!("`{member}` is not a plain path")));
    }
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|e| invalid(format!("the archive cannot be read: {e}")))?;
    let mut file = zip
        .by_name(member)
        .map_err(|_| invalid(format!("the archive has no `{member}`")))?;
    if !file.is_file() || file.size() > MAX_UNPACKED_BYTES {
        return Err(invalid(format!(
            "`{member}` in the archive is not a file Sextant takes"
        )));
    }
    let mut out = Vec::new();
    file.by_ref()
        .take(MAX_UNPACKED_BYTES)
        .read_to_end(&mut out)
        .map_err(|e| invalid(format!("`{member}` cannot be read: {e}")))?;
    Ok(out)
}

/// One installed version of a tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledTool {
    pub tool: Tool,
    pub version: String,
    #[ts(type = "number")]
    pub bytes: u64,
}

/// The installed versions under `root` (`<root>/<tool>/<vX.Y.Z>/`), newest first per tool. A folder whose name is not
/// a version, or that lacks one of the tool's binaries, is not listed.
pub fn installed(root: &Path, platform: Platform) -> Vec<InstalledTool> {
    let mut out = Vec::new();
    for tool in Tool::ALL {
        let Ok(entries) = std::fs::read_dir(root.join(tool.dir_name())) else {
            continue;
        };
        let mut versions: Vec<(Version, u64)> = entries
            .flatten()
            .filter_map(|e| {
                let version = Version::parse(e.file_name().to_str()?)?;
                let dir = e.path();
                let mut bytes = 0;
                for binary in tool.binaries() {
                    let meta =
                        std::fs::metadata(dir.join(format!("{binary}{}", platform.exe()))).ok()?;
                    meta.is_file().then_some(())?;
                    bytes += meta.len();
                }
                Some((version, bytes))
            })
            .collect();
        versions.sort_by_key(|v| std::cmp::Reverse(v.0));
        out.extend(versions.into_iter().map(|(v, bytes)| InstalledTool {
            tool,
            version: v.to_string(),
            bytes,
        }));
    }
    out
}

/// The folder of one installed version.
pub fn version_dir(root: &Path, tool: Tool, version: Version) -> PathBuf {
    root.join(tool.dir_name()).join(version.to_string())
}

/// The folders a terminal gets in front of its `PATH`: the kubectl of the cluster's minor version if installed (else
/// the newest), and the newest of every other tool. Only installed versions.
pub fn path_dirs(
    root: &Path,
    installed: &[InstalledTool],
    server: Option<(u32, u32)>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for tool in Tool::ALL {
        let versions: Vec<Version> = installed
            .iter()
            .filter(|i| i.tool == tool)
            .filter_map(|i| Version::parse(&i.version))
            .collect();
        let chosen = match (tool, server) {
            (Tool::Kubectl, Some(server)) => versions
                .iter()
                .find(|v| (v.major, v.minor) == server)
                .or_else(|| versions.iter().find(|v| v.in_skew(server)))
                .or_else(|| versions.first()),
            _ => versions.first(),
        };
        if let Some(version) = chosen {
            dirs.push(version_dir(root, tool, *version));
        }
    }
    dirs
}

/// The client version `kubectl version --client -o json` printed.
pub fn kubectl_client_version(json: &str) -> Option<Version> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let git = value.pointer("/clientVersion/gitVersion")?.as_str()?;
    let core = git.split(['-', '+']).next()?;
    Version::parse(core)
}

#[cfg(test)]
mod tests;
