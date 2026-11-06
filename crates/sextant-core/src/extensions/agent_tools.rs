//! Tools an extension gives AI agents in Sextant's MCP server (`contributes.agentTools`, ADR-0159).
//!
//! A tool is a name, a description and the JSON Schema of its arguments; the extension's backend (ADR-0131) answers
//! it (`handle("agentTool:<id>", arguments)`). The user agrees to the tools word for word at install
//! (`grantedAgentTools`) and lets agents have them per extension (`AppSettings.mcp.extensionTools`, off by default).
//! Every call the backend makes while it answers an agent is decided against the extension's grant and the agent's
//! own access rules both (the Tauri layer).
//!
//! Here: what reading a manifest checks — the API version, a backend to answer, a name MCP accepts
//! ([`mcp_tool_name`]), and an argument schema of a small JSON Schema subset ([`check_input_schema`]).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::manifest::{ExtensionManifest, ManifestError};
use super::schema::JsonPath;

/// The extension API version that brought `contributes.agentTools`.
pub const AGENT_TOOLS_API: u32 = 4;
/// Longest MCP tool name.
pub const MAX_TOOL_NAME_CHARS: usize = 64;
/// An argument schema, serialized, at most.
pub const MAX_SCHEMA_BYTES: usize = 8 * 1024;
/// Nesting of an argument schema: the root is level 1.
pub const MAX_SCHEMA_DEPTH: usize = 4;
/// The method of the backend that answers the tool `id`: `agentTool:<id>`.
pub const METHOD_PREFIX: &str = "agentTool:";

/// A tool for AI agents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentToolContribution {
    pub id: String,
    /// Shown to the user (consent, settings).
    pub title: String,
    /// What the agent reads to choose the tool.
    pub description: String,
    /// The JSON Schema of its arguments: an object (a subset: types, properties, required, items, enum, bounds).
    #[ts(type = "Record<string, unknown>")]
    pub input_schema: Value,
    /// It only reads: agents' clients show it as such. Default `false`.
    #[serde(default)]
    pub read_only: bool,
}

/// The MCP name of an extension's tool: `ext_<extension id, dots as _>__<tool id>`. Extension and tool ids have no
/// `_`, so the name is the pair's own.
pub fn mcp_tool_name(extension_id: &str, tool_id: &str) -> String {
    format!("ext_{}__{tool_id}", extension_id.replace('.', "_"))
}

/// What reading a manifest checks of its agent tools beyond the schema.
pub(crate) fn check_agent_tools(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let tools = &manifest.contributes.agent_tools;
    let list = JsonPath::default().key("contributes").key("agentTools");
    if tools.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < AGENT_TOOLS_API {
        return Err(at(
            &list,
            format!("needs sextantApi {AGENT_TOOLS_API} or later"),
        ));
    }
    if manifest.backend.is_none() {
        return Err(at(
            &list,
            "needs a `backend`: the extension's backend answers the tools",
        ));
    }
    for (i, tool) in tools.iter().enumerate() {
        let here = list.index(i);
        let name = mcp_tool_name(&manifest.id, &tool.id);
        if name.chars().count() > MAX_TOOL_NAME_CHARS {
            return Err(at(
                &here.key("id"),
                format!(
                    "with the extension's id the tool's name `{name}` is longer than {MAX_TOOL_NAME_CHARS} characters"
                ),
            ));
        }
        let size = tool.input_schema.to_string().len();
        if size > MAX_SCHEMA_BYTES {
            return Err(at(
                &here.key("inputSchema"),
                format!("is larger than {MAX_SCHEMA_BYTES} bytes"),
            ));
        }
        check_input_schema(&tool.input_schema, &here.key("inputSchema"))?;
    }
    Ok(())
}

/// The root is `{"type": "object", …}`; every node uses only the keywords of [`check_node`].
pub(crate) fn check_input_schema(schema: &Value, path: &JsonPath) -> Result<(), ManifestError> {
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return Err(at(
            &path.key("type"),
            "the arguments are an object: `\"type\": \"object\"`",
        ));
    }
    check_node(schema, path, 1)
}

const KEYWORDS: [&str; 13] = [
    "type",
    "description",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
];
const TYPES: [&str; 6] = ["object", "string", "number", "integer", "boolean", "array"];

