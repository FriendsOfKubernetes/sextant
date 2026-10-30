//! Metric queries of an extension (`contributes.metricQueries`, ADR-0138): Prometheus-compatible queries fixed in the
//! manifest, signed with the package and shown at install, that the extension runs by id with typed parameters. The
//! extension never sends PromQL: [`fill`] puts each parameter's value into the template after checking it against its
//! type and escaping it for where it stands (a string literal, a regular-expression matcher, or a duration from a
//! fixed list), and [`run_metric_query`] sends the result to the cluster's Prometheus-compatible source (the one
//! Sextant found or the cluster settings name, through the service proxy), with fixed steps and caps on the answer.
//!
//! What a template may be is checked when the manifest is read ([`check_metric_queries`]): placeholders are `{{name}}`
//! of declared parameters, each used, a text parameter only inside a `"…"` string, a duration only outside strings;
//! no comments. Prometheus may answer with series of namespaces the extension may not read: the consent says so.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::manifest::{ExtensionManifest, ManifestError};
use super::schema::JsonPath;
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;
use crate::metrics::PrometheusMode;

#[cfg(test)]
mod tests;

/// The extension API version that brought `contributes.metricQueries`.
pub const METRIC_QUERIES_API: u32 = 2;
/// Queries per extension (the schema's `maxItems`).
pub const MAX_QUERIES: usize = 20;
/// Characters of a template (the schema's `maxLength`).
pub const MAX_QUERY_CHARS: usize = 2000;
/// Parameters of a query (the schema's `maxItems`).
pub const MAX_PARAMS: usize = 5;
/// Characters of a `labelValue` parameter's value.
pub const MAX_LABEL_VALUE_CHARS: usize = 256;
/// The longest range a manifest may allow, in hours (a week; the schema's `maximum`).
pub const MAX_RANGE_HOURS: u32 = 168;
/// Points of one series a range query may ask for.
pub const MAX_POINTS: u32 = 1500;
/// The largest answer read.
pub const MAX_BODY: usize = 8 * 1024 * 1024;
/// Series returned; the rest are left out and the answer says `truncated`.
pub const MAX_SERIES: usize = 500;

/// The durations a `duration` parameter may be (`rate(x[{{window}}])`).
pub const DURATIONS: [&str; 12] = [
    "1m", "2m", "5m", "10m", "15m", "30m", "1h", "2h", "6h", "12h", "1d", "7d",
];
/// The steps of a range query, with their length in seconds.
pub const STEPS: [(&str, u32); 7] = [
    ("15s", 15),
    ("30s", 30),
    ("1m", 60),
    ("5m", 300),
    ("15m", 900),
    ("30m", 1800),
    ("1h", 3600),
];

/// A query of the manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricQuery {
    pub id: String,
    /// What it reads, in the extension's words; shown at install.
    pub title: String,
    /// PromQL with `{{name}}` placeholders of `params`.
    pub query: String,
    #[serde(default)]
    pub params: Vec<MetricParam>,
    /// Allowed as a range query, up to this far back; `None`: instant queries only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub range: Option<MetricRange>,
}

/// A parameter of a query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricParam {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: MetricParamType,
}

/// What a parameter's value may be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MetricParamType {
    /// A namespace name (DNS-1123 label), inside a string.
    Namespace,
    /// An object name (DNS-1123 subdomain), inside a string.
    Name,
    /// Printable text of at most [`MAX_LABEL_VALUE_CHARS`] characters, inside a string.
    LabelValue,
    /// One of [`DURATIONS`], outside strings.
    Duration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricRange {
    pub max_hours: u32,
}

/// The range of a call: the last `minutes`, a point every `step` (one of [`STEPS`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct MetricQueryRange {
    pub minutes: u32,
    pub step: String,
}

/// What a query answered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricAnswer {
    pub result_type: MetricResultType,
    /// A scalar is one series without labels.
    pub series: Vec<MetricSeries>,
    /// More than [`MAX_SERIES`] series came; the rest are left out.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MetricResultType {
    Vector,
    Matrix,
    Scalar,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MetricSeries {
    pub labels: BTreeMap<String, String>,
    /// `(unix seconds, value)`; a value that is not a finite number (`NaN`, `±Inf`) is `null`.
    #[ts(type = "Array<[number, number | null]>")]
    pub points: Vec<(f64, Option<f64>)>,
}

