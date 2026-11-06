//! Requests of an extension to a Service inside a cluster (`contributes.services`, `service.request`, ADR-0158).
//!
//! The manifest declares each Service by name and port; the user agrees to them word for word at install
//! (`grantedServices`). Sextant reaches one through a port forward of its own to `127.0.0.1` (the Tauri layer holds
//! it) and sends one request with the method, path and query the extension gives — what a port forward to that
//! Service would let anyone send — under these rules, kept here, without a network:
//!
//! - the path is a plain absolute path ([`check_path`]), the query is encoded by Sextant ([`encode_query`]), the body
//!   is JSON of at most [`MAX_REQUEST_BYTES`];
//! - TLS is spoken without checking the certificate only because the other end is the loopback end of Sextant's own
//!   forward ([`crate::argocd`]'s verifier), never plain HTTP unless the manifest says `http`;
//! - an answer is read up to [`MAX_ANSWER_BYTES`] within [`REQUEST_TIMEOUT`]; Kubernetes objects in a JSON answer
//!   (also inside JSON strings, as Argo CD's `liveState`) lose their Secret values and inline secrets
//!   ([`strip_secrets`]) before the extension gets them.

use std::net::Ipv4Addr;
use std::time::Duration;

use http::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HOST, HeaderValue};
use http::{Method, Request, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use ts_rs::TS;

use super::manifest::{ExtensionManifest, ManifestError};
use super::schema::JsonPath;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::resources::inline_secrets::hide_inline_secrets;

/// The extension API version that brought `contributes.services`.
pub const SERVICES_API: u32 = 4;
/// A request body, serialized, at most.
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// An answer is read up to this many bytes.
pub const MAX_ANSWER_BYTES: usize = 8 * 1024 * 1024;
/// One request, connection and answer included.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest path.
pub const MAX_PATH_CHARS: usize = 2048;
/// Query parameters of one request.
pub const MAX_QUERY_PARAMS: usize = 50;
/// How deep [`strip_secrets`] looks into an answer (objects, arrays and JSON strings).
const MAX_DEPTH: usize = 64;

/// A Service the extension may send requests to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServiceContribution {
    pub id: String,
    /// What it is, at consent: "Argo CD API".
    pub title: String,
    /// The Service's name, in the namespace each call names; or `label_selector`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    /// A label selector picking exactly one Service in the namespace (a Helm release's prefixed name), instead of
    /// `name` (ADR-0161).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label_selector: Option<String>,
    /// Keys of Secrets of the namespace the service may receive in `{{secret:<name>/<key>}}`, agreed to with it: no
    /// "Secret values" on the whole namespace is needed for them (ADR-0161).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<ServiceSecret>>", optional)]
    pub secrets: Vec<ServiceSecret>,
    /// The Service's port: its number or its name.
    #[ts(type = "number | string")]
    pub port: Value,
    /// `https` (the certificate is not checked: the loopback end of Sextant's forward) or `http`.
    pub scheme: ServiceScheme,
    /// What the user types to sign in, in Sextant's own dialog (`ui.signIn`, ADR-0160): put into a request body by
    /// `{{signIn:<field>}}`, never shown to the extension, remembered per cluster on request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sign_in: Option<SignIn>,
}

/// A key of a Secret a service may receive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServiceSecret {
    pub name: String,
    pub key: String,
}

impl ServiceContribution {
    /// The Service as the journal names it: its name, or its label selector.
    pub fn shown_name(&self) -> &str {
        self.name
            .as_deref()
            .or(self.label_selector.as_deref())
            .unwrap_or_default()
    }

    /// Whether the service may receive `key` of the Secret `name` without "Secret values".
    pub fn receives_secret(&self, name: &str, key: &str) -> bool {
        self.secrets.iter().any(|s| s.name == name && s.key == key)
    }
}

/// The fields of a service's sign-in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SignIn {
    pub fields: Vec<SignInField>,
}

/// One field of a sign-in: its id (`{{signIn:<id>}}`), its label and whether its value is hidden while typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SignInField {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ServiceScheme {
    Https,
    Http,
}

