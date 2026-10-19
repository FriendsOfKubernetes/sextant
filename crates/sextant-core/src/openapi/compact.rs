//! An OpenAPI v3 document reduced to [`SchemaNode`]s, and the schema of one kind cut out of it.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

use super::{DESCRIPTION_LIMIT, KindSchema, MAX_DEFINITIONS, MAX_DEPTH, MAX_NODES, SchemaNode};

const REF_PREFIX: &str = "#/components/schemas/";
/// Enum values kept per node; a default whose JSON is longer than [`DESCRIPTION_LIMIT`] is dropped.
const MAX_ENUM_VALUES: usize = 256;

/// The compact definitions of one group/version document and the kinds it defines.
#[derive(Debug, Default)]
pub struct GroupVersionSchemas {
    definitions: HashMap<String, SchemaNode>,
    /// `(group, version, kind)` → the definition's name (`x-kubernetes-group-version-kind`).
    kinds: HashMap<(String, String, String), String>,
}

impl GroupVersionSchemas {
    /// Reduces `components.schemas` of an OpenAPI v3 document; anything else in it (paths, parameters) is ignored.
    pub fn from_document(document: &Value) -> Self {
        let mut out = Self::default();
        let mut builder = Builder { nodes: 0 };
        let schemas = document
            .pointer("/components/schemas")
            .and_then(Value::as_object);
        for (name, schema) in schemas.into_iter().flatten() {
            out.add(&mut builder, name.clone(), schema);
        }
        out
    }

    /// The same as [`GroupVersionSchemas::from_document`] straight from the document's bytes, without holding the
    /// whole parsed document: everything but `components.schemas` is skipped while reading, and each schema is
    /// parsed, reduced and dropped before the next one (see `stream`).
    pub fn from_slice(bytes: &[u8]) -> serde_json::Result<Self> {
        let mut out = Self::default();
        let mut builder = Builder { nodes: 0 };
        let mut reader = serde_json::Deserializer::from_slice(bytes);
        serde::de::DeserializeSeed::deserialize(
            super::stream::Document(&mut |name, schema| out.add(&mut builder, name, &schema)),
            &mut reader,
        )?;
        reader.end()?;
        Ok(out)
    }

    fn add(&mut self, builder: &mut Builder, name: String, schema: &Value) {
        for gvk in schema
            .get("x-kubernetes-group-version-kind")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let part = |key: &str| gvk.get(key).and_then(Value::as_str).map(str::to_owned);
            if let (Some(group), Some(version), Some(kind)) =
                (part("group"), part("version"), part("kind"))
            {
                self.kinds
                    .entry((group, version, kind))
                    .or_insert_with(|| name.clone());
            }
        }
        let mut node = builder.convert(schema, 0);
        // Older clusters publish both as a plain `type: string`; a number is accepted by the API server all the same.
        if name.ends_with(".api.resource.Quantity") {
            node.types = Some(vec!["string".to_owned(), "number".to_owned()]);
        } else if name.ends_with(".util.intstr.IntOrString") {
            node.types = Some(vec!["integer".to_owned(), "string".to_owned()]);
        }
        self.definitions.insert(name, node);
    }

    /// The number of definitions kept.
    pub fn len(&self) -> usize {
        self.definitions.len()
    }

    /// Whether the document defined nothing.
    pub fn is_empty(&self) -> bool {
        self.definitions.is_empty()
    }

    /// The schema of `group/version/kind`: its definition and every definition reachable from it (at most
    /// [`MAX_DEFINITIONS`]; a reference past that, or to a definition the document lacks, reads as "anything").
    pub fn kind(&self, group: &str, version: &str, kind: &str) -> Option<KindSchema> {
        let key = (group.to_owned(), version.to_owned(), kind.to_owned());
        let root = self.definitions.get(self.kinds.get(&key)?)?.clone();
        let mut definitions = BTreeMap::new();
        let mut pending = Vec::new();
        collect_refs(&root, &mut pending);
        while let Some(name) = pending.pop() {
            if definitions.len() >= MAX_DEFINITIONS || definitions.contains_key(&name) {
                continue;
            }
            if let Some(def) = self.definitions.get(&name) {
                collect_refs(def, &mut pending);
                definitions.insert(name, def.clone());
            }
        }
        Some(KindSchema {
            group: group.to_owned(),
            version: version.to_owned(),
            kind: kind.to_owned(),
            root,
            definitions,
        })
    }
}

/// Every definition name `node` refers to, directly or below it (not through other definitions).
fn collect_refs(node: &SchemaNode, out: &mut Vec<String>) {
    if let Some(name) = &node.reference {
        out.push(name.clone());
    }
    for child in node.properties.iter().flat_map(|p| p.values()) {
        collect_refs(child, out);
    }
    for child in node.items.iter().chain(node.additional_properties.iter()) {
        collect_refs(child, out);
    }
}

