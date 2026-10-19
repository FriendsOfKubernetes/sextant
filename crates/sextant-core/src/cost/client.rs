//! One allocation request through the API server's service proxy, and the answer reduced to [`CostRow`]s.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use http_body_util::{BodyExt, LengthLimitError, Limited};
use kube::client::Body;
use serde::Deserialize;
use serde_json::Value;

use super::{CostAggregate, CostQuery, CostReport, CostRow, CostSource};
use crate::error::{CoreError, CoreResult, ErrorCode, code_for_http_status, kube_error};

/// How long one allocation request may take (a 30-day window is computed on the spot).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The largest answer read; a bigger one is refused (a coarser aggregation answers in less).
pub const MAX_BODY: usize = 8 * 1024 * 1024;
/// At most this many groups are returned, most expensive first.
pub const MAX_ROWS: usize = 2000;
/// The API's name of the idle group.
pub const IDLE: &str = "__idle__";

/// Percent-encoding for a query parameter value.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The `aggregate` parameter. Label keys are sent as the cost model stores them (Prometheus label names: every
/// character other than a letter, a digit or `_` becomes `_`).
pub(crate) fn aggregate_param(aggregate: &CostAggregate) -> String {
    match aggregate {
        CostAggregate::Namespace => "namespace".into(),
        CostAggregate::Workload => "namespace,controller".into(),
        CostAggregate::Pod => "namespace,pod".into(),
        CostAggregate::Node => "node".into(),
        CostAggregate::Label { key } => {
            let sanitized: String = key
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect();
            format!("label:{sanitized}")
        }
    }
}

/// The path and query of the request; the query is checked ([`super::validate`]) before.
pub(crate) fn request_uri(source: &CostSource, query: &CostQuery) -> String {
    let mut uri = format!(
        "/api/v1/namespaces/{}/services/{}:{}/proxy{}?window={}&aggregate={}&accumulate=true\
         &includeIdle=true&idle=true&shareIdle=false",
        source.namespace,
        source.service,
        source.port,
        source.api_path(),
        query.window.param(),
        encode(&aggregate_param(&query.aggregate)),
    );
    if let Some(namespaces) = &query.namespaces {
        let quoted: Vec<String> = namespaces.iter().map(|n| format!("\"{n}\"")).collect();
        uri.push_str("&filter=");
        uri.push_str(&encode(&format!("namespace:{}", quoted.join(","))));
    }
    uri
}

fn unreachable(source: &CostSource, detail: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        ErrorCode::Unreachable,
        format!(
            "the cost service {}/{} did not answer through the API server: {detail}",
            source.namespace, source.service
        ),
    )
}

/// Sends the request and reads at most [`MAX_BODY`] of the answer; non-2xx statuses become errors.
async fn send(client: &kube::Client, source: &CostSource, uri: &str) -> CoreResult<Vec<u8>> {
    let request = http::Request::get(uri)
        .body(Body::from(Vec::new()))
        .map_err(|e| CoreError::new(ErrorCode::Invalid, e.to_string()))?;
    let exchange = async {
        let response = client
            .send(request)
            .await
            .map_err(|e| kube_error(e, None))?;
        let status = response.status();
        let body = Limited::new(response.into_body(), MAX_BODY)
            .collect()
            .await
            .map_err(|err| {
                if err.downcast_ref::<LengthLimitError>().is_some() {
                    CoreError::new(
                        ErrorCode::Invalid,
                        format!(
                            "the cost answer is larger than {} MiB; choose a coarser grouping or a shorter period",
                            MAX_BODY / (1024 * 1024)
                        ),
                    )
                } else {
                    unreachable(source, err)
                }
            })?
            .to_bytes();
        Ok::<_, CoreError>((status, body))
    };
    let (status, body) = tokio::time::timeout(REQUEST_TIMEOUT, exchange)
        .await
        .map_err(|_| {
            CoreError::new(
                ErrorCode::Timeout,
                format!(
                    "the cost service did not answer in {} seconds",
                    REQUEST_TIMEOUT.as_secs()
                ),
            )
        })??;
    if status.is_success() {
        return Ok(body.to_vec());
    }
    Err(match status.as_u16() {
        403 => CoreError::new(
            ErrorCode::Forbidden,
            format!(
                "no permission to reach the cost service {}/{} through the API server (services/proxy)",
                source.namespace, source.service
            ),
        ),
        404 | 502 | 503 => unreachable(source, format!("HTTP {status}")),
        code => CoreError::new(
            code_for_http_status(code),
            format!("the cost service answered HTTP {code}{}", message_of(&body)),
        ),
    })
}

