//! Kubeconfig folders as a source (#329, ADR-0148): every kubeconfig file in a folder the user added, and in its
//! subfolders one level down, is a source of its own ([`SourceKind::FolderFile`], ids by path like an added file),
//! read again whenever the sources are. The folder itself is the source the settings keep ([`SourceKind::Folder`]);
//! its files are found by [`scan`] each time and never stored.
//!
//! Which files count: regular files (or links to one inside the folder) whose name is not hidden, not an editor's or a
//! backup's (`~`, `.swp`, `.bak`, `.bak-…`, `.orig`, `.tmp`, `.part`), with no extension or one of [`EXTENSIONS`], at
//! most [`MAX_FILE_BYTES`] large; at most [`MAX_FILES`] of them, by path. A file that does not parse is listed with
//! its error and hides nothing else.

use std::path::{Path, PathBuf};

use super::{KubeconfigSource, SourceKind, source};

/// Files of one folder read at most; the rest are left out and the folder says so.
pub const MAX_FILES: usize = 500;
/// Larger files are left out (a kubeconfig is a few kilobytes).
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// The extensions a kubeconfig file may have (besides none).
pub const EXTENSIONS: [&str; 6] = ["yaml", "yml", "conf", "config", "kubeconfig", "json"];

/// Where a file of a folder source is: its folder source's id, and the subfolder it is in (`None`: the folder itself).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FolderPlace {
    pub source_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subfolder: Option<String>,
}

/// What [`scan`] found in a folder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scan {
    /// Each file's path and subfolder, sorted by path.
    pub files: Vec<(PathBuf, Option<String>)>,
    /// More than [`MAX_FILES`] files counted: the first ones by path are read.
    pub truncated: bool,
}

/// The kubeconfig files of `root` and of its subfolders one level down. A folder that cannot be read gives nothing.
pub fn scan(root: &Path) -> Scan {
    let Ok(canonical_root) = std::fs::canonicalize(root) else {
        return Scan::default();
    };
    let mut files: Vec<(PathBuf, Option<String>)> = Vec::new();
    collect(&canonical_root, root, None, &mut files);
    if let Ok(entries) = std::fs::read_dir(root) {
        let mut subfolders: Vec<(PathBuf, String)> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_str()?.to_owned();
                let kind = entry.file_type().ok()?;
                // A subfolder that is a link is not followed: it could lead anywhere.
                (kind.is_dir() && !is_hidden(&name)).then(|| (entry.path(), name))
            })
            .collect();
        subfolders.sort();
        for (path, name) in subfolders {
            collect(&canonical_root, &path, Some(&name), &mut files);
        }
    }
    files.sort();
    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    Scan { files, truncated }
}

/// The kubeconfig files directly in `dir`.
fn collect(
    root: &Path,
    dir: &Path,
    subfolder: Option<&str>,
    out: &mut Vec<(PathBuf, Option<String>)>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_kubeconfig_name(&name) {
            continue;
        }
        let path = entry.path();
        // A link counts only when it leads to a file inside the folder.
        let Ok(target) = std::fs::canonicalize(&path) else {
            continue;
        };
        if !target.starts_with(root) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&target) else {
            continue;
        };
        if meta.is_file() && meta.len() <= MAX_FILE_BYTES {
            out.push((path, subfolder.map(str::to_owned)));
        }
    }
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// A name a kubeconfig file may have: not hidden, not an editor's or backup's, no extension or a known one.
pub fn is_kubeconfig_name(name: &str) -> bool {
    if is_hidden(name) || name.ends_with('~') || name.contains(".bak-") {
        return false;
    }
    match name.rsplit_once('.') {
        None => true,
        Some((_, ext)) => {
            let ext = ext.to_ascii_lowercase();
            EXTENSIONS.contains(&ext.as_str())
        }
    }
}

/// The file sources of the folder source `folder`, as [`scan`] finds them now.
pub(crate) fn file_sources(folder: &KubeconfigSource) -> (Vec<KubeconfigSource>, bool) {
    let Scan { files, truncated } = scan(&folder.path);
    let sources = files
        .into_iter()
        .map(|(path, subfolder)| KubeconfigSource {
            folder: Some(FolderPlace {
                source_id: folder.id.clone(),
                subfolder,
            }),
            ..source(path, SourceKind::FolderFile)
        })
        .collect();
    (sources, truncated)
}

/// A cluster whose file moved within one folder (`from` is gone, `to` is new, the same file name and context in the
/// same folder source): its settings follow it ([`super::edit::move_cluster_settings`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Moved {
    pub from: super::ClusterId,
    pub to: super::ClusterId,
}

/// The clusters of folder sources that moved between `before` and `after` (two listings of the clusters): a context
/// gone from one file and come in a file of the same name in another subfolder of the same folder, when exactly one
/// such pair exists for that name and context.
pub fn moved_clusters(before: &[super::ClusterInfo], after: &[super::ClusterInfo]) -> Vec<Moved> {
    use std::collections::HashMap;
    // (folder source, file name, context) of a cluster that is in a folder.
    let key = |c: &super::ClusterInfo| -> Option<(String, String, String)> {
        let place = c.folder.as_ref()?;
        let name = c.file_name.clone()?;
        Some((place.source_id.clone(), name, c.context.clone()))
    };
    let ids_after: std::collections::HashSet<&super::ClusterId> =
        after.iter().map(|c| &c.id).collect();
    let ids_before: std::collections::HashSet<&super::ClusterId> =
        before.iter().map(|c| &c.id).collect();
    let mut gone: HashMap<(String, String, String), Vec<&super::ClusterId>> = HashMap::new();
    for c in before.iter().filter(|c| !ids_after.contains(&c.id)) {
        if let Some(k) = key(c) {
            gone.entry(k).or_default().push(&c.id);
        }
    }
    let mut came: HashMap<(String, String, String), Vec<&super::ClusterId>> = HashMap::new();
    for c in after.iter().filter(|c| !ids_before.contains(&c.id)) {
        if let Some(k) = key(c) {
            came.entry(k).or_default().push(&c.id);
        }
    }
    let mut out: Vec<Moved> = gone
        .into_iter()
        .filter_map(|(k, from)| {
            let to = came.get(&k)?;
            (from.len() == 1 && to.len() == 1).then(|| Moved {
                from: from[0].clone(),
                to: to[0].clone(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.from.cmp(&b.from));
    out
}
