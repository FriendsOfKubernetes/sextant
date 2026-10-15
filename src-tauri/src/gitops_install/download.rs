//! Where the Flux and Argo CD manifests come from, and nothing else: the GitHub API's list of releases of
//! `fluxcd/flux2` / `argoproj/argo-cd`, Flux's release assets `install.yaml` and `flux_<ver>_checksums.txt`, and Argo
//! CD's `manifests/install.yaml` at a release tag on raw.githubusercontent.com. Only HTTPS, only these owners and
//! repositories, only tags `vX.Y.Z`; redirects only to GitHub's asset hosts; the rules of [`crate::download`]. Flux's
//! `install.yaml` must match the SHA-256 its release publishes; Argo CD publishes none for it, so its SHA-256 is only
//! shown.

use std::time::Duration;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sextant_core::gitops_install::GitopsTool;
use sextant_core::{CoreError, CoreResult, ErrorCode};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::download::{Connect, Fetch, is_asset_host, plain_https};

/// The Flux version offered when GitHub cannot be asked (the one the test cluster and the fixtures use).
pub const BUNDLED_FLUX: &str = "v2.9.6";
/// The Argo CD version offered when GitHub cannot be asked.
pub const BUNDLED_ARGOCD: &str = "v3.5.5";
/// The list of releases is refused when larger (30 releases with their notes are about 1.2 MB).
pub const MAX_RELEASES_BYTES: u64 = 2 * 1024 * 1024;
/// A manifest (or a checksums file) is refused when larger (Argo CD's is about 1.9 MB).
pub const MAX_MANIFEST_BYTES: u64 = 20 * 1024 * 1024;
/// Each download is cancelled after this long.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// How many releases are asked for.
const RELEASES_PER_PAGE: u32 = 30;
const GITHUB_JSON: &str = "application/vnd.github+json";

/// The versions offered for a tool, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitopsVersions {
    /// Stable releases (no pre-releases, no drafts, tags `vX.Y.Z`), newest first; only the bundled version when
    /// GitHub could not be asked.
    pub versions: Vec<String>,
    /// The version chosen by default: the newest.
    pub latest: String,
    /// Why the list is only the bundled version (no network, GitHub's rate limit).
    pub error: Option<String>,
}

/// A downloaded and checked manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub text: String,
    /// Where it was downloaded from.
    pub url: String,
    /// SHA-256 of the text, lowercase hex.
    pub sha256: String,
    /// The SHA-256 matched the checksums file of the release (Flux); false when the project publishes none (Argo CD).
    pub checksum_verified: bool,
}

/// The version offered when the list of releases cannot be read.
pub fn bundled_version(tool: GitopsTool) -> &'static str {
    match tool {
        GitopsTool::Flux => BUNDLED_FLUX,
        GitopsTool::ArgoCd => BUNDLED_ARGOCD,
    }
}

fn repository(tool: GitopsTool) -> (&'static str, &'static str) {
    match tool {
        GitopsTool::Flux => ("fluxcd", "flux2"),
        GitopsTool::ArgoCd => ("argoproj", "argo-cd"),
    }
}

/// `v1.2.3` and nothing else.
pub fn is_release_tag(tag: &str) -> bool {
    let Some(numbers) = tag.strip_prefix('v') else {
        return false;
    };
    let parts: Vec<&str> = numbers.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

fn checked_tag(tag: &str) -> CoreResult<&str> {
    if is_release_tag(tag) {
        Ok(tag)
    } else {
        Err(invalid(format!("{tag:?} is not a release tag like v1.2.3")))
    }
}

/// The GitHub API's list of the tool's releases.
pub fn releases_url(tool: GitopsTool) -> String {
    let (owner, repo) = repository(tool);
    format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page={RELEASES_PER_PAGE}")
}

/// The official `install.yaml` of the release `tag`.
pub fn manifest_url(tool: GitopsTool, tag: &str) -> CoreResult<String> {
    let tag = checked_tag(tag)?;
    Ok(match tool {
        GitopsTool::Flux => {
            format!("https://github.com/fluxcd/flux2/releases/download/{tag}/install.yaml")
        }
        GitopsTool::ArgoCd => format!(
            "https://raw.githubusercontent.com/argoproj/argo-cd/{tag}/manifests/install.yaml"
        ),
    })
}

/// Flux's `flux_<version>_checksums.txt` of the release `tag`.
pub fn checksums_url(tag: &str) -> CoreResult<String> {
    let tag = checked_tag(tag)?;
    let version = &tag[1..];
    Ok(format!(
        "https://github.com/fluxcd/flux2/releases/download/{tag}/flux_{version}_checksums.txt"
    ))
}

/// One of the URLs above, exactly (any tag `vX.Y.Z`), and nothing else.
pub fn is_allowed_source(url: &Url) -> bool {
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments: Vec<&str> = segments.collect();
    let host = url.host_str().unwrap_or_default();
    if !plain_https(url, host) || url.fragment().is_some() {
        return false;
    }
    match (host, segments.as_slice()) {
        ("api.github.com", ["repos", owner, repo, "releases"]) => {
            [GitopsTool::Flux, GitopsTool::ArgoCd]
                .into_iter()
                .any(|tool| repository(tool) == (*owner, *repo))
                && url.query() == Some(&format!("per_page={RELEASES_PER_PAGE}"))
        }
        ("github.com", ["fluxcd", "flux2", "releases", "download", tag, file]) => {
            url.query().is_none()
                && is_release_tag(tag)
                && (*file == "install.yaml" || *file == format!("flux_{}_checksums.txt", &tag[1..]))
        }
        (
            "raw.githubusercontent.com",
            ["argoproj", "argo-cd", tag, "manifests", "install.yaml"],
        ) => url.query().is_none() && is_release_tag(tag),
        _ => false,
    }
}

/// The stable releases in the GitHub API's answer, newest first: no pre-releases, no drafts, only tags `vX.Y.Z`.
pub fn stable_versions(body: &[u8]) -> CoreResult<Vec<String>> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
        #[serde(default)]
        prerelease: bool,
        #[serde(default)]
        draft: bool,
    }
    let releases: Vec<Release> = serde_json::from_slice(body)
        .map_err(|e| CoreError::other(format!("GitHub answered with something unexpected: {e}")))?;
    let number = |tag: &str| -> (u64, u64, u64) {
        let mut parts = tag[1..].split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        (
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
        )
    };
    let mut tags: Vec<String> = releases
        .into_iter()
        .filter(|r| !r.prerelease && !r.draft && is_release_tag(&r.tag_name))
        .map(|r| r.tag_name)
        .collect();
    tags.sort_by_key(|tag| std::cmp::Reverse(number(tag)));
    tags.dedup();
    Ok(tags)
}

