//! Custom table columns (#214, ADR-0099): the user's own columns of a kind's table, read from a label, an annotation
//! or a simple field path of the objects the table already watches. A frontend-written list in `settings.json`.
//!
//! The list is read entry by entry like the saved views ([`super::views`]): an entry that does not read or breaks a
//! rule is left out instead of failing the whole file, and a value that is not a list reads as empty. The rules are
//! the frontend's (`src/features/custom-columns/path.ts`): a label or annotation key in Kubernetes syntax, a field
//! path in the small grammar of ADR-0099 (`.spec.nodeName`, `.spec.containers[0].image`, `.metadata.labels["a.b/c"]`;
//! no wildcards, filters or functions), a header of at most [`MAX_TITLE_CHARS`], never a path into `data` or
//! `stringData` of a core Secret, no repeated column of one kind and scope, at most [`MAX_COLUMNS_PER_KIND`] per kind
//! and scope and [`MAX_CUSTOM_COLUMNS`] in all.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// Most custom columns kept in all.
pub const MAX_CUSTOM_COLUMNS: usize = 1000;
/// Most custom columns of one kind in one scope (one cluster, or all clusters).
pub const MAX_COLUMNS_PER_KIND: usize = 20;
/// Longest label or annotation key (a 253-character prefix, `/`, a 63-character name).
pub const MAX_KEY_CHARS: usize = 317;
/// Longest field path, in characters.
pub const MAX_FIELD_PATH_CHARS: usize = 256;
/// Longest header, in characters.
pub const MAX_TITLE_CHARS: usize = 64;

/// Where a custom column reads its value from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ColumnSource {
    /// `metadata.labels[path]`.
    #[default]
    Label,
    /// `metadata.annotations[path]`.
    Annotation,
    /// A field path of the object (`.status.phase`).
    Field,
}

/// What a column shows: its source, the key or path, and its header. Saved views carry these (#149).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct CustomColumnSpec {
    pub source: ColumnSource,
    /// The label or annotation key, or the field path in its canonical form.
    pub path: String,
    /// The header; empty = the key or path.
    pub title: String,
}

/// A custom column of one kind's table, for one cluster or for every cluster.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct CustomColumn {
    /// The cluster (`ClusterId`) whose table shows it; `None` = every cluster's.
    pub cluster: Option<String>,
    /// API group of the kind (`""` for the core group).
    pub group: String,
    pub kind: String,
    pub source: ColumnSource,
    pub path: String,
    pub title: String,
}

/// Whether `key` is a label or annotation key: an optional DNS subdomain prefix and `/`, then a name of at most 63
/// characters (`[A-Za-z0-9]`, inside also `-_.`).
pub fn is_metadata_key(key: &str) -> bool {
    if key.chars().count() > MAX_KEY_CHARS {
        return false;
    }
    let (prefix, name) = match key.split_once('/') {
        Some((prefix, name)) => (Some(prefix), name),
        None => (None, key),
    };
    let name_ok = !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.as_bytes()[name.len() - 1].is_ascii_alphanumeric();
    let prefix_ok = prefix.is_none_or(|p| {
        !p.is_empty()
            && p.len() <= 253
            && p.split('.').all(|part| {
                !part.is_empty()
                    && part.len() <= 63
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    && !part.starts_with('-')
                    && !part.ends_with('-')
            })
    });
    name_ok && prefix_ok
}

/// One step of a field path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathStep {
    Key(String),
    Index(usize),
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Parses a field path of the grammar of ADR-0099: `["."] name ("." name | "[" digits "]" | "[\"" key "\"]")*`, where
/// a name is `[A-Za-z0-9_-]+` and a quoted key has no `"`, `\` or control character. `None` for anything else.
pub fn parse_field_path(path: &str) -> Option<Vec<PathStep>> {
    if path.is_empty() || path.chars().count() > MAX_FIELD_PATH_CHARS {
        return None;
    }
    let chars: Vec<char> = path.chars().collect();
    let mut i = usize::from(chars[0] == '.' && chars.get(1) != Some(&'['));
    let mut steps = Vec::new();
    let mut expect_name = true;
    while i < chars.len() {
        if chars[i] == '[' {
            if chars.get(i + 1) == Some(&'"') {
                let end = (i + 2..chars.len()).find(|&j| chars[j] == '"')?;
                if chars.get(end + 1) != Some(&']') || end == i + 2 {
                    return None;
                }
                let key: String = chars[i + 2..end].iter().collect();
                if key.chars().any(|c| c == '\\' || c.is_control()) {
                    return None;
                }
                steps.push(PathStep::Key(key));
                i = end + 2;
            } else {
                let end = (i + 1..chars.len()).find(|&j| chars[j] == ']')?;
                let digits: String = chars[i + 1..end].iter().collect();
                if digits.is_empty()
                    || digits.len() > 6
                    || !digits.bytes().all(|b| b.is_ascii_digit())
                {
                    return None;
                }
                steps.push(PathStep::Index(digits.parse().ok()?));
                i = end + 1;
            }
            expect_name = false;
            continue;
        }
        if !expect_name {
            if chars[i] != '.' {
                return None;
            }
            i += 1;
        }
        let start = i;
        while i < chars.len() && is_name_char(chars[i]) {
            i += 1;
        }
        if i == start {
            return None;
        }
        steps.push(PathStep::Key(chars[start..i].iter().collect()));
        expect_name = false;
    }
    (!steps.is_empty()).then_some(steps)
}

