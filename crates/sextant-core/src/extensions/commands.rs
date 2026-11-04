//! Commands of an extension (`contributes.commands`, sextantApi 3, ADR-0147): programs fixed in the manifest that the
//! extension runs by id in a container it names by labels, with typed parameters. The extension never sends a command
//! line: [`fill`] puts each parameter's value in as one whole argument, after checking it against its type, and there
//! is never a shell. Each command is agreed to word for word at install (`grantedCommands`); one that changes
//! something is confirmed by the user every time it runs (`changes`).
//!
//! What a command may be is checked when the manifest is read ([`check_commands`]): the program a literal word; every
//! other argument a literal word or exactly `{{name}}` of a declared parameter, each parameter used; the target a
//! label selector of `key=value` pairs and a container name.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::manifest::{ExtensionManifest, ManifestError};
use super::schema::JsonPath;
use crate::error::{CoreError, CoreResult, ErrorCode};

/// The extension API version that brought `contributes.commands`.
pub const COMMANDS_API: u32 = 3;
/// Commands per extension (the schema's `maxItems`).
pub const MAX_COMMANDS: usize = 20;
/// Words of a command, the program included.
pub const MAX_ARGS: usize = 32;
/// Characters of one word or `enum` value.
pub const MAX_ARG_CHARS: usize = 256;
/// Parameters of a command.
pub const MAX_PARAMS: usize = 5;
/// Values of an `enum` parameter.
pub const MAX_ENUM_VALUES: usize = 20;
/// The longest a command may run before Sextant stops waiting (`exec::MAX_COMMAND_TIMEOUT`).
pub const MAX_TIMEOUT_SECONDS: u32 = 60;
/// When a command names none.
pub const DEFAULT_TIMEOUT_SECONDS: u32 = 30;
/// Bytes of output kept of each of stdout and stderr.
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// A command of the manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandContribution {
    pub id: String,
    /// What it does, in the extension's words; shown at install and when it asks.
    pub title: String,
    /// The container it runs in.
    pub target: CommandTarget,
    /// The program and its arguments; an argument may be exactly `{{name}}` of a parameter.
    pub argv: Vec<String>,
    #[serde(default)]
    pub params: Vec<CommandParam>,
    /// It changes something: Sextant asks the user every time it runs. `false`: it only reads, and runs without asking.
    #[serde(default)]
    pub changes: bool,
    /// How long Sextant waits for it, 1 to [`MAX_TIMEOUT_SECONDS`]; [`DEFAULT_TIMEOUT_SECONDS`] when left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timeout_seconds: Option<u32>,
}

/// Where a command runs: the newest ready pod of the namespace the call names whose labels match, in this container.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandTarget {
    /// `key=value` pairs separated by commas (`app=rook-ceph-tools`).
    pub label_selector: String,
    pub container: String,
}

/// A parameter of a command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommandParam {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: CommandParamType,
    /// `enum`: the values it may be.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<String>,
    /// `int`: the smallest and largest value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub min: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub max: Option<i64>,
}

/// What a parameter's value may be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CommandParamType {
    /// A whole number, within `min` and `max`.
    Int,
    /// One of `values`.
    Enum,
    /// An object name (DNS-1123 subdomain).
    Name,
}

// ---------------------------------------------------------------------------------------------------------------
// Checks of the manifest