/// Lowercase hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The checksum of `file` in a `sha256sum`-style text (`<hex>  <name>`, the name maybe after `*`).
fn checksum_of(checksums: &str, file: &str) -> Option<String> {
    checksums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let sum = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        (name == file && sum.len() == 64 && sum.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| sum.to_ascii_lowercase())
    })
}

/// Downloads what an install needs from GitHub.
#[derive(Clone)]
pub struct GitopsDownloader {
    connect: Option<Connect>,
    timeout: Duration,
    max_manifest: u64,
    max_releases: u64,
}

impl Default for GitopsDownloader {
    fn default() -> Self {
        Self::github()
    }
}

impl GitopsDownloader {
    /// The real one: GitHub over HTTPS, [`MAX_MANIFEST_BYTES`], [`MAX_RELEASES_BYTES`], [`DOWNLOAD_TIMEOUT`].
    pub fn github() -> Self {
        Self {
            connect: None,
            timeout: DOWNLOAD_TIMEOUT,
            max_manifest: MAX_MANIFEST_BYTES,
            max_releases: MAX_RELEASES_BYTES,
        }
    }

    /// Sends every request to `connect(url)` (a local fake server in tests) with other limits; the allowed sources
    /// are checked against the original URLs.
    pub fn redirected(
        connect: Connect,
        timeout: Duration,
        max_manifest: u64,
        max_releases: u64,
    ) -> Self {
        Self {
            connect: Some(connect),
            timeout,
            max_manifest,
            max_releases,
        }
    }

    async fn get(
        &self,
        url: &str,
        max_bytes: u64,
        accept: Option<&'static str>,
    ) -> CoreResult<Vec<u8>> {
        let parsed = Url::parse(url).map_err(|e| invalid(format!("Not a link: {e}")))?;
        if !is_allowed_source(&parsed) {
            return Err(invalid(format!(
                "{url} is not an official source of Flux or Argo CD"
            )));
        }
        Fetch {
            max_bytes,
            timeout: self.timeout,
            connect: self.connect.as_ref(),
            allowed_redirect: &is_asset_host,
            accept,
        }
        .get(parsed)
        .await
    }

    /// The stable releases of the tool, newest first; when GitHub cannot be asked (no network, its rate limit), the
    /// bundled version and the reason.
    pub async fn versions(&self, tool: GitopsTool) -> GitopsVersions {
        let listed = self
            .get(&releases_url(tool), self.max_releases, Some(GITHUB_JSON))
            .await
            .and_then(|body| stable_versions(&body))
            .and_then(|versions| {
                if versions.is_empty() {
                    Err(CoreError::other("GitHub listed no stable release"))
                } else {
                    Ok(versions)
                }
            });
        match listed {
            Ok(versions) => GitopsVersions {
                latest: versions[0].clone(),
                versions,
                error: None,
            },
            Err(err) => {
                let bundled = bundled_version(tool).to_owned();
                GitopsVersions {
                    versions: vec![bundled.clone()],
                    latest: bundled,
                    error: Some(err.message),
                }
            }
        }
    }

    /// Downloads the official `install.yaml` of the release `tag`; for Flux, also the release's checksums file, and
    /// refuses (`invalid`) a manifest whose SHA-256 is not the one listed there.
    pub async fn manifest(&self, tool: GitopsTool, tag: &str) -> CoreResult<Manifest> {
        let url = manifest_url(tool, tag)?;
        let bytes = self.get(&url, self.max_manifest, None).await?;
        let sha256 = sha256_hex(&bytes);
        let checksum_verified = match tool {
            GitopsTool::ArgoCd => false,
            GitopsTool::Flux => {
                let sums_url = checksums_url(tag)?;
                let sums = self.get(&sums_url, self.max_manifest, None).await?;
                let sums = String::from_utf8_lossy(&sums);
                let file = format!("flux_{}_checksums.txt", &tag[1..]);
                let Some(expected) = checksum_of(&sums, "install.yaml") else {
                    return Err(invalid(format!("{file} lists no install.yaml")));
                };
                if expected != sha256 {
                    return Err(invalid(format!(
                        "The SHA-256 of the downloaded install.yaml ({sha256}) is not the one in {file} ({expected}); nothing is installed"
                    )));
                }
                true
            }
        };
        let text = String::from_utf8(bytes)
            .map_err(|_| invalid("The downloaded install.yaml is not UTF-8 text"))?;
        Ok(Manifest {
            text,
            url,
            sha256,
            checksum_verified,
        })
    }
}

#[cfg(test)]
mod tests;
