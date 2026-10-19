//! Changes to kubeconfig files (#150): rename a context, set its default namespace, delete it (with its cluster and
//! user entries when no other context uses them), duplicate it with another namespace, and merge files into
//! Sextant's own `merged.yaml`.
//!
//! ```ignore
//! let preview = registry.preview_edit(&edit, &writable)?;          // what would change, nothing is written
//! let outcome = registry.apply_edit(&edit, &preview.base, &writable)?;  // the same change, written
//! ```
//!
//! Rules:
//! - Two steps. [`KubeconfigRegistry::preview_edit`] computes the new document and describes it (names and
//!   non-secret fields; every credential is [`HIDDEN`]); [`KubeconfigRegistry::apply_edit`] computes it again from the
//!   file as it is now and writes it only when that file is still the one previewed (`base`, a SHA-256 over what the
//!   change was computed from); otherwise `conflict`.
//! - Only writable files are changed: Sextant's own files (pasted, cloud, merged) always, any other source
//!   (`~/.kube/config`, `KUBECONFIG` files, added files) only when the user allowed it
//!   ([`KubeconfigSettings::writable_sources`], off by default) — checked here, not only in the window.
//! - Every write first copies the file to `<file>.bak-<UTC time>` (mode 0600 on Unix, never replacing a copy; only the
//!   newest [`MAX_BACKUPS`] of these copies are kept, files with other names are never touched), then
//!   writes a temporary file in the same directory (the original's permissions) and renames it over the file, so a
//!   crash never leaves half a kubeconfig. A symlinked kubeconfig stays a symlink: its target is replaced.
//! - The document is edited as generic YAML, so fields Sextant does not know are kept. Comments are not: the YAML
//!   library drops them, and the preview says so (`commentsLost`), as it says when the layout changes.
//! - Merged entries keep pointing at their files: relative paths are made absolute against the origin's directory.
//! - Deleting the current context leaves `current-context` unset (never another cluster). A rename also follows the
//!   `current-context` of another `KUBECONFIG` file when that file is writable; otherwise the preview names it.
//! - Nothing of a credential is ever returned, logged or put in an error (nor a password in a server or proxy URL).

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::{ClusterId, KubeconfigRegistry, KubeconfigSource, SourceKind};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::settings::AppSettings;

/// Sextant's own file kubeconfig files are merged into, in [`KubeconfigRegistry::own_dir`].
pub const MERGED_FILE: &str = "merged.yaml";
/// What a preview shows instead of a credential (or any value it does not show).
pub const HIDDEN: &str = "<hidden>";
/// A kubeconfig larger than this is not read for a change.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// At most this many files are merged at once.
pub const MAX_MERGE_FILES: usize = 32;
/// Sextant keeps at most this many of its own backups (`<file>.bak-<UTC time>`) of one kubeconfig; older ones are
/// deleted after a write.
pub const MAX_BACKUPS: usize = 5;

/// The kubeconfig part of the settings (#150). Written by the frontend. Read leniently: a value that does not read
/// (a days value that is not a number, an id that is not text, a part that is not an object) is replaced by its
/// default instead of failing the whole settings file, and the days are clamped to 1..=365.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct KubeconfigSettings {
    /// Sources (ids) that are not Sextant's own files and that the user allowed Sextant to edit ("Allow Sextant to
    /// edit" in Settings → Clusters). Empty by default: `~/.kube/config`, `KUBECONFIG` files and added files are
    /// never written until the user turns this on for them.
    pub writable_sources: Vec<String>,
    /// How many days before they expire credentials (a client certificate, a token) are shown as expiring; 14 by
    /// default; clamped to 1..=365 (by the frontend, and when the settings are read).
    pub credential_expiry_days: u32,
}

/// `KubeconfigSettings::credential_expiry_days` of a new install.
pub const DEFAULT_CREDENTIAL_EXPIRY_DAYS: u32 = 14;

/// The range `KubeconfigSettings::credential_expiry_days` is clamped to.
pub const CREDENTIAL_EXPIRY_DAYS_RANGE: std::ops::RangeInclusive<u32> = 1..=365;
/// Most writable sources kept.
const MAX_WRITABLE_SOURCES: usize = 1000;

impl Default for KubeconfigSettings {
    fn default() -> Self {
        Self {
            writable_sources: Vec::new(),
            credential_expiry_days: DEFAULT_CREDENTIAL_EXPIRY_DAYS,
        }
    }
}

impl<'de> Deserialize<'de> for KubeconfigSettings {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let mut out = Self::default();
        if let Some(list) = value
            .get("writableSources")
            .and_then(serde_json::Value::as_array)
        {
            for id in list.iter().filter_map(serde_json::Value::as_str) {
                if out.writable_sources.len() < MAX_WRITABLE_SOURCES
                    && !id.is_empty()
                    && !out.writable_sources.iter().any(|kept| kept == id)
                {
                    out.writable_sources.push(id.to_owned());
                }
            }
        }
        if let Some(days) = value
            .get("credentialExpiryDays")
            .and_then(serde_json::Value::as_f64)
            .filter(|d| d.is_finite())
        {
            let (min, max) = (
                *CREDENTIAL_EXPIRY_DAYS_RANGE.start(),
                *CREDENTIAL_EXPIRY_DAYS_RANGE.end(),
            );
            out.credential_expiry_days = days.round().clamp(f64::from(min), f64::from(max)) as u32;
        }
        Ok(out)
    }
}