// ---------------------------------------------------------------------------------------------------------------
// Templates

/// A part of a template.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Piece<'a> {
    Text(&'a str),
    /// A placeholder; `string` is `Some(regex)` inside a `"…"` string (`regex`: the string is the right side of `=~`
    /// or `!~`), `None` outside strings.
    Param {
        name: &'a str,
        string: Option<bool>,
    },
}

/// `query` split into text and placeholders; an error says what is wrong with it.
fn pieces(query: &str) -> Result<Vec<Piece<'_>>, String> {
    let mut out = Vec::new();
    let bytes = query.as_bytes();
    // The quote of the string being read, and whether it is a regular-expression matcher's.
    let mut quote: Option<(u8, bool)> = None;
    let (mut i, mut text_start) = (0, 0);
    while i < bytes.len() {
        let byte = bytes[i];
        if byte == b'{' && bytes.get(i + 1) == Some(&b'{') {
            let rest = &query[i + 2..];
            let end = rest
                .find("}}")
                .ok_or_else(|| "a `{{` is not closed by `}}`".to_owned())?;
            let name = &rest[..end];
            if !is_param_name(name) {
                return Err(format!(
                    "`{{{{{name}}}}}` is not a placeholder of a parameter name"
                ));
            }
            let string = match quote {
                None => None,
                Some((b'"', regex)) => Some(regex),
                Some(_) => {
                    return Err(format!(
                        "`{{{{{name}}}}}` is in a '…' or `…` string: a parameter goes only into a \"…\" string"
                    ));
                }
            };
            if text_start < i {
                out.push(Piece::Text(&query[text_start..i]));
            }
            out.push(Piece::Param { name, string });
            i += 2 + end + 2;
            text_start = i;
            continue;
        }
        match quote {
            Some((open, _)) => {
                if byte == b'\\' && open != b'`' {
                    i += 1;
                } else if byte == open {
                    quote = None;
                }
            }
            None => match byte {
                b'"' | b'\'' | b'`' => {
                    let before = query[..i].trim_end();
                    quote = Some((byte, before.ends_with("=~") || before.ends_with("!~")));
                }
                b'#' => return Err("comments (`#`) are not allowed".to_owned()),
                _ => {}
            },
        }
        i += 1;
    }
    if quote.is_some() {
        return Err("a string is not closed".to_owned());
    }
    if text_start < bytes.len() {
        out.push(Piece::Text(&query[text_start..]));
    }
    Ok(out)
}

fn is_param_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && name.len() <= 40
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// What reading a manifest checks of its queries beyond the schema.
pub(crate) fn check_metric_queries(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let queries = &manifest.contributes.metric_queries;
    let list = JsonPath::default().key("contributes").key("metricQueries");
    if queries.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < METRIC_QUERIES_API {
        return Err(at(
            &list,
            format!("needs sextantApi {METRIC_QUERIES_API} or later"),
        ));
    }
    for (i, query) in queries.iter().enumerate() {
        let here = list.index(i);
        for (p, param) in query.params.iter().enumerate() {
            if let Some(first) = query.params[..p].iter().position(|o| o.name == param.name) {
                return Err(at(
                    &here.key("params").index(p).key("name"),
                    format!(
                        "duplicate parameter `{}` (also {})",
                        param.name,
                        here.key("params").index(first)
                    ),
                ));
            }
        }
        let parts = pieces(&query.query).map_err(|message| at(&here.key("query"), message))?;
        for part in &parts {
            let Piece::Param { name, string } = part else {
                continue;
            };
            let Some(param) = query.params.iter().find(|p| p.name == *name) else {
                return Err(at(
                    &here.key("query"),
                    format!("`{{{{{name}}}}}` is not a parameter of this query"),
                ));
            };
            match (param.kind, string) {
                (MetricParamType::Duration, Some(_)) => {
                    return Err(at(
                        &here.key("query"),
                        format!("the duration `{{{{{name}}}}}` goes outside strings"),
                    ));
                }
                (MetricParamType::Duration, None) | (_, Some(_)) => {}
                (_, None) => {
                    return Err(at(
                        &here.key("query"),
                        format!("`{{{{{name}}}}}` goes inside a \"…\" string"),
                    ));
                }
            }
        }
        for (p, param) in query.params.iter().enumerate() {
            let used = parts
                .iter()
                .any(|part| matches!(part, Piece::Param { name, .. } if *name == param.name));
            if !used {
                return Err(at(
                    &here.key("params").index(p),
                    format!("`{}` is not used in the query", param.name),
                ));
            }
        }
    }
    Ok(())
}

