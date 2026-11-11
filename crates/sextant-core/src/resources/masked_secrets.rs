//! Masked copies of inline secret material for an extension the user let have them (ADR-0169, ADR-0123): instead of
//! the empty text [`super::inline_secrets::hide_inline_secrets`] leaves, a k3s/RKE2 node's arguments with every secret
//! value hidden, and a HelmChart's (a HelmChartConfig's) values with every value under a secret-looking key hidden, by
//! the rules the window and the former built-in k3s view masked them with:
//!
//! - `<program>.io/node-args` (k3s `pkg/nodeconfig/nodeconfig.go`): a JSON array of strings; the value of each of k3s's
//!   own secret flags (`isSecret`), of every flag whose name looks secret, of every `*-arg` flag whose `name=value` names
//!   a secret-looking setting, and k3s's own mask become `********`; every other value is cleaned of URI credentials.
//!   The window's rules are `src/resources/nodeArgs.ts` (`secretFlag`, `K3S_OMITTED`) and `src/resources/secretNames.ts`
//!   (`looksSecret`); the extension gets the arguments back as such an array, `--flag=value` written together, so it
//!   reads the same pairs.
//! - `spec.valuesContent` (helm-controller `HelmChartSpec.ValuesContent`): YAML that must read as one mapping; every
//!   value under a secret-looking key becomes `<hidden>`, every other text is cleaned; written back as JSON text (YAML
//!   reads it). The rules are the extension's `src/mask.ts` (`maskValues`), ported from the built-in view.
//! - `spec.set` (`HelmChartSpec.Set`): each value under a key any part of which looks secret becomes `<hidden>`, every
//!   other is cleaned text (`maskedSet`).
//!
//! The shared cases `src/resources/masking-cases.json` keep Rust, the window and the extension in step. Anything that
//! does not read — not a string, not JSON, not one YAML mapping, too long, a YAML tag or a key that is no text — is
//! blanked as before, never passed on. The object still carries `sextant.dev/values-hidden` naming every path that held
//! something (so a copy is never saved over the real one), and `sextant.dev/values-masked` names those given masked.
//! Node environments (`node-env`) and every other inline secret stay blanked. Only an extension's object reads use it
//! (`resources.get|getMany|list|watch` and what a change answers), for the kinds it was granted
//! (`permissions.maskedSecrets`); agents and the timeline never.

use serde_json::{Map, Value};

use super::inline_secrets::hide_inline_secrets;
use super::{WatchObject, WatchUpdate};
use crate::access::KindPattern;
use crate::alerts::clean_text;

/// The annotation naming the paths an object carries masked rather than blanked.
pub const VALUES_MASKED_ANNOTATION: &str = "sextant.dev/values-masked";

/// What is shown instead of a value under a secret-looking key (`HIDDEN` in `src/resources/secretNames.ts`).
pub const HIDDEN: &str = "<hidden>";
/// k3s's own mask (`OmittedValue` in pkg/nodeconfig/nodeconfig.go).
pub const K3S_OMITTED: &str = "********";
/// The flags whose value k3s itself masks (`isSecret` in pkg/nodeconfig/nodeconfig.go).
pub const K3S_SECRET_FLAGS: &[&str] = &[
    "--token",
    "-t",
    "--agent-token",
    "--datastore-endpoint",
    "--etcd-s3-access-key",
    "--etcd-s3-secret-key",
    "--vpn-auth",
];
/// A node-args annotation longer than this is not read (`MAX_ARGS_TEXT`).
pub const MAX_ARGS_TEXT: usize = 64 * 1024;
/// At most this many arguments are given (`MAX_ARGS`).
pub const MAX_ARGS: usize = 300;
/// A values text longer than this is not parsed (`MAX_VALUES_TEXT`).
pub const MAX_VALUES_TEXT: usize = 256 * 1024;

/// How one path of a kind is masked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Masking {
    NodeArgs,
    Values,
    Set,
}

/// One path of a kind and how it is masked.
type MaskedPath = (&'static [&'static str], Masking);

/// The kinds and paths that can be given masked; every other inline secret path stays blanked.
const MASKED: &[(&str, &str, &[MaskedPath])] = &[
    (
        "",
        "Node",
        &[
            (
                &["metadata", "annotations", "k3s.io/node-args"],
                Masking::NodeArgs,
            ),
            (
                &["metadata", "annotations", "rke2.io/node-args"],
                Masking::NodeArgs,
            ),
        ],
    ),
    (
        "helm.cattle.io",
        "HelmChart",
        &[
            (&["spec", "valuesContent"], Masking::Values),
            (&["spec", "set"], Masking::Set),
        ],
    ),
    (
        "helm.cattle.io",
        "HelmChartConfig",
        &[(&["spec", "valuesContent"], Masking::Values)],
    ),
];

