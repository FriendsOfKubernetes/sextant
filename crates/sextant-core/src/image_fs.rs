//! Browsing the files of a container image from its registry (#216, ADR-0103): no `exec`, no pull on a node, no local
//! `docker`. This module has no network: it parses image references, `WWW-Authenticate` challenges, Docker configs
//! and pull secrets, manifests; it indexes layer streams (`std::io::Read`) within [`limits`], merges the layers into one
//! tree per the OCI layer spec ([`tree`]), finds one file's data in a layer stream, and caches layer indexes on disk
//! ([`cache`]). The HTTP client (registry, token realm, blob redirects) is in the app (`src-tauri/src/image_files/`).
//!
//! Credentials ([`auth::Credential`]) never leave the backend: their `Debug` prints `<hidden>`, they are not
//! serialized, and no error names them.

pub mod auth;
pub mod cache;
#[cfg(feature = "desktop")]
pub mod helper;
pub mod layer;
pub mod limits;
pub mod manifest;
pub mod pull_secrets;
pub mod reference;
pub mod save;
pub mod tree;

#[doc(hidden)]
pub mod fixtures;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{CoreError, ErrorCode};

/// Which credentials opened an image, as the window may know it (never the credentials themselves).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ImageCredentials {
    Anonymous,
    /// An `imagePullSecrets` entry of the pod or of its ServiceAccount.
    PullSecret {
        name: String,
    },
    /// The user's Docker config (`auths` or a credential helper), allowed in the settings.
    DockerConfig,
}

/// What an entry of an image is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ImageEntryKind")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Hardlink,
    /// A device, a FIFO or another special file: shown, never read.
    Other,
}

/// One file of an image as the window sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageEntry {
    /// The last path component.
    pub name: String,
    /// The full path, starting with `/`.
    pub path: String,
    pub kind: EntryKind,
    #[ts(type = "number")]
    pub size: u64,
    /// Permission bits and the setuid/setgid/sticky bits (`0o7777`).
    pub mode: u32,
    #[ts(type = "number")]
    pub uid: u64,
    #[ts(type = "number")]
    pub gid: u64,
    pub user: Option<String>,
    pub group: Option<String>,
    /// Seconds since the epoch.
    #[ts(type = "number")]
    pub mtime: u64,
    /// A symbolic link's target as written, or the path a hard link names.
    pub link: Option<String>,
    /// Index of the layer that provides it (0 = the base layer).
    pub layer: u32,
    /// A folder has entries (shown with an expander).
    pub has_children: bool,
}

/// A folder's entries, folders first, then by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageDir {
    pub path: String,
    pub entries: Vec<ImageEntry>,
    /// More than [`limits::MAX_DIR_ENTRIES`] entries: the rest are not listed.
    pub truncated: bool,
}

/// Paths that contain the searched text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageSearch {
    pub matches: Vec<ImageEntry>,
    /// More than [`limits::MAX_SEARCH_RESULTS`] matched.
    pub truncated: bool,
}

/// A file's text for the viewer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageFileText {
    pub path: String,
    #[ts(type = "number")]
    pub size: u64,
    /// `None` when the file is binary.
    pub text: Option<String>,
    pub binary: bool,
    /// Only the first [`limits::MAX_TEXT_BYTES`] are shown.
    pub truncated: bool,
}

pub(crate) fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// An image that breaks a rule or a limit (a hostile or broken image); never echoes its content.
pub(crate) fn refused(message: impl Into<String>) -> CoreError {
    CoreError::new(
        ErrorCode::Invalid,
        format!("the image was refused: {}", message.into()),
    )
}

/// The viewer's text of a file of `size` bytes whose first bytes are `bytes` (at most [`limits::MAX_TEXT_BYTES`]):
/// binary when the first [`limits::BINARY_SNIFF_BYTES`] hold a NUL or the bytes are not UTF-8 (a character cut by the
/// size limit at the very end is dropped, not counted as binary).
pub fn file_text(path: &str, size: u64, bytes: &[u8]) -> ImageFileText {
    let truncated = (bytes.len() as u64) < size;
    let sniff = &bytes[..bytes.len().min(limits::BINARY_SNIFF_BYTES)];
    let text = if sniff.contains(&0) {
        None
    } else {
        match std::str::from_utf8(bytes) {
            Ok(text) => Some(text.to_owned()),
            Err(e) if truncated && e.error_len().is_none() => {
                Some(String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned())
            }
            Err(_) => None,
        }
    };
    ImageFileText {
        path: path.to_owned(),
        size,
        binary: text.is_none(),
        text,
        truncated,
    }
}