/// What reading a manifest checks of its commands beyond the schema.
pub(crate) fn check_commands(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let commands = &manifest.contributes.commands;
    let list = JsonPath::default().key("contributes").key("commands");
    if commands.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < COMMANDS_API {
        return Err(at(
            &list,
            format!("needs sextantApi {COMMANDS_API} or later"),
        ));
    }
    for (i, command) in commands.iter().enumerate() {
        let here = list.index(i);
        if !is_label_selector(&command.target.label_selector) {
            return Err(at(
                &here.key("target").key("labelSelector"),
                "must be `key=value` pairs separated by commas, such as `app=rook-ceph-tools`",
            ));
        }
        if !is_dns_name(&command.target.container, 63, false) {
            return Err(at(
                &here.key("target").key("container"),
                "must be a container name",
            ));
        }
        for (j, param) in command.params.iter().enumerate() {
            let at_param = here.key("params").index(j);
            if command.params[..j].iter().any(|p| p.name == param.name) {
                return Err(at(
                    &at_param.key("name"),
                    "is the name of another parameter",
                ));
            }
            match param.kind {
                CommandParamType::Enum => {
                    if param.values.is_empty() {
                        return Err(at(&at_param.key("values"), "an `enum` lists its values"));
                    }
                    for (k, value) in param.values.iter().enumerate() {
                        if !is_word(value) {
                            return Err(at(&at_param.key("values").index(k), WORD));
                        }
                    }
                }
                CommandParamType::Int | CommandParamType::Name if !param.values.is_empty() => {
                    return Err(at(&at_param.key("values"), "only an `enum` has values"));
                }
                _ => {}
            }
            if param.kind != CommandParamType::Int && (param.min.is_some() || param.max.is_some()) {
                return Err(at(&at_param, "only an `int` has `min` and `max`"));
            }
            if let (Some(min), Some(max)) = (param.min, param.max)
                && min > max
            {
                return Err(at(&at_param.key("min"), "is above `max`"));
            }
        }
        let mut used = vec![false; command.params.len()];
        for (j, word) in command.argv.iter().enumerate() {
            let at_word = here.key("argv").index(j);
            match placeholder(word) {
                Some(name) => {
                    if j == 0 {
                        return Err(at(
                            &at_word,
                            "the program is a word of its own, never a parameter",
                        ));
                    }
                    let Some(k) = command.params.iter().position(|p| p.name == name) else {
                        return Err(at(&at_word, format!("names no parameter `{name}`")));
                    };
                    used[k] = true;
                }
                None if !is_word(word) => return Err(at(&at_word, WORD)),
                None => {}
            }
        }
        if let Some(k) = used.iter().position(|u| !u) {
            return Err(at(
                &here.key("params").index(k).key("name"),
                "is not used by `argv`",
            ));
        }
    }
    Ok(())
}

const WORD: &str = "must be a word without control characters and without `{{` or `}}`, or exactly `{{name}}` of a parameter";

/// `name` when `word` is exactly `{{name}}`.
fn placeholder(word: &str) -> Option<&str> {
    word.strip_prefix("{{")?.strip_suffix("}}").map(str::trim)
}

/// A literal argument: printable, no placeholder braces.
fn is_word(text: &str) -> bool {
    text.chars().count() <= MAX_ARG_CHARS
        && !text.chars().any(char::is_control)
        && !text.contains("{{")
        && !text.contains("}}")
}

/// `key=value` pairs separated by commas: label keys and values as Kubernetes allows them, values not empty.
fn is_label_selector(text: &str) -> bool {
    !text.is_empty()
        && text.split(',').all(|pair| {
            let Some((key, value)) = pair.split_once('=') else {
                return false;
            };
            is_label_key(key) && is_label_value(value)
        })
}

fn is_label_key(text: &str) -> bool {
    let (prefix, name) = match text.rsplit_once('/') {
        Some((prefix, name)) => (Some(prefix), name),
        None => (None, text),
    };
    is_label_value(name) && prefix.is_none_or(|p| is_dns_name(p, 253, true))
}

/// 1–63 letters, digits, `-`, `_` and `.`, starting and ending with a letter or digit.
fn is_label_value(text: &str) -> bool {
    let alnum = |c: char| c.is_ascii_alphanumeric();
    !text.is_empty()
        && text.len() <= 63
        && text.starts_with(alnum)
        && text.ends_with(alnum)
        && text
            .chars()
            .all(|c| alnum(c) || matches!(c, '-' | '_' | '.'))
}

/// Lowercase letters, digits and `-` (and `.` between labels when `dots`), starting and ending with a letter or digit.
fn is_dns_name(text: &str, max: usize, dots: bool) -> bool {
    let alnum = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= max
        && alnum(&bytes[0])
        && alnum(&bytes[bytes.len() - 1])
        && bytes
            .iter()
            .all(|b| alnum(b) || *b == b'-' || (dots && *b == b'.'))
}