/// Whether objects of `group`/`kind` can be given masked (`permissions.maskedSecrets` names only these).
pub fn can_mask(group: &str, kind: &str) -> bool {
    MASKED
        .iter()
        .any(|(g, k, _)| g.eq_ignore_ascii_case(group) && k.eq_ignore_ascii_case(kind))
}

/// The kinds that can be given masked, as `group/Kind`.
pub fn maskable_kinds() -> Vec<String> {
    MASKED
        .iter()
        .map(|(g, k, _)| {
            if g.is_empty() {
                (*k).to_owned()
            } else {
                format!("{g}/{k}")
            }
        })
        .collect()
}

fn group_kind(value: &Value) -> Option<(String, String)> {
    let api_version = value.get("apiVersion")?.as_str()?;
    let kind = value.get("kind")?.as_str()?;
    let group = api_version.rsplit_once('/').map_or("", |(group, _)| group);
    Some((group.to_owned(), kind.to_owned()))
}

/// An object for an extension: its inline secret material hidden ([`hide_inline_secrets`]), except — for a kind in
/// `masked` — the paths that can be masked, which carry their masked copy (see the module). Returns whether anything
/// changed.
pub fn mask_inline_secrets(value: &mut Value, masked: &[KindPattern]) -> bool {
    let Some((group, kind)) = group_kind(value) else {
        return hide_inline_secrets(value);
    };
    let granted = masked
        .iter()
        .any(|k| k.group.eq_ignore_ascii_case(&group) && k.kind.eq_ignore_ascii_case(&kind));
    let paths = MASKED
        .iter()
        .find(|(g, k, _)| g.eq_ignore_ascii_case(&group) && k.eq_ignore_ascii_case(&kind))
        .map(|(_, _, paths)| *paths)
        .filter(|_| granted);
    let Some(paths) = paths else {
        return hide_inline_secrets(value);
    };
    // The masked copies, computed from the values as they are; then everything is blanked as for any extension, and
    // only the copies go back in.
    let mut copies: Vec<(&[&str], Value)> = Vec::with_capacity(paths.len());
    for (path, how) in paths {
        let Some(raw) = pointer(value, path) else {
            continue;
        };
        if raw.is_null() || raw.as_str() == Some("") {
            continue;
        }
        let copy = match how {
            Masking::NodeArgs => raw.as_str().and_then(masked_node_args).map(Value::String),
            Masking::Values => raw
                .as_str()
                .and_then(masked_values_content)
                .map(Value::String),
            Masking::Set => masked_set(raw),
        };
        if let Some(copy) = copy {
            copies.push((path, copy));
        }
    }
    let changed = hide_inline_secrets(value);
    if copies.is_empty() {
        return changed;
    }
    let mut shown = Vec::with_capacity(copies.len());
    for (path, copy) in copies {
        if let Some(slot) = pointer_mut(value, path) {
            *slot = copy;
            shown.push(shown_path(path));
        }
    }
    if let Some(annotations) = value
        .pointer_mut("/metadata/annotations")
        .and_then(Value::as_object_mut)
    {
        annotations.insert(
            VALUES_MASKED_ANNOTATION.to_owned(),
            Value::String(shown.join(", ")),
        );
    }
    true
}

/// A watch update with [`mask_inline_secrets`] applied to every object it carries (an extension's `resources.watch`
/// of a kind in `masked`). An object whose masked copy cannot be written is left out, never sent as it was.
pub fn mask_in_watch_update(update: WatchUpdate, masked: &[KindPattern]) -> WatchUpdate {
    let mask_all = |items: Vec<WatchObject>| -> Vec<WatchObject> {
        items
            .into_iter()
            .filter_map(|item| {
                let mut value = item.to_value();
                if !mask_inline_secrets(&mut value, masked) {
                    return Some(item);
                }
                WatchObject::new(&value).ok()
            })
            .collect()
    };
    match update {
        WatchUpdate::Snapshot { items } => WatchUpdate::Snapshot {
            items: mask_all(items),
        },
        WatchUpdate::Delta { upserted, deleted } => WatchUpdate::Delta {
            upserted: mask_all(upserted),
            deleted,
        },
        WatchUpdate::SnapshotPart { items } => WatchUpdate::SnapshotPart {
            items: mask_all(items),
        },
        WatchUpdate::SnapshotEnd { items, deleted } => WatchUpdate::SnapshotEnd {
            items: mask_all(items),
            deleted,
        },
        other => other,
    }
}

fn pointer<'v>(value: &'v Value, path: &[&str]) -> Option<&'v Value> {
    path.iter()
        .try_fold(value, |at, key| at.as_object()?.get(*key))
}