/// What reading a manifest checks of its services beyond the schema: the API version, a DNS-1123 name, a port number
/// or name as Kubernetes allows them.
pub(crate) fn check_services(manifest: &ExtensionManifest) -> Result<(), ManifestError> {
    let services = &manifest.contributes.services;
    let list = JsonPath::default().key("contributes").key("services");
    if services.is_empty() {
        return Ok(());
    }
    if manifest.sextant_api < SERVICES_API {
        return Err(at(
            &list,
            format!("needs sextantApi {SERVICES_API} or later"),
        ));
    }
    for (i, service) in services.iter().enumerate() {
        let here = list.index(i);
        match (&service.name, &service.label_selector) {
            (Some(name), None) => {
                if !is_dns_label(name) {
                    return Err(at(
                        &here.key("name"),
                        "must be a Service name: lowercase letters, digits and `-`, at most 63",
                    ));
                }
            }
            (None, Some(selector)) => {
                if !super::problems::is_set_selector(selector) {
                    return Err(at(
                        &here.key("labelSelector"),
                        "must be a Kubernetes label selector such as `app.kubernetes.io/name=argocd-server`",
                    ));
                }
            }
            _ => {
                return Err(at(
                    &here,
                    "names the Service by `name` or `labelSelector`, one of them",
                ));
            }
        }
        for (j, secret) in service.secrets.iter().enumerate() {
            let ok_key = !secret.key.is_empty()
                && secret.key.len() <= 253
                && secret
                    .key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
            if !is_dns_label(&secret.name) || !ok_key {
                return Err(at(
                    &here.key("secrets").index(j),
                    "names a Secret (a DNS name) and a key (letters, digits, `-`, `_`, `.`)",
                ));
            }
        }
        let port_ok = match &service.port {
            Value::Number(n) => n.as_u64().is_some_and(|p| (1..=65535).contains(&p)),
            Value::String(name) => is_port_name(name),
            _ => false,
        };
        if !port_ok {
            return Err(at(
                &here.key("port"),
                "must be a port number (1–65535) or a port name",
            ));
        }
        for (j, field) in service.sign_in.iter().flat_map(|s| &s.fields).enumerate() {
            let fields = &service.sign_in.as_ref().map_or(&[][..], |s| &s.fields[..]);
            if let Some(first) = fields[..j].iter().position(|f| f.id == field.id) {
                let list = here.key("signIn").key("fields");
                return Err(at(
                    &list.index(j).key("id"),
                    format!("duplicate id `{}` (also {})", field.id, list.index(first)),
                ));
            }
        }
    }
    Ok(())
}

/// Whether every service of `manifest` was agreed to as it is now written.
pub fn services_within(
    manifest: &ExtensionManifest,
    granted: Option<&[ServiceContribution]>,
) -> bool {
    let services = &manifest.contributes.services;
    services.is_empty()
        || granted.is_some_and(|granted| services.iter().all(|s| granted.contains(s)))
}

/// A DNS-1123 label.
pub fn is_dns_label(text: &str) -> bool {
    (1..=63).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !text.starts_with('-')
        && !text.ends_with('-')
}

/// An IANA service name as a port name: 1–15 lowercase letters, digits and `-`, a letter in it, no `--`.
fn is_port_name(text: &str) -> bool {
    (1..=15).contains(&text.len())
        && is_dns_label(text)
        && text.bytes().any(|b| b.is_ascii_lowercase())
        && !text.contains("--")
}

/// The HTTP method of a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum ServiceMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl ServiceMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceMethod::Get => "GET",
            ServiceMethod::Post => "POST",
            ServiceMethod::Put => "PUT",
            ServiceMethod::Patch => "PATCH",
            ServiceMethod::Delete => "DELETE",
        }
    }

    fn http(self) -> Method {
        match self {
            ServiceMethod::Get => Method::GET,
            ServiceMethod::Post => Method::POST,
            ServiceMethod::Put => Method::PUT,
            ServiceMethod::Patch => Method::PATCH,
            ServiceMethod::Delete => Method::DELETE,
        }
    }
}

/// A plain absolute path: `/` and printable ASCII, no query or fragment, no `.` or `..` segment, no `%2F`-style
/// escape of a separator.
pub fn check_path(path: &str) -> CoreResult<()> {
    let invalid = |why: &str| CoreError::new(ErrorCode::Invalid, format!("path {why}"));
    if !path.starts_with('/') {
        return Err(invalid("must start with /"));
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err(invalid(&format!(
            "is longer than {MAX_PATH_CHARS} characters"
        )));
    }
    if !path.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(invalid(
            "has a space or a character outside printable ASCII",
        ));
    }
    if path.contains(['?', '#', '\\']) {
        return Err(invalid("has `?`, `#` or `\\`: the query goes in `query`"));
    }
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") || lower.contains("%2e") {
        return Err(invalid("escapes a separator or a dot"));
    }
    if path
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(invalid("has a `.` or `..` segment"));
    }
    Ok(())
}