/// One change to a kubeconfig file. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum KubeconfigEdit {
    /// Renames the context of a cluster (its id changes: the id is derived from the name).
    RenameContext {
        cluster_id: ClusterId,
        new_name: String,
    },
    /// Sets (or, with `None`, removes) the default namespace of a cluster's context.
    SetNamespace {
        cluster_id: ClusterId,
        namespace: Option<String>,
    },
    /// Deletes the context, and its cluster and user entries when no other context uses them.
    DeleteContext { cluster_id: ClusterId },
    /// A copy of the context under `new_name` with another default namespace, next to it in the same file.
    DuplicateContext {
        cluster_id: ClusterId,
        new_name: String,
        namespace: String,
    },
    /// Copies the contexts, clusters and users of these files into Sextant's own [`MERGED_FILE`]; a name that is
    /// taken by a different entry gets a suffix (`-2`, `-3`, …). The files themselves are not changed.
    Merge { paths: Vec<PathBuf> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum EntryKind {
    Context,
    Cluster,
    User,
    CurrentContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ChangeKind {
    Added,
    Removed,
    Renamed,
    Changed,
}

/// One field of an entry in a preview. A credential (any field of a user entry, a cluster's CA data) reads
/// [`HIDDEN`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FieldChange {
    pub field: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// One entry of the file that the change adds, removes, renames or changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EntryChange {
    pub entry: EntryKind,
    pub change: ChangeKind,
    /// The entry's name (for `currentContext`, empty).
    pub name: String,
    /// The new name: a rename, or a merged entry whose name was taken.
    pub new_name: Option<String>,
    /// The file a merged entry comes from; for a change written to another file of `KUBECONFIG` than the previewed
    /// one (its `current-context`), that file.
    pub origin: Option<PathBuf>,
    pub fields: Vec<FieldChange>,
}

/// The file a change is written to, as the user should see it before allowing or applying it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditTarget {
    /// The path after symlinks: the file that is really replaced (the path itself when it is no symlink or does not
    /// exist yet).
    pub real_path: PathBuf,
    /// How the copy of the file as it was is named (`<real path>.bak-YYYYMMDD-HHMMSS`); `None` when the file is
    /// created.
    pub backup_pattern: Option<PathBuf>,
    /// How many of these copies are kept ([`MAX_BACKUPS`]); older ones are deleted.
    pub backups_kept: u32,
}

impl EditTarget {
    /// The target of a change to `path` (which may not exist yet).
    pub fn of(path: &Path) -> Self {
        let real = std::fs::canonicalize(path).ok();
        let backup_pattern = real.as_ref().and_then(|real| {
            let name = real.file_name()?.to_string_lossy().into_owned();
            Some(real.with_file_name(format!("{name}.bak-YYYYMMDD-HHMMSS")))
        });
        Self {
            real_path: real.unwrap_or_else(|| path.to_path_buf()),
            backup_pattern,
            backups_kept: MAX_BACKUPS as u32,
        }
    }
}

/// A cluster whose id changes with its context's name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RenamedCluster {
    pub from: ClusterId,
    pub to: ClusterId,
}

/// What a change would do to which file. Nothing of a credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditPreview {
    /// The source written to; `None` when a merge creates Sextant's merged file.
    pub source_id: Option<String>,
    pub path: PathBuf,
    /// Where the change is really written (symlinks followed) and where the copy of the old file goes.
    pub target: EditTarget,
    /// The file does not exist yet (the first merge).
    pub creates_file: bool,
    /// One of Sextant's own files (no permission needed).
    pub own_file: bool,
    pub changes: Vec<EntryChange>,
    /// The file has comments, which the rewrite drops.
    pub comments_lost: bool,
    /// The file is written in another layout (quoting, indentation, order of nothing but the YAML style).
    pub layout_changes: bool,
    /// Nothing would change (`apply` refuses).
    pub unchanged: bool,
    /// Other files of `KUBECONFIG` whose `current-context` names the renamed context but that Sextant may not edit:
    /// they keep the old name, which then names no context.
    pub current_context_elsewhere: Vec<PathBuf>,
    /// What the change was computed from; `kubeconfig_edit_apply` takes it back and refuses when it differs.
    pub base: String,
    pub renamed: Vec<RenamedCluster>,
    pub removed: Vec<ClusterId>,
    pub added: Vec<ClusterId>,
    pub changed: Vec<ClusterId>,
}

/// What a written change did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditOutcome {
    pub source: KubeconfigSource,
    /// The copy of the file as it was (`None` when the file was created).
    pub backup_path: Option<PathBuf>,
    pub renamed: Vec<RenamedCluster>,
    pub removed: Vec<ClusterId>,
    pub added: Vec<ClusterId>,
    pub changed: Vec<ClusterId>,
}

/// A computed change, not written yet.
struct Plan {
    /// The path the source is listed under (ids are derived from it).
    path: PathBuf,
    /// The file as read (`None`: it does not exist).
    before: Option<Vec<u8>>,
    doc: Value,
    preview: EditPreview,
    /// Other files of `KUBECONFIG` that change too (their `current-context` named a renamed context): the path,
    /// the file as read, the new document.
    others: Vec<(PathBuf, Vec<u8>, Value)>,
}

/// Another file of `KUBECONFIG` whose `current-context` names the context being changed.
struct CurrentElsewhere {
    path: PathBuf,
    bytes: Vec<u8>,
    doc: Value,
    writable: bool,
}

impl KubeconfigRegistry {
    /// What `edit` would change. Fails when the file may not be edited (`denied`), cannot be read, or the change
    /// is not possible (a taken name, an invalid namespace: `invalid`).
    pub fn preview_edit(
        &self,
        edit: &KubeconfigEdit,
        writable: &[String],
    ) -> CoreResult<EditPreview> {
        Ok(self.plan(edit, writable)?.preview)
    }