/// `: <message>` of an error answer, clipped; empty when there is none.
fn message_of(body: &[u8]) -> String {
    let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    match value.get("message").and_then(Value::as_str) {
        Some(m) if !m.trim().is_empty() => format!(": {}", m.chars().take(200).collect::<String>()),
        _ => String::new(),
    }
}

/// Requests the costs of `query` from `source`.
pub(crate) async fn fetch(
    client: &kube::Client,
    source: CostSource,
    query: &CostQuery,
) -> CoreResult<CostReport> {
    let body = send(client, &source, &request_uri(&source, query)).await?;
    let mut report = parse(&body, query)?;
    report.source = Some(source);
    Ok(report)
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing: only the fields the views need are read; the rest of the answer is skipped.

/// A number the API may send as a number or a string ("NaN" and other non-finite values read as missing).
#[derive(Debug, Default, Clone, Copy)]
struct Num(Option<f64>);

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(d)?;
        let n = match value {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        };
        Ok(Num(n.filter(|v| v.is_finite())))
    }
}

impl Num {
    fn or0(self) -> f64 {
        self.0.unwrap_or(0.0)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawProperties {
    namespace: Option<String>,
    controller_kind: Option<String>,
    controller: Option<String>,
    pod: Option<String>,
    node: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RawAllocation {
    properties: Option<RawProperties>,
    minutes: Num,
    cpu_core_hours: Num,
    cpu_cost: Num,
    cpu_cost_adjustment: Num,
    cpu_efficiency: Num,
    gpu_cost: Num,
    gpu_cost_adjustment: Num,
    network_cost: Num,
    network_cost_adjustment: Num,
    pv_cost: Num,
    pv_cost_adjustment: Num,
    ram_byte_hours: Num,
    ram_cost: Num,
    ram_cost_adjustment: Num,
    ram_efficiency: Num,
    total_cost: Num,
    total_efficiency: Num,
}

type RawSet = HashMap<String, Option<RawAllocation>>;

/// `data`: a list of sets (one with `accumulate=true`), or one set.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawData {
    Sets(Vec<Option<RawSet>>),
    Set(RawSet),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    code: Option<i64>,
    message: Option<String>,
    data: Option<RawData>,
    currency_code: Option<String>,
    currency: Option<String>,
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|t| !t.trim().is_empty())
}

fn to_row(name: &str, raw: RawAllocation) -> CostRow {
    let props = raw.properties.unwrap_or_default();
    let cpu = raw.cpu_cost.or0() + raw.cpu_cost_adjustment.or0();
    let ram = raw.ram_cost.or0() + raw.ram_cost_adjustment.or0();
    let pv = raw.pv_cost.or0() + raw.pv_cost_adjustment.or0();
    let network = raw.network_cost.or0() + raw.network_cost_adjustment.or0();
    let gpu = raw.gpu_cost.or0() + raw.gpu_cost_adjustment.or0();
    let parts = cpu + ram + pv + network + gpu;
    let total = raw.total_cost.0.unwrap_or(parts);
    CostRow {
        name: name.to_owned(),
        namespace: non_empty(props.namespace),
        controller_kind: non_empty(props.controller_kind),
        controller: non_empty(props.controller),
        pod: non_empty(props.pod),
        node: non_empty(props.node),
        cpu_cost: cpu,
        ram_cost: ram,
        pv_cost: pv,
        network_cost: network,
        gpu_cost: gpu,
        other_cost: other(total, parts),
        total_cost: total,
        cpu_core_hours: raw.cpu_core_hours.or0(),
        ram_byte_hours: raw.ram_byte_hours.or0(),
        minutes: raw.minutes.or0(),
        cpu_efficiency: raw.cpu_efficiency.0,
        ram_efficiency: raw.ram_efficiency.0,
        total_efficiency: raw.total_efficiency.0,
    }
}

/// What the total holds beyond the parts; rounding noise reads as zero.
fn other(total: f64, parts: f64) -> f64 {
    let rest = total - parts;
    if rest > 1e-9 { rest } else { 0.0 }
}

/// Adds `b` (the same group in another set) to `a`. Efficiencies cannot be added and are dropped.
fn merge(a: &mut CostRow, b: CostRow) {
    a.cpu_cost += b.cpu_cost;
    a.ram_cost += b.ram_cost;
    a.pv_cost += b.pv_cost;
    a.network_cost += b.network_cost;
    a.gpu_cost += b.gpu_cost;
    a.other_cost += b.other_cost;
    a.total_cost += b.total_cost;
    a.cpu_core_hours += b.cpu_core_hours;
    a.ram_byte_hours += b.ram_byte_hours;
    a.minutes = a.minutes.max(b.minutes);
    a.cpu_efficiency = None;
    a.ram_efficiency = None;
    a.total_efficiency = None;
}

fn is_idle(name: &str) -> bool {
    name == IDLE || name.ends_with(&format!("/{IDLE}"))
}

/// A three-letter ISO 4217 code, upper case.
fn currency_code(text: Option<String>) -> Option<String> {
    let code = text?.trim().to_ascii_uppercase();
    (code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase())).then_some(code)
}

