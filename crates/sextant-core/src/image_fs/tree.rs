//! The merged file tree of an image (OCI image spec, "Applying changesets"): layers applied base first; in each,
//! opaque markers and whiteouts remove what lower layers had, then the layer's entries go in. Symbolic links are
//! resolved only inside this tree, never on a disk.
//!
//! Keys are path components joined by NUL (which no tar path holds), so a folder's entries are one ordered range and
//! siblings are found by seeking past each child's subtree.

use std::collections::BTreeMap;
use std::ops::Bound;

use super::layer::{LayerEntry, LayerIndex, normalize};
use super::{EntryKind, ImageDir, ImageEntry, ImageSearch, invalid, limits, refused};
use crate::{CoreError, CoreResult, ErrorCode};

const SEP: char = '\0';

#[derive(Debug, Clone, PartialEq, Eq)]
struct Node {
    kind: EntryKind,
    size: u64,
    mode: u32,
    uid: u64,
    gid: u64,
    user: Option<String>,
    group: Option<String>,
    mtime: u64,
    link: Option<String>,
    layer: u32,
}

impl Node {
    fn implicit_dir(layer: u32) -> Self {
        Self {
            kind: EntryKind::Directory,
            size: 0,
            mode: 0o755,
            uid: 0,
            gid: 0,
            user: None,
            group: None,
            mtime: 0,
            link: None,
            layer,
        }
    }

    fn from_entry(entry: &LayerEntry, layer: u32) -> Self {
        Self {
            kind: entry.kind,
            size: entry.size,
            mode: entry.mode,
            uid: entry.uid,
            gid: entry.gid,
            user: entry.user.clone(),
            group: entry.group.clone(),
            mtime: entry.mtime,
            link: entry.link.clone(),
            layer,
        }
    }
}

/// The files of an image after all its layers.
#[derive(Debug, Default)]
pub struct MergedTree {
    nodes: BTreeMap<String, Node>,
    key_bytes: u64,
}

fn key_of(path: &str) -> String {
    path.replace('/', "\0")
}

fn display(key: &str) -> String {
    format!("/{}", key.replace(SEP, "/"))
}

/// The key of a path the window names (`/usr/bin`); `""` is the root.
fn window_key(path: &str) -> CoreResult<String> {
    if path.trim_matches('/').is_empty() {
        return Ok(String::new());
    }
    normalize(path)
        .map(|p| key_of(&p))
        .ok_or_else(|| invalid("not a path in the image"))
}

fn child_prefix(key: &str) -> String {
    if key.is_empty() {
        String::new()
    } else {
        format!("{key}{SEP}")
    }
}

/// The keys of everything below `key` (not `key` itself); everything for the root.
fn subtree(key: &str) -> (Bound<String>, Bound<String>) {
    if key.is_empty() {
        return (Bound::Unbounded, Bound::Unbounded);
    }
    (
        Bound::Included(format!("{key}{SEP}")),
        Bound::Excluded(format!("{key}\u{1}")),
    )
}

impl MergedTree {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    fn remove_below(&mut self, key: &str) {
        let doomed: Vec<String> = self
            .nodes
            .range(subtree(key))
            .map(|(k, _)| k.clone())
            .collect();
        for k in doomed {
            self.key_bytes -= k.len() as u64;
            self.nodes.remove(&k);
        }
    }

    fn remove(&mut self, key: &str) {
        self.remove_below(key);
        if self.nodes.remove(key).is_some() {
            self.key_bytes -= key.len() as u64;
        }
    }

    fn insert(&mut self, key: String, node: Node) -> CoreResult<()> {
        if let Some(slot) = self.nodes.get_mut(&key) {
            *slot = node;
            return Ok(());
        }
        if self.nodes.len() >= limits::MAX_ENTRIES {
            return Err(refused(format!(
                "the image has more than {} files",
                limits::MAX_ENTRIES
            )));
        }
        self.key_bytes += key.len() as u64;
        if self.key_bytes > limits::MAX_TREE_BYTES {
            return Err(refused("the image's folders are too deep"));
        }
        self.nodes.insert(key, node);
        Ok(())
    }

    /// Applies layer number `layer` (0 = base).
    pub fn apply(&mut self, layer: u32, index: &LayerIndex) -> CoreResult<()> {
        for dir in &index.opaque {
            self.remove_below(&key_of(dir));
        }
        for path in &index.whiteouts {
            self.remove(&key_of(path));
        }
        for entry in &index.entries {
            let key = key_of(&entry.path);
            // Parents: missing ones are implied; a lower layer's non-folder there becomes a folder.
            let mut end = 0;
            while let Some(i) = key[end..].find(SEP) {
                let parent = &key[..end + i];
                match self.nodes.get(parent) {
                    Some(node) if node.kind == EntryKind::Directory => {}
                    _ => self.insert(parent.to_owned(), Node::implicit_dir(layer))?,
                }
                end += i + 1;
            }
            let node = Node::from_entry(entry, layer);
            if node.kind != EntryKind::Directory {
                self.remove_below(&key);
            }
            self.insert(key, node)?;
        }
        Ok(())
    }

    fn entry_of(&self, key: &str, node: &Node) -> ImageEntry {
        let name = key.rsplit(SEP).next().unwrap_or("").to_owned();
        let has_children =
            node.kind == EntryKind::Directory && self.nodes.range(subtree(key)).next().is_some();
        ImageEntry {
            name,
            path: display(key),
            kind: node.kind,
            size: node.size,
            mode: node.mode,
            uid: node.uid,
            gid: node.gid,
            user: node.user.clone(),
            group: node.group.clone(),
            mtime: node.mtime,
            link: node.link.as_ref().map(|l| {
                if node.kind == EntryKind::Hardlink {
                    format!("/{l}")
                } else {
                    l.clone()
                }
            }),
            layer: node.layer,
            has_children,
        }
    }

