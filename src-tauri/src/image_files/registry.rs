//! The registry client of the image file viewer (ADR-0103) — the one exception to "Sextant fetches only URLs it built":
//! the registry is the host named in an image reference. HTTPS only; no request ever goes to a loopback, link-local or
//! other forbidden address (checked on URLs and again on every resolved address); the Bearer token flow asks the
//! realm for `repository:<repo>:pull` only; manifests follow redirects only within their origin; blobs follow at most
//! [`limits::MAX_BLOB_REDIRECTS`] HTTPS redirects to any allowed host, without credentials. Errors never carry a URL,
//! a token or a credential.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, LOCATION, WWW_AUTHENTICATE};
use reqwest::{Response, StatusCode, Url};
use sextant_core::image_fs::auth::{Challenge, Credential, parse_challenge, parse_token};
use sextant_core::image_fs::limits;
use sextant_core::image_fs::manifest::MANIFEST_ACCEPT;
use sextant_core::image_fs::reference::{ImageRef, check_host_name, forbidden_ip};
use sextant_core::{CoreError, CoreResult, ErrorCode};
use tokio::sync::Mutex;

use crate::download::Connect;

/// Resolves names like the system does, then drops every address Sextant never contacts.
pub(crate) struct FilteringResolver;

impl reqwest::dns::Resolve for FilteringResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let found: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|addr| !forbidden_ip(addr.ip()))
                .collect();
            if found.is_empty() {
                return Err("the host has no address Sextant may contact".into());
            }
            Ok(Box::new(found.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

fn network(err: reqwest::Error) -> CoreError {
    let err = err.without_url();
    if err.is_timeout() {
        CoreError::new(ErrorCode::Timeout, "the registry did not answer in time")
    } else {
        CoreError::new(
            ErrorCode::Unreachable,
            format!("the registry could not be reached: {err}"),
        )
    }
}

fn status_error(status: StatusCode, what: &str) -> CoreError {
    let code = sextant_core::error::code_for_http_status(status.as_u16());
    let hint = match status {
        StatusCode::UNAUTHORIZED => " (no credentials, or the credentials were refused)",
        StatusCode::FORBIDDEN => " (the credentials may not pull this image)",
        StatusCode::NOT_FOUND => " (no such image, tag or blob)",
        StatusCode::TOO_MANY_REQUESTS => " (rate limited)",
        _ => "",
    };
    CoreError::new(
        code,
        format!("the registry refused {what}: HTTP {status}{hint}"),
    )
}

/// A URL Sextant may send a request to: HTTPS, no user name or password, an allowed host.
pub fn check_url(url: &Url) -> CoreResult<()> {
    if url.scheme() != "https" {
        return Err(invalid(
            "the registry sent a link that is not HTTPS, which Sextant never follows",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("the registry sent a link with a user name in it"));
    }
    match url.host_str() {
        Some(host) => check_host_name(host),
        None => Err(invalid("the registry sent a link without a host")),
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// How the registry wants requests authorized, as learnt from its challenges.
#[derive(Default)]
enum Auth {
    #[default]
    None,
    Basic,
    Bearer(String),
}

/// One image's registry, its credentials and its token.
pub struct Registry {
    client: reqwest::Client,
    image: ImageRef,
    credential: Option<Credential>,
    auth: Mutex<Auth>,
    connect: Option<Connect>,
}

impl Registry {
    pub fn new(
        image: ImageRef,
        credential: Option<Credential>,
        connect: Option<Connect>,
    ) -> CoreResult<Self> {
        // reqwest is built without a crypto provider; ring is the one the app uses.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("Sextant/", env!("CARGO_PKG_VERSION")))
            .dns_resolver(Arc::new(FilteringResolver))
            .build()
            .map_err(|e| {
                CoreError::other(format!(
                    "cannot start the registry client: {}",
                    e.without_url()
                ))
            })?;
        Ok(Self {
            client,
            image,
            credential,
            auth: Mutex::new(Auth::None),
            connect,
        })
    }

    pub fn image(&self) -> &ImageRef {
        &self.image
    }

    fn url(&self, kind: &str, reference: &str) -> CoreResult<Url> {
        let text = format!(
            "https://{}/v2/{}/{kind}/{reference}",
            self.image.api_host(),
            self.image.repository
        );
        let url = Url::parse(&text)
            .map_err(|_| invalid("the image reference does not make a valid link"))?;
        check_url(&url)?;
        Ok(url)
    }

    fn target(&self, url: &Url) -> Url {
        match &self.connect {
            Some(connect) => connect(url),
            None => url.clone(),
        }
    }

    async fn header(&self) -> Option<String> {
        match &*self.auth.lock().await {
            Auth::None => None,
            Auth::Basic => self.credential.as_ref().and_then(Credential::basic_header),
            Auth::Bearer(token) => Some(format!("Bearer {token}")),
        }
    }

    /// GET `url` with the registry's authorization, answering one challenge (a token, or Basic credentials).
    async fn get_authorized(&self, url: &Url, accept: Option<&str>) -> CoreResult<Response> {
        let mut answered = false;
        loop {
            let mut request = self.client.get(self.target(url));
            if let Some(accept) = accept {
                request = request.header(ACCEPT, accept);
            }
            if let Some(header) = self.header().await {
                request = request.header(AUTHORIZATION, header);
            }
            let response = request.send().await.map_err(network)?;
            if response.status() != StatusCode::UNAUTHORIZED || answered {
                return Ok(response);
            }
            answered = true;
            let challenge = response
                .headers()
                .get(WWW_AUTHENTICATE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_challenge);
            match challenge {
                Some(Challenge::Bearer { realm, service }) => {
                    let token = self.fetch_token(&realm, service.as_deref()).await?;
                    *self.auth.lock().await = Auth::Bearer(token);
                }
                Some(Challenge::Basic)
                    if self
                        .credential
                        .as_ref()
                        .and_then(Credential::basic_header)
                        .is_some() =>
                {
                    *self.auth.lock().await = Auth::Basic;
                }
                _ => return Ok(response),
            }
        }
    }

    /// Asks the token realm for a pull token of this repository (never a wider scope). The realm must be HTTPS and
    /// an allowed host; its answer is not followed if it redirects.
    async fn fetch_token(&self, realm: &str, service: Option<&str>) -> CoreResult<String> {
        let mut url = Url::parse(realm)
            .map_err(|_| invalid("the registry named an invalid token service"))?;
        check_url(&url)?;
        let scope = format!("repository:{}:pull", self.image.repository);
        let request = match self
            .credential
            .as_ref()
            .and_then(Credential::identity_token)
        {
            Some(refresh) => {
                let mut form = vec![
                    ("grant_type", "refresh_token"),
                    ("client_id", "sextant"),
                    ("scope", scope.as_str()),
                    ("refresh_token", refresh),
                ];
                if let Some(service) = service {
                    form.push(("service", service));
                }
                let body = form_body(&form);
                self.client
                    .post(self.target(&url))
                    .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .body(body)
            }
            None => {
                {
                    let mut query = url.query_pairs_mut();
                    if let Some(service) = service {
                        query.append_pair("service", service);
                    }
                    query.append_pair("scope", &scope);
                }
                let mut request = self.client.get(self.target(&url));
                if let Some(basic) = self.credential.as_ref().and_then(Credential::basic_header) {
                    request = request.header(AUTHORIZATION, basic);
                }
                request
            }
        };
        let response = request.send().await.map_err(network)?;
        if !response.status().is_success() {
            return Err(status_error(response.status(), "the token request"));
        }
        let body = read_capped(response, limits::MAX_TOKEN_RESPONSE_BYTES).await?;
        parse_token(&body)
    }

    /// A manifest or an index by tag or digest, and its content type. Redirects only within the registry's origin.
    pub async fn manifest(&self, reference: &str) -> CoreResult<(Vec<u8>, Option<String>)> {
        let mut url = self.url("manifests", reference)?;
        for _ in 0..=limits::MAX_BLOB_REDIRECTS {
            let response = self.get_authorized(&url, Some(MANIFEST_ACCEPT)).await?;
            if response.status().is_redirection() {
                let next = redirect_target(&url, &response)?;
                if !same_origin(&url, &next) {
                    return Err(invalid(
                        "the registry redirected a manifest to another site",
                    ));
                }
                url = next;
                continue;
            }
            if !response.status().is_success() {
                return Err(status_error(response.status(), "the manifest"));
            }
            let content_type = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let body = read_capped(response, limits::MAX_MANIFEST_BYTES).await?;
            return Ok((body, content_type));
        }
        Err(invalid("the registry redirected too many times"))
    }

    /// Opens the blob `digest`: the registry's answer, or the storage it redirects to (each hop HTTPS to an allowed
    /// host, without credentials).
    pub async fn blob(&self, digest: &str) -> CoreResult<Response> {
        let mut url = self.url("blobs", digest)?;
        let mut response = self.get_authorized(&url, None).await?;
        for hop in 0..=limits::MAX_BLOB_REDIRECTS {
            if !response.status().is_redirection() {
                break;
            }
            if hop == limits::MAX_BLOB_REDIRECTS {
                return Err(invalid("the registry redirected too many times"));
            }
            let next = redirect_target(&url, &response)?;
            response = self
                .client
                .get(self.target(&next))
                .send()
                .await
                .map_err(network)?;
            url = next;
        }
        if !response.status().is_success() {
            return Err(status_error(response.status(), "a layer download"));
        }
        Ok(response)
    }

    /// A small blob (the image config), whole, within `max` bytes.
    pub async fn blob_bytes(&self, digest: &str, max: u64) -> CoreResult<Vec<u8>> {
        let response = self.blob(digest).await?;
        read_capped(response, max).await
    }
}

/// `application/x-www-form-urlencoded` text of `pairs`.
fn form_body(pairs: &[(&str, &str)]) -> String {
    let mut scratch = Url::parse("https://form.invalid/").expect("a constant URL");
    scratch.query_pairs_mut().extend_pairs(pairs);
    scratch.query().unwrap_or("").to_owned()
}

fn redirect_target(from: &Url, response: &Response) -> CoreResult<Url> {
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| CoreError::other("the registry redirected nowhere"))?;
    let next = from
        .join(location)
        .map_err(|_| CoreError::other("the registry redirected to an invalid link"))?;
    check_url(&next)?;
    Ok(next)
}

/// The body within `max` bytes and the idle limit.
pub async fn read_capped(mut response: Response, max: u64) -> CoreResult<Vec<u8>> {
    if response.content_length().is_some_and(|len| len > max) {
        return Err(invalid("the registry's answer is too large"));
    }
    let mut body = Vec::new();
    loop {
        let chunk = tokio::time::timeout(limits::IDLE_TIMEOUT, response.chunk())
            .await
            .map_err(|_| CoreError::new(ErrorCode::Timeout, "the registry stopped sending"))?
            .map_err(network)?;
        let Some(chunk) = chunk else {
            return Ok(body);
        };
        if body.len() as u64 + chunk.len() as u64 > max {
            return Err(invalid("the registry's answer is too large"));
        }
        body.extend_from_slice(&chunk);
    }
}

/// A response body as a blocking reader (for the indexer on a blocking thread): chunks are pumped by an async task
/// through a small channel; no data for [`limits::IDLE_TIMEOUT`] or a broken connection ends it with an error, and
/// dropping the reader stops the pump.
pub struct BodyReader {
    rx: tokio::sync::mpsc::Receiver<std::io::Result<Vec<u8>>>,
    current: Vec<u8>,
    offset: usize,
}

impl BodyReader {
    pub fn start(mut response: Response) -> Self {
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move {
            loop {
                let next = match tokio::time::timeout(limits::IDLE_TIMEOUT, response.chunk()).await
                {
                    Ok(Ok(Some(chunk))) => Ok(chunk.to_vec()),
                    Ok(Ok(None)) => break,
                    Ok(Err(err)) => Err(std::io::Error::other(network(err).message)),
                    Err(_) => Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "the registry stopped sending",
                    )),
                };
                let failed = next.is_err();
                if tx.send(next).await.is_err() || failed {
                    break;
                }
            }
        });
        Self {
            rx,
            current: Vec::new(),
            offset: 0,
        }
    }
}

impl std::io::Read for BodyReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.offset >= self.current.len() {
            match self.rx.blocking_recv() {
                Some(Ok(chunk)) => {
                    self.current = chunk;
                    self.offset = 0;
                }
                Some(Err(err)) => return Err(err),
                None => return Ok(0),
            }
        }
        let n = buf.len().min(self.current.len() - self.offset);
        buf[..n].copy_from_slice(&self.current[self.offset..self.offset + n]);
        self.offset += n;
        Ok(n)
    }
}