fn pointer_mut<'v>(value: &'v mut Value, path: &[&str]) -> Option<&'v mut Value> {
    path.iter()
        .try_fold(value, |at, key| at.as_object_mut()?.get_mut(*key))
}

/// `spec.valuesContent`, `metadata.annotations["k3s.io/node-args"]`: as `sextant.dev/values-hidden` names paths.
fn shown_path(path: &[&str]) -> String {
    let mut out = String::new();
    for segment in path {
        if segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            if !out.is_empty() {
                out.push('.');
            }
            out.push_str(segment);
        } else {
            out.push('[');
            out.push_str(&Value::String((*segment).to_owned()).to_string());
            out.push(']');
        }
    }
    out
}

/// Words that make a name secret wherever they appear in it, separators ignored (`SECRET_SUBSTRINGS`).
const SECRET_SUBSTRINGS: &[&str] = &[
    "secret",
    "password",
    "passwd",
    "credential",
    "apikey",
    "accesskey",
    "privatekey",
    "passphrase",
];
/// Words that make a name secret as a whole part of it (`SECRET_PARTS`).
const SECRET_PARTS: &[&str] = &[
    "token",
    "key",
    "auth",
    "authorization",
    "pwd",
    "pass",
    "cred",
    "creds",
    "sas",
    "signature",
    "cookie",
    "bearer",
    "dsn",
];

/// Whether a key, flag or variable name looks like it holds a secret (`looksSecret` in `src/resources/secretNames.ts`):
/// one of [`SECRET_SUBSTRINGS`] anywhere in it, ending in `token`, or one of [`SECRET_PARTS`] as a part (camelCase
/// split, then anything but ASCII letters and digits).
pub fn looks_secret(name: &str) -> bool {
    let flat: String = name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect();
    if SECRET_SUBSTRINGS.iter().any(|w| flat.contains(w)) || flat.ends_with("token") {
        return true;
    }
    // `([a-z0-9])([A-Z])` → `$1 $2`, then lower case, then split at anything but `[a-z0-9]`.
    let chars: Vec<char> = name.chars().collect();
    let mut spaced = String::with_capacity(name.len() + 8);
    for (i, c) in chars.iter().enumerate() {
        if i > 0 && c.is_ascii_uppercase() {
            let before = chars[i - 1];
            if before.is_ascii_lowercase() || before.is_ascii_digit() {
                spaced.push(' ');
            }
        }
        spaced.push(*c);
    }
    spaced
        .to_lowercase()
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .any(|part| SECRET_PARTS.contains(&part))
}

/// A word k3s reads as a flag (`/^-{1,2}[A-Za-z0-9]/`).
fn is_flag(word: &str) -> bool {
    let rest = word.strip_prefix("--").or_else(|| word.strip_prefix('-'));
    rest.and_then(|r| r.chars().next())
        .is_some_and(|c| c.is_ascii_alphanumeric())
}

/// Whether the value of `flag` (with its value, for the `*-arg` flags) must not be shown (`secretFlag`).
pub fn secret_flag(flag: &str, value: Option<&str>) -> bool {
    if K3S_SECRET_FLAGS.contains(&flag) {
        return true;
    }
    let name = flag.trim_start_matches('-');
    if looks_secret(name) || name.ends_with("datastore-endpoint") {
        return true;
    }
    if name.ends_with("-arg")
        && let Some(value) = value
    {
        let setting = value.trim_start_matches('-');
        let setting = setting.split('=').next().unwrap_or_default();
        if looks_secret(setting) {
            return true;
        }
    }
    false
}

/// One argument as the window reads it (`NodeArg` in `src/resources/nodeArgs.ts`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NodeArg {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub hidden: bool,
}

/// The arguments of `<program>.io/node-args` (`nodeArgs`); `None` when they cannot be read.
pub fn node_args(text: &str) -> Option<Vec<NodeArg>> {
    // JavaScript measures in UTF-16 units.
    if text.encode_utf16().count() > MAX_ARGS_TEXT {
        return None;
    }
    let words: Vec<String> = serde_json::from_str::<Vec<String>>(text).ok()?;
    let mut out = Vec::new();
    let mut i = 0;
    while i < words.len() && out.len() < MAX_ARGS {
        let word = &words[i];
        if !is_flag(word) {
            // A bare word: the subcommand, or a value k3s could not pair with a flag.
            out.push(NodeArg {
                flag: None,
                value: Some(clean_text(word)),
                hidden: word == K3S_OMITTED,
            });
            i += 1;
            continue;
        }
        let (flag, value) = match word.find('=') {
            Some(eq) if eq > 0 => (word[..eq].to_owned(), Some(word[eq + 1..].to_owned())),
            _ if i + 1 < words.len() && !is_flag(&words[i + 1]) => {
                i += 1;
                (word.clone(), Some(words[i].clone()))
            }
            _ => (word.clone(), None),
        };
        let hidden = value
            .as_deref()
            .is_some_and(|v| v == K3S_OMITTED || secret_flag(&flag, Some(v)));
        out.push(if hidden {
            NodeArg {
                flag: Some(flag),
                value: None,
                hidden: true,
            }
        } else {
            NodeArg {
                value: value.map(|v| clean_text(&v)),
                flag: Some(flag),
                hidden: false,
            }
        });
        i += 1;
    }
    Some(out)
}