/// `key=value&…`, both percent-encoded (RFC 3986 unreserved characters kept).
pub fn encode_query(params: &[(String, String)]) -> CoreResult<String> {
    if params.len() > MAX_QUERY_PARAMS {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("at most {MAX_QUERY_PARAMS} query parameters"),
        ));
    }
    Ok(params
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&"))
}

fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Kubernetes objects anywhere in `value` — and in strings that hold a JSON object — lose what an extension never
/// reads: a core Secret its values (`data`, `stringData`, the last-applied annotation; marked
/// `sextant.dev/values-hidden`), any kind its inline secret fields.
pub fn strip_secrets(value: &mut Value) {
    strip(value, 0);
}

fn strip(value: &mut Value, depth: usize) {
    if depth > MAX_DEPTH {
        *value = Value::Null;
        return;
    }
    match value {
        Value::Object(map) => {
            let is_secret = map.get("apiVersion").and_then(Value::as_str) == Some("v1")
                && map.get("kind").and_then(Value::as_str) == Some("Secret");
            if is_secret {
                for field in ["data", "stringData"] {
                    if let Some(Value::Object(values)) = map.get_mut(field) {
                        for v in values.values_mut() {
                            *v = Value::String(String::new());
                        }
                    }
                }
                if let Some(Value::Object(annotations)) = map
                    .get_mut("metadata")
                    .and_then(|m| m.get_mut("annotations"))
                {
                    annotations.remove("kubectl.kubernetes.io/last-applied-configuration");
                    annotations.insert(
                        "sextant.dev/values-hidden".to_owned(),
                        Value::String("true".into()),
                    );
                }
            }
            for v in map.values_mut() {
                strip(v, depth + 1);
            }
        }
        Value::Array(items) => {
            for v in items {
                strip(v, depth + 1);
            }
        }
        Value::String(text) => {
            let trimmed = text.trim_start();
            if trimmed.starts_with('{')
                && let Ok(mut inner) = serde_json::from_str::<Value>(text)
            {
                strip(&mut inner, depth + 1);
                *text = inner.to_string();
            }
            return;
        }
        _ => return,
    }
    hide_inline_secrets(value);
}

/// One request sent through the forward at `127.0.0.1:<port>`.
#[derive(Debug, Clone)]
pub struct LoopbackRequest {
    pub port: u16,
    pub scheme: ServiceScheme,
    /// The Service's own name (`<name>.<namespace>.svc`): sent as `Host`, so a virtual host answers.
    pub host: String,
    pub method: ServiceMethod,
    /// Path and encoded query.
    pub path_and_query: String,
    pub body: Option<Value>,
    /// A bearer token Sextant adds (`Authorization`), never seen by the extension.
    pub bearer: Option<String>,
}

/// An answer: its status and body (JSON when it is JSON, else text).
#[derive(Debug, Clone, PartialEq)]
pub struct LoopbackAnswer {
    pub status: u16,
    pub body: Value,
}

/// Sends `request` over a fresh connection to the forward and reads the answer within the limits.
pub async fn send(request: LoopbackRequest) -> CoreResult<LoopbackAnswer> {
    let timed = tokio::time::timeout(REQUEST_TIMEOUT, send_now(request)).await;
    timed.unwrap_or_else(|_| {
        Err(CoreError::new(
            ErrorCode::Timeout,
            format!(
                "the service did not answer in {} s",
                REQUEST_TIMEOUT.as_secs()
            ),
        ))
    })
}

async fn send_now(request: LoopbackRequest) -> CoreResult<LoopbackAnswer> {
    let body = match &request.body {
        Some(value) => {
            let text = value.to_string();
            if text.len() > MAX_REQUEST_BYTES {
                return Err(CoreError::new(
                    ErrorCode::Invalid,
                    format!("the request body is larger than {MAX_REQUEST_BYTES} bytes"),
                ));
            }
            Bytes::from(text)
        }
        None => Bytes::new(),
    };
    let mut builder = Request::builder()
        .method(request.method.http())
        .uri(&request.path_and_query)
        .header(HOST, &request.host)
        .header(ACCEPT, "application/json");
    if request.body.is_some() {
        builder = builder.header(CONTENT_TYPE, "application/json");
    }
    if let Some(token) = &request.bearer {
        let mut value = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
            CoreError::new(
                ErrorCode::Unauthorized,
                "the session token has characters a header cannot carry",
            )
        })?;
        value.set_sensitive(true);
        builder = builder.header(AUTHORIZATION, value);
    }
    let http = builder
        .body(Full::new(body))
        .map_err(|err| CoreError::new(ErrorCode::Invalid, format!("bad request: {err}")))?;
    let tcp = TcpStream::connect((Ipv4Addr::LOCALHOST, request.port))
        .await
        .map_err(|err| unreachable(&err))?;
    let (status, bytes) = match request.scheme {
        ServiceScheme::Http => exchange(tcp, http).await?,
        ServiceScheme::Https => {
            let tls = crate::loopback_tls::loopback_tls_connector()
                .connect(crate::loopback_tls::loopback_server_name(), tcp)
                .await
                .map_err(|err| unreachable(&err))?;
            exchange(tls, http).await?
        }
    };
    let body = match serde_json::from_slice::<Value>(&bytes) {
        Ok(mut json) => {
            strip_secrets(&mut json);
            json
        }
        Err(_) => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
    };
    Ok(LoopbackAnswer {
        status: status.as_u16(),
        body,
    })
}