    /// Writes `edit` if the file (and, for a merge, the merged files) are still what the preview with this `base`
    /// was computed from (`conflict` otherwise). Registers the merged file as a source on its first merge.
    pub fn apply_edit(
        &mut self,
        edit: &KubeconfigEdit,
        base: &str,
        writable: &[String],
    ) -> CoreResult<EditOutcome> {
        let plan = self.plan(edit, writable)?;
        if plan.preview.base != base {
            return Err(changed_since_preview());
        }
        if plan.preview.unchanged {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                "the change leaves the kubeconfig as it is",
            ));
        }
        let yaml = serde_yaml::to_string(&plan.doc)?;
        // The written text must still read as a kubeconfig (it always should: only names and namespaces change).
        kube::config::Kubeconfig::from_yaml(&yaml).map_err(super::kubeconfig_error)?;
        if plan.before.is_none()
            && let Some(dir) = plan.path.parent()
        {
            std::fs::create_dir_all(dir)?;
        }
        let mut written_others = Vec::new();
        for (path, before, doc) in &plan.others {
            // Checked before anything is written: a file changed since the preview stops the whole change.
            if std::fs::read(path).ok().as_deref() != Some(before.as_slice()) {
                return Err(changed_since_preview());
            }
            let text = serde_yaml::to_string(doc)?;
            kube::config::Kubeconfig::from_yaml(&text).map_err(super::kubeconfig_error)?;
            written_others.push((path, before, text));
        }
        let backup_path = replace_file(&plan.path, plan.before.as_deref(), yaml.as_bytes())?;
        for (path, before, text) in written_others {
            replace_file(path, Some(before), text.as_bytes())?;
        }
        let source = match plan.preview.source_id.as_deref() {
            Some(id) => self
                .all_sources()
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "no such kubeconfig source"))?,
            None => self.register_merged(plan.path.clone()),
        };
        let preview = plan.preview;
        Ok(EditOutcome {
            source,
            backup_path,
            renamed: preview.renamed,
            removed: preview.removed,
            added: preview.added,
            changed: preview.changed,
        })
    }

    /// Where a change to the source `source_id` would really be written, and where its backups go: shown before the
    /// user allows Sextant to edit it.
    pub fn edit_target(&self, source_id: &str) -> CoreResult<EditTarget> {
        let source = self
            .all_sources()
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "no such kubeconfig source"))?;
        Ok(EditTarget::of(&source.path))
    }

    fn ensure_writable(&self, source: &KubeconfigSource, writable: &[String]) -> CoreResult<()> {
        if self.is_own(source) || writable.contains(&source.id) {
            return Ok(());
        }
        Err(CoreError::new(
            ErrorCode::Denied,
            format!(
                "Sextant may not edit {}: allow it for this source in Settings → Clusters first",
                source.path.display()
            ),
        ))
    }

    fn plan(&self, edit: &KubeconfigEdit, writable: &[String]) -> CoreResult<Plan> {
        match edit {
            KubeconfigEdit::Merge { paths } => self.plan_merge(paths),
            KubeconfigEdit::RenameContext {
                cluster_id,
                new_name,
            } => self.plan_context(cluster_id, writable, |ctx| ctx.rename(new_name)),
            KubeconfigEdit::SetNamespace {
                cluster_id,
                namespace,
            } => self.plan_context(cluster_id, writable, |ctx| {
                ctx.set_namespace(namespace.as_deref())
            }),
            KubeconfigEdit::DeleteContext { cluster_id } => {
                self.plan_context(cluster_id, writable, ContextEdit::delete)
            }
            KubeconfigEdit::DuplicateContext {
                cluster_id,
                new_name,
                namespace,
            } => self.plan_context(cluster_id, writable, |ctx| {
                ctx.duplicate(new_name, namespace)
            }),
        }
    }

    fn plan_context(
        &self,
        id: &ClusterId,
        writable: &[String],
        change: impl FnOnce(&mut ContextEdit) -> CoreResult<()>,
    ) -> CoreResult<Plan> {
        let (source, context) = self.locate(id)?;
        self.ensure_writable(&source, writable)?;
        let bytes = read_capped(&source.path)?;
        let doc = parse_document(&bytes)?;
        // Names other files of `KUBECONFIG` hold: a context there may use this file's cluster or user, and a new
        // context name must not hide one of theirs.
        let mut other_refs = HashSet::new();
        let mut other_contexts = HashSet::new();
        let mut current_elsewhere = Vec::new();
        if source.kind == SourceKind::Env {
            for other in self
                .all_sources()
                .iter()
                .filter(|s| s.kind == SourceKind::Env && s.path != source.path)
            {
                let Ok(other_bytes) = read_capped(&other.path) else {
                    continue;
                };
                let Ok(other_doc) = parse_document(&other_bytes) else {
                    continue;
                };
                for ctx in seq(&other_doc, "contexts") {
                    if let Some(name) = name_of(ctx) {
                        other_contexts.insert(name.to_owned());
                    }
                    let (cluster, user) = refs_of(ctx);
                    other_refs.extend(cluster.map(|c| (EntryKind::Cluster, c)));
                    other_refs.extend(user.map(|u| (EntryKind::User, u)));
                }
                if current(&other_doc).as_deref() == Some(context.as_str()) {
                    current_elsewhere.push(CurrentElsewhere {
                        path: other.path.clone(),
                        writable: self.ensure_writable(other, writable).is_ok(),
                        bytes: other_bytes,
                        doc: other_doc,
                    });
                }
            }
        }
        let mut edit = ContextEdit {
            path: source.path.clone(),
            original: doc.clone(),
            doc,
            context,
            other_refs,
            other_contexts,
            preview: empty_preview(&source.path),
        };
        change(&mut edit)?;
        let mut preview = edit.preview;
        let mut base = Sha256::new();
        base.update(Sha256::digest(&bytes));
        // A renamed context that another file of the list makes current: that file follows the new name when Sextant
        // may edit it; otherwise the preview names it (kubectl would then point at a context that no longer exists).
        let new_name = preview.changes.iter().find_map(|c| {
            (c.entry == EntryKind::Context && c.change == ChangeKind::Renamed)
                .then(|| c.new_name.clone())
                .flatten()
        });
        let mut others = Vec::new();
        for other in current_elsewhere.into_iter().filter(|_| new_name.is_some()) {
            if !other.writable {
                preview.current_context_elsewhere.push(other.path);
                continue;
            }
            let mut doc = other.doc;
            let first = preview.changes.len();
            set_current(&mut doc, new_name.as_deref(), &mut preview);
            for change in &mut preview.changes[first..] {
                change.origin = Some(other.path.clone());
            }
            base.update(other.path.as_os_str().as_encoded_bytes());
            base.update([0]);
            base.update(Sha256::digest(&other.bytes));
            others.push((other.path, other.bytes, doc));
        }
        preview.source_id = Some(source.id.clone());
        preview.own_file = self.is_own(&source);
        preview.comments_lost = has_comments(&bytes);
        preview.layout_changes = layout_changes(&bytes, &edit.original);
        preview.unchanged = edit.doc == edit.original;
        preview.base = if others.is_empty() {
            hex(&Sha256::digest(&bytes))
        } else {
            hex(&base.finalize())
        };
        Ok(Plan {
            path: source.path,
            before: Some(bytes),
            doc: edit.doc,
            preview,
            others,
        })
    }

    fn plan_merge(&self, paths: &[PathBuf]) -> CoreResult<Plan> {
        if paths.is_empty() {
            return Err(CoreError::new(ErrorCode::Invalid, "choose files to merge"));
        }
        if paths.len() > MAX_MERGE_FILES {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!("at most {MAX_MERGE_FILES} files can be merged at once"),
            ));
        }
        let target = self.own_dir().join(MERGED_FILE);
        let before = if target.exists() {
            Some(read_capped(&target)?)
        } else {
            None
        };
        let original = match &before {
            Some(bytes) => parse_document(bytes)?,
            None => new_document(),
        };
        let mut base = Sha256::new();
        match &before {
            Some(bytes) => base.update(Sha256::digest(bytes)),
            None => base.update(b"absent"),
        }

        let real_target = std::fs::canonicalize(&target).ok();
        let mut inputs: Vec<(PathBuf, Value)> = Vec::new();
        for path in paths {
            let canonical = std::fs::canonicalize(path).map_err(|_| {
                CoreError::new(
                    ErrorCode::NotFound,
                    format!("cannot open {}", path.display()),
                )
            })?;
            if real_target.as_ref() == Some(&canonical) {
                return Err(CoreError::new(
                    ErrorCode::Invalid,
                    "the merged file cannot be merged into itself",
                ));
            }
            if inputs.iter().any(|(p, _)| *p == canonical) {
                continue;
            }
            let bytes = read_capped(&canonical)?;
            base.update(canonical.as_os_str().as_encoded_bytes());
            base.update([0]);
            base.update(Sha256::digest(&bytes));
            let mut doc = parse_document(&bytes).map_err(|e| {
                CoreError::new(e.code, format!("{}: {}", canonical.display(), e.message))
            })?;
            // Relative paths are relative to the origin's directory (as kubectl reads it: the path as given, not a
            // symlink's target), not to the merged file's.
            let origin = if path.is_absolute() { path } else { &canonical };
            if let Some(dir) = origin.parent() {
                absolutize_paths(&mut doc, dir);
            }
            inputs.push((canonical, doc));
        }

        let mut doc = original.clone();
        let mut preview = empty_preview(&target);
        let mut added_contexts: Vec<String> = Vec::new();
        for (path, input) in &inputs {
            let clusters = merge_entries(
                &mut doc,
                input,
                "clusters",
                EntryKind::Cluster,
                path,
                &mut preview,
            );
            let users = merge_entries(
                &mut doc,
                input,
                "users",
                EntryKind::User,
                path,
                &mut preview,
            );
            for ctx in seq(input, "contexts") {
                let Some(name) = name_of(ctx).map(str::to_owned) else {
                    continue;
                };
                let mut ctx = ctx.clone();
                if let Some(inner) = ctx.get_mut("context").and_then(Value::as_mapping_mut) {
                    for (key, renames) in [("cluster", &clusters), ("user", &users)] {
                        let target_name = inner
                            .get(key)
                            .and_then(Value::as_str)
                            .and_then(|n| renames.iter().find(|(from, _)| from == n))
                            .map(|(_, to)| to.clone());
                        if let Some(to) = target_name {
                            inner.insert(key.into(), Value::String(to));
                        }
                    }
                }
                let list = seq_mut(&mut doc, "contexts");
                if merged_copy(list, &ctx, &name).is_some() {
                    continue;
                }
                let final_name = free_name(&name, list);
                ctx.as_mapping_mut()
                    .expect("a named entry is a mapping")
                    .insert("name".into(), Value::String(final_name.clone()));
                preview.changes.push(EntryChange {
                    entry: EntryKind::Context,
                    change: ChangeKind::Added,
                    name: name.clone(),
                    new_name: (final_name != name).then(|| final_name.clone()),
                    origin: Some(path.clone()),
                    fields: context_fields(&ctx),
                });
                preview
                    .added
                    .push(ClusterId::for_context(&target, &final_name));
                list.push(ctx);
                added_contexts.push(final_name);
            }
        }
        let has_current = doc
            .get("current-context")
            .and_then(Value::as_str)
            .is_some_and(|c| !c.is_empty());
        if !has_current && let Some(first) = added_contexts.first() {
            set_current(&mut doc, Some(first), &mut preview);
        }

        let source = self.all_sources().into_iter().find(|s| s.path == target);
        preview.source_id = source.as_ref().map(|s| s.id.clone());
        preview.own_file = true;
        preview.creates_file = before.is_none();
        preview.comments_lost = before.as_deref().is_some_and(has_comments);
        preview.layout_changes = before
            .as_deref()
            .is_some_and(|bytes| layout_changes(bytes, &original));
        preview.unchanged = doc == original;
        preview.base = hex(&base.finalize());
        Ok(Plan {
            path: target,
            before,
            doc,
            preview,
            others: Vec::new(),
        })
    }
}

