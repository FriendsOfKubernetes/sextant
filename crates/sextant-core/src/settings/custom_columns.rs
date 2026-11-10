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
use serde_json::Value;
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
    /// `[field="value",…]`: the first item of a list — or value of a map, in key order (#392) — whose every `field` is
    /// the string `value` (ADR-0161); up to [`MAX_MATCH_PAIRS`] pairs. A last part `<field` picks the matching entry
    /// with the smallest value there instead, `*` every matching entry as a list (#399).
    Match {
        pairs: Vec<(String, String)>,
        pick: MatchPick,
    },
}

/// Which of the entries a `[field="value",…]` step matches it takes (#399).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchPick {
    /// The first, in list or key order.
    First,
    /// `<field`: the one with the smallest value of `field` (numbers as numbers, else text; one without it last).
    Earliest(String),
    /// `*`: every one, as a list; only in a path's last step.
    All,
}

/// Pairs one `[field="value",…]` step takes at most.
pub const MAX_MATCH_PAIRS: usize = 12;

impl PathStep {
    /// The items of a list, or the values of a map (in key order), whose fields are all `pairs`.
    pub fn matching<'a>(pairs: &[(String, String)], value: &'a Value) -> Vec<&'a Value> {
        let fits = |item: &&Value| pair_fits(pairs, item);
        match value {
            Value::Array(items) => items.iter().filter(fits).collect(),
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                keys.into_iter().map(|k| &map[k]).filter(fits).collect()
            }
            _ => Vec::new(),
        }
    }

    /// The item of a list, or the value of a map (in key order), whose fields are all `pairs`.
    pub fn pick<'a>(pairs: &[(String, String)], value: &'a Value) -> Option<&'a Value> {
        Self::matching(pairs, value).into_iter().next()
    }

    /// The matching entry with the smallest value of `field` (#399): numbers as numbers, strings as text (RFC 3339
    /// times sort so); an entry without it comes last; the first of equals.
    pub fn earliest<'a>(
        pairs: &[(String, String)],
        field: &str,
        value: &'a Value,
    ) -> Option<&'a Value> {
        let rank = |v: &Value| -> (u8, f64, String) {
            match field.split('.').try_fold(v, |at, part| at.get(part)) {
                Some(Value::Number(n)) => (0, n.as_f64().unwrap_or(f64::MAX), String::new()),
                Some(Value::String(s)) => (1, 0.0, s.clone()),
                _ => (2, 0.0, String::new()),
            }
        };
        let mut best: Option<(&Value, (u8, f64, String))> = None;
        for entry in Self::matching(pairs, value) {
            let r = rank(entry);
            let better = best.as_ref().is_none_or(|(_, b)| {
                r.0 < b.0 || (r.0 == b.0 && (r.1 < b.1 || (r.1 == b.1 && r.2 < b.2)))
            });
            if better {
                best = Some((entry, r));
            }
        }
        best.map(|(entry, _)| entry)
    }

    /// [`PathStep::pick`] for a value to change.
    pub fn pick_mut<'a>(pairs: &[(String, String)], value: &'a mut Value) -> Option<&'a mut Value> {
        let fits = |item: &Value| pair_fits(pairs, item);
        match value {
            Value::Array(items) => items.iter_mut().find(|item| fits(item)),
            Value::Object(map) => {
                let mut keys: Vec<String> = map.keys().cloned().collect();
                keys.sort();
                let key = keys.into_iter().find(|k| fits(&map[k]))?;
                map.get_mut(&key)
            }
            _ => None,
        }
    }
}

/// Whether an entry has every pair (#404): a field may name a nested one (`connector.state`) and end in `!` for "not
/// this value" (`type!="Ready"`, also when the entry lacks it); a value is compared as text, so `"true"` and `"3"`
/// match a boolean and a number too. `[*]`'s no pairs take every entry, a scalar included.
fn pair_fits(pairs: &[(String, String)], item: &Value) -> bool {
    pairs.iter().all(|(field, want)| {
        let (field, negated) = match field.strip_suffix('!') {
            Some(f) => (f, true),
            None => (field.as_str(), false),
        };
        if !item.is_object() {
            return false;
        }
        // Through a list on the way, any of its items will do (#404): `tasks.state` of a connector with a failed task.
        fn reaches(at: &Value, parts: &[&str], want: &str) -> bool {
            match (at, parts.split_first()) {
                (Value::Array(items), _) => items.iter().any(|item| reaches(item, parts, want)),
                (_, Some((first, rest))) => {
                    at.get(*first).is_some_and(|next| reaches(next, rest, want))
                }
                (Value::String(s), None) => s == want,
                (Value::Bool(b), None) => b.to_string() == want,
                (Value::Number(n), None) => n.to_string() == want,
                _ => false,
            }
        }
        let parts: Vec<&str> = field.split('.').collect();
        reaches(item, &parts, want) != negated
    })
}