async fn exchange<S>(io: S, request: Request<Full<Bytes>>) -> CoreResult<(StatusCode, Bytes)>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .map_err(|err| unreachable(&err))?;
    let driver = tokio::spawn(connection);
    let result = async {
        let response = sender
            .send_request(request)
            .await
            .map_err(|err| unreachable(&err))?;
        let status = response.status();
        let body = Limited::new(response.into_body(), MAX_ANSWER_BYTES)
            .collect()
            .await
            .map_err(|err| {
                CoreError::new(
                    ErrorCode::Unreachable,
                    format!("reading the service's answer: {err}"),
                )
            })?
            .to_bytes();
        Ok((status, body))
    }
    .await;
    driver.abort();
    result
}

fn unreachable(err: &dyn std::error::Error) -> CoreError {
    CoreError::new(
        ErrorCode::Unreachable,
        format!("the service cannot be reached through the port forward: {err}"),
    )
}

fn at(path: &JsonPath, message: impl Into<String>) -> ManifestError {
    ManifestError {
        path: path.to_string(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_path_is_plain_and_absolute() {
        for good in [
            "/api/v1/applications/web/managed-resources",
            "/",
            "/a-b_c.d~e/%20x",
        ] {
            assert!(check_path(good).is_ok(), "{good}");
        }
        for bad in [
            "api",
            "/a?b=c",
            "/a#x",
            "/a/../b",
            "/a/./b",
            "/a b",
            "/a\\b",
            "/a%2Fb",
            "/%2e%2e/x",
            "/ü",
        ] {
            assert!(check_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_query_is_encoded_by_sextant() {
        let query = encode_query(&[
            ("appNamespace".into(), "argo cd".into()),
            ("x&y".into(), "a=b/c".into()),
        ])
        .unwrap();
        assert_eq!(query, "appNamespace=argo%20cd&x%26y=a%3Db%2Fc");
    }

    #[test]
    fn secrets_in_an_answer_are_emptied_also_inside_json_strings() {
        let secret = json!({ "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": "db", "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{}" } },
            "data": { "password": "aHVudGVyMg==" }, "stringData": { "token": "t0k" } });
        let mut answer = json!({ "items": [
            { "kind": "Secret", "name": "db", "liveState": secret.to_string(), "targetState": secret },
            { "kind": "ConfigMap", "liveState": "{\"apiVersion\":\"v1\",\"kind\":\"ConfigMap\",\"data\":{\"a\":\"b\"}}" }
        ] });
        strip_secrets(&mut answer);
        let live: Value =
            serde_json::from_str(answer["items"][0]["liveState"].as_str().unwrap()).unwrap();
        for side in [&live, &answer["items"][0]["targetState"]] {
            assert_eq!(side["data"]["password"], json!(""));
            assert_eq!(side["stringData"]["token"], json!(""));
            assert_eq!(
                side["metadata"]["annotations"]["sextant.dev/values-hidden"],
                json!("true")
            );
            assert!(
                side["metadata"]["annotations"]
                    .get("kubectl.kubernetes.io/last-applied-configuration")
                    .is_none()
            );
        }
        let config: Value =
            serde_json::from_str(answer["items"][1]["liveState"].as_str().unwrap()).unwrap();
        assert_eq!(config["data"]["a"], json!("b"));
        assert!(!answer.to_string().contains("aHVudGVyMg=="));
    }

    #[test]
    fn port_names_and_service_names_follow_kubernetes() {
        assert!(is_dns_label("argocd-server"));
        assert!(!is_dns_label("Argo"));
        assert!(!is_dns_label("-a"));
        assert!(is_port_name("https"));
        assert!(!is_port_name("http--x"));
        assert!(!is_port_name("443"));
        assert!(!is_port_name("a-very-long-port-name"));
    }
}