/// Moves what the settings keep under a cluster's id to its new id (a renamed context): its per-cluster settings,
/// the overview's choice, the muted clusters, the last open cluster, and the cluster of saved views, pins and
/// workspaces. The moved settings win: anything still kept under the new id belongs to a context that is gone (a new
/// name is always free in its file), so it is forgotten first — a renamed cluster never inherits, say, the agent
/// access of a deleted context that had its name.
pub fn move_cluster_settings(settings: &mut AppSettings, from: &ClusterId, to: &ClusterId) {
    if from == to {
        return;
    }
    forget_cluster_settings(settings, to);
    let (from, to) = (from.as_str(), to.as_str());
    if let Some(moved) = settings.clusters.remove(from) {
        settings.clusters.insert(to.to_owned(), moved);
    }
    let replace = |ids: &mut Vec<String>| {
        if ids.iter().any(|id| id == from) {
            let mut seen = HashSet::new();
            *ids = ids
                .iter()
                .map(|id| {
                    if id == from {
                        to.to_owned()
                    } else {
                        id.clone()
                    }
                })
                .filter(|id| seen.insert(id.clone()))
                .collect();
        }
    };
    replace(&mut settings.fleet.selected);
    replace(&mut settings.notifications.muted_clusters);
    if settings.window.last_cluster.as_deref() == Some(from) {
        settings.window.last_cluster = Some(to.to_owned());
    }
    for view in &mut settings.views {
        if view.cluster.as_deref() == Some(from) {
            view.cluster = Some(to.to_owned());
        }
    }
    for pin in &mut settings.pins {
        if pin.cluster == from {
            pin.cluster = to.to_owned();
        }
    }
    for workspace in &mut settings.workspaces {
        replace(&mut workspace.clusters);
    }
}

