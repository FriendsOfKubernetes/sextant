//! The manifest's JSON Schema and the small validator that reads it, so the schema the SDK and editors use and the
//! check Sextant makes are one file.
//!
//! Only the keywords the schema uses are understood; any other keyword is an error (a schema edit that needs more
//! must teach the validator first). `pattern` is not evaluated here: every string with a `pattern` also names a
//! `format`, which is checked by code ([`check_format`]). `oneOf` whose branches each fix `type` with `const` is read
//! as a tagged union, so the error comes from the branch the value names.

use serde_json::Value;

use super::manifest::ManifestError;

/// `manifest.schema.json`: the JSON Schema (draft 2020-12) of `sextant-extension.json`.
pub const MANIFEST_SCHEMA: &str = include_str!("manifest.schema.json");

/// Keywords that only describe; they never fail a value.
const ANNOTATIONS: &[&str] = &[
    "$schema",
    "$id",
    "$defs",
    "$comment",
    "title",
    "description",
    "default",
    "examples",
    "pattern",
];

/// Keywords the validator checks.
const ASSERTIONS: &[&str] = &[
    "$ref",
    "type",
    "const",
    "enum",
    "oneOf",
    "properties",
    "required",
    "additionalProperties",
    "maxProperties",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "format",
];

/// Where a value is in the manifest: `contributes.pages[0].id`.
#[derive(Debug, Clone, Default)]
pub(crate) struct JsonPath(Vec<Segment>);

#[derive(Debug, Clone)]
enum Segment {
    Key(String),
    Index(usize),
}

impl JsonPath {
    pub(crate) fn key(&self, key: &str) -> Self {
        let mut next = self.clone();
        next.0.push(Segment::Key(key.to_owned()));
        next
    }

    pub(crate) fn index(&self, index: usize) -> Self {
        let mut next = self.clone();
        next.0.push(Segment::Index(index));
        next
    }
}

impl std::fmt::Display for JsonPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (i, segment) in self.0.iter().enumerate() {
            match segment {
                Segment::Key(key) if i == 0 => write!(f, "{key}")?,
                Segment::Key(key) => write!(f, ".{key}")?,
                Segment::Index(index) => write!(f, "[{index}]")?,
            }
        }
        Ok(())
    }
}

fn error(path: &JsonPath, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.to_string(),
        message: message.into(),
    }
}

/// The parsed schema.
pub(crate) fn manifest_schema() -> Value {
    serde_json::from_str(MANIFEST_SCHEMA).expect("manifest.schema.json is valid JSON")
}

/// Checks `value` against `schema` (the root, for `$ref`); the first problem found, in a stable order.
pub(crate) fn validate(schema: &Value, value: &Value) -> Result<(), ManifestError> {
    check(schema, schema, value, &JsonPath::default())
}

fn check(
    root: &Value,
    schema: &Value,
    value: &Value,
    path: &JsonPath,
) -> Result<(), ManifestError> {
    let Some(keywords) = schema.as_object() else {
        return Err(error(path, "internal: a schema node is not an object"));
    };
    if let Some(unknown) = keywords
        .keys()
        .find(|k| !ANNOTATIONS.contains(&k.as_str()) && !ASSERTIONS.contains(&k.as_str()))
    {
        return Err(error(
            path,
            format!("internal: unsupported schema keyword `{unknown}`"),
        ));
    }
    if let Some(reference) = keywords.get("$ref") {
        let target = reference
            .as_str()
            .and_then(|r| r.strip_prefix("#/$defs/"))
            .and_then(|name| root.get("$defs")?.get(name))
            .ok_or_else(|| error(path, format!("internal: unresolved $ref {reference}")))?;
        check(root, target, value, path)?;
    }
    if let Some(branches) = keywords.get("oneOf").and_then(Value::as_array) {
        check_one_of(root, branches, value, path)?;
    }
    if let Some(expected) = keywords.get("type").and_then(Value::as_str) {
        check_type(expected, value, path)?;
    }
    if let Some(expected) = keywords.get("const")
        && value != expected
    {
        return Err(error(path, format!("must be {}", show(expected))));
    }
    if let Some(allowed) = keywords.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        let list: Vec<String> = allowed.iter().map(show).collect();
        return Err(error(path, format!("must be one of: {}", list.join(", "))));
    }
    match value {
        Value::String(text) => check_string(keywords, text, path)?,
        Value::Number(number) => check_number(keywords, number, path)?,
        Value::Array(items) => check_array(root, keywords, items, path)?,
        Value::Object(fields) => check_object(root, keywords, fields, path)?,
        Value::Bool(_) | Value::Null => {}
    }
    Ok(())
}