/// `text` cut to at most `limit` bytes on a character boundary, ending with `…` when cut.
pub(super) fn clip(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit.saturating_sub('…'.len_utf8());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// Counts the nodes made, so one document cannot grow without bound.
struct Builder {
    nodes: usize,
}

impl Builder {
    fn convert(&mut self, schema: &Value, depth: usize) -> SchemaNode {
        if depth > MAX_DEPTH || self.nodes >= MAX_NODES {
            return SchemaNode {
                truncated: Some(true),
                ..SchemaNode::default()
            };
        }
        self.nodes += 1;
        // `true` (or anything that is not an object) allows anything.
        let Some(obj) = schema.as_object() else {
            return SchemaNode::default();
        };
        let mut node = SchemaNode {
            reference: reference(obj),
            types: types_of(obj),
            format: text(obj, "format"),
            description: text(obj, "description").map(|d| clip(&d, DESCRIPTION_LIMIT)),
            default: obj
                .get("default")
                .filter(|d| d.to_string().len() <= DESCRIPTION_LIMIT)
                .cloned(),
            enum_values: obj
                .get("enum")
                .and_then(Value::as_array)
                .map(|values| values.iter().take(MAX_ENUM_VALUES).cloned().collect()),
            required: obj.get("required").and_then(Value::as_array).map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            }),
            nullable: flag(obj, "nullable"),
            // An embedded object's apiVersion, kind and metadata are allowed without being listed.
            preserve_unknown: flag(obj, "x-kubernetes-preserve-unknown-fields")
                .or(flag(obj, "x-kubernetes-embedded-resource")),
            ..SchemaNode::default()
        };
        if let Some(props) = obj.get("properties").and_then(Value::as_object) {
            let mut converted = BTreeMap::new();
            for (name, child) in props {
                converted.insert(name.clone(), self.convert(child, depth + 1));
            }
            node.properties = Some(converted);
        }
        if let Some(items) = obj.get("items").filter(|i| i.is_object()) {
            node.items = Some(Box::new(self.convert(items, depth + 1)));
        }
        node.additional_properties = match obj.get("additionalProperties") {
            Some(Value::Bool(true)) => Some(Box::default()),
            Some(extra @ Value::Object(_)) => Some(Box::new(self.convert(extra, depth + 1))),
            _ => None,
        };
        // `allOf: [{$ref}]` is how a property names its type next to its own description and default.
        for part in obj
            .get("allOf")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let part = self.convert(part, depth + 1);
            merge(&mut node, part);
        }
        node
    }
}

/// Adds what `node` does not say yet from `other` (a part of `allOf`).
fn merge(node: &mut SchemaNode, other: SchemaNode) {
    node.reference = node.reference.take().or(other.reference);
    node.types = node.types.take().or(other.types);
    node.format = node.format.take().or(other.format);
    node.description = node.description.take().or(other.description);
    node.default = node.default.take().or(other.default);
    node.enum_values = node.enum_values.take().or(other.enum_values);
    node.items = node.items.take().or(other.items);
    node.additional_properties = node
        .additional_properties
        .take()
        .or(other.additional_properties);
    node.preserve_unknown = node.preserve_unknown.or(other.preserve_unknown);
    node.nullable = node.nullable.or(other.nullable);
    node.truncated = node.truncated.or(other.truncated);
    if let Some(required) = other.required {
        node.required.get_or_insert_with(Vec::new).extend(required);
    }
    if let Some(props) = other.properties {
        node.properties
            .get_or_insert_with(BTreeMap::new)
            .extend(props);
    }
}

fn reference(obj: &Map<String, Value>) -> Option<String> {
    let target = obj.get("$ref")?.as_str()?;
    Some(target.strip_prefix(REF_PREFIX).unwrap_or(target).to_owned())
}

/// `type` (a string or, in OpenAPI 3.1, a list), else the types of every `oneOf`/`anyOf` alternative when each
/// names one (`IntOrString`, `Quantity`); `x-kubernetes-int-or-string` is integer or string whatever else is said.
fn types_of(obj: &Map<String, Value>) -> Option<Vec<String>> {
    let named = |types: &[&str]| Some(types.iter().map(|t| (*t).to_owned()).collect());
    // Clusters before about 1.27 publish IntOrString and Quantity as `type: string` with only the format saying more.
    if flag(obj, "x-kubernetes-int-or-string") == Some(true)
        || obj.get("format").and_then(Value::as_str) == Some("int-or-string")
    {
        return named(&["integer", "string"]);
    }
    if obj.get("format").and_then(Value::as_str) == Some("quantity") {
        return named(&["string", "number"]);
    }
    match obj.get("type") {
        Some(Value::String(t)) => return Some(vec![t.clone()]),
        Some(Value::Array(list)) => {
            return Some(
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            );
        }
        _ => {}
    }
    for key in ["oneOf", "anyOf"] {
        let Some(alternatives) = obj.get(key).and_then(Value::as_array) else {
            continue;
        };
        let named: Option<Vec<String>> = alternatives
            .iter()
            .map(|alt| alt.get("type").and_then(Value::as_str).map(str::to_owned))
            .collect();
        if let Some(mut named) = named.filter(|n| !n.is_empty()) {
            named.dedup();
            return Some(named);
        }
    }
    None
}

fn text(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `Some(true)` when `key` is `true`; nothing otherwise, so the JSON stays small.
fn flag(obj: &Map<String, Value>, key: &str) -> Option<bool> {
    (obj.get(key) == Some(&Value::Bool(true))).then_some(true)
}