/// Forgets what the settings keep for a cluster whose context was deleted: its per-cluster settings (display name,
/// icon, agent access…), its place in the overview, the muted clusters and the last open cluster, its saved views
/// (and every pin of those views), its pins, and its place in workspaces. A context created later under the same
/// name then starts clean.
pub fn forget_cluster_settings(settings: &mut AppSettings, id: &ClusterId) {
    let id = id.as_str();
    settings.clusters.remove(id);
    settings.fleet.selected.retain(|c| c != id);
    settings.notifications.muted_clusters.retain(|c| c != id);
    if settings.window.last_cluster.as_deref() == Some(id) {
        settings.window.last_cluster = None;
    }
    let gone_views: HashSet<String> = settings
        .views
        .iter()
        .filter(|v| v.cluster.as_deref() == Some(id))
        .map(|v| v.id.clone())
        .collect();
    settings.views.retain(|v| !gone_views.contains(&v.id));
    settings.pins.retain(|p| {
        p.cluster != id
            && !matches!(&p.target, crate::settings::PinTarget::View { view } if gone_views.contains(view))
    });
    for workspace in &mut settings.workspaces {
        workspace.clusters.retain(|c| c != id);
    }
}

/// Forgets that the user allowed Sextant to edit a kubeconfig source that was removed: adding the file again asks
/// again.
pub fn forget_source_settings(settings: &mut AppSettings, source_id: &str) {
    settings
        .kubeconfig
        .writable_sources
        .retain(|id| id != source_id);
}

/// One context of one file being changed.
struct ContextEdit {
    path: PathBuf,
    original: Value,
    doc: Value,
    context: String,
    /// Cluster and user names that contexts of other `KUBECONFIG` files use.
    other_refs: HashSet<(EntryKind, String)>,
    /// Context names of other `KUBECONFIG` files.
    other_contexts: HashSet<String>,
    preview: EditPreview,
}

impl ContextEdit {
    fn index(&self) -> CoreResult<usize> {
        seq(&self.doc, "contexts")
            .iter()
            .position(|c| name_of(c) == Some(self.context.as_str()))
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    "the context is no longer in the kubeconfig; refresh the list",
                )
            })
    }

    fn ensure_free(&self, name: &str) -> CoreResult<()> {
        validate_context_name(name)?;
        let taken = seq(&self.doc, "contexts")
            .iter()
            .any(|c| name_of(c) == Some(name))
            || self.other_contexts.contains(name);
        if taken {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!("a context named {name:?} already exists"),
            ));
        }
        Ok(())
    }

    fn rename(&mut self, new_name: &str) -> CoreResult<()> {
        let index = self.index()?;
        let new_name = new_name.trim();
        if new_name == self.context {
            return Ok(());
        }
        self.ensure_free(new_name)?;
        seq_mut(&mut self.doc, "contexts")[index]
            .as_mapping_mut()
            .expect("a named entry is a mapping")
            .insert("name".into(), Value::String(new_name.to_owned()));
        self.preview.changes.push(EntryChange {
            entry: EntryKind::Context,
            change: ChangeKind::Renamed,
            name: self.context.clone(),
            new_name: Some(new_name.to_owned()),
            origin: None,
            fields: Vec::new(),
        });
        if current(&self.doc).as_deref() == Some(self.context.as_str()) {
            set_current(&mut self.doc, Some(new_name), &mut self.preview);
        }
        self.preview.renamed.push(RenamedCluster {
            from: ClusterId::for_context(&self.path, &self.context),
            to: ClusterId::for_context(&self.path, new_name),
        });
        Ok(())
    }

    fn set_namespace(&mut self, namespace: Option<&str>) -> CoreResult<()> {
        let index = self.index()?;
        let namespace = namespace.map(str::trim).filter(|n| !n.is_empty());
        if let Some(ns) = namespace {
            validate_namespace(ns)?;
        }
        let ctx = &mut seq_mut(&mut self.doc, "contexts")[index];
        let before = inner_str(ctx, "namespace");
        if before.as_deref() == namespace {
            return Ok(());
        }
        let inner = inner_mut(ctx);
        match namespace {
            Some(ns) => {
                inner.insert("namespace".into(), Value::String(ns.to_owned()));
            }
            None => {
                inner.remove("namespace");
            }
        }
        self.preview.changes.push(EntryChange {
            entry: EntryKind::Context,
            change: ChangeKind::Changed,
            name: self.context.clone(),
            new_name: None,
            origin: None,
            fields: vec![FieldChange {
                field: "namespace".to_owned(),
                before,
                after: namespace.map(str::to_owned),
            }],
        });
        self.preview
            .changed
            .push(ClusterId::for_context(&self.path, &self.context));
        Ok(())
    }

    fn duplicate(&mut self, new_name: &str, namespace: &str) -> CoreResult<()> {
        let index = self.index()?;
        let new_name = new_name.trim();
        let namespace = namespace.trim();
        self.ensure_free(new_name)?;
        validate_namespace(namespace)?;
        let mut copy = seq(&self.doc, "contexts")[index].clone();
        copy.as_mapping_mut()
            .expect("a named entry is a mapping")
            .insert("name".into(), Value::String(new_name.to_owned()));
        inner_mut(&mut copy).insert("namespace".into(), Value::String(namespace.to_owned()));
        self.preview.changes.push(EntryChange {
            entry: EntryKind::Context,
            change: ChangeKind::Added,
            name: new_name.to_owned(),
            new_name: None,
            origin: None,
            fields: context_fields(&copy),
        });
        self.preview
            .added
            .push(ClusterId::for_context(&self.path, new_name));
        seq_mut(&mut self.doc, "contexts").insert(index + 1, copy);
        Ok(())
    }

    fn delete(&mut self) -> CoreResult<()> {
        let index = self.index()?;
        let removed = seq_mut(&mut self.doc, "contexts").remove(index);
        let (cluster, user) = refs_of(&removed);
        self.preview.changes.push(EntryChange {
            entry: EntryKind::Context,
            change: ChangeKind::Removed,
            name: self.context.clone(),
            new_name: None,
            origin: None,
            fields: context_fields(&removed),
        });
        self.preview
            .removed
            .push(ClusterId::for_context(&self.path, &self.context));

        let mut used = self.other_refs.clone();
        for ctx in seq(&self.doc, "contexts") {
            let (c, u) = refs_of(ctx);
            used.extend(c.map(|c| (EntryKind::Cluster, c)));
            used.extend(u.map(|u| (EntryKind::User, u)));
        }
        for (entry, key, name) in [
            (EntryKind::Cluster, "clusters", cluster),
            (EntryKind::User, "users", user),
        ] {
            let Some(name) = name else { continue };
            if used.contains(&(entry, name.clone())) {
                continue;
            }
            let list = seq_mut(&mut self.doc, key);
            let before = list.len();
            list.retain(|e| name_of(e) != Some(name.as_str()));
            if list.len() != before {
                self.preview.changes.push(EntryChange {
                    entry,
                    change: ChangeKind::Removed,
                    name,
                    new_name: None,
                    origin: None,
                    fields: Vec::new(),
                });
            }
        }
        // The current context is left unset rather than switched to another one: kubectl then works with no cluster
        // until the user picks one, instead of silently on an unrelated cluster.
        if current(&self.doc).as_deref() == Some(self.context.as_str()) {
            set_current(&mut self.doc, None, &mut self.preview);
        }
        Ok(())
    }
}