/// A tagged union (every branch fixes `type` with `const`) is checked against the branch the value names; any other
/// `oneOf` needs exactly one branch to match.
fn check_one_of(
    root: &Value,
    branches: &[Value],
    value: &Value,
    path: &JsonPath,
) -> Result<(), ManifestError> {
    let tags: Option<Vec<&Value>> = branches
        .iter()
        .map(|b| b.get("properties")?.get("type")?.get("const"))
        .collect();
    if let Some(tags) = tags {
        let Some(fields) = value.as_object() else {
            return Err(error(path, "must be an object"));
        };
        let tag_path = path.key("type");
        let Some(tag) = fields.get("type") else {
            return Err(error(&tag_path, "is required"));
        };
        return match tags.iter().position(|t| *t == tag) {
            Some(i) => check(root, &branches[i], value, path),
            None => {
                let list: Vec<String> = tags.iter().map(|t| show(t)).collect();
                Err(error(
                    &tag_path,
                    format!("must be one of: {}", list.join(", ")),
                ))
            }
        };
    }
    let matching = branches
        .iter()
        .filter(|b| check(root, b, value, path).is_ok())
        .count();
    if matching == 1 {
        Ok(())
    } else {
        Err(error(path, "does not match any of the allowed shapes"))
    }
}

fn check_type(expected: &str, value: &Value, path: &JsonPath) -> Result<(), ManifestError> {
    let (ok, message) = match expected {
        "object" => (value.is_object(), "must be an object"),
        "array" => (value.is_array(), "must be a list"),
        "string" => (value.is_string(), "must be a string"),
        "integer" => (value.is_i64() || value.is_u64(), "must be a whole number"),
        "number" => (value.is_number(), "must be a number"),
        "boolean" => (value.is_boolean(), "must be true or false"),
        other => {
            return Err(error(
                path,
                format!("internal: unsupported schema type `{other}`"),
            ));
        }
    };
    if ok {
        Ok(())
    } else {
        Err(error(path, message))
    }
}

fn limit(keywords: &serde_json::Map<String, Value>, name: &str) -> Option<u64> {
    keywords.get(name).and_then(Value::as_u64)
}

fn check_string(
    keywords: &serde_json::Map<String, Value>,
    text: &str,
    path: &JsonPath,
) -> Result<(), ManifestError> {
    let length = text.chars().count() as u64;
    if let Some(min) = limit(keywords, "minLength")
        && length < min
    {
        return Err(error(
            path,
            if min == 1 {
                "must not be empty".to_owned()
            } else {
                format!("must be at least {min} characters")
            },
        ));
    }
    if let Some(max) = limit(keywords, "maxLength")
        && length > max
    {
        return Err(error(path, format!("must be at most {max} characters")));
    }
    if let Some(format) = keywords.get("format").and_then(Value::as_str) {
        check_format(format, text).map_err(|message| error(path, message))?;
    }
    Ok(())
}

fn check_number(
    keywords: &serde_json::Map<String, Value>,
    number: &serde_json::Number,
    path: &JsonPath,
) -> Result<(), ManifestError> {
    // Without serde_json's `arbitrary_precision` every JSON number has an f64 value.
    let value = number.as_f64().unwrap_or_default();
    if let Some(min) = keywords.get("minimum").and_then(Value::as_f64)
        && value < min
    {
        return Err(error(path, format!("must be at least {min}")));
    }
    if let Some(max) = keywords.get("maximum").and_then(Value::as_f64)
        && value > max
    {
        return Err(error(path, format!("must be at most {max}")));
    }
    Ok(())
}