fn at(path: &JsonPath, message: String) -> ManifestError {
    ManifestError {
        path: path.to_string(),
        message,
    }
}

/// The PromQL of `query` with `values` put in: every parameter needs a value of its type, and nothing else may be
/// given.
pub fn fill(query: &MetricQuery, values: &BTreeMap<String, String>) -> CoreResult<String> {
    if let Some(unknown) = values
        .keys()
        .find(|k| !query.params.iter().any(|p| &p.name == *k))
    {
        return Err(invalid(format!(
            "query {} has no parameter {unknown:?}",
            query.id
        )));
    }
    let parts = pieces(&query.query).map_err(invalid)?;
    let mut out = String::with_capacity(query.query.len() + 64);
    for part in parts {
        match part {
            Piece::Text(text) => out.push_str(text),
            Piece::Param { name, string } => {
                let param = query
                    .params
                    .iter()
                    .find(|p| p.name == name)
                    .ok_or_else(|| {
                        invalid(format!("query {} names no parameter {name}", query.id))
                    })?;
                let value = values.get(name).ok_or_else(|| {
                    invalid(format!("query {} needs the parameter {name}", query.id))
                })?;
                check_value(param, value)?;
                match string {
                    None => out.push_str(value),
                    Some(false) => out.push_str(&literal(value)),
                    Some(true) => out.push_str(&literal(&regex_literal(value))),
                }
            }
        }
    }
    Ok(out)
}