/// The masked copy of a node-args annotation: the arguments [`node_args`] reads, written back as k3s writes them, a
/// flag and its value as one `--flag=value` word, every hidden value as `********` (so the window's reading gives the
/// same arguments); `None` when they cannot be read.
pub fn masked_node_args(text: &str) -> Option<String> {
    let words: Vec<String> = node_args(text)?
        .into_iter()
        .map(|arg| match (arg.flag, arg.value, arg.hidden) {
            (None, _, true) => K3S_OMITTED.to_owned(),
            (None, value, false) => value.unwrap_or_default(),
            (Some(flag), _, true) => format!("{flag}={K3S_OMITTED}"),
            (Some(flag), Some(value), false) => format!("{flag}={value}"),
            (Some(flag), None, false) => flag,
        })
        .collect();
    serde_json::to_string(&words).ok()
}

/// Every leaf of a value under a secret-looking key as [`HIDDEN`], its shape kept (`hideAll`).
fn hide_all(value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::Array(items) => Value::Array(items.iter().map(hide_all).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), hide_all(v))).collect())
        }
        _ => Value::String(HIDDEN.to_owned()),
    }
}

/// A values document with every value under a secret-looking key hidden and every text cleaned (`maskValues`).
fn mask_values(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(clean_text(text)),
        Value::Array(items) => Value::Array(items.iter().map(mask_values).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, v)| {
                    let shown = if looks_secret(key) && !v.is_null() {
                        if v.is_object() || v.is_array() {
                            hide_all(v)
                        } else {
                            Value::String(HIDDEN.to_owned())
                        }
                    } else {
                        mask_values(v)
                    };
                    (key.clone(), shown)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A YAML value as JSON, keys as texts (a number or a flag written as text); `None` for a tag, a key that is no
/// text, number or flag, or a number JSON cannot hold.
fn yaml_to_json(value: &serde_yaml::Value) -> Option<Value> {
    use serde_yaml::Value as Y;
    Some(match value {
        Y::Null => Value::Null,
        Y::Bool(b) => Value::Bool(*b),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(u) = n.as_u64() {
                Value::from(u)
            } else {
                Value::Number(serde_json::Number::from_f64(n.as_f64()?)?)
            }
        }
        Y::String(s) => Value::String(s.clone()),
        Y::Sequence(items) => Value::Array(items.iter().map(yaml_to_json).collect::<Option<_>>()?),
        Y::Mapping(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                let key = match k {
                    Y::String(s) => s.clone(),
                    Y::Bool(b) => b.to_string(),
                    Y::Number(n) => n.to_string(),
                    _ => return None,
                };
                if out.insert(key, yaml_to_json(v)?).is_some() {
                    // Two keys that read alike once written as text: not one mapping as the window reads it.
                    return None;
                }
            }
            Value::Object(out)
        }
        Y::Tagged(_) => return None,
    })
}

/// The masked copy of `spec.valuesContent` (`maskedValuesContent`): `""` when empty, the masked mapping as JSON text,
/// `None` when it cannot be read safely (too long, not YAML, not one mapping).
pub fn masked_values_content(text: &str) -> Option<String> {
    if text.trim().is_empty() {
        return Some(String::new());
    }
    if text.encode_utf16().count() > MAX_VALUES_TEXT {
        return None;
    }
    let parsed: serde_yaml::Value = serde_yaml::from_str(text).ok()?;
    if parsed.is_null() {
        return Some(String::new());
    }
    let value = yaml_to_json(&parsed)?;
    if !value.is_object() {
        return None;
    }
    serde_json::to_string(&mask_values(&value)).ok()
}

/// The masked copy of `spec.set` (`maskedSet`): each value as text, `<hidden>` under a key any `.`-part of which looks
/// secret, else cleaned; `None` for anything but a mapping.
pub fn masked_set(set: &Value) -> Option<Value> {
    let map = set.as_object()?;
    let mut out = Map::new();
    for (key, value) in map {
        let secret = key.split('.').any(looks_secret);
        let text = match value {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            other => serde_json::to_string(other).ok()?,
        };
        let shown = if secret {
            HIDDEN.to_owned()
        } else {
            clean_text(&text)
        };
        out.insert(key.clone(), Value::String(shown));
    }
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests;