fn check_array(
    root: &Value,
    keywords: &serde_json::Map<String, Value>,
    items: &[Value],
    path: &JsonPath,
) -> Result<(), ManifestError> {
    let count = items.len() as u64;
    if let Some(min) = limit(keywords, "minItems")
        && count < min
    {
        return Err(error(
            path,
            if min == 1 {
                "must not be empty".to_owned()
            } else {
                format!("must have at least {min} items")
            },
        ));
    }
    if let Some(max) = limit(keywords, "maxItems")
        && count > max
    {
        return Err(error(path, format!("must have at most {max} items")));
    }
    if keywords.get("uniqueItems") == Some(&Value::Bool(true)) {
        for (i, item) in items.iter().enumerate() {
            if items[..i].contains(item) {
                return Err(error(
                    &path.index(i),
                    format!("{} is listed twice", show(item)),
                ));
            }
        }
    }
    if let Some(item_schema) = keywords.get("items") {
        for (i, item) in items.iter().enumerate() {
            check(root, item_schema, item, &path.index(i))?;
        }
    }
    Ok(())
}

fn check_object(
    root: &Value,
    keywords: &serde_json::Map<String, Value>,
    fields: &serde_json::Map<String, Value>,
    path: &JsonPath,
) -> Result<(), ManifestError> {
    let properties = keywords.get("properties").and_then(Value::as_object);
    let known = |key: &str| properties.is_some_and(|p| p.contains_key(key));
    if keywords.get("additionalProperties") == Some(&Value::Bool(false))
        && let Some(unknown) = fields.keys().find(|k| !known(k))
    {
        return Err(error(&path.key(unknown), "unknown field"));
    }
    if let Some(max) = limit(keywords, "maxProperties")
        && fields.len() as u64 > max
    {
        return Err(error(path, format!("must have at most {max} entries")));
    }
    if let Some(required) = keywords.get("required").and_then(Value::as_array) {
        for name in required.iter().filter_map(Value::as_str) {
            if !fields.contains_key(name) {
                return Err(error(&path.key(name), "is required"));
            }
        }
    }
    if let Some(properties) = properties {
        for (name, value) in fields {
            if let Some(property) = properties.get(name) {
                check(root, property, value, &path.key(name))?;
            }
        }
    }
    // A map: every other field is checked against one schema.
    if let Some(other) = keywords
        .get("additionalProperties")
        .filter(|v| v.is_object())
    {
        for (name, value) in fields {
            if !known(name) {
                check(root, other, value, &path.key(name))?;
            }
        }
    }
    Ok(())
}

/// A JSON value as the error message quotes it: strings in backticks, the rest as JSON.
fn show(value: &Value) -> String {
    match value {
        Value::String(s) => format!("`{s}`"),
        other => other.to_string(),
    }
}