fn check_node(node: &Value, path: &JsonPath, depth: usize) -> Result<(), ManifestError> {
    let Some(map) = node.as_object() else {
        return Err(at(path, "must be a schema object"));
    };
    if depth > MAX_SCHEMA_DEPTH {
        return Err(at(
            path,
            format!("schemas nest at most {MAX_SCHEMA_DEPTH} deep"),
        ));
    }
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    if let Some(unknown) = keys.iter().find(|k| !KEYWORDS.contains(&k.as_str())) {
        return Err(at(
            &path.key(unknown),
            format!("`{unknown}` is not a keyword Sextant reads in an argument schema"),
        ));
    }
    let kind = map.get("type").and_then(Value::as_str);
    if !kind.is_some_and(|t| TYPES.contains(&t)) {
        return Err(at(
            &path.key("type"),
            "must be one of: `object`, `string`, `number`, `integer`, `boolean`, `array`",
        ));
    }
    if let Some(description) = map.get("description")
        && !description
            .as_str()
            .is_some_and(|d| d.chars().count() <= 500)
    {
        return Err(at(
            &path.key("description"),
            "must be text of at most 500 characters",
        ));
    }
    for bound in ["minimum", "maximum"] {
        if map.get(bound).is_some_and(|v| !v.is_number()) {
            return Err(at(&path.key(bound), "must be a number"));
        }
    }
    for bound in ["minLength", "maxLength", "minItems", "maxItems"] {
        if map.get(bound).is_some_and(|v| v.as_u64().is_none()) {
            return Err(at(&path.key(bound), "must be a whole number of 0 or more"));
        }
    }
    if let Some(values) = map.get("enum") {
        let ok = values.as_array().is_some_and(|items| {
            !items.is_empty()
                && items.len() <= 50
                && items
                    .iter()
                    .all(|v| v.is_string() || v.is_number() || v.is_boolean())
        });
        if !ok {
            return Err(at(
                &path.key("enum"),
                "must list 1 to 50 strings, numbers or booleans",
            ));
        }
    }
    if map
        .get("additionalProperties")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(at(
            &path.key("additionalProperties"),
            "must be true or false",
        ));
    }
    if kind != Some("object") {
        for key in ["properties", "required", "additionalProperties"] {
            if map.contains_key(key) {
                return Err(at(&path.key(key), "goes only with `\"type\": \"object\"`"));
            }
        }
    }
    if kind != Some("array") && map.contains_key("items") {
        return Err(at(
            &path.key("items"),
            "goes only with `\"type\": \"array\"`",
        ));
    }
    let properties = match map.get("properties") {
        Some(Value::Object(properties)) => Some(properties),
        Some(_) => return Err(at(&path.key("properties"), "must be an object of schemas")),
        None => None,
    };
    if let Some(properties) = properties {
        let mut names: Vec<&String> = properties.keys().collect();
        names.sort();
        for name in names {
            let ok = (1..=64).contains(&name.len())
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
            if !ok {
                return Err(at(
                    &path.key("properties").key(name),
                    "a property name has 1 to 64 letters, digits, `_` and `-`",
                ));
            }
            check_node(
                &properties[name],
                &path.key("properties").key(name),
                depth + 1,
            )?;
        }
    }
    if let Some(required) = map.get("required") {
        let names = required
            .as_array()
            .filter(|items| items.iter().all(Value::is_string));
        let Some(names) = names else {
            return Err(at(&path.key("required"), "must list property names"));
        };
        for (i, name) in names.iter().enumerate() {
            let known =
                properties.is_some_and(|p| p.contains_key(name.as_str().unwrap_or_default()));
            if !known {
                return Err(at(
                    &path.key("required").index(i),
                    "is not one of `properties`",
                ));
            }
        }
    }
    if let Some(items) = map.get("items") {
        check_node(items, &path.key("items"), depth + 1)?;
    }
    Ok(())
}

/// Whether every agent tool of `manifest` was agreed to as it is now written.
pub fn agent_tools_within(
    manifest: &ExtensionManifest,
    granted: Option<&[AgentToolContribution]>,
) -> bool {
    let tools = &manifest.contributes.agent_tools;
    tools.is_empty() || granted.is_some_and(|granted| tools.iter().all(|t| granted.contains(t)))
}

fn at(path: &JsonPath, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.to_string(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_name_is_the_pair_of_ids_mcp_accepts() {
        assert_eq!(
            mcp_tool_name("sextant.argo-cd", "sync"),
            "ext_sextant_argo-cd__sync"
        );
    }
}