fn check_value(param: &MetricParam, value: &str) -> CoreResult<()> {
    let ok = match param.kind {
        MetricParamType::Namespace => is_dns_name(value, 63, false),
        MetricParamType::Name => is_dns_name(value, 253, true),
        MetricParamType::LabelValue => {
            value.chars().count() <= MAX_LABEL_VALUE_CHARS && !value.chars().any(char::is_control)
        }
        MetricParamType::Duration => DURATIONS.contains(&value),
    };
    if ok {
        return Ok(());
    }
    Err(invalid(match param.kind {
        MetricParamType::Namespace => format!("{} must be a namespace name", param.name),
        MetricParamType::Name => format!("{} must be an object name", param.name),
        MetricParamType::LabelValue => format!(
            "{} must be at most {MAX_LABEL_VALUE_CHARS} characters without control characters",
            param.name
        ),
        MetricParamType::Duration => {
            format!("{} must be one of {}", param.name, DURATIONS.join(", "))
        }
    }))
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

/// A PromQL string literal body: backslashes and quotes escaped.
fn literal(text: &str) -> String {
    text.replace('\\', r"\\").replace('"', "\\\"")
}

/// A regular expression matching `text` literally.
fn regex_literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if r"\.+*?()|[]{}^$".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

// ---------------------------------------------------------------------------------------------------------------
// Grants

/// Whether every query of `manifest` is one the user agreed to, word for word.
pub fn metric_queries_within(
    manifest: &ExtensionManifest,
    granted: Option<&[MetricQuery]>,
) -> bool {
    let queries = &manifest.contributes.metric_queries;
    queries.is_empty() || granted.is_some_and(|granted| queries.iter().all(|q| granted.contains(q)))
}

// ---------------------------------------------------------------------------------------------------------------
// Running

/// `(start, end, step seconds)` of `range` ending at `now`, if `query` allows it.
fn range_of(
    query: &MetricQuery,
    range: &MetricQueryRange,
    now: i64,
) -> CoreResult<(i64, i64, u32)> {
    let Some(allowed) = &query.range else {
        return Err(invalid(format!(
            "query {} is an instant query: its manifest allows no range",
            query.id
        )));
    };
    if range.minutes == 0 || u64::from(range.minutes) > u64::from(allowed.max_hours) * 60 {
        return Err(invalid(format!(
            "the range of query {} is 1 to {} minutes",
            query.id,
            u64::from(allowed.max_hours) * 60
        )));
    }
    let step = STEPS
        .iter()
        .find(|(name, _)| *name == range.step)
        .map(|(_, secs)| *secs)
        .ok_or_else(|| {
            let names: Vec<&str> = STEPS.iter().map(|(n, _)| *n).collect();
            invalid(format!("the step must be one of {}", names.join(", ")))
        })?;
    let points = u64::from(range.minutes) * 60 / u64::from(step);
    if points > u64::from(MAX_POINTS) {
        return Err(invalid(format!(
            "{} minutes at a {} step are {points} points; at most {MAX_POINTS}: choose a longer step",
            range.minutes, range.step
        )));
    }
    Ok((now - i64::from(range.minutes) * 60, now, step))
}

/// Runs `query` of an extension with `values` in `cluster`'s Prometheus-compatible source for `mode`: an instant query
/// at `now`, or a range query over `range` ending at `now`. The caller has checked that the extension may.
pub async fn run_metric_query(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &PrometheusMode,
    query: &MetricQuery,
    values: &BTreeMap<String, String>,
    range: Option<&MetricQueryRange>,
    now: i64,
) -> CoreResult<MetricAnswer> {
    let promql = fill(query, values)?;
    let range = range.map(|r| range_of(query, r, now)).transpose()?;
    let prometheus = crate::metrics::required_prometheus(mgr, cluster, mode).await?;
    let data = match range {
        None => prometheus.query_limited(&promql, now, MAX_BODY).await?,
        Some((start, end, step)) => {
            prometheus
                .query_range_limited(&promql, start, end, i64::from(step), MAX_BODY)
                .await?
        }
    };
    read_answer(&data)
}

/// The `data` of a Prometheus answer as a [`MetricAnswer`].
fn read_answer(data: &Value) -> CoreResult<MetricAnswer> {
    let not_read = || invalid("the answer is not from the Prometheus HTTP API");
    let result = data.get("result").ok_or_else(not_read)?;
    let (result_type, series, truncated) = match data.get("resultType").and_then(Value::as_str) {
        Some("scalar") => {
            let point = point(result).ok_or_else(not_read)?;
            (
                MetricResultType::Scalar,
                vec![MetricSeries {
                    labels: BTreeMap::new(),
                    points: vec![point],
                }],
                false,
            )
        }
        Some(kind @ ("vector" | "matrix")) => {
            let items = result.as_array().ok_or_else(not_read)?;
            let series = items
                .iter()
                .take(MAX_SERIES)
                .map(|item| {
                    let labels = item
                        .get("metric")
                        .and_then(Value::as_object)
                        .map(|m| {
                            m.iter()
                                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                                .collect()
                        })
                        .unwrap_or_default();
                    let points = if kind == "vector" {
                        item.get("value").and_then(point).into_iter().collect()
                    } else {
                        item.get("values")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(point)
                            .collect()
                    };
                    MetricSeries { labels, points }
                })
                .collect();
            let result_type = if kind == "vector" {
                MetricResultType::Vector
            } else {
                MetricResultType::Matrix
            };
            (result_type, series, items.len() > MAX_SERIES)
        }
        Some("string") => {
            return Err(invalid("the query answered a string, not a number"));
        }
        _ => return Err(not_read()),
    };
    Ok(MetricAnswer {
        result_type,
        series,
        truncated,
    })
}

/// `[<unix seconds>, "<value>"]`; a value that is not a finite number is `None`.
fn point(value: &Value) -> Option<(f64, Option<f64>)> {
    let pair = value.as_array()?;
    let time = pair.first()?.as_f64()?;
    let number = match pair.get(1)? {
        Value::String(text) => text.parse::<f64>().ok(),
        other => other.as_f64(),
    }
    .filter(|n| n.is_finite());
    Some((time, number))
}