/// Adds the `key` entries (`clusters`, `users`) of `input` to `doc`: an equal entry under the same name is already
/// there; a different one under a taken name gets a free name. Returns the renames (`from`, `to`) for the contexts.
fn merge_entries(
    doc: &mut Value,
    input: &Value,
    key: &str,
    entry: EntryKind,
    origin: &Path,
    preview: &mut EditPreview,
) -> Vec<(String, String)> {
    let mut renames = Vec::new();
    for item in seq(input, key) {
        let Some(name) = name_of(item).map(str::to_owned) else {
            continue;
        };
        let list = seq_mut(doc, key);
        if let Some(existing) = merged_copy(list, item, &name) {
            if existing != name {
                renames.push((name.clone(), existing));
            }
            continue;
        }
        let final_name = free_name(&name, list);
        let mut item = item.clone();
        item.as_mapping_mut()
            .expect("a named entry is a mapping")
            .insert("name".into(), Value::String(final_name.clone()));
        let fields = match entry {
            EntryKind::Cluster => cluster_fields(&item),
            _ => user_fields(&item),
        };
        list.push(item);
        if final_name != name {
            renames.push((name.clone(), final_name.clone()));
        }
        preview.changes.push(EntryChange {
            entry,
            change: ChangeKind::Added,
            name: name.clone(),
            new_name: (final_name != name).then_some(final_name),
            origin: Some(origin.to_path_buf()),
            fields,
        });
    }
    renames
}

/// Rewrites the relative file paths of a kubeconfig document against `dir` (the directory of the file it was read
/// from), as kubectl resolves them: a cluster's `certificate-authority`, a user's `client-certificate`, `client-key`
/// and `tokenFile`, and an exec plugin's `command` when it holds a path separator (a bare name is looked up in
/// `PATH`). A copy into another file then still points at the same files.
pub(crate) fn absolutize_paths(doc: &mut Value, dir: &Path) {
    let absolute = |value: &mut Value, only_paths: bool| {
        let Some(text) = value.as_str() else { return };
        let is_path = text.contains('/') || text.contains(std::path::MAIN_SEPARATOR);
        if text.is_empty() || (only_paths && !is_path) || Path::new(text).is_absolute() {
            return;
        }
        if let Some(full) = dir.join(text).to_str() {
            *value = Value::String(full.to_owned());
        }
    };
    if let Some(items) = doc.get_mut("clusters").and_then(Value::as_sequence_mut) {
        for cluster in items
            .iter_mut()
            .filter_map(|e| e.get_mut("cluster").and_then(Value::as_mapping_mut))
        {
            if let Some(value) = cluster.get_mut("certificate-authority") {
                absolute(value, false);
            }
        }
    }
    if let Some(items) = doc.get_mut("users").and_then(Value::as_sequence_mut) {
        for user in items
            .iter_mut()
            .filter_map(|e| e.get_mut("user").and_then(Value::as_mapping_mut))
        {
            for key in ["client-certificate", "client-key", "tokenFile"] {
                if let Some(value) = user.get_mut(key) {
                    absolute(value, false);
                }
            }
            if let Some(command) = user
                .get_mut("exec")
                .and_then(Value::as_mapping_mut)
                .and_then(|exec| exec.get_mut("command"))
            {
                absolute(command, true);
            }
        }
    }
}

/// The name of the entry of `list` that is `item` merged before: equal but for its name, which is `name` or a
/// suffixed `name-<n>` ([`free_name`]). So merging the same files again adds nothing.
fn merged_copy(list: &[Value], item: &Value, name: &str) -> Option<String> {
    let without_name = |entry: &Value| {
        let mut map = entry.as_mapping()?.clone();
        map.remove("name");
        Some(map)
    };
    let wanted = without_name(item)?;
    let is_suffixed = |existing: &str| {
        existing == name
            || existing
                .strip_prefix(name)
                .and_then(|rest| rest.strip_prefix('-'))
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    };
    let mut candidates = list.iter().filter_map(|existing| {
        let existing_name = name_of(existing)?;
        (is_suffixed(existing_name) && without_name(existing).as_ref() == Some(&wanted))
            .then(|| existing_name.to_owned())
    });
    let first = candidates.next()?;
    if first == name {
        return Some(first);
    }
    Some(candidates.find(|n| n == name).unwrap_or(first))
}

/// `name`, or `name-2`, `name-3`, … — the first no entry of `list` has.
fn free_name(name: &str, list: &[Value]) -> String {
    let taken = |n: &str| list.iter().any(|e| name_of(e) == Some(n));
    if !taken(name) {
        return name.to_owned();
    }
    (2..)
        .map(|i| format!("{name}-{i}"))
        .find(|n| !taken(n))
        .expect("an unbounded range has a free name")
}

fn empty_preview(path: &Path) -> EditPreview {
    EditPreview {
        source_id: None,
        path: path.to_path_buf(),
        target: EditTarget::of(path),
        creates_file: false,
        own_file: false,
        changes: Vec::new(),
        comments_lost: false,
        layout_changes: false,
        unchanged: true,
        current_context_elsewhere: Vec::new(),
        base: String::new(),
        renamed: Vec::new(),
        removed: Vec::new(),
        added: Vec::new(),
        changed: Vec::new(),
    }
}

