//! Requests to Loki's HTTP API through the API server's service proxy, and the answers read within caps.

use std::time::Duration;

use http_body_util::{BodyExt, LengthLimitError, Limited};
use kube::client::Body;
use serde::Deserialize;
use serde_json::Value;

use super::{LokiDirection, LokiSource};
use crate::error::{CoreError, CoreResult, ErrorCode, code_for_http_status, kube_error};

/// How long one request may take.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The largest answer read; a bigger one is refused, not cut.
pub const MAX_BODY: usize = 8 * 1024 * 1024;

/// Percent-encoding for a query parameter value.
pub(crate) fn encode(text: &str) -> String {
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

/// Loki's HTTP API on one Service.
pub(crate) struct Loki {
    client: kube::Client,
    source: LokiSource,
    /// `/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy<prefix>`.
    base: String,
    tenant: Option<String>,
}

impl Loki {
    /// `source` and `tenant` are validated before (`super::validate_source`, `super::validate_tenant`).
    pub(crate) fn new(client: kube::Client, source: LokiSource, tenant: Option<String>) -> Self {
        let base = format!(
            "/api/v1/namespaces/{}/services/{}:{}/proxy{}",
            source.namespace, source.service, source.port, source.path_prefix
        );
        Self {
            client,
            source,
            base,
            tenant,
        }
    }

    /// The path and query of `GET <api>` (`api` starts with `/`).
    pub(crate) fn uri(&self, api: &str) -> String {
        format!("{}{api}", self.base)
    }

    fn unreachable(&self, detail: impl std::fmt::Display) -> CoreError {
        CoreError::new(
            ErrorCode::Unreachable,
            format!(
                "Loki {}/{} did not answer through the API server: {detail}",
                self.source.namespace, self.source.service
            ),
        )
    }

    /// `GET <api>`: the body of a 2xx answer (at most [`MAX_BODY`]); any other status is an error that says why.
    pub(crate) async fn get(&self, api: &str) -> CoreResult<Vec<u8>> {
        let (status, body) = self.get_raw(api).await?;
        if (200..300).contains(&status) {
            return Ok(body);
        }
        Err(self.status_error(status, &body))
    }

    /// `GET <api>`: the status and the body (at most [`MAX_BODY`]).
    async fn get_raw(&self, api: &str) -> CoreResult<(u16, Vec<u8>)> {
        let mut request = http::Request::get(self.uri(api));
        if let Some(tenant) = &self.tenant {
            request = request.header("X-Scope-OrgID", tenant.as_str());
        }
        let request = request
            .body(Body::from(Vec::new()))
            .map_err(|e| CoreError::new(ErrorCode::Invalid, e.to_string()))?;
        let exchange = async {
            let response = self
                .client
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
                                "the Loki answer is larger than {} MiB; choose a shorter period",
                                MAX_BODY / (1024 * 1024)
                            ),
                        )
                    } else {
                        self.unreachable(err)
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
                        "Loki did not answer in {} seconds",
                        REQUEST_TIMEOUT.as_secs()
                    ),
                )
            })??;
        Ok((status.as_u16(), body.to_vec()))
    }

    fn status_error(&self, code: u16, body: &[u8]) -> CoreError {
        let message = message_of(body);
        match code {
            401 if message.contains("no org id") => CoreError::new(
                ErrorCode::Unauthorized,
                "Loki needs a tenant (X-Scope-OrgID): set it in the cluster settings",
            ),
            403 => CoreError::new(
                ErrorCode::Forbidden,
                format!(
                    "no permission to reach Loki {}/{} through the API server (services/proxy){}",
                    self.source.namespace,
                    self.source.service,
                    suffix(&message)
                ),
            ),
            404 | 502 | 503 => self.unreachable(format!("HTTP {code}")),
            code => CoreError::new(
                code_for_http_status(code),
                format!("Loki answered HTTP {code}{}", suffix(&message)),
            ),
        }
    }
}

/// `: <message>`, or nothing for an empty one.
fn suffix(message: &str) -> String {
    if message.is_empty() {
        String::new()
    } else {
        format!(": {message}")
    }
}

/// The message of an error answer: a Kubernetes `Status`'s `message`, else Loki's plain text; one line, clipped to
/// 200 characters, without control characters.
pub(crate) fn message_of(body: &[u8]) -> String {
    let text = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        Err(_) => String::from_utf8_lossy(body).into_owned(),
    };
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(200)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// `{"status":"success","data":[…]}` of the label APIs.
#[derive(Deserialize)]
struct Strings {
    status: Option<String>,
    #[serde(default)]
    data: Option<Vec<String>>,
}

