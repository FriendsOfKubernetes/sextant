//! `sextant-extension.json`: what an extension is, what it adds to Sextant and what it asks to do in clusters.
//!
//! Reading is strict ([`parse_manifest`]): an unknown field or a wrong value is an error that names the field
//! (`contributes.pages[0].title: must not be empty`), so a typo never silently drops a permission or a contribution.
//! The structure is checked against `manifest.schema.json`; this module adds what a schema cannot say.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::permissions::ExtensionPermissions;
use super::schema::{self, JsonPath};
use crate::access::KindPattern;
use crate::error::{CoreError, ErrorCode};

/// The manifest's file name, at the root of a package or folder.
pub const MANIFEST_FILE: &str = "sextant-extension.json";

/// The extension API major version this Sextant implements (`sextantApi`).
pub const SUPPORTED_API: u32 = 1;

/// A manifest larger than this is refused before it is parsed.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;

/// A manifest that cannot be used: where (`path`, e.g. `contributes.pages[0].id`; empty for the whole file) and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ManifestError {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.path.is_empty() {
            write!(f, "{MANIFEST_FILE}: {}", self.message)
        } else {
            write!(f, "{MANIFEST_FILE}: {}: {}", self.path, self.message)
        }
    }
}

impl std::error::Error for ManifestError {}

impl From<ManifestError> for CoreError {
    fn from(err: ManifestError) -> Self {
        CoreError::new(ErrorCode::Invalid, err.to_string())
    }
}

/// `sextant-extension.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExtensionManifest {
    /// `[a-z0-9][a-z0-9.-]{2,63}`, not ending with `.`, without `..`; unique among installed extensions.
    pub id: String,
    pub name: String,
    /// Semantic version.
    pub version: String,
    pub description: String,
    pub author: String,
    /// The extension API major version it is written for ([`SUPPORTED_API`]).
    pub sextant_api: u32,
    /// The HTML file every view opens, relative to the package root.
    pub entry: String,
    /// Name of an icon from Sextant's set; an unknown one shows the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<String>,
    pub permissions: ExtensionPermissions,
    pub contributes: Contributions,
}

/// What an extension adds to Sextant's interface. Titles are shown as written (not translation keys).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct Contributions {
    pub pages: Vec<PageContribution>,
    pub details_sections: Vec<DetailsSectionContribution>,
    pub actions: Vec<ActionContribution>,
    pub columns: Vec<ColumnContribution>,
    pub dock_actions: Vec<DockActionContribution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub settings: Option<SettingsContribution>,
}

/// A page in the cluster's sidebar (`view=page`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PageContribution {
    pub id: String,
    pub title: String,
    /// A sidebar section of Sextant (`workloads`, `customResources`, …) or the extension's own.
    pub section: String,
    /// Header of the extension's own section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub section_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub order: Option<i32>,
}

/// Where a details contribution shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DetailsPlacement {
    /// A section with a title among the details sections.
    Section,
    /// A tab next to "Overview", the full height of the panel.
    Tab,
}

/// A section or tab in the details panel of the listed kinds (`view=details`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DetailsSectionContribution {
    pub id: String,
    pub title: String,
    pub kinds: Vec<KindPattern>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub order: Option<i32>,
    pub placement: DetailsPlacement,
}

/// An action on objects of the listed kinds: the details action bar and the table row menu (`view=action`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ActionContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<String>,
    pub kinds: Vec<KindPattern>,
    /// Shown as a dangerous action.
    #[serde(default)]
    pub danger: bool,
    /// Offered for several selected objects at once.
    #[serde(default)]
    pub multiple: bool,
}

/// A table column of one kind, from a JSONPath (no code runs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ColumnContribution {
    pub kind: KindPattern,
    pub id: String,
    pub title: String,
    /// The JSONPath subset of CRD printer columns.
    pub json_path: String,
    /// Title of the column this one goes after; at the end when `None` or unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub after: Option<String>,
}

/// A dock button that opens a dock tab (`view=dock`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DockActionContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<String>,
}

/// The extension's own section in Settings → Extensions (`view=settings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SettingsContribution {
    pub title: String,
}

/// Reads `sextant-extension.json`. Every problem is a [`ManifestError`] naming the field; the first one found is
/// returned.
pub fn parse_manifest(bytes: &[u8]) -> Result<ExtensionManifest, ManifestError> {
    let whole = |message: String| ManifestError {
        path: String::new(),
        message,
    };
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(whole(format!(
            "the file is too large ({} bytes; at most {MAX_MANIFEST_BYTES})",
            bytes.len()
        )));
    }
    let mut value: Value =
        serde_json::from_slice(bytes).map_err(|err| whole(format!("not valid JSON: {err}")))?;
    if !value.is_object() {
        return Err(whole("must be an object".to_owned()));
    }
    // A manifest for another API version may have fields this Sextant does not know: the version is the reason.
    if let Some(api) = value.get("sextantApi").and_then(Value::as_i64)
        && api != i64::from(SUPPORTED_API)
    {
        return Err(ManifestError {
            path: "sextantApi".to_owned(),
            message: format!(
                "extension API {api} is not supported; this Sextant supports {SUPPORTED_API}"
            ),
        });
    }
    schema::validate(&schema::manifest_schema(), &value)?;
    check_unique_ids(&value)?;
    apply_defaults(&mut value);
    serde_json::from_value(value).map_err(|err| whole(format!("cannot be read: {err}")))
}