fn changed_since_preview() -> CoreError {
    CoreError::new(
        ErrorCode::Conflict,
        "the kubeconfig changed since the preview; look at the change again",
    )
}

fn new_document() -> Value {
    let mut map = Mapping::new();
    map.insert("apiVersion".into(), "v1".into());
    map.insert("kind".into(), "Config".into());
    map.insert("clusters".into(), Value::Sequence(Vec::new()));
    map.insert("users".into(), Value::Sequence(Vec::new()));
    map.insert("contexts".into(), Value::Sequence(Vec::new()));
    Value::Mapping(map)
}

/// Reads a kubeconfig of at most [`MAX_FILE_BYTES`]; the error names the file, never its content.
fn read_capped(path: &Path) -> CoreResult<Vec<u8>> {
    let meta = std::fs::metadata(path).map_err(|e| {
        CoreError::new(
            if e.kind() == std::io::ErrorKind::NotFound {
                ErrorCode::NotFound
            } else {
                ErrorCode::Kubeconfig
            },
            format!("cannot read {}", path.display()),
        )
    })?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err(CoreError::new(
            ErrorCode::Kubeconfig,
            format!(
                "{} is not a kubeconfig file Sextant can edit",
                path.display()
            ),
        ));
    }
    std::fs::read(path).map_err(|_| {
        CoreError::new(
            ErrorCode::Kubeconfig,
            format!("cannot read {}", path.display()),
        )
    })
}

/// The document as generic YAML (unknown fields kept); a mapping, or an empty file as an empty config. A parse error
/// gives the position only, never the line (it may hold a token).
fn parse_document(bytes: &[u8]) -> CoreResult<Value> {
    let value: Value = serde_yaml::from_slice(bytes).map_err(|e| {
        CoreError::new(
            ErrorCode::Kubeconfig,
            match e.location() {
                Some(loc) => format!(
                    "the kubeconfig is not valid YAML (line {}, column {})",
                    loc.line(),
                    loc.column()
                ),
                None => "the kubeconfig is not valid YAML".to_owned(),
            },
        )
    })?;
    match value {
        Value::Mapping(_) => Ok(value),
        Value::Null => Ok(new_document()),
        _ => Err(CoreError::new(
            ErrorCode::Kubeconfig,
            "the kubeconfig is not a YAML mapping",
        )),
    }
}

fn seq<'a>(doc: &'a Value, key: &str) -> &'a [Value] {
    doc.get(key)
        .and_then(Value::as_sequence)
        .map_or(&[], Vec::as_slice)
}

/// The list under `key`, created when it is missing or `null`. Entries that are not named mappings stay as they are.
fn seq_mut<'a>(doc: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    let map = doc.as_mapping_mut().expect("the document is a mapping");
    let slot = map
        .entry(key.into())
        .or_insert_with(|| Value::Sequence(Vec::new()));
    if !slot.is_sequence() {
        *slot = Value::Sequence(Vec::new());
    }
    slot.as_sequence_mut().expect("just made a sequence")
}

fn name_of(entry: &Value) -> Option<&str> {
    entry.get("name").and_then(Value::as_str)
}

fn inner_str(ctx: &Value, key: &str) -> Option<String> {
    ctx.get("context")
        .and_then(|c| c.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn inner_mut(ctx: &mut Value) -> &mut Mapping {
    let map = ctx.as_mapping_mut().expect("a named entry is a mapping");
    let slot = map
        .entry("context".into())
        .or_insert_with(|| Value::Mapping(Mapping::new()));
    if !slot.is_mapping() {
        *slot = Value::Mapping(Mapping::new());
    }
    slot.as_mapping_mut().expect("just made a mapping")
}

fn refs_of(ctx: &Value) -> (Option<String>, Option<String>) {
    (inner_str(ctx, "cluster"), inner_str(ctx, "user"))
}

fn current(doc: &Value) -> Option<String> {
    doc.get("current-context")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn set_current(doc: &mut Value, to: Option<&str>, preview: &mut EditPreview) {
    let before = current(doc).filter(|c| !c.is_empty());
    let map = doc.as_mapping_mut().expect("the document is a mapping");
    match to {
        Some(name) => {
            map.insert("current-context".into(), Value::String(name.to_owned()));
        }
        None => {
            map.remove("current-context");
        }
    }
    preview.changes.push(EntryChange {
        entry: EntryKind::CurrentContext,
        change: ChangeKind::Changed,
        name: String::new(),
        new_name: None,
        origin: None,
        fields: vec![FieldChange {
            field: "current-context".to_owned(),
            before,
            after: to.map(str::to_owned),
        }],
    });
}

/// A context's fields as a preview shows them: its cluster, user and namespace (names only).
fn context_fields(ctx: &Value) -> Vec<FieldChange> {
    ["cluster", "user", "namespace"]
        .into_iter()
        .filter_map(|key| {
            inner_str(ctx, key).map(|value| FieldChange {
                field: key.to_owned(),
                before: None,
                after: Some(value),
            })
        })
        .collect()
}

/// A cluster entry's fields: where it points shown, its CA data and anything else [`HIDDEN`].
fn cluster_fields(entry: &Value) -> Vec<FieldChange> {
    const SHOWN: [&str; 5] = [
        "server",
        "proxy-url",
        "tls-server-name",
        "insecure-skip-tls-verify",
        "certificate-authority",
    ];
    fields_of(entry.get("cluster"), |key| SHOWN.contains(&key))
}

/// A user entry's fields: names only, every value [`HIDDEN`].
fn user_fields(entry: &Value) -> Vec<FieldChange> {
    fields_of(entry.get("user"), |_| false)
}

fn fields_of(inner: Option<&Value>, shown: impl Fn(&str) -> bool) -> Vec<FieldChange> {
    let Some(map) = inner.and_then(Value::as_mapping) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(key, value)| {
            let key = key.as_str()?;
            let text = match value {
                Value::String(s) if shown(key) && (key == "server" || key == "proxy-url") => {
                    without_userinfo(s)
                }
                Value::String(s) if shown(key) => s.clone(),
                Value::Bool(b) if shown(key) => b.to_string(),
                _ => HIDDEN.to_owned(),
            };
            Some(FieldChange {
                field: key.to_owned(),
                before: None,
                after: Some(text),
            })
        })
        .collect()
}

/// A URL without the user name and password it may carry (`http://user:pass@proxy:3128` → `http://proxy:3128`).
fn without_userinfo(url: &str) -> String {
    let (scheme, rest) = match url.find("://") {
        Some(i) => url.split_at(i + 3),
        None => ("", url),
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{scheme}{}", &rest[at + 1..]),
        None => url.to_owned(),
    }
}

/// A context name kubectl can use: not empty, at most 253 characters, no control characters.
fn validate_context_name(name: &str) -> CoreResult<()> {
    if name.is_empty() || name.chars().count() > 253 || name.chars().any(char::is_control) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a context name must be 1 to 253 characters without control characters",
        ));
    }
    Ok(())
}