/// The `data` of a label API answer.
pub(crate) fn parse_strings(body: &[u8]) -> CoreResult<Vec<String>> {
    let answer: Strings = serde_json::from_slice(body).map_err(|_| not_loki())?;
    if answer.status.as_deref() != Some("success") {
        return Err(not_loki());
    }
    Ok(answer.data.unwrap_or_default())
}

#[derive(Deserialize)]
struct Streams {
    status: Option<String>,
    data: Option<StreamsData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamsData {
    result_type: Option<String>,
    #[serde(default)]
    result: Vec<StreamResult>,
}

#[derive(Deserialize)]
struct StreamResult {
    /// `[<ns timestamp as text>, <line>]`, with a third element (structured metadata) on request.
    #[serde(default)]
    values: Vec<Vec<Value>>,
}

/// The entries of a `query_range` answer (log streams), every stream's together, oldest first (entries with the
/// same timestamp keep the answer's order).
pub(crate) fn parse_streams(body: &[u8]) -> CoreResult<Vec<(i64, String)>> {
    let answer: Streams = serde_json::from_slice(body).map_err(|_| not_loki())?;
    if answer.status.as_deref() != Some("success") {
        return Err(not_loki());
    }
    let Some(data) = answer.data else {
        return Ok(Vec::new());
    };
    if data.result_type.as_deref().is_some_and(|t| t != "streams") {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "Loki answered with metrics, not log lines",
        ));
    }
    let mut entries: Vec<(i64, String)> = data
        .result
        .into_iter()
        .flat_map(|stream| stream.values)
        .filter_map(|value| {
            let ts = value.first()?.as_str()?.parse::<i64>().ok()?;
            let line = value.get(1)?.as_str()?.to_owned();
            Some((ts, line))
        })
        .collect();
    entries.sort_by_key(|(ts, _)| *ts);
    Ok(entries)
}

fn not_loki() -> CoreError {
    CoreError::new(
        ErrorCode::Invalid,
        "the answer is not from the Loki HTTP API",
    )
}

impl Loki {
    /// Whether the Service answers as Loki: `/loki/api/v1/status/buildinfo` (Loki 2.3 on, also through the
    /// grafana/loki chart's gateway, which passes `/loki/api/…` on), else `/ready` (single binary and read pods).
    pub(crate) async fn probe(&self) -> CoreResult<()> {
        let (status, body) = self.get_raw("/loki/api/v1/status/buildinfo").await?;
        if (200..300).contains(&status) {
            let value: Value = serde_json::from_slice(&body).map_err(|_| not_loki())?;
            return if value.get("version").is_some() {
                Ok(())
            } else {
                Err(not_loki())
            };
        }
        if status != 404 {
            return Err(self.status_error(status, &body));
        }
        let body = self.get("/ready").await?;
        if String::from_utf8_lossy(&body).trim() == "ready" {
            Ok(())
        } else {
            Err(not_loki())
        }
    }

    /// The label names of the streams in `[start_ns, end_ns)`.
    pub(crate) async fn labels(&self, start_ns: i64, end_ns: i64) -> CoreResult<Vec<String>> {
        let body = self
            .get(&format!(
                "/loki/api/v1/labels?start={start_ns}&end={end_ns}"
            ))
            .await?;
        parse_strings(&body)
    }

    /// The values of `label` on the streams `selector` matches in `[start_ns, end_ns)`.
    pub(crate) async fn label_values(
        &self,
        label: &str,
        selector: &str,
        start_ns: i64,
        end_ns: i64,
    ) -> CoreResult<Vec<String>> {
        let body = self
            .get(&format!(
                "/loki/api/v1/label/{label}/values?query={}&start={start_ns}&end={end_ns}",
                encode(selector)
            ))
            .await?;
        parse_strings(&body)
    }

    /// At most `limit` lines of `selector` in `[start_ns, end_ns)`, the newest (`backward`) or the oldest; oldest
    /// first.
    pub(crate) async fn query_range(
        &self,
        selector: &str,
        start_ns: i64,
        end_ns: i64,
        limit: u32,
        direction: LokiDirection,
    ) -> CoreResult<Vec<(i64, String)>> {
        let direction = match direction {
            LokiDirection::Backward => "backward",
            LokiDirection::Forward => "forward",
        };
        let body = self
            .get(&query_range_api(
                selector, start_ns, end_ns, limit, direction,
            ))
            .await?;
        parse_streams(&body)
    }
}

/// The path and query of a `query_range` request.
pub(crate) fn query_range_api(
    selector: &str,
    start_ns: i64,
    end_ns: i64,
    limit: u32,
    direction: &str,
) -> String {
    format!(
        "/loki/api/v1/query_range?query={}&start={start_ns}&end={end_ns}&limit={limit}&direction={direction}",
        encode(selector)
    )
}