/// Contribution ids are unique within each contribution type.
fn check_unique_ids(manifest: &Value) -> Result<(), ManifestError> {
    let contributes = JsonPath::default().key("contributes");
    for kind in [
        "pages",
        "detailsSections",
        "actions",
        "columns",
        "dockActions",
    ] {
        let Some(items) = manifest
            .get("contributes")
            .and_then(|c| c.get(kind))
            .and_then(Value::as_array)
        else {
            continue;
        };
        let list = contributes.key(kind);
        for (i, item) in items.iter().enumerate() {
            let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
            let first = items[..i]
                .iter()
                .position(|other| other.get("id").and_then(Value::as_str) == Some(id));
            if let Some(first) = first {
                return Err(ManifestError {
                    path: list.index(i).key("id").to_string(),
                    message: format!("duplicate id `{id}` (also {})", list.index(first)),
                });
            }
        }
    }
    Ok(())
}

/// What the schema leaves out and the types need: `confirm` of a rule is `true` unless written.
fn apply_defaults(manifest: &mut Value) {
    let rules = manifest
        .pointer_mut("/permissions/rules")
        .and_then(Value::as_array_mut);
    for rule in rules.into_iter().flatten() {
        if let Some(rule) = rule.as_object_mut() {
            rule.entry("confirm").or_insert(Value::Bool(true));
        }
    }
}

/// `id`: `[a-z0-9][a-z0-9.-]{2,63}`, not ending with `.`, without `..`, and not a Windows device name (`nul`,
/// `con.tools`, …) — it is a folder name on every OS.
pub(crate) fn is_extension_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (3..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase() | bytes[0].is_ascii_digit()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'.' || *b == b'-')
        && !text.ends_with('.')
        && !text.contains("..")
        && !is_windows_device_name(text)
}

/// Whether Windows reads a file name as a device (`CON`, `nul.js`, `COM0.html`, `lpt¹`, any case): writing it would
/// write to the device, not to a file.
pub(crate) fn is_windows_device_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    let upper = stem.to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&upper.as_str()) {
        return true;
    }
    let mut chars = upper.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let rest: Vec<char> = chars.collect();
    (prefix == "COM" || prefix == "LPT")
        && rest.len() == 1
        && matches!(rest[0], '0'..='9' | '¹' | '²' | '³')
}

/// A contribution id: `[a-z0-9-]{1,40}`.
pub(crate) fn is_contribution_id(text: &str) -> bool {
    (1..=40).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A section or icon name: `[A-Za-z][A-Za-z0-9-]{0,39}`.
pub(crate) fn is_identifier(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=40).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
}

/// Semantic version 2.0.0: `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`, no leading zeros in numbers.
pub(crate) fn is_semver(text: &str) -> bool {
    fn number(part: &str) -> bool {
        !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'))
    }
    fn identifiers(text: &str, numeric_rule: bool) -> bool {
        text.split('.').all(|id| {
            !id.is_empty()
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && (!numeric_rule || !id.bytes().all(|b| b.is_ascii_digit()) || number(id))
        })
    }
    let (rest, build) = match text.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (text, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| number(p))
        && pre.is_none_or(|p| identifiers(p, true))
        && build.is_none_or(|b| identifiers(b, false))
}

/// A file path inside a package: relative, `/`-separated, no empty, `.` or `..` segment, none of `\ : * ? " < > |` or
/// control characters, no segment ending with `.` or a space (Windows drops them, so `index.html.` would land on
/// `index.html`) and no Windows device name (`nul.js`, `CON`) — the same on every OS, and never outside the package.
pub(crate) fn is_package_path(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 1024
        && !text.starts_with('/')
        && !text
            .chars()
            .any(|c| matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
        && text.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && !segment.ends_with('.')
                && !segment.ends_with(' ')
                && !is_windows_device_name(segment)
        })
}

/// A [package path](is_package_path) Sextant serves and installs: also no part starting with `.` (`.git`, `.env`)
/// and no `node_modules` folder in any case — what a folder package leaves out.
pub(crate) fn is_servable_path(text: &str) -> bool {
    is_package_path(text)
        && text.split('/').all(|segment| {
            !segment.starts_with('.') && !segment.eq_ignore_ascii_case("node_modules")
        })
}

