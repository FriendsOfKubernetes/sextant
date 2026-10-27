//! Resource-table filters, written by the frontend and checked at the settings boundary.
//!
//! A malformed table is rejected atomically, including any bad child of an OR. Cluster maps keep valid entries
//! independently, at most 512 in key order. Empty value selections and columns are removed; an empty root group
//! means no advanced restriction, a single-child group becomes its child, and nested empty groups are rejected
//! rather than silently changing an OR. Caps apply before normalization. No display units or UI ids are persisted.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const MAX_TABLES: usize = 512;
pub const MAX_COLUMNS: usize = 200;
pub const MAX_NODES: usize = 200;
pub const MAX_CONDITIONS: usize = 200;
pub const MAX_DEPTH: usize = 8;
pub const MAX_VALUES: usize = 1000;
pub const MAX_TEXT_CHARS: usize = 1000;
pub const MAX_ID_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum FilterValue {
    String(String),
    Number(#[ts(type = "number")] serde_json::Number),
    Boolean(bool),
    Null,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FilterMode {
    Include,
    Exclude,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct FilterValues {
    pub mode: FilterMode,
    pub values: Vec<FilterValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FilterOperator {
    Eq,
    Neq,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Gt,
    Gte,
    Lt,
    Lte,
    Between,
    Empty,
    NotEmpty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct FilterCondition {
    pub operator: FilterOperator,
    // Preserve an explicit JSON null as Some(Null), so empty/notEmpty can reject any supplied operand.
    #[serde(
        default,
        with = "operand_field",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(as = "Option<FilterValue>", optional)]
    pub value: Option<FilterValue>,
    #[serde(
        default,
        with = "operand_field",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(as = "Option<FilterValue>", optional)]
    pub upper: Option<FilterValue>,
}

mod operand_field {
    use super::*;

    pub fn serialize<S: serde::Serializer>(
        value: &Option<FilterValue>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<FilterValue>, D::Error> {
        FilterValue::deserialize(d).map(Some)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct ColumnFilter {
    pub values: Option<FilterValues>,
    pub condition: Option<FilterCondition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FilterGroupOperator {
    And,
    Or,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum FilterExpression {
    Rule {
        column: String,
        condition: FilterCondition,
    },
    Group {
        operator: FilterGroupOperator,
        children: Vec<FilterExpression>,
    },
}

impl<'de> Deserialize<'de> for FilterExpression {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        expression(Value::deserialize(d)?, 1, &mut 0, &mut 0)
            .map_err(D::Error::custom)?
            .ok_or_else(|| D::Error::custom("empty table filter expression"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableFilters {
    pub columns: BTreeMap<String, ColumnFilter>,
    pub advanced: Option<FilterExpression>,
}

fn bounded(text: &str, max: usize) -> bool {
    text.chars().take(max + 1).count() <= max
}

fn is_id(id: &str) -> bool {
    !id.trim().is_empty() && bounded(id, MAX_ID_CHARS) && !id.chars().any(char::is_control)
}

fn is_view_id(id: &str) -> bool {
    is_id(id)
        && id
            .strip_prefix("kind:")
            .and_then(|kind| kind.split_once('/'))
            .is_some_and(|(_, kind)| !kind.trim().is_empty() && !kind.contains('/'))
}

impl FilterValue {
    fn valid(&self) -> bool {
        match self {
            Self::String(text) => bounded(text, MAX_TEXT_CHARS),
            Self::Number(number) => number.as_f64().is_some_and(f64::is_finite),
            Self::Boolean(_) | Self::Null => true,
        }
    }

    fn number(&self) -> Option<f64> {
        match self {
            Self::Number(number) => number.as_f64().filter(|n| n.is_finite()),
            _ => None,
        }
    }
}

impl FilterCondition {
    fn valid(&self) -> bool {
        if self.value.as_ref().is_some_and(|v| !v.valid())
            || self.upper.as_ref().is_some_and(|v| !v.valid())
        {
            return false;
        }
        match self.operator {
            FilterOperator::Empty | FilterOperator::NotEmpty => {
                self.value.is_none() && self.upper.is_none()
            }
            FilterOperator::Eq | FilterOperator::Neq => {
                self.value
                    .as_ref()
                    .is_some_and(|v| !matches!(v, FilterValue::Null))
                    && self.upper.is_none()
            }
            FilterOperator::Contains
            | FilterOperator::NotContains
            | FilterOperator::StartsWith
            | FilterOperator::EndsWith => {
                matches!(self.value, Some(FilterValue::String(_))) && self.upper.is_none()
            }
            FilterOperator::Gt | FilterOperator::Gte | FilterOperator::Lt | FilterOperator::Lte => {
                self.value.as_ref().and_then(FilterValue::number).is_some() && self.upper.is_none()
            }
            FilterOperator::Between => {
                match (
                    self.value.as_ref().and_then(FilterValue::number),
                    self.upper.as_ref().and_then(FilterValue::number),
                ) {
                    (Some(lower), Some(upper)) => upper >= lower,
                    _ => false,
                }
            }
        }
    }
}

// Reject nested containers and overlong strings before an untagged FilterValue could buffer them.
fn scalar_shape(value: &Value) -> bool {
    match value {
        Value::String(text) => bounded(text, MAX_TEXT_CHARS),
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::Bool(_) | Value::Null => true,
        Value::Array(_) | Value::Object(_) => false,
    }
}

fn condition_shape(value: &Value) -> bool {
    value.is_object()
        && ["value", "upper"]
            .iter()
            .all(|key| value.get(key).is_none_or(scalar_shape))
}

fn expression(
    raw: Value,
    depth: usize,
    nodes: &mut usize,
    conditions: &mut usize,
) -> Result<Option<FilterExpression>, &'static str> {
    *nodes += 1;
    if depth > MAX_DEPTH || *nodes > MAX_NODES {
        return Err("table filter expression exceeds its limits");
    }
    let Value::Object(mut fields) = raw else {
        return Err("invalid table filter expression");
    };
    let Some(Value::String(tag)) = fields.remove("type") else {
        return Err("invalid table filter expression");
    };
    // Both variants have exactly two fields beside their tag. Required fields below also reject wrong variants.
    if fields.len() != 2 {
        return Err("invalid table filter expression");
    }
    match tag.as_str() {
        "rule" => {
            let Some(Value::String(column)) = fields.remove("column") else {
                return Err("invalid table filter rule");
            };
            let raw = fields
                .remove("condition")
                .ok_or("invalid table filter rule")?;
            if !condition_shape(&raw) {
                return Err("invalid table filter rule");
            }
            let condition: FilterCondition =
                serde_json::from_value(raw).map_err(|_| "invalid table filter rule")?;
            *conditions += 1;
            if !is_id(&column) || !condition.valid() || *conditions > MAX_CONDITIONS {
                return Err("invalid table filter rule");
            }
            Ok(Some(FilterExpression::Rule { column, condition }))
        }
        "group" => {
            // Move the existing raw array without deserializing/reallocating any of its subtrees.
            let Some(Value::Array(children)) = fields.remove("children") else {
                return Err("invalid table filter group");
            };
            if children.len() > MAX_NODES - *nodes {
                return Err("too many table filter expression nodes");
            }
            let operator: FilterGroupOperator = serde_json::from_value(
                fields
                    .remove("operator")
                    .ok_or("invalid table filter group")?,
            )
            .map_err(|_| "invalid table filter group")?;
            if children.is_empty() {
                return if depth == 1 {
                    Ok(None)
                } else {
                    Err("empty nested table filter group")
                };
            }
            let mut read = Vec::with_capacity(children.len());
            for child in children {
                read.push(
                    expression(child, depth + 1, nodes, conditions)?
                        .ok_or("empty nested table filter group")?,
                );
            }
            if read.len() == 1 {
                Ok(read.pop())
            } else {
                Ok(Some(FilterExpression::Group {
                    operator,
                    children: read,
                }))
            }
        }
        _ => Err("invalid table filter expression"),
    }
}

impl<'de> Deserialize<'de> for TableFilters {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        Self::read(Value::deserialize(d)?).map_err(D::Error::custom)
    }
}

impl TableFilters {
    /// Check raw container sizes before allocating typed columns or selected-value vectors.
    fn read(raw: Value) -> Result<Self, &'static str> {
        let Value::Object(mut fields) = raw else {
            return Err("invalid table filters");
        };
        let raw_columns = match fields.remove("columns") {
            None => serde_json::Map::new(),
            Some(Value::Object(columns)) => columns,
            _ => return Err("invalid table filter columns"),
        };
        let raw_advanced = fields.remove("advanced").filter(|value| !value.is_null());
        if !fields.is_empty() {
            return Err("invalid table filter fields");
        }
        if raw_columns.len() > MAX_COLUMNS {
            return Err("too many table filter columns");
        }
        let mut columns = BTreeMap::new();
        let mut conditions = 0;
        for (id, raw) in raw_columns {
            if !is_id(&id) || !raw.is_object() {
                return Err("invalid table filter column");
            }
            if let Some(values) = raw.get("values").filter(|value| !value.is_null()) {
                let Some(values) = values.get("values").and_then(Value::as_array) else {
                    return Err("invalid table filter values");
                };
                if values.len() > MAX_VALUES {
                    return Err("too many table filter values");
                }
                if !values.iter().all(scalar_shape) {
                    return Err("invalid table filter values");
                }
            }
            if raw
                .get("condition")
                .filter(|value| !value.is_null())
                .is_some_and(|value| !condition_shape(value))
            {
                return Err("invalid table filter condition");
            }
            let mut column: ColumnFilter =
                serde_json::from_value(raw).map_err(|_| "invalid table filter column")?;
            if column.condition.as_ref().is_some_and(|c| !c.valid()) {
                return Err("invalid table filter column");
            }
            if column.values.as_ref().is_some_and(|v| v.values.is_empty()) {
                column.values = None;
            }
            conditions +=
                usize::from(column.values.is_some()) + usize::from(column.condition.is_some());
            if conditions > MAX_CONDITIONS {
                return Err("too many table filter conditions");
            }
            if column.values.is_some() || column.condition.is_some() {
                columns.insert(id, column);
            }
        }
        let advanced = raw_advanced
            .map(|raw| expression(raw, 1, &mut 0, &mut conditions))
            .transpose()?
            .flatten();
        Ok(Self { columns, advanced })
    }

    fn is_empty(&self) -> bool {
        self.columns.is_empty() && self.advanced.is_none()
    }
}

/// Invalid or empty entries affect only their own table, never sibling settings.
pub(super) fn read_cluster(raw: Option<Value>) -> BTreeMap<String, TableFilters> {
    let Some(Value::Object(entries)) = raw else {
        return BTreeMap::new();
    };
    entries
        .into_iter()
        .filter(|(id, _)| is_view_id(id))
        .filter_map(|(id, raw)| {
            TableFilters::read(raw)
                .ok()
                .filter(|filters| !filters.is_empty())
                .map(|filters| (id, filters))
        })
        .take(MAX_TABLES)
        .collect()
}

pub(super) mod optional_field {
    use super::*;

    pub fn serialize<S: serde::Serializer>(
        value: &Option<TableFilters>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<TableFilters>, D::Error> {
        let raw = Value::deserialize(d)?;
        Ok(TableFilters::read(raw)
            .ok()
            .filter(|filters| !filters.is_empty()))
    }
}