/// Whether a field path reads a core Secret's values (`data`, `stringData` or anything inside them).
pub fn is_secret_data_path(group: &str, kind: &str, steps: &[PathStep]) -> bool {
    group.is_empty()
        && kind == "Secret"
        && matches!(steps.first(), Some(PathStep::Key(k)) if k == "data" || k == "stringData")
}

/// Whether a column with this source and path is allowed on `group/kind`.
pub fn is_valid_spec(
    group: &str,
    kind: &str,
    source: ColumnSource,
    path: &str,
    title: &str,
) -> bool {
    let path_ok = match source {
        ColumnSource::Label | ColumnSource::Annotation => is_metadata_key(path),
        ColumnSource::Field => {
            parse_field_path(path).is_some_and(|steps| !is_secret_data_path(group, kind, &steps))
        }
    };
    path_ok && title.chars().count() <= MAX_TITLE_CHARS && !title.chars().any(char::is_control)
}

impl CustomColumn {
    fn is_valid(&self) -> bool {
        !self.kind.is_empty()
            && self.kind.len() <= 253
            && self.group.len() <= 253
            && self
                .cluster
                .as_deref()
                .is_none_or(|c| !c.is_empty() && c.len() <= 512)
            && is_valid_spec(
                &self.group,
                &self.kind,
                self.source,
                &self.path,
                &self.title,
            )
    }

    fn same_column(&self, other: &Self) -> bool {
        self.cluster == other.cluster
            && self.group == other.group
            && self.kind == other.kind
            && self.source == other.source
            && self.path == other.path
    }

    fn same_table(&self, other: &Self) -> bool {
        self.cluster == other.cluster && self.group == other.group && self.kind == other.kind
    }
}

/// `#[serde(with)]` module of `AppSettings::custom_columns`: written as it is, read entry by entry.
pub(crate) mod custom_columns_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &[CustomColumn],
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Vec<CustomColumn>, D::Error> {
        let serde_json::Value::Array(entries) = serde_json::Value::deserialize(d)? else {
            return Ok(Vec::new());
        };
        let mut list: Vec<CustomColumn> = Vec::new();
        for entry in entries {
            if list.len() >= MAX_CUSTOM_COLUMNS {
                break;
            }
            let Ok(column) = serde_json::from_value::<CustomColumn>(entry) else {
                continue;
            };
            let full =
                list.iter().filter(|kept| kept.same_table(&column)).count() >= MAX_COLUMNS_PER_KIND;
            if column.is_valid() && !full && !list.iter().any(|kept| kept.same_column(&column)) {
                list.push(column);
            }
        }
        Ok(list)
    }
}

/// `#[serde(with)]` module of `SavedView::custom_columns`: written as it is, read entry by entry, at most
/// [`MAX_COLUMNS_PER_KIND`]. The view's kind is not known here: a view with a column into a Secret's values is left out
/// as a whole by `SavedView::is_valid`.
pub(crate) mod view_columns_field {
    use super::*;

    pub(crate) fn serialize<S: serde::Serializer>(
        value: &[CustomColumnSpec],
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Vec<CustomColumnSpec>, D::Error> {
        let serde_json::Value::Array(entries) = serde_json::Value::deserialize(d)? else {
            return Ok(Vec::new());
        };
        let mut list: Vec<CustomColumnSpec> = Vec::new();
        for entry in entries {
            if list.len() >= MAX_COLUMNS_PER_KIND {
                break;
            }
            let Ok(spec) = serde_json::from_value::<CustomColumnSpec>(entry) else {
                continue;
            };
            let valid = is_valid_spec("", "", spec.source, &spec.path, &spec.title);
            if valid
                && !list
                    .iter()
                    .any(|k| k.source == spec.source && k.path == spec.path)
            {
                list.push(spec);
            }
        }
        Ok(list)
    }
}

#[cfg(test)]
mod tests;