/// A match field: names joined by single dots, optionally ending in `!` (#404).
fn is_match_field(field: &str) -> bool {
    let names = field.strip_suffix('!').unwrap_or(field);
    !names.is_empty()
        && names
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(is_name_char))
}

/// The field `[<field]` ranks by (#404): a name, or names joined by `.` (`timestamp.seconds`).
fn is_earliest_field(field: &str) -> bool {
    field
        .split('.')
        .all(|part| !part.is_empty() && part.chars().all(is_name_char))
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Parses a field path of the grammar of ADR-0099: `["."] name ("." name | "[" digits "]" | "[\"" key "\"]" |
/// "[" name "=\"" value "\"]")*`, where a name is `[A-Za-z0-9_-]+` and a quoted key or value has no `"`, `\` or
/// control character (the last step picks a list item by a field, ADR-0161). `None` for anything else.
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
            } else if chars.get(i + 1) == Some(&'*') && chars.get(i + 2) == Some(&']') {
                // `[*]`: every item of a list, or value of a map in key order, as a list (#404).
                steps.push(PathStep::Match {
                    pairs: Vec::new(),
                    pick: MatchPick::All,
                });
                i += 3;
            } else if chars.get(i + 1) == Some(&'<') {
                // `[<field]`: the item with the smallest value there (#404).
                let end = (i + 2..chars.len()).find(|&j| chars[j] == ']')?;
                let field: String = chars[i + 2..end].iter().collect();
                if !is_earliest_field(&field) {
                    return None;
                }
                steps.push(PathStep::Match {
                    pairs: Vec::new(),
                    pick: MatchPick::Earliest(field),
                });
                i = end + 1;
            } else if (i + 1..chars.len())
                .take_while(|&j| chars[j] != ']')
                .any(|j| chars[j] == '=')
            {
                // `[field="value",…]`: pairs separated by `,`; a value may hold `]` or `,`, so each ends at its quote.
                let mut pairs = Vec::new();
                let mut pick = MatchPick::First;
                let mut at = i + 1;
                loop {
                    let eq = (at..chars.len()).find(|&j| chars[j] == '=')?;
                    let field: String = chars[at..eq].iter().collect();
                    if !is_match_field(&field) || chars.get(eq + 1) != Some(&'"') {
                        return None;
                    }
                    let close = (eq + 2..chars.len()).find(|&j| chars[j] == '"')?;
                    let value: String = chars[eq + 2..close].iter().collect();
                    if value.chars().any(|c| c == '\\' || c.is_control()) {
                        return None;
                    }
                    pairs.push((field, value));
                    if pairs.len() > MAX_MATCH_PAIRS {
                        return None;
                    }
                    match chars.get(close + 1) {
                        Some(']') => {
                            at = close + 2;
                            break;
                        }
                        Some(',') => at = close + 2,
                        _ => return None,
                    }
                    // A last part: `<field` (the earliest by it) or `*` (every match), then `]` (#399).
                    if chars.get(at) == Some(&'*') {
                        if chars.get(at + 1) != Some(&']') {
                            return None;
                        }
                        pick = MatchPick::All;
                        at += 2;
                        break;
                    }
                    if chars.get(at) == Some(&'<') {
                        let end = (at + 1..chars.len()).find(|&j| chars[j] == ']')?;
                        let field: String = chars[at + 1..end].iter().collect();
                        if !is_earliest_field(&field) {
                            return None;
                        }
                        pick = MatchPick::Earliest(field);
                        at = end + 1;
                        break;
                    }
                }
                steps.push(PathStep::Match { pairs, pick });
                i = at;
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
    // `*` gives a list; the steps after it read each item (#404). One list per path.
    let lists = steps
        .iter()
        .filter(|s| {
            matches!(
                s,
                PathStep::Match {
                    pick: MatchPick::All,
                    ..
                }
            )
        })
        .count();
    // Two lists at most (#404): the second's items of every first's item, one flat list (delegations' namespaces).
    (!steps.is_empty() && lists <= 2).then_some(steps)
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
        // One value per cell: a path that gives a list (`*`, #404) is an extension's, not a custom column's.
        ColumnSource::Field => parse_field_path(path).is_some_and(|steps| {
            !is_secret_data_path(group, kind, &steps)
                && !steps.iter().any(|s| {
                    matches!(
                        s,
                        PathStep::Match {
                            pick: MatchPick::All,
                            ..
                        }
                    )
                })
        }),
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