/// Sextant's own string formats; `Err` is the message for the field.
pub(crate) fn check_format(format: &str, text: &str) -> Result<(), String> {
    use super::manifest as m;
    let (ok, message) = match format {
        "extension-id" => (
            m::is_extension_id(text),
            "must be 3–64 characters: lowercase letters, digits, `.` and `-`, starting with a letter or digit, \
             not ending with `.`, without `..`, and not a Windows device name such as `nul` or `con`",
        ),
        "contribution-id" => (
            m::is_contribution_id(text),
            "must be 1–40 characters: lowercase letters, digits and `-`",
        ),
        "semver" => (
            m::is_semver(text),
            "must be a semantic version such as 1.0.0 or 1.2.0-beta.1",
        ),
        "entry-path" => (
            m::is_servable_path(text) && m::is_html_path(text),
            "must be an .html file inside the package: a relative path with `/`, without `..`, `.`, `\\`, `:` or \
             other characters Windows forbids, no part starting with `.`, named `node_modules`, ending with `.` or a \
             space, or named like a Windows device (`nul`, `con`, `com1`, …)",
        ),
        "wasm-path" => (
            m::is_wasm_path(text),
            "must be a .wasm file inside the package: a relative path with `/`, without `..`, `.`, `\\`, `:` or \
             other characters Windows forbids, no part starting with `.` or named `node_modules`",
        ),
        "host-name" => (
            m::is_host_name(text),
            "must be a lower-case host name such as api.example.com: no scheme, port, path, wildcard or IP address, \
             and not localhost",
        ),
        "identifier" => (
            m::is_identifier(text),
            "must be a name of letters, digits and `-`, starting with a letter",
        ),
        "non-blank" => (!text.trim().is_empty(), "must not be blank"),
        "json-path" => (
            m::is_supported_json_path(text),
            "is not a JSONPath Sextant understands (as in CRD printer columns, e.g. .spec.replicas)",
        ),
        other => return Err(format!("internal: unsupported schema format `{other}`")),
    };
    if ok { Ok(()) } else { Err(message.to_owned()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Every keyword anywhere in the schema is one the validator knows, every `format` is implemented, and every
    /// `pattern` comes with a `format` (the validator does not run regular expressions).
    #[test]
    fn the_schema_uses_only_what_the_validator_implements() {
        fn walk(node: &Value, at: &str) {
            let Some(object) = node.as_object() else {
                return;
            };
            for (key, value) in object {
                assert!(
                    ANNOTATIONS.contains(&key.as_str()) || ASSERTIONS.contains(&key.as_str()),
                    "unsupported keyword {key} at {at}"
                );
                match key.as_str() {
                    "properties" | "$defs" => {
                        for (name, child) in value.as_object().unwrap() {
                            walk(child, &format!("{at}/{key}/{name}"));
                        }
                    }
                    "items" => walk(value, &format!("{at}/items")),
                    "oneOf" => {
                        for (i, branch) in value.as_array().unwrap().iter().enumerate() {
                            walk(branch, &format!("{at}/oneOf/{i}"));
                        }
                    }
                    "format" => {
                        let format = value.as_str().unwrap();
                        let message = check_format(format, "").err().unwrap_or_default();
                        assert!(!message.starts_with("internal"), "format {format} at {at}");
                    }
                    "pattern" => assert!(
                        object.contains_key("format"),
                        "pattern without format at {at}"
                    ),
                    _ => {}
                }
            }
        }
        walk(&manifest_schema(), "#");
    }

    #[test]
    fn paths_name_keys_and_indexes() {
        let schema = json!({
            "type": "object",
            "properties": {
                "list": { "type": "array", "items": { "type": "object", "additionalProperties": false,
                          "properties": { "a": { "type": "string" } } } }
            }
        });
        let err = validate(&schema, &json!({ "list": [{ "a": "x" }, { "a": 1 }] })).unwrap_err();
        assert_eq!(
            (err.path.as_str(), err.message.as_str()),
            ("list[1].a", "must be a string")
        );
        let err = validate(&schema, &json!({ "list": [{ "b": "x" }] })).unwrap_err();
        assert_eq!(
            (err.path.as_str(), err.message.as_str()),
            ("list[0].b", "unknown field")
        );
    }

    #[test]
    fn an_unknown_keyword_is_an_error_not_a_pass() {
        let schema =
            json!({ "type": "string", "pattern": "^a$", "format": "non-blank", "multipleOf": 2 });
        let err = validate(&schema, &json!("a")).unwrap_err();
        assert!(err.message.contains("multipleOf"), "{err:?}");
    }

    #[test]
    fn a_tagged_union_reports_the_named_branch() {
        let schema = json!({ "oneOf": [
            { "type": "object", "additionalProperties": false, "required": ["type"],
              "properties": { "type": { "const": "all" } } },
            { "type": "object", "additionalProperties": false, "required": ["type", "names"],
              "properties": { "type": { "const": "only" }, "names": { "type": "array" } } }
        ] });
        assert!(validate(&schema, &json!({ "type": "all" })).is_ok());
        assert!(validate(&schema, &json!({ "type": "only", "names": [] })).is_ok());
        let err = validate(&schema, &json!({ "type": "only" })).unwrap_err();
        assert_eq!(
            (err.path.as_str(), err.message.as_str()),
            ("names", "is required")
        );
        let err = validate(&schema, &json!({ "type": "all", "names": [] })).unwrap_err();
        assert_eq!(
            (err.path.as_str(), err.message.as_str()),
            ("names", "unknown field")
        );
        let err = validate(&schema, &json!({ "type": "some" })).unwrap_err();
        assert_eq!(
            (err.path.as_str(), err.message.as_str()),
            ("type", "must be one of: `all`, `only`")
        );
        let err = validate(&schema, &json!("all")).unwrap_err();
        assert_eq!(err.message, "must be an object");
    }
}