/// Ends with `.html` or `.htm` (any case).
pub(crate) fn is_html_path(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// Whether the frontend's printer-column JSONPath evaluator (`src/resources/jsonpath.ts`) understands `path`:
/// `.a.b`, `.a[0]`, `.a[*]`, `.*`, `['key']`, `[?(@.x=="y")]`, `[?(@.x)]`, optionally inside `{…}` and after `$`.
/// At least one step.
pub(crate) fn is_supported_json_path(raw: &str) -> bool {
    let mut path = raw.trim();
    if path.starts_with('{') && path.ends_with('}') && path.len() >= 2 {
        path = path[1..path.len() - 1].trim();
    }
    if let Some(rest) = path.strip_prefix('$') {
        path = rest;
    }
    let chars: Vec<char> = path.chars().collect();
    let mut steps = 0;
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '.' => {
                i += 1;
                if chars.get(i) == Some(&'*') {
                    i += 1;
                    steps += 1;
                    continue;
                }
                let mut key = 0;
                while i < chars.len() && chars[i] != '.' && chars[i] != '[' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        i += 1;
                    }
                    key += 1;
                    i += 1;
                }
                if key == 0 {
                    return false;
                }
                steps += 1;
            }
            '[' => {
                let Some(end) = closing_bracket(&chars, i) else {
                    return false;
                };
                let inner: String = chars[i + 1..end].iter().collect();
                if !is_bracket_step(inner.trim()) {
                    return false;
                }
                i = end + 1;
                steps += 1;
            }
            _ => return false,
        }
    }
    steps > 0
}