/// A namespace name (an RFC 1123 label).
fn validate_namespace(ns: &str) -> CoreResult<()> {
    let ok = !ns.is_empty()
        && ns.len() <= 63
        && ns
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !ns.starts_with('-')
        && !ns.ends_with('-');
    if !ok {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "{ns:?} is not a namespace name (lowercase letters, digits and '-', at most 63)"
            ),
        ));
    }
    Ok(())
}

/// Whether the text has YAML comments: a `#` at the start of a line or after whitespace, outside quotes. Errs on
/// the side of "yes" (a `#` inside a block scalar counts).
pub(crate) fn has_comments(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    text.lines().any(|line| {
        let mut quote: Option<char> = None;
        let mut previous = ' ';
        for c in line.chars() {
            match quote {
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None if c == '\'' || c == '"' => quote = Some(c),
                None if c == '#' && previous.is_whitespace() => return true,
                None => {}
            }
            previous = c;
        }
        false
    })
}

/// Whether writing the document back as it is would change the text (quoting, indentation, flow style).
fn layout_changes(bytes: &[u8], doc: &Value) -> bool {
    serde_yaml::to_string(doc).map_or(true, |text| text.as_bytes() != bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Replaces the file at `path` (its target, when it is a symlink) with `content`: when it exists (`before`), it is
/// checked to still be `before`, copied to `<name>.bak-<UTC time>` (mode 0600) and its permissions are kept; a new
/// file gets 0600. Returns the copy's path.
fn replace_file(path: &Path, before: Option<&[u8]>, content: &[u8]) -> CoreResult<Option<PathBuf>> {
    let real = match before {
        Some(_) => std::fs::canonicalize(path)?,
        None => path.to_path_buf(),
    };
    let dir = real
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| CoreError::other("the kubeconfig has no directory"))?;
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_owned());
    let still_same = |expected: &[u8]| std::fs::read(&real).is_ok_and(|now| now == expected);

    let backup = match before {
        Some(expected) => {
            if !still_same(expected) {
                return Err(changed_since_preview());
            }
            Some(write_backup(dir, &name, expected)?)
        }
        None => {
            if real.exists() {
                return Err(changed_since_preview());
            }
            None
        }
    };

    let mut tmp = tempfile::Builder::new()
        .prefix(&format!(".{name}.sextant-"))
        .tempfile_in(dir)?;
    match before.and_then(|_| std::fs::metadata(&real).ok()) {
        Some(meta) => std::fs::set_permissions(tmp.path(), meta.permissions())?,
        None => super::restrict_permissions(tmp.path())?,
    }
    tmp.write_all(content)?;
    tmp.as_file().sync_all()?;
    // The last look before the rename: a change made meanwhile is not overwritten.
    let unchanged = match before {
        Some(expected) => still_same(expected),
        None => !real.exists(),
    };
    if !unchanged {
        if let Some(copy) = &backup {
            let _ = std::fs::remove_file(copy);
        }
        return Err(changed_since_preview());
    }
    tmp.persist(&real).map_err(|e| CoreError::from(e.error))?;
    if let Some(copy) = &backup {
        prune_backups(dir, &name, copy);
    }
    Ok(backup)
}

/// The order of one of Sextant's backups of the file `name` (its time stamp, then its `-<n>` suffix); `None` for any
/// other file name, so nothing else in the directory is ever touched.
fn backup_order(name: &str, file: &str) -> Option<(String, u32)> {
    let rest = file.strip_prefix(name)?.strip_prefix(".bak-")?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (stamp, attempt) = match rest.get(15..) {
        Some("") => (rest, 1),
        Some(suffix) => {
            let n = suffix.strip_prefix('-').filter(|n| digits(n))?;
            (&rest[..15], n.parse().ok()?)
        }
        None => return None,
    };
    let (date, time) = stamp.split_once('-')?;
    (date.len() == 8 && time.len() == 6 && digits(date) && digits(time))
        .then(|| (stamp.to_owned(), attempt))
}

/// Deletes Sextant's oldest backups of `name` in `dir` beyond [`MAX_BACKUPS`], never `keep` (the one just written)
/// and never a file whose name is not exactly one of Sextant's backup names. Best effort: a failure keeps the copy.
fn prune_backups(dir: &Path, name: &str, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut found: Vec<((String, u32), PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let order = backup_order(name, e.file_name().to_str()?)?;
            Some((order, e.path()))
        })
        .collect();
    if found.len() <= MAX_BACKUPS {
        return;
    }
    found.sort();
    let excess = found.len() - MAX_BACKUPS;
    for (_, path) in found.into_iter().take(excess) {
        if path != keep {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Writes `bytes` to a new `<name>.bak-<YYYYMMDD-HHMMSS>` (UTC; `-2`, `-3`, … when taken) in `dir`, mode 0600.
fn write_backup(dir: &Path, name: &str, bytes: &[u8]) -> CoreResult<PathBuf> {
    let stamp = k8s_openapi::jiff::Timestamp::now()
        .strftime("%Y%m%d-%H%M%S")
        .to_string();
    for attempt in 1..1000 {
        let candidate = if attempt == 1 {
            dir.join(format!("{name}.bak-{stamp}"))
        } else {
            dir.join(format!("{name}.bak-{stamp}-{attempt}"))
        };
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.sync_all()?;
                return Ok(candidate);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Err(CoreError::other(
        "too many kubeconfig backups with the same time",
    ))
}

#[cfg(test)]
mod tests;