    fn node(&self, key: &str) -> CoreResult<&Node> {
        self.nodes
            .get(key)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "no such file in the image"))
    }

    /// One entry by path.
    pub fn entry(&self, path: &str) -> CoreResult<ImageEntry> {
        let key = window_key(path)?;
        if key.is_empty() {
            let root = Node::implicit_dir(0);
            let mut entry = self.entry_of("", &root);
            entry.has_children = !self.nodes.is_empty();
            return Ok(entry);
        }
        Ok(self.entry_of(&key, self.node(&key)?))
    }

    /// A folder's entries (folders first, then by name), at most [`limits::MAX_DIR_ENTRIES`].
    pub fn list(&self, path: &str) -> CoreResult<ImageDir> {
        let key = window_key(path)?;
        if !key.is_empty() && self.node(&key)?.kind != EntryKind::Directory {
            return Err(invalid("not a folder"));
        }
        let prefix = child_prefix(&key);
        let mut entries = Vec::new();
        let mut truncated = false;
        let mut cursor = Bound::Included(prefix.clone());
        while let Some((child_key, node)) = self
            .nodes
            .range((cursor.clone(), Bound::Unbounded))
            .next()
            .filter(|(k, _)| k.starts_with(&prefix))
        {
            let rest = &child_key[prefix.len()..];
            let name_len = rest.find(SEP).unwrap_or(rest.len());
            let own_key = &child_key[..prefix.len() + name_len];
            if entries.len() == limits::MAX_DIR_ENTRIES {
                truncated = true;
                break;
            }
            match self.nodes.get(own_key) {
                Some(own) => entries.push(self.entry_of(own_key, own)),
                None => entries.push(self.entry_of(own_key, node)),
            }
            cursor = Bound::Included(format!("{own_key}\u{1}"));
        }
        entries.sort_by(|a, b| {
            (b.kind == EntryKind::Directory)
                .cmp(&(a.kind == EntryKind::Directory))
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(ImageDir {
            path: display(&key),
            entries,
            truncated,
        })
    }

    /// Entries whose path contains `query` (case-insensitive), at most [`limits::MAX_SEARCH_RESULTS`].
    pub fn search(&self, query: &str) -> CoreResult<ImageSearch> {
        let query = query.trim();
        if query.is_empty() {
            return Err(invalid("the search is empty"));
        }
        if query.chars().count() > limits::MAX_SEARCH_CHARS {
            return Err(invalid("the search is too long"));
        }
        let needle = query.to_lowercase();
        let mut matches = Vec::new();
        let mut truncated = false;
        for (key, node) in &self.nodes {
            let path = display(key);
            if !path.to_lowercase().contains(&needle) {
                continue;
            }
            if matches.len() == limits::MAX_SEARCH_RESULTS {
                truncated = true;
                break;
            }
            matches.push(self.entry_of(key, node));
        }
        Ok(ImageSearch { matches, truncated })
    }

    /// Where a symbolic link leads inside the image (`..` stops at the root, at most [`limits::MAX_SYMLINK_HOPS`]
    /// links); `None` when it leads nowhere in the image or loops.
    pub fn resolve(&self, path: &str) -> CoreResult<Option<String>> {
        let start = window_key(path)?;
        let mut pending: Vec<String> = start
            .split(SEP)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .rev()
            .collect();
        let mut current: Vec<String> = Vec::new();
        let mut hops = 0;
        while let Some(part) = pending.pop() {
            match part.as_str() {
                "" | "." => continue,
                ".." => {
                    current.pop();
                    continue;
                }
                _ => {}
            }
            current.push(part);
            let key = current.join("\0");
            let Some(node) = self.nodes.get(&key) else {
                return Ok(None);
            };
            if node.kind == EntryKind::Symlink {
                hops += 1;
                if hops > limits::MAX_SYMLINK_HOPS {
                    return Ok(None);
                }
                let target = node.link.clone().unwrap_or_default();
                current.pop();
                if target.starts_with('/') {
                    current.clear();
                }
                pending.extend(
                    target
                        .split('/')
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .rev(),
                );
            }
        }
        if current.is_empty() {
            return Ok(Some("/".to_owned()));
        }
        Ok(Some(display(&current.join("\0"))))
    }

    /// The layer whose stream holds a file's data and the path of the entry there: the file itself, or for a hard
    /// link the path it names in the hard link's own layer. Folders, links and special files have no data.
    pub fn data_source(&self, path: &str) -> CoreResult<DataSource> {
        let key = window_key(path)?;
        let node = self.node(&key)?;
        match node.kind {
            EntryKind::File => Ok(DataSource {
                layer: node.layer,
                path: key.replace(SEP, "/"),
                size: node.size,
            }),
            EntryKind::Hardlink => {
                let target = node.link.clone().unwrap_or_default();
                let size = self
                    .nodes
                    .get(&key_of(&target))
                    .filter(|t| t.kind == EntryKind::File)
                    .map_or(0, |t| t.size);
                Ok(DataSource {
                    layer: node.layer,
                    path: target,
                    size,
                })
            }
            _ => Err(invalid("only files can be read")),
        }
    }
}

/// Where a file's data is: layer `layer`, entry `path` (normalised), `size` bytes (as the tree knows it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataSource {
    pub layer: u32,
    pub path: String,
    pub size: u64,
}