fn closing_bracket(chars: &[char], open: usize) -> Option<usize> {
    let mut quote: Option<char> = None;
    let mut depth = 0i32;
    let mut i = open;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            if ch == '\\' {
                i += 1;
            } else if ch == q {
                quote = None;
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if ch == '[' || ch == '(' {
            depth += 1;
        } else if ch == ']' || ch == ')' {
            depth -= 1;
            if depth == 0 && ch == ']' {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn is_bracket_step(inner: &str) -> bool {
    if inner == "*" {
        return true;
    }
    let digits = inner.strip_prefix('-').unwrap_or(inner);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    if inner.len() >= 2 {
        let first = inner.as_bytes()[0];
        if (first == b'\'' || first == b'"') && inner.as_bytes()[inner.len() - 1] == first {
            return true;
        }
    }
    is_filter(inner)
}

/// `?(@.a.b)`, `?(@.a == "x")`, `?(@.a != 1)` — as the frontend's filter expression.
fn is_filter(inner: &str) -> bool {
    let Some(body) = inner.strip_prefix("?(").and_then(|b| b.strip_suffix(')')) else {
        return false;
    };
    let Some(rest) = body.trim_start().strip_prefix("@.") else {
        return false;
    };
    let field_end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    if field_end == 0 {
        return false;
    }
    let after = rest[field_end..].trim_start();
    if after.is_empty() {
        return true;
    }
    match after
        .strip_prefix("==")
        .or_else(|| after.strip_prefix("!="))
    {
        Some(literal) => !literal.is_empty(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::{AccessAction, AccessRule, KindScope, NamespaceScope};
    use crate::extensions::permissions::ClusterScope;
    use serde_json::json;

    const FULL: &str = include_str!("testdata/full-manifest.json");

    fn full() -> Value {
        serde_json::from_str(FULL).unwrap()
    }

    fn parse(value: &Value) -> Result<ExtensionManifest, ManifestError> {
        parse_manifest(&serde_json::to_vec(value).unwrap())
    }

    /// The error for `value`, as `(path, message)`.
    fn fails(value: &Value) -> (String, String) {
        let err = parse(value).expect_err("must not parse");
        (err.path, err.message)
    }

    /// A minimal valid manifest.
    fn minimal() -> Value {
        json!({
            "id": "hello",
            "name": "Hello",
            "version": "0.1.0",
            "description": "",
            "author": "Me",
            "sextantApi": 1,
            "entry": "index.html",
            "permissions": { "clusters": { "type": "all" }, "rules": [] },
            "contributes": {}
        })
    }

    /// `value` with `field` set at `pointer` (added when missing).
    fn with(mut value: Value, pointer: &str, field: Value) -> Value {
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        match value
            .pointer_mut(parent)
            .unwrap_or_else(|| panic!("{pointer}"))
        {
            Value::Object(object) => {
                object.insert(key.to_owned(), field);
            }
            Value::Array(items) => items[key.parse::<usize>().unwrap()] = field,
            other => panic!("{pointer}: {other}"),
        }
        value
    }

    fn without(mut value: Value, pointer: &str) -> Value {
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        value
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        value
    }

    fn widget() -> KindPattern {
        KindPattern::new("example.dev", "Widget")
    }

    #[test]
    fn the_full_example_reads_every_field() {
        let m = parse(&full()).unwrap();
        assert_eq!(m.id, "dev.example.widgets");
        assert_eq!(m.name, "Widgets");
        assert_eq!(m.version, "1.2.0-beta.1+build.7");
        assert_eq!(m.author, "Example Team");
        assert_eq!(m.sextant_api, 1);
        assert_eq!(m.entry, "dist/index.html");
        assert_eq!(m.icon.as_deref(), Some("customResource"));

        assert_eq!(
            m.permissions.clusters,
            ClusterScope::Only {
                names: vec!["kind-sextant-test".into(), "staging".into()]
            }
        );
        assert_eq!(m.permissions.rules.len(), 4);
        assert_eq!(
            m.permissions.rules[0],
            AccessRule {
                namespaces: NamespaceScope::All,
                kinds: KindScope::Only {
                    kinds: vec![widget(), KindPattern::new("", "Pod")]
                },
                actions: vec![AccessAction::Read, AccessAction::Logs],
                confirm: true,
            },
            "confirm defaults to true"
        );
        assert!(m.permissions.rules[1].confirm);
        assert!(!m.permissions.rules[2].confirm);
        assert_eq!(
            m.permissions.rules[3].actions,
            vec![AccessAction::SecretValues]
        );

        let c = &m.contributes;
        assert_eq!(
            c.pages[0],
            PageContribution {
                id: "overview".into(),
                title: "Widgets overview".into(),
                section: "widgets".into(),
                section_title: Some("Widgets".into()),
                icon: Some("workloads".into()),
                order: Some(1),
            }
        );
        assert_eq!(c.pages[1].section, "customResources");
        assert_eq!(c.pages[1].section_title, None);
        assert_eq!(c.details_sections[0].placement, DetailsPlacement::Section);
        assert_eq!(c.details_sections[0].order, Some(10));
        assert_eq!(c.details_sections[1].placement, DetailsPlacement::Tab);
        assert_eq!(
            c.details_sections[1].kinds[1],
            KindPattern::new("apps", "Deployment")
        );
        assert_eq!(
            c.actions[0],
            ActionContribution {
                id: "scale".into(),
                title: "Scale widget".into(),
                icon: Some("scale".into()),
                kinds: vec![widget()],
                danger: false,
                multiple: false,
            }
        );
        assert!(c.actions[1].danger && c.actions[1].multiple);
        assert_eq!(
            c.columns[0],
            ColumnContribution {
                kind: widget(),
                id: "size".into(),
                title: "Size".into(),
                json_path: ".spec.size".into(),
                after: Some("Name".into()),
            }
        );
        assert_eq!(
            c.columns[2].json_path,
            "{.metadata.labels['app\\.kubernetes\\.io/name']}"
        );
        assert_eq!(c.dock_actions[0].id, "console");
        assert_eq!(c.settings.as_ref().unwrap().title, "Widgets");
    }

    #[test]
    fn a_minimal_manifest_has_no_contributions() {
        let m = parse(&minimal()).unwrap();
        assert_eq!(m.contributes, Contributions::default());
        assert_eq!(m.icon, None);
        assert_eq!(m.permissions.rules, vec![]);
    }

    #[test]
    fn the_manifest_round_trips_through_its_typescript_shape() {
        // What the frontend receives (and the SDK types describe) parses back to the same manifest.
        let m = parse(&full()).unwrap();
        let written = serde_json::to_value(&m).unwrap();
        assert_eq!(
            written["contributes"]["detailsSections"][1]["placement"],
            "tab"
        );
        assert_eq!(
            written["contributes"]["columns"][0]["jsonPath"],
            ".spec.size"
        );
        assert_eq!(written["contributes"]["dockActions"][0]["id"], "console");
        assert_eq!(written["sextantApi"], 1);
        assert_eq!(parse(&written).unwrap(), m);
    }

    #[test]
    fn not_json_or_not_an_object_is_an_error_about_the_whole_file() {
        let err = parse_manifest(b"{ not json").unwrap_err();
        assert_eq!(err.path, "");
        assert!(err.message.contains("not valid JSON"), "{err:?}");
        let err = parse_manifest(b"[]").unwrap_err();
        assert_eq!(
            (err.path.as_str(), err.message.as_str()),
            ("", "must be an object")
        );
        let huge = vec![b' '; MAX_MANIFEST_BYTES + 1];
        let err = parse_manifest(&huge).unwrap_err();
        assert!(err.message.contains("too large"), "{err:?}");
    }

    #[test]
    fn an_unknown_field_anywhere_names_its_path() {
        let cases = [
            (with(minimal(), "/homepage", json!("x")), "homepage"),
            (
                with(full(), "/permissions/deny", json!([])),
                "permissions.deny",
            ),
            (
                with(full(), "/permissions/rules/1/when", json!("x")),
                "permissions.rules[1].when",
            ),
            (
                with(full(), "/permissions/clusters/except", json!([])),
                "permissions.clusters.except",
            ),
            (
                with(
                    full(),
                    "/permissions/rules/0/namespaces/namespaces",
                    json!(["a"]),
                ),
                "permissions.rules[0].namespaces.namespaces",
            ),
            (
                with(full(), "/contributes/menus", json!([])),
                "contributes.menus",
            ),
            (
                with(full(), "/contributes/pages/0/url", json!("x")),
                "contributes.pages[0].url",
            ),
            (
                with(
                    full(),
                    "/contributes/detailsSections/0/kinds/0/version",
                    json!("v1"),
                ),
                "contributes.detailsSections[0].kinds[0].version",
            ),
            (
                with(full(), "/contributes/actions/1/confirm", json!(true)),
                "contributes.actions[1].confirm",
            ),
            (
                with(full(), "/contributes/columns/0/type", json!("string")),
                "contributes.columns[0].type",
            ),
            (
                with(full(), "/contributes/dockActions/0/order", json!(1)),
                "contributes.dockActions[0].order",
            ),
            (
                with(full(), "/contributes/settings/icon", json!("x")),
                "contributes.settings.icon",
            ),
        ];
        for (value, path) in cases {
            assert_eq!(fails(&value), (path.to_owned(), "unknown field".to_owned()));
        }
    }

    #[test]
    fn a_missing_required_field_names_its_path() {
        for field in [
            "id",
            "name",
            "version",
            "description",
            "author",
            "sextantApi",
            "entry",
            "permissions",
            "contributes",
        ] {
            assert_eq!(
                fails(&without(minimal(), &format!("/{field}"))),
                (field.to_owned(), "is required".to_owned())
            );
        }
        let cases = [
            ("/permissions/rules", "permissions.rules"),
            (
                "/permissions/rules/0/actions",
                "permissions.rules[0].actions",
            ),
            (
                "/contributes/pages/0/section",
                "contributes.pages[0].section",
            ),
            (
                "/contributes/detailsSections/1/placement",
                "contributes.detailsSections[1].placement",
            ),
            (
                "/contributes/actions/0/kinds",
                "contributes.actions[0].kinds",
            ),
            (
                "/contributes/columns/1/jsonPath",
                "contributes.columns[1].jsonPath",
            ),
            (
                "/contributes/columns/1/kind/group",
                "contributes.columns[1].kind.group",
            ),
            (
                "/contributes/dockActions/0/title",
                "contributes.dockActions[0].title",
            ),
            ("/contributes/settings/title", "contributes.settings.title"),
            ("/permissions/clusters/names", "permissions.clusters.names"),
            ("/permissions/clusters/type", "permissions.clusters.type"),
        ];
        for (pointer, path) in cases {
            assert_eq!(
                fails(&without(full(), pointer)),
                (path.to_owned(), "is required".to_owned()),
                "{pointer}"
            );
        }
    }

    #[test]
    fn an_unsupported_api_version_is_its_own_error() {
        for api in [0, 2, 99] {
            // Even with fields this Sextant does not know: the version is the reason.
            let value = with(
                with(minimal(), "/sextantApi", json!(api)),
                "/futureField",
                json!(true),
            );
            let (path, message) = fails(&value);
            assert_eq!(path, "sextantApi");
            assert!(
                message.contains(&format!("{api}")) && message.contains("supports 1"),
                "{message}"
            );
        }
        assert_eq!(
            fails(&with(minimal(), "/sextantApi", json!("1"))),
            ("sextantApi".to_owned(), "must be a whole number".to_owned())
        );
    }

    #[test]
    fn wrong_values_name_their_path() {
        let cases: Vec<(Value, &str, &str)> = vec![
            (
                with(minimal(), "/id", json!("Hello")),
                "id",
                "lowercase letters",
            ),
            (
                with(minimal(), "/id", json!("ab")),
                "id",
                "must be at least 3 characters",
            ),
            (
                with(minimal(), "/id", json!("-hello")),
                "id",
                "starting with a letter or digit",
            ),
            (
                with(minimal(), "/id", json!("hello.")),
                "id",
                "not ending with `.`",
            ),
            (with(minimal(), "/id", json!("a..b")), "id", "without `..`"),
            (
                with(minimal(), "/id", json!("x".repeat(65))),
                "id",
                "must be at most 64 characters",
            ),
            (with(minimal(), "/id", json!(5)), "id", "must be a string"),
            (
                with(minimal(), "/name", json!("")),
                "name",
                "must not be empty",
            ),
            (
                with(minimal(), "/name", json!("   ")),
                "name",
                "must not be blank",
            ),
            (
                with(minimal(), "/name", json!("n".repeat(81))),
                "name",
                "must be at most 80 characters",
            ),
            (
                with(minimal(), "/version", json!("1.0")),
                "version",
                "semantic version",
            ),
            (
                with(minimal(), "/version", json!("01.0.0")),
                "version",
                "semantic version",
            ),
            (
                with(minimal(), "/version", json!("1.0.0-01")),
                "version",
                "semantic version",
            ),
            (
                with(minimal(), "/version", json!("1.0.0+")),
                "version",
                "semantic version",
            ),
            (
                with(minimal(), "/author", json!("")),
                "author",
                "must not be empty",
            ),
            (
                with(minimal(), "/description", json!("d".repeat(501))),
                "description",
                "at most 500",
            ),
            (
                with(minimal(), "/entry", json!("/index.html")),
                "entry",
                ".html file inside the package",
            ),
            (
                with(minimal(), "/entry", json!("../index.html")),
                "entry",
                ".html file inside the package",
            ),
            (
                with(minimal(), "/entry", json!("a/./index.html")),
                "entry",
                ".html file inside the package",
            ),
            (
                with(minimal(), "/entry", json!("a\\index.html")),
                "entry",
                ".html file inside the package",
            ),
            (
                with(minimal(), "/entry", json!("C:/index.html")),
                "entry",
                ".html file inside the package",
            ),
            (
                with(minimal(), "/entry", json!("main.js")),
                "entry",
                ".html file inside the package",
            ),
            (
                with(minimal(), "/icon", json!("my icon")),
                "icon",
                "must be a name",
            ),
            (
                with(minimal(), "/icon", json!("")),
                "icon",
                "must not be empty",
            ),
            (
                with(minimal(), "/permissions/clusters", json!("all")),
                "permissions.clusters",
                "must be an object",
            ),
            (
                with(
                    minimal(),
                    "/permissions/clusters",
                    json!({ "type": "some" }),
                ),
                "permissions.clusters.type",
                "must be one of: `all`, `only`",
            ),
            (
                with(
                    minimal(),
                    "/permissions/clusters",
                    json!({ "type": "only", "names": ["a", "a"] }),
                ),
                "permissions.clusters.names[1]",
                "listed twice",
            ),
            (
                with(
                    minimal(),
                    "/permissions/clusters",
                    json!({ "type": "only", "names": [" "] }),
                ),
                "permissions.clusters.names[0]",
                "must not be blank",
            ),
            (
                with(
                    full(),
                    "/permissions/rules/0/actions",
                    json!(["read", "exec"]),
                ),
                "permissions.rules[0].actions[1]",
                "must be one of: `read`, `modify`, `delete`, `logs`, `secretValues`",
            ),
            (
                with(
                    full(),
                    "/permissions/rules/0/actions",
                    json!(["portForward"]),
                ),
                "permissions.rules[0].actions[0]",
                "must be one of",
            ),
            (
                with(full(), "/permissions/rules/0/actions", json!([])),
                "permissions.rules[0].actions",
                "must not be empty",
            ),
            (
                with(
                    full(),
                    "/permissions/rules/0/actions",
                    json!(["read", "read"]),
                ),
                "permissions.rules[0].actions[1]",
                "listed twice",
            ),
            (
                with(full(), "/permissions/rules/1/confirm", json!("yes")),
                "permissions.rules[1].confirm",
                "true or false",
            ),
            (
                with(
                    full(),
                    "/permissions/rules/1/namespaces",
                    json!({ "type": "only", "namespaces": [] }),
                ),
                "permissions.rules[1].namespaces.namespaces",
                "must not be empty",
            ),
            (
                with(
                    full(),
                    "/permissions/rules/1/kinds",
                    json!({ "type": "only", "kinds": [{ "group": "", "kind": "" }] }),
                ),
                "permissions.rules[1].kinds.kinds[0].kind",
                "must not be empty",
            ),
            (
                with(full(), "/contributes/pages", json!({})),
                "contributes.pages",
                "must be a list",
            ),
            (
                with(full(), "/contributes/pages/0/id", json!("Overview")),
                "contributes.pages[0].id",
                "lowercase letters",
            ),
            (
                with(full(), "/contributes/pages/0/id", json!("a".repeat(41))),
                "contributes.pages[0].id",
                "at most 40",
            ),
            (
                with(full(), "/contributes/pages/0/title", json!("")),
                "contributes.pages[0].title",
                "must not be empty",
            ),
            (
                with(full(), "/contributes/pages/0/title", json!("t".repeat(81))),
                "contributes.pages[0].title",
                "at most 80",
            ),
            (
                with(full(), "/contributes/pages/0/section", json!("my section")),
                "contributes.pages[0].section",
                "must be a name",
            ),
            (
                with(full(), "/contributes/pages/0/order", json!(1.5)),
                "contributes.pages[0].order",
                "whole number",
            ),
            (
                with(full(), "/contributes/pages/0/order", json!(10001)),
                "contributes.pages[0].order",
                "at most 10000",
            ),
            (
                with(
                    full(),
                    "/contributes/detailsSections/0/placement",
                    json!("panel"),
                ),
                "contributes.detailsSections[0].placement",
                "must be one of: `section`, `tab`",
            ),
            (
                with(full(), "/contributes/detailsSections/0/kinds", json!([])),
                "contributes.detailsSections[0].kinds",
                "must not be empty",
            ),
            (
                with(full(), "/contributes/actions/0/danger", json!(1)),
                "contributes.actions[0].danger",
                "true or false",
            ),
            (
                with(
                    full(),
                    "/contributes/columns/0/jsonPath",
                    json!("spec.size"),
                ),
                "contributes.columns[0].jsonPath",
                "JSONPath",
            ),
            (
                with(full(), "/contributes/columns/0/jsonPath", json!(".spec[")),
                "contributes.columns[0].jsonPath",
                "JSONPath",
            ),
            (
                with(
                    full(),
                    "/contributes/columns/0/jsonPath",
                    json!(".spec[?(x)]"),
                ),
                "contributes.columns[0].jsonPath",
                "JSONPath",
            ),
            (
                with(full(), "/contributes/columns/0/jsonPath", json!("$")),
                "contributes.columns[0].jsonPath",
                "JSONPath",
            ),
            (
                with(full(), "/contributes/columns/0/jsonPath", json!(".a..b")),
                "contributes.columns[0].jsonPath",
                "JSONPath",
            ),
            (
                with(full(), "/contributes/settings", json!([])),
                "contributes.settings",
                "must be an object",
            ),
        ];
        for (value, path, part) in cases {
            let (got_path, message) = fails(&value);
            assert_eq!(got_path, path, "{message}");
            assert!(message.contains(part), "{path}: {message:?} lacks {part:?}");
        }
    }

    #[test]
    fn ids_and_entries_named_like_windows_devices_or_with_trailing_dots_are_refused() {
        for id in [
            "nul",
            "con",
            "aux",
            "prn",
            "com1",
            "lpt9",
            "con.tools",
            "nul.x-y",
        ] {
            let (path, message) = fails(&with(minimal(), "/id", json!(id)));
            assert_eq!(path, "id", "{id}");
            assert!(message.contains("Windows device name"), "{id}: {message}");
        }
        for id in [
            "console",
            "null-check",
            "com10",
            "auxiliary",
            "lpt-tools",
            "my.con",
        ] {
            assert!(parse(&with(minimal(), "/id", json!(id))).is_ok(), "{id}");
        }
        for entry in [
            "nul.html",
            "CON/index.html",
            "com1.html",
            "COM0.html",
            "lpt0/index.html",
            "Lpt3 .html",
            "NODE_MODULES/x/index.html",
            "dist./index.html",
            "dist /index.html",
            ".hidden/index.html",
            "node_modules/x/index.html",
            "a?b.html",
            "a|b.html",
        ] {
            let (path, message) = fails(&with(minimal(), "/entry", json!(entry)));
            assert_eq!(path, "entry", "{entry}");
            assert!(
                message.contains(".html file inside the package"),
                "{entry}: {message}"
            );
        }
        for entry in [
            "console.html",
            "dist/index.htm",
            "a.b/index.html",
            "nullable/index.html",
        ] {
            assert!(
                parse(&with(minimal(), "/entry", json!(entry))).is_ok(),
                "{entry}"
            );
        }
    }

    #[test]
    fn contribution_ids_are_unique_per_type() {
        let page = json!({ "id": "overview", "title": "Again", "section": "workloads" });
        let mut value = full();
        value["contributes"]["pages"]
            .as_array_mut()
            .unwrap()
            .push(page);
        let (path, message) = fails(&value);
        assert_eq!(path, "contributes.pages[2].id");
        assert!(
            message.contains("`overview`") && message.contains("contributes.pages[0]"),
            "{message}"
        );

        let column = json!({ "kind": { "group": "", "kind": "Pod" }, "id": "size", "title": "Size", "jsonPath": ".a" });
        let mut value = full();
        value["contributes"]["columns"]
            .as_array_mut()
            .unwrap()
            .push(column);
        assert_eq!(fails(&value).0, "contributes.columns[3].id");

        // The same id in different contribution types is fine.
        let mut value = full();
        value["contributes"]["dockActions"][0]["id"] = json!("overview");
        value["contributes"]["actions"][0]["id"] = json!("overview");
        assert!(parse(&value).is_ok());
    }

    #[test]
    fn json_paths_of_the_frontend_evaluator_are_accepted() {
        for path in [
            ".spec.size",
            "$.spec.size",
            "{.spec.size}",
            ".items[0].name",
            ".items[-1]",
            ".items[*].name",
            ".metadata.*",
            ".metadata.labels['app\\.kubernetes\\.io/name']",
            ".metadata.labels[\"a\"]",
            ".status.conditions[?(@.type==\"Ready\")].status",
            ".status.conditions[?(@.type != 'Ready')].status",
            ".status.conditions[?(@.reason)]",
            ".a\\.b",
        ] {
            assert!(is_supported_json_path(path), "{path}");
        }
        for path in [
            "",
            "spec",
            "$",
            "{}",
            ".",
            ".a.",
            ".a[",
            ".a[]",
            ".a[x]",
            ".a[?(@)]",
            ".a[?(type==1)]",
        ] {
            assert!(!is_supported_json_path(path), "{path:?}");
        }
    }

    #[test]
    fn the_schema_file_accepts_the_full_example_and_rejects_the_error_cases() {
        // The schema the SDK uses is the one Sextant checks with: the same verdicts as `parse_manifest` for
        // everything structural.
        let schema = schema::manifest_schema();
        assert!(schema::validate(&schema, &full()).is_ok());
        assert!(schema::validate(&schema, &minimal()).is_ok());
        let rejected = [
            with(minimal(), "/extra", json!(1)),
            without(minimal(), "/entry"),
            with(minimal(), "/sextantApi", json!(2)),
            with(minimal(), "/id", json!("Bad Id")),
            with(full(), "/permissions/rules/0/actions", json!(["exec"])),
            with(full(), "/contributes/columns/0/jsonPath", json!("nope")),
            with(full(), "/contributes/pages/0/title", json!("")),
            with(
                full(),
                "/contributes/detailsSections/0/placement",
                json!("x"),
            ),
        ];
        for value in rejected {
            assert!(schema::validate(&schema, &value).is_err(), "{value}");
        }
    }

    /// The cases the SDK's validator is tested against (`sdk/test/fixtures/manifest-cases.json`, built as
    /// `sdk/test/cases.ts` builds them): Sextant accepts and refuses the same manifests, with the same `path` and a
    /// message that contains the case's.
    #[test]
    fn the_shared_manifest_cases_are_accepted_and_refused_as_the_sdk_does() {
        const CASES: &str = include_str!("../../../../sdk/test/fixtures/manifest-cases.json");
        let cases: Value = serde_json::from_str(CASES).unwrap();
        /// A JSON pointer's parent segments and its last one (`~1` and `~0` undone).
        fn split(pointer: &str) -> (Vec<String>, String) {
            let mut parts: Vec<String> = pointer
                .split('/')
                .skip(1)
                .map(|part| part.replace("~1", "/").replace("~0", "~"))
                .collect();
            let last = parts.pop().unwrap_or_else(|| panic!("pointer {pointer:?}"));
            (parts, last)
        }
        fn parent_of<'a>(mut node: &'a mut Value, parents: &[String]) -> &'a mut Value {
            for part in parents {
                node = match node {
                    Value::Array(items) => &mut items[part.parse::<usize>().unwrap()],
                    other => &mut other[part.as_str()],
                };
            }
            node
        }
        let build = |case: &Value| -> Value {
            let base = case["base"].as_str().unwrap();
            let mut value = cases["bases"][base].clone();
            assert!(!value.is_null(), "no base {base}");
            for (pointer, field) in case["set"].as_object().into_iter().flatten() {
                let (parents, last) = split(pointer);
                match parent_of(&mut value, &parents) {
                    Value::Array(items) => {
                        let index: usize = last.parse().unwrap();
                        if index == items.len() {
                            items.push(field.clone());
                        } else {
                            items[index] = field.clone();
                        }
                    }
                    Value::Object(object) => {
                        object.insert(last, field.clone());
                    }
                    other => panic!("{pointer}: the parent is {other}"),
                }
            }
            for pointer in case["remove"].as_array().into_iter().flatten() {
                let (parents, last) = split(pointer.as_str().unwrap());
                if let Value::Object(object) = parent_of(&mut value, &parents) {
                    object.remove(&last);
                }
            }
            value
        };

        let valid = cases["valid"].as_array().unwrap();
        let invalid = cases["invalid"].as_array().unwrap();
        assert!(
            valid.len() + invalid.len() >= 100,
            "the fixture lost its cases"
        );
        let mut wrong = Vec::new();
        for case in valid {
            if let Err(err) = parse(&build(case)) {
                wrong.push(format!("{}: refused ({err})", case["name"]));
            }
        }
        for case in invalid {
            let (path, message) = (
                case["path"].as_str().unwrap(),
                case["message"].as_str().unwrap(),
            );
            match parse(&build(case)) {
                Ok(_) => wrong.push(format!("{}: accepted", case["name"])),
                Err(err) if err.path != path || !err.message.contains(message) => {
                    wrong.push(format!(
                        "{}: refused as {:?}: {:?}, the case says {path:?}: {message:?}",
                        case["name"], err.path, err.message
                    ))
                }
                Err(_) => {}
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }
}
