//! Alertmanager's API v2 through the API server's service proxy: fixed paths and queries only.

use http_body_util::{BodyExt, LengthLimitError, Limited};
use kube::client::Body;

use super::{Alert, Silence};
use super::{AlertmanagerTarget, MAX_BODY, REQUEST_TIMEOUT, read};
use crate::error::{CoreError, CoreResult, ErrorCode, code_for_http_status, kube_error};

/// Every alert the Alertmanager holds: active, silenced, inhibited and not yet processed.
pub(crate) const ALERTS_QUERY: &str =
    "api/v2/alerts?active=true&silenced=true&inhibited=true&unprocessed=true";
/// Asks for no alert at all: a cheap check that an Alertmanager API answers there.
pub(crate) const PROBE_QUERY: &str =
    "api/v2/alerts?active=false&silenced=false&inhibited=false&unprocessed=false";
pub(crate) const SILENCES_PATH: &str = "api/v2/silences";
/// The probe's answer is a list of nothing.
const PROBE_LIMIT: usize = 256 * 1024;

/// The request path of `query` at `target` (checked by `validate_target` or built by detection).
pub(crate) fn request_uri(target: &AlertmanagerTarget, query: &str) -> String {
    format!("{}/{query}", target.base())
}

fn unreachable(target: &AlertmanagerTarget, detail: impl std::fmt::Display) -> CoreError {
    CoreError::new(
        ErrorCode::Unreachable,
        format!(
            "the Alertmanager {} did not answer through the API server: {detail}",
            target.describe()
        ),
    )
}

/// Sends a GET and reads at most `limit` bytes of the answer; non-2xx statuses become errors.
async fn send(
    client: &kube::Client,
    target: &AlertmanagerTarget,
    query: &str,
    limit: usize,
) -> CoreResult<Vec<u8>> {
    let request = http::Request::get(request_uri(target, query))
        .body(Body::from(Vec::new()))
        .map_err(|e| CoreError::new(ErrorCode::Invalid, e.to_string()))?;
    let exchange = async {
        let response = client
            .send(request)
            .await
            .map_err(|e| kube_error(e, None))?;
        let status = response.status();
        let body = Limited::new(response.into_body(), limit)
            .collect()
            .await
            .map_err(|err| {
                if err.downcast_ref::<LengthLimitError>().is_some() {
                    CoreError::new(
                        ErrorCode::Invalid,
                        format!(
                            "the Alertmanager answer is larger than {} MiB",
                            MAX_BODY / (1024 * 1024)
                        ),
                    )
                } else {
                    unreachable(target, err)
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
                    "the Alertmanager did not answer in {} seconds",
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
                "no permission to reach the Alertmanager {} through the API server (services/proxy)",
                target.describe()
            ),
        ),
        404 | 502 | 503 => unreachable(target, format!("HTTP {status}")),
        code => CoreError::new(
            code_for_http_status(code),
            format!("the Alertmanager answered HTTP {code}"),
        ),
    })
}

/// Whether an Alertmanager API v2 answers at `target`.
pub(crate) async fn probe(client: &kube::Client, target: &AlertmanagerTarget) -> CoreResult<()> {
    let body = send(client, target, PROBE_QUERY, PROBE_LIMIT).await?;
    match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(serde_json::Value::Array(_)) => Ok(()),
        _ => Err(CoreError::new(
            ErrorCode::Invalid,
            "the answer is not from the Alertmanager API v2",
        )),
    }
}

/// Every alert, read and clipped.
pub(crate) async fn alerts(
    client: &kube::Client,
    target: &AlertmanagerTarget,
) -> CoreResult<Vec<Alert>> {
    let body = send(client, target, ALERTS_QUERY, MAX_BODY).await?;
    read::alertmanager_alerts(&body)
}

/// Active and pending silences (at most `MAX_SILENCES`), and how many expired ones there are.
pub(crate) async fn silences(
    client: &kube::Client,
    target: &AlertmanagerTarget,
) -> CoreResult<(Vec<Silence>, u32)> {
    let body = send(client, target, SILENCES_PATH, MAX_BODY).await?;
    read::silences(&body)
}