/// The report of an answer body (without `source`): groups merged across sets, the idle group apart, rows outside
/// the namespace filter dropped, most expensive first, capped at [`MAX_ROWS`].
pub(crate) fn parse(body: &[u8], query: &CostQuery) -> CoreResult<CostReport> {
    let envelope: Envelope = serde_json::from_slice(body).map_err(|_| {
        CoreError::new(
            ErrorCode::Invalid,
            "the answer is not from the OpenCost allocation API",
        )
    })?;
    if let Some(code) = envelope.code
        && !(200..300).contains(&code)
    {
        let message = non_empty(envelope.message).unwrap_or_else(|| "unknown error".into());
        return Err(CoreError::new(
            code_for_http_status(u16::try_from(code).unwrap_or(500)),
            format!(
                "the cost service answered {code}: {}",
                message.chars().take(200).collect::<String>()
            ),
        ));
    }
    let sets: Vec<RawSet> = match envelope.data {
        None => Vec::new(),
        Some(RawData::Set(set)) => vec![set],
        Some(RawData::Sets(sets)) => sets.into_iter().flatten().collect(),
    };
    let mut groups: BTreeMap<String, CostRow> = BTreeMap::new();
    let mut idle: Option<CostRow> = None;
    for set in sets {
        for (name, raw) in set {
            let Some(raw) = raw else { continue };
            let row = to_row(&name, raw);
            if is_idle(&name) {
                match &mut idle {
                    Some(sum) => merge(sum, row),
                    None => {
                        idle = Some(CostRow {
                            name: IDLE.into(),
                            ..row
                        })
                    }
                }
                continue;
            }
            match groups.get_mut(&name) {
                Some(sum) => merge(sum, row),
                None => {
                    groups.insert(name, row);
                }
            }
        }
    }
    let mut rows: Vec<CostRow> = groups
        .into_values()
        .filter(|row| match (&query.namespaces, &row.namespace) {
            (Some(filter), Some(ns)) => filter.iter().any(|f| f == ns),
            _ => true,
        })
        .collect();
    rows.sort_by(|a, b| {
        b.total_cost
            .total_cmp(&a.total_cost)
            .then_with(|| a.name.cmp(&b.name))
    });
    let total_rows = rows.len();
    rows.truncate(MAX_ROWS);
    Ok(CostReport {
        source: None,
        window: query.window,
        currency: currency_code(envelope.currency_code).or(currency_code(envelope.currency)),
        rows,
        idle,
        total_rows: u32::try_from(total_rows).unwrap_or(u32::MAX),
        truncated: total_rows > MAX_ROWS,
    })
}
