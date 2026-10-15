//! Downloads from GitHub with fixed rules, shared by extension packages (`extensions::manage::Downloader`) and the
//! Flux / Argo CD installer (`gitops_install::download`): HTTPS through rustls (ring), no automatic redirects — each
//! one is checked by the caller's rule before it is followed, at most [`MAX_REDIRECTS`] — a size limit checked
//! while reading, and a limit on the whole download's time. Errors never carry the URL (signed asset links).

use std::sync::Arc;
use std::time::Duration;

use reqwest::Url;
use sextant_core::{CoreError, CoreResult, ErrorCode};

/// Redirects followed at most.
pub const MAX_REDIRECTS: usize = 5;
/// Hosts a GitHub release download may redirect to (where GitHub keeps the files).
pub const ASSET_HOSTS: [&str; 2] = [
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// Rewrites the URL a request is actually sent to (tests: a local fake server); policy checks see the original.
pub type Connect = Arc<dyn Fn(&Url) -> Url + Send + Sync>;

/// `https://<host>/…` on the default port, with no user name or password.
pub fn plain_https(url: &Url, host: &str) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// One of GitHub's asset hosts over plain HTTPS.
pub fn is_asset_host(url: &Url) -> bool {
    ASSET_HOSTS.iter().any(|host| plain_https(url, host))
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

fn network(err: reqwest::Error) -> CoreError {
    let err = err.without_url();
    if err.is_timeout() {
        CoreError::new(ErrorCode::Timeout, format!("The download timed out: {err}"))
    } else {
        CoreError::new(
            ErrorCode::Unreachable,
            format!("The download failed: {err}"),
        )
    }
}

/// What one download may do.
pub struct Fetch<'a> {
    /// The body is refused once it would grow past this.
    pub max_bytes: u64,
    /// The whole download, redirects included.
    pub timeout: Duration,
    /// Where requests really go (tests); `None` sends them to the URL itself.
    pub connect: Option<&'a Connect>,
    /// Whether a redirect target may be followed.
    pub allowed_redirect: &'a (dyn Fn(&Url) -> bool + Sync),
    /// The `Accept` header, when one is needed (the GitHub API).
    pub accept: Option<&'static str>,
}

fn client() -> CoreResult<reqwest::Client> {
    // reqwest is built without a crypto provider; ring is the one the app uses (as the updater does).
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("Sextant/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CoreError::other(format!("cannot start the download: {}", e.without_url())))
}

impl Fetch<'_> {
    fn too_large(&self) -> CoreError {
        invalid(format!(
            "The file is larger than {} MB",
            self.max_bytes / 1024 / 1024
        ))
    }

    /// Downloads `url` (already checked by the caller) into memory within the limits.
    pub async fn get(&self, url: Url) -> CoreResult<Vec<u8>> {
        match tokio::time::timeout(self.timeout, self.follow(url)).await {
            Ok(result) => result,
            Err(_) => Err(CoreError::new(
                ErrorCode::Timeout,
                format!("The download took longer than {} s", self.timeout.as_secs()),
            )),
        }
    }

    async fn follow(&self, mut url: Url) -> CoreResult<Vec<u8>> {
        let client = client()?;
        for _ in 0..=MAX_REDIRECTS {
            let target = match self.connect {
                Some(connect) => connect(&url),
                None => url.clone(),
            };
            let mut request = client.get(target);
            if let Some(accept) = self.accept {
                request = request.header(reqwest::header::ACCEPT, accept);
            }
            let mut response = request.send().await.map_err(network)?;
            let status = response.status();
            if status.is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| CoreError::other("The download was redirected nowhere"))?;
                let next = url.join(location).map_err(|e| {
                    CoreError::other(format!("The download was redirected to a bad link: {e}"))
                })?;
                if !(self.allowed_redirect)(&next) {
                    return Err(invalid(format!(
                        "The download was redirected to {}, which is not GitHub",
                        next.host_str().unwrap_or("another site")
                    )));
                }
                url = next;
                continue;
            }
            if !status.is_success() {
                return Err(CoreError::new(
                    sextant_core::error::code_for_http_status(status.as_u16()),
                    format!("The download failed: HTTP {status}"),
                ));
            }
            if response
                .content_length()
                .is_some_and(|len| len > self.max_bytes)
            {
                return Err(self.too_large());
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(network)? {
                if body.len() as u64 + chunk.len() as u64 > self.max_bytes {
                    return Err(self.too_large());
                }
                body.extend_from_slice(&chunk);
            }
            return Ok(body);
        }
        Err(CoreError::other(
            "The download was redirected too many times",
        ))
    }
}