fn at(path: &JsonPath, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.to_string(),
        message: message.into(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Running

/// The words to run: `argv` with each `{{name}}` replaced by its checked value, whole; nothing else may be given.
pub fn fill(
    command: &CommandContribution,
    values: &BTreeMap<String, String>,
) -> CoreResult<Vec<String>> {
    if let Some(unknown) = values
        .keys()
        .find(|k| !command.params.iter().any(|p| &p.name == *k))
    {
        return Err(invalid(format!(
            "command {} has no parameter {unknown:?}",
            command.id
        )));
    }
    command
        .argv
        .iter()
        .map(|word| {
            let Some(name) = placeholder(word) else {
                return Ok(word.clone());
            };
            let param = command
                .params
                .iter()
                .find(|p| p.name == name)
                .ok_or_else(|| {
                    invalid(format!("command {} names no parameter {name}", command.id))
                })?;
            let value = values.get(name).ok_or_else(|| {
                invalid(format!("command {} needs the parameter {name}", command.id))
            })?;
            check_value(param, value)
        })
        .collect()
}

/// The value as it is put in, or why it may not be.
fn check_value(param: &CommandParam, value: &str) -> CoreResult<String> {
    match param.kind {
        CommandParamType::Int => {
            let n: i64 = value
                .trim()
                .parse()
                .map_err(|_| invalid(format!("{} must be a whole number", param.name)))?;
            if param.min.is_some_and(|min| n < min) || param.max.is_some_and(|max| n > max) {
                return Err(invalid(format!(
                    "{} must be from {} to {}",
                    param.name,
                    param.min.map_or("any".into(), |m| m.to_string()),
                    param.max.map_or("any".into(), |m| m.to_string())
                )));
            }
            Ok(n.to_string())
        }
        CommandParamType::Enum => param
            .values
            .iter()
            .find(|v| *v == value)
            .cloned()
            .ok_or_else(|| {
                invalid(format!(
                    "{} must be one of {}",
                    param.name,
                    param.values.join(", ")
                ))
            }),
        CommandParamType::Name if is_dns_name(value, 253, true) => Ok(value.to_owned()),
        CommandParamType::Name => Err(invalid(format!("{} must be an object name", param.name))),
    }
}

/// How long to wait for `command`.
pub fn timeout_of(command: &CommandContribution) -> std::time::Duration {
    let seconds = command
        .timeout_seconds
        .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
        .clamp(1, MAX_TIMEOUT_SECONDS);
    std::time::Duration::from_secs(u64::from(seconds))
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

// ---------------------------------------------------------------------------------------------------------------
// Grants

/// Whether every command of `manifest` was agreed to as it is now written.
pub fn commands_within(
    manifest: &ExtensionManifest,
    granted: Option<&[CommandContribution]>,
) -> bool {
    let commands = &manifest.contributes.commands;
    commands.is_empty()
        || granted.is_some_and(|granted| commands.iter().all(|c| granted.contains(c)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> CommandContribution {
        serde_json::from_value(serde_json::json!({
            "id": "reweight",
            "title": "Reweight an OSD",
            "target": { "labelSelector": "app=rook-ceph-tools", "container": "rook-ceph-tools" },
            "argv": ["ceph", "osd", "reweight", "{{osd}}", "{{weight}}", "--pool", "{{pool}}"],
            "params": [
                { "name": "osd", "type": "int", "min": 0, "max": 99 },
                { "name": "weight", "type": "enum", "values": ["0.5", "1.0"] },
                { "name": "pool", "type": "name" }
            ],
            "changes": true
        }))
        .unwrap()
    }

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn each_value_is_one_whole_argument_after_its_check() {
        let filled = fill(
            &command(),
            &values(&[("osd", " 7 "), ("weight", "0.5"), ("pool", "replicapool")]),
        )
        .unwrap();
        assert_eq!(
            filled,
            [
                "ceph",
                "osd",
                "reweight",
                "7",
                "0.5",
                "--pool",
                "replicapool"
            ]
        );
        // A value with spaces or a shell's characters is never split or read: it is refused by its type.
        for (name, value) in [
            ("osd", "7; rm -rf /"),
            ("osd", "100"),
            ("weight", "2"),
            ("pool", "a b"),
            ("pool", "$(id)"),
        ] {
            let mut given = values(&[("osd", "1"), ("weight", "1.0"), ("pool", "p")]);
            given.insert(name.into(), value.into());
            assert_eq!(
                fill(&command(), &given).unwrap_err().code,
                ErrorCode::Invalid,
                "{name}={value}"
            );
        }
    }

    #[test]
    fn a_missing_or_unknown_value_is_refused() {
        let missing = fill(&command(), &values(&[("osd", "1"), ("weight", "1.0")])).unwrap_err();
        assert!(
            missing.message.contains("needs the parameter pool"),
            "{}",
            missing.message
        );
        let unknown = fill(
            &command(),
            &values(&[("osd", "1"), ("weight", "1.0"), ("pool", "p"), ("x", "y")]),
        )
        .unwrap_err();
        assert!(
            unknown.message.contains("no parameter"),
            "{}",
            unknown.message
        );
    }

    #[test]
    fn the_timeout_is_within_a_minute() {
        let mut c = command();
        assert_eq!(timeout_of(&c).as_secs(), u64::from(DEFAULT_TIMEOUT_SECONDS));
        c.timeout_seconds = Some(5);
        assert_eq!(timeout_of(&c).as_secs(), 5);
    }
}
