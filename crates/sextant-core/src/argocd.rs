//! Argo CD API: finding `argocd-server`, signing in, and the desired ↔ live state of an Application's resources.
//!
//! The API is reached through a local port forward (`PortForwarder`, owned by the caller) on `127.0.0.1`. Argo CD
//! serves it with a self-signed certificate, so [`ArgoClient`] does not check the certificate — and it can only talk to
//! the loopback address: the channel behind the forward is the Kubernetes API connection, already protected by TLS.
//!
//! Passwords and tokens are [`SecretString`]s: they print as `<hidden>`, never go into an error message and never
//! cross to the frontend (no type here that the frontend receives carries one). Values of Kubernetes Secrets in the
//! resource states are hidden the same way `resources::get::to_json` hides them.

use std::collections::BTreeSet;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use http::header::{AUTHORIZATION, CONTENT_TYPE, HOST, HeaderValue};
use http::{Method, Request, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use k8s_openapi::api::core::v1::{ConfigMap, Secret, Service};
use k8s_openapi::api::rbac::v1::ClusterRoleBinding;
use kube::Api;
use kube::api::ListParams;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, kube_error};
use crate::kubeconfig::ClusterId;

/// Namespace Argo CD's own manifests install it into; preferred among several candidates (see `installation_namespace`).
pub const DEFAULT_NAMESPACE: &str = "argocd";
/// Label of the `argocd-server` Service in the official manifests and the Helm chart.
pub const SERVER_SELECTOR: &str = "app.kubernetes.io/name=argocd-server";
/// The Secret Argo CD creates at installation with the first password of `admin` (key `password`).
pub const INITIAL_ADMIN_SECRET: &str = "argocd-initial-admin-secret";
/// Secrets of an Argo CD installation; one with a `token` key holds an API token (`argocd account generate-token`).
pub const PART_OF_SELECTOR: &str = "app.kubernetes.io/part-of=argocd";
/// Argo CD's settings: `admin.enabled`, local `accounts.*`, SSO (`dex.config`, `oidc.config`).
pub const SETTINGS_CONFIG_MAP: &str = "argocd-cm";
/// How the `notFound` error of [`find_server`] begins when several namespaces look like an Argo CD installation and
/// nothing a namespace's tenant cannot create tells the real one.
pub const AMBIGUOUS_INSTALLATION: &str = "ambiguous Argo CD installation";

/// One request to the Argo CD API (connect, TLS, answer).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The largest answer read (managed resources of a big application).
const MAX_BODY: usize = 64 * 1024 * 1024;
/// Same marker as `resources::get::VALUES_HIDDEN_ANNOTATION`: a Secret sent without its values.
const VALUES_HIDDEN_ANNOTATION: &str = "sextant.dev/values-hidden";
const LAST_APPLIED_ANNOTATION: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// A password or token. Prints as `<hidden>`; [`SecretString::expose`] is the only way to the value.
#[derive(Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.trim().is_empty()
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<hidden>")
    }
}

/// How to sign in. As JSON (the saved form): `{"username":…,"password":…}` or `{"token":…}`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Credentials {
    Password {
        username: String,
        password: SecretString,
    },
    Token {
        token: SecretString,
    },
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Password { username, .. } => write!(f, "Password {{ username: {username:?} }}"),
            Self::Token { .. } => f.write_str("Token"),
        }
    }
}

/// Where the credentials of a session came from. `secret`: a standard Secret of the installation
/// (`argocd-initial-admin-secret` or a token Secret); `saved`: the OS credential store; `manual`: typed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CredentialSource {
    Secret,
    Saved,
    Manual,
}

/// A signed-in session: the token Argo CD issued (or the API token itself). Prints without the token.
#[derive(Clone)]
pub struct Session {
    token: SecretString,
    pub username: Option<String>,
}

impl Session {
    /// The bearer token (an API token can be made from it with `argocd account generate-token`; tests sign in
    /// with it as a token).
    pub fn token(&self) -> &SecretString {
        &self.token
    }
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Session {{ username: {:?} }}", self.username)
    }
}

/// One resource of an Application with its states as Argo CD sees them (`GET …/managed-resources`). A state is
/// `None` when the object is missing on that side (not yet created / to be pruned). Values of a core/v1 Secret are
/// `""`, as everywhere in Sextant; `metadata.managedFields` is removed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ManagedResource {
    /// `""` for the core group.
    pub group: String,
    pub kind: String,
    /// `""` for cluster-scoped objects.
    pub namespace: String,
    pub name: String,
    /// The object as rendered from Git.
    pub target_state: Option<Value>,
    /// The object in the cluster.
    pub live_state: Option<Value>,
    /// The live object after Argo CD's normalization (`ignoreDifferences`): what Argo CD compares.
    pub normalized_live_state: Option<Value>,
    /// The live object as it would be after a sync (the target merged into it): Argo CD's side of the diff.
    pub predicted_live_state: Option<Value>,
}

/// The `argocd-server` Service and the port of it the API is reached on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgoServer {
    pub namespace: String,
    pub name: String,
    pub port: u16,
}

/// What the sign-in window can offer, from `argocd-cm`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoginOptions {
    /// There is a local user who may sign in with a password (`admin`, unless `admin.enabled: "false"`, or an
    /// `accounts.<name>` with the `login` capability).
    pub local_users: bool,
    /// SSO is configured (`dex.config` or `oidc.config`); Sextant cannot sign in through it.
    pub sso: bool,
}

/// Finds the `argocd-server` Service of the Argo CD installation: only in the namespace Argo CD is installed in
/// ([`installation_namespace`]) — by its label, otherwise by the name `argocd-server`. A Service with the same label
/// in any other namespace is never chosen, so the password typed in the sign-in window and the credentials of the
/// installation's Secrets (read from the same namespace) go to the installation's own server only. The port is the
/// one named `https` (or 443), otherwise the first.
pub async fn find_server(mgr: &ClusterManager, cluster: &ClusterId) -> CoreResult<ArgoServer> {
    let client = mgr.client(cluster)?;
    let namespace = installation_namespace(&client).await?;
    let api = Api::<Service>::namespaced(client, &namespace);
    let mut services = match api
        .list(&ListParams::default().labels(SERVER_SELECTOR))
        .await
    {
        Ok(list) => list.items,
        Err(err) => absent_as_none(kube_error(err, None))?.unwrap_or_default(),
    };
    if services.is_empty() {
        match api.get("argocd-server").await {
            Ok(svc) => services.push(svc),
            Err(err) => absent_as_none::<()>(kube_error(err, None)).map(|_| ())?,
        }
    }
    // By name, so the choice does not change between calls.
    services.sort_by_key(|svc| svc.metadata.name.clone());
    let not_found = || {
        CoreError::new(
            ErrorCode::NotFound,
            format!(
                "Argo CD server not found: no Service with the label {SERVER_SELECTOR} and no argocd-server in \
                 {namespace}"
            ),
        )
    };
    let svc = services.into_iter().next().ok_or_else(not_found)?;
    let ports = svc.spec.and_then(|s| s.ports).unwrap_or_default();
    let port = ports
        .iter()
        .find(|p| p.name.as_deref() == Some("https") || p.port == 443)
        .or_else(|| ports.first())
        .ok_or_else(not_found)?;
    Ok(ArgoServer {
        name: svc.metadata.name.clone().unwrap_or_default(),
        port: u16::try_from(port.port).map_err(|_| not_found())?,
        namespace,
    })
}

/// The namespace Argo CD is installed in. A tenant who may write only in their own namespace can put an `argocd-cm`,
/// a labelled Service and a token Secret there, so those alone do not decide:
///
/// 1. A cluster-wide installation is named by a ClusterRoleBinding of its `argocd-application-controller` or
///    `argocd-server` (official manifests, Helm chart: `<release>-argocd-…`) to the component's ServiceAccount —
///    cluster-scoped, so a namespace's tenant cannot create one. The namespace of that ServiceAccount (narrowed to
///    the namespaces holding `argocd-cm` / `argocd-initial-admin-secret`, when some of them do) is the installation.
/// 2. Without such a binding (a namespaced installation, or no right to list ClusterRoleBindings) the namespaces
///    holding `argocd-cm` or `argocd-initial-admin-secret` are the candidates.
///
/// Out of the namespaces left: the only one, else [`DEFAULT_NAMESPACE`] when it is one of them; several others are a
/// `notFound` error beginning with [`AMBIGUOUS_INSTALLATION`] that names them — none is picked. No namespace at all
/// gives [`DEFAULT_NAMESPACE`]. Only names are read (metadata), never a Secret's values.
async fn installation_namespace(client: &kube::Client) -> CoreResult<String> {
    let marked = marked_namespaces(client).await?;
    let candidates = candidate_namespaces(client).await?;
    if marked.is_empty() {
        return choose_namespace(candidates, "");
    }
    let live: BTreeSet<String> = marked.intersection(&candidates).cloned().collect();
    choose_namespace(
        if live.is_empty() { marked } else { live },
        " named by ClusterRoleBindings of argocd-application-controller / argocd-server",
    )
}

/// Argo CD components whose ClusterRoleBinding marks the namespace of a cluster-wide installation.
const MARKING_COMPONENTS: [&str; 2] = ["argocd-application-controller", "argocd-server"];

/// `name` is `component` or ends with `-<component>` (the Helm chart prefixes the release name).
fn is_component(name: &str, component: &str) -> bool {
    name == component
        || name
            .strip_suffix(component)
            .is_some_and(|prefix| prefix.ends_with('-'))
}

/// Namespaces of the ServiceAccounts bound by the ClusterRoleBindings of [`MARKING_COMPONENTS`]; empty when there are
/// none or they cannot be listed.
async fn marked_namespaces(client: &kube::Client) -> CoreResult<BTreeSet<String>> {
    let bindings = match Api::<ClusterRoleBinding>::all(client.clone())
        .list(&ListParams::default())
        .await
    {
        Ok(list) => list.items,
        Err(err) => absent_as_none(kube_error(err, None))?.unwrap_or_default(),
    };
    let mut namespaces = BTreeSet::new();
    for binding in bindings {
        let name = binding.metadata.name.as_deref().unwrap_or_default();
        let Some(component) = MARKING_COMPONENTS
            .into_iter()
            .find(|c| is_component(name, c))
        else {
            continue;
        };
        namespaces.extend(
            binding
                .subjects
                .unwrap_or_default()
                .into_iter()
                .filter(|s| s.kind == "ServiceAccount" && is_component(&s.name, component))
                .filter_map(|s| s.namespace.filter(|ns| !ns.is_empty())),
        );
    }
    Ok(namespaces)
}

/// The installation out of `namespaces` (see [`installation_namespace`]); `why` says where they came from.
fn choose_namespace(namespaces: BTreeSet<String>, why: &str) -> CoreResult<String> {
    if namespaces.len() <= 1 || namespaces.contains(DEFAULT_NAMESPACE) {
        return Ok(if namespaces.len() == 1 {
            namespaces.into_iter().next().unwrap_or_default()
        } else {
            DEFAULT_NAMESPACE.to_owned()
        });
    }
    let names: Vec<String> = namespaces.into_iter().collect();
    Err(CoreError::new(
        ErrorCode::NotFound,
        format!(
            "{AMBIGUOUS_INSTALLATION}: several namespaces look like it ({}){why}, and nothing a namespace's tenant \
             cannot create (a ClusterRoleBinding of argocd-application-controller or argocd-server) tells the real \
             one; Sextant does not pick one",
            names.join(", ")
        ),
    ))
}

/// Namespaces holding an `argocd-cm` or `argocd-initial-admin-secret`; empty when they cannot be listed.
async fn candidate_namespaces(client: &kube::Client) -> CoreResult<BTreeSet<String>> {
    let by_name = |name: &str| ListParams::default().fields(&format!("metadata.name={name}"));
    let settings = Api::<ConfigMap>::all(client.clone())
        .list_metadata(&by_name(SETTINGS_CONFIG_MAP))
        .await;
    let admin_secret = Api::<Secret>::all(client.clone())
        .list_metadata(&by_name(INITIAL_ADMIN_SECRET))
        .await;
    let mut namespaces = BTreeSet::new();
    for listed in [
        settings.map(|l| l.items.into_iter().map(|o| o.metadata).collect::<Vec<_>>()),
        admin_secret.map(|l| l.items.into_iter().map(|o| o.metadata).collect::<Vec<_>>()),
    ] {
        let found = match listed {
            Ok(items) => items,
            Err(err) => absent_as_none(kube_error(err, None))?.unwrap_or_default(),
        };
        namespaces.extend(found.into_iter().filter_map(|meta| meta.namespace));
    }
    Ok(namespaces)
}

/// The first password of `admin` from `argocd-initial-admin-secret` (key `password`), `None` when the Secret or the
/// key is missing or cannot be read. The value is never logged.
pub async fn initial_admin_password(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
) -> CoreResult<Option<SecretString>> {
    Ok(initial_admin_secret(mgr, cluster, namespace)
        .await?
        .and_then(|secret| secret_key(&secret, "password")))
}

async fn initial_admin_secret(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
) -> CoreResult<Option<Secret>> {
    let api = Api::<Secret>::namespaced(mgr.client(cluster)?, namespace);
    match api.get(INITIAL_ADMIN_SECRET).await {
        Ok(secret) => Ok(Some(secret)),
        Err(err) => absent_as_none(kube_error(err, None)),
    }
}

/// Sign-in options of the installation in `namespace` (from `argocd-cm`). Without the ConfigMap (or the right to
/// read it) Argo CD's defaults apply: `admin` may sign in, no SSO.
pub async fn login_options(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
) -> CoreResult<LoginOptions> {
    let settings = settings(mgr, cluster, namespace).await?;
    Ok(login_options_of(&settings))
}

/// The credentials the installation itself provides, in the order to try them: `admin` with the password of
/// `argocd-initial-admin-secret` (unless `admin.enabled` is `"false"` in `argocd-cm`), then the `token` of every
/// Secret labelled `app.kubernetes.io/part-of=argocd` (by name). Sources that are missing or cannot be read are
/// skipped.
pub async fn standard_credentials(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
) -> CoreResult<Vec<Credentials>> {
    let found = standard_credentials_with_origin(mgr, cluster, namespace).await?;
    Ok(found
        .into_iter()
        .map(|(_, credentials)| credentials)
        .collect())
}

/// [`standard_credentials`], each with the Secret it came from as `<namespace>/<name>@<resourceVersion>`: a changed
/// Secret gives a new origin, so a caller can tell a credential Argo CD already refused from a new one.
pub async fn standard_credentials_with_origin(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
) -> CoreResult<Vec<(String, Credentials)>> {
    let origin = |secret: &Secret| {
        format!(
            "{namespace}/{}@{}",
            secret.metadata.name.as_deref().unwrap_or_default(),
            secret
                .metadata
                .resource_version
                .as_deref()
                .unwrap_or_default()
        )
    };
    let mut found = Vec::new();
    let settings = settings(mgr, cluster, namespace).await?;
    if admin_enabled(&settings)
        && let Some(secret) = initial_admin_secret(mgr, cluster, namespace).await?
        && let Some(password) = secret_key(&secret, "password")
    {
        found.push((
            origin(&secret),
            Credentials::Password {
                username: "admin".into(),
                password,
            },
        ));
    }
    let api = Api::<Secret>::namespaced(mgr.client(cluster)?, namespace);
    let mut secrets = match api
        .list(&ListParams::default().labels(PART_OF_SELECTOR))
        .await
    {
        Ok(list) => list.items,
        Err(err) => absent_as_none(kube_error(err, None))?.unwrap_or_default(),
    };
    secrets.sort_by(|a, b| a.metadata.name.cmp(&b.metadata.name));
    found.extend(secrets.iter().filter_map(|secret| {
        secret_key(secret, "token").map(|token| (origin(secret), Credentials::Token { token }))
    }));
    Ok(found)
}

/// Signs in with the first of `candidates` that Argo CD accepts. A server that cannot be reached ends the attempt
/// at once; when every candidate is refused (or there is none) the error is `unauthorized`.
pub async fn sign_in(
    client: &ArgoClient,
    candidates: Vec<(CredentialSource, Credentials)>,
) -> CoreResult<(Session, CredentialSource, Credentials)> {
    if candidates.is_empty() {
        return Err(CoreError::new(
            ErrorCode::Unauthorized,
            "sign in to Argo CD: there is no saved login and no standard secret with credentials",
        ));
    }
    for (source, credentials) in candidates {
        match client.login(&credentials).await {
            Ok(session) => return Ok((session, source, credentials)),
            Err(err) if is_refusal(&err) => {}
            Err(err) => return Err(err),
        }
    }
    Err(CoreError::new(
        ErrorCode::Unauthorized,
        "sign in to Argo CD: the saved login and the standard secrets were refused",
    ))
}

/// Argo CD refused the credentials of a sign-in (as opposed to not being reachable).
pub fn is_refusal(err: &CoreError) -> bool {
    matches!(err.code, ErrorCode::Unauthorized | ErrorCode::Forbidden)
}

/// A client of the Argo CD API behind a local port forward. It talks only to `127.0.0.1`, over TLS without checking
/// the (self-signed) certificate; a server without TLS (`server.insecure`) is talked to in plain HTTP.
#[derive(Clone)]
pub struct ArgoClient {
    port: u16,
    tls: tokio_rustls::TlsConnector,
    /// The server does not speak TLS (found on the first request).
    plain: Arc<AtomicBool>,
}

impl fmt::Debug for ArgoClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ArgoClient {{ {} }}", self.base_url())
    }
}

impl ArgoClient {
    /// A client of the API forwarded to `127.0.0.1:<local_port>`.
    pub fn new(local_port: u16) -> Self {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(LoopbackVerifier(provider)))
            .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Self {
            port: local_port,
            tls: tokio_rustls::TlsConnector::from(Arc::new(config)),
            plain: Arc::new(AtomicBool::new(false)),
        }
    }

    /// A client that speaks plain HTTP from the start (tests against a fake server).
    #[cfg(test)]
    fn plain(local_port: u16) -> Self {
        let client = Self::new(local_port);
        client.plain.store(true, Ordering::Relaxed);
        client
    }

    pub fn base_url(&self) -> String {
        let scheme = if self.plain.load(Ordering::Relaxed) {
            "http"
        } else {
            "https"
        };
        format!("{scheme}://127.0.0.1:{}", self.port)
    }

    /// Signs in with a local user (`POST /api/v1/session`).
    pub async fn login_password(
        &self,
        username: &str,
        password: &SecretString,
    ) -> CoreResult<Session> {
        let body = json!({ "username": username, "password": password.expose() });
        let answer = self
            .call(Method::POST, "/api/v1/session", None, Some(body))
            .await
            .map_err(|err| match err.code {
                ErrorCode::Unauthorized | ErrorCode::Forbidden => CoreError::new(
                    ErrorCode::Unauthorized,
                    format!("Argo CD refused the user name or password of {username:?}"),
                ),
                _ => err,
            })?;
        let token = answer
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| CoreError::other("Argo CD answered the sign-in without a token"))?;
        Ok(Session {
            token: SecretString::new(token),
            username: Some(username.to_string()),
        })
    }

    /// Signs in with an API token: checks it with `GET /api/v1/session/userinfo` (which answers `loggedIn: false`
    /// for a token it does not accept).
    pub async fn login_token(&self, token: &SecretString) -> CoreResult<Session> {
        let refused = || {
            CoreError::new(
                ErrorCode::Unauthorized,
                "Argo CD refused the API token: it is wrong, expired or revoked",
            )
        };
        if token.is_empty() {
            return Err(refused());
        }
        let session = Session {
            token: SecretString::new(token.expose().trim()),
            username: None,
        };
        let info = self
            .call(
                Method::GET,
                "/api/v1/session/userinfo",
                Some(&session),
                None,
            )
            .await
            .map_err(|err| match err.code {
                ErrorCode::Unauthorized | ErrorCode::Forbidden => refused(),
                _ => err,
            })?;
        if info.get("loggedIn").and_then(Value::as_bool) != Some(true) {
            return Err(refused());
        }
        Ok(Session {
            username: info
                .get("username")
                .and_then(Value::as_str)
                .map(str::to_string),
            ..session
        })
    }

    pub async fn login(&self, credentials: &Credentials) -> CoreResult<Session> {
        match credentials {
            Credentials::Password { username, password } => {
                self.login_password(username, password).await
            }
            Credentials::Token { token } => self.login_token(token).await,
        }
    }

    /// The resources of Application `app` (in `app_namespace`, when it is not Argo CD's own namespace) with their
    /// target and live states.
    pub async fn managed_resources(
        &self,
        session: &Session,
        app: &str,
        app_namespace: Option<&str>,
        project: Option<&str>,
    ) -> CoreResult<Vec<ManagedResource>> {
        let mut path = format!("/api/v1/applications/{}/managed-resources", encode(app));
        let query: Vec<String> = [("appNamespace", app_namespace), ("project", project)]
            .into_iter()
            .filter_map(|(key, value)| {
                value
                    .filter(|v| !v.is_empty())
                    .map(|v| format!("{key}={}", encode(v)))
            })
            .collect();
        if !query.is_empty() {
            path = format!("{path}?{}", query.join("&"));
        }
        let answer = self
            .call(Method::GET, &path, Some(session), None)
            .await
            .map_err(|err| match err.code {
                ErrorCode::Unauthorized => CoreError::new(
                    ErrorCode::Unauthorized,
                    "the Argo CD session has expired or was revoked",
                ),
                // Argo CD answers "permission denied" for an application that does not exist, too.
                ErrorCode::Forbidden | ErrorCode::NotFound => CoreError::new(
                    ErrorCode::Forbidden,
                    format!("Argo CD does not show the application {app} to this account (it may not exist): {}", err.message),
                ),
                _ => err,
            })?;
        Ok(parse_managed_resources(&answer))
    }

    /// One JSON request; a non-2xx answer becomes an error with Argo CD's own message.
    async fn call(
        &self,
        method: Method,
        path: &str,
        session: Option<&Session>,
        body: Option<Value>,
    ) -> CoreResult<Value> {
        let send = self.send(method, path, session, body);
        let (status, bytes) = match tokio::time::timeout(REQUEST_TIMEOUT, send).await {
            Ok(result) => result?,
            Err(_) => {
                return Err(CoreError::new(
                    ErrorCode::Timeout,
                    format!("Argo CD did not answer in {} s", REQUEST_TIMEOUT.as_secs()),
                ));
            }
        };
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(value);
        }
        Err(api_error(status, &value))
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        session: Option<&Session>,
        body: Option<Value>,
    ) -> CoreResult<(StatusCode, Bytes)> {
        let request = || self.request(method.clone(), path, session, body.as_ref());
        let tcp = self.connect().await?;
        if self.plain.load(Ordering::Relaxed) {
            return exchange(tcp, request()?).await;
        }
        let name = ServerName::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST).into());
        match self.tls.connect(name, tcp).await {
            Ok(tls) => exchange(tls, request()?).await,
            Err(tls_err) => {
                // A server without TLS answers the handshake with plain HTTP; talk HTTP to it from now on.
                let answer = exchange(self.connect().await?, request()?).await;
                match answer {
                    Ok(answer) if !answer.0.is_redirection() => {
                        self.plain.store(true, Ordering::Relaxed);
                        Ok(answer)
                    }
                    _ => Err(CoreError::new(
                        ErrorCode::Unreachable,
                        format!(
                            "Argo CD cannot be reached through the port forward: TLS: {tls_err}"
                        ),
                    )),
                }
            }
        }
    }

    async fn connect(&self) -> CoreResult<TcpStream> {
        TcpStream::connect((Ipv4Addr::LOCALHOST, self.port))
            .await
            .map_err(|err| unreachable(&err))
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        session: Option<&Session>,
        body: Option<&Value>,
    ) -> CoreResult<Request<Full<Bytes>>> {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(HOST, format!("127.0.0.1:{}", self.port))
            .header(CONTENT_TYPE, "application/json");
        if let Some(session) = session {
            let mut value = HeaderValue::from_str(&format!("Bearer {}", session.token.expose()))
                .map_err(|_| {
                    CoreError::new(
                        ErrorCode::Unauthorized,
                        "the Argo CD token has characters a header cannot carry",
                    )
                })?;
            value.set_sensitive(true);
            builder = builder.header(AUTHORIZATION, value);
        }
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        builder.body(Full::new(Bytes::from(body))).map_err(|err| {
            CoreError::new(
                ErrorCode::Invalid,
                format!("bad Argo CD request {path}: {err}"),
            )
        })
    }
}

/// Sends one request over a fresh connection and reads the whole answer.
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
        let body = Limited::new(response.into_body(), MAX_BODY)
            .collect()
            .await
            .map_err(|err| {
                CoreError::new(
                    ErrorCode::Unreachable,
                    format!("reading the Argo CD answer: {err}"),
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
        format!("Argo CD cannot be reached through the port forward: {err}"),
    )
}

/// An error answer of the API (`{"error":…,"code":…,"message":…}`) as a [`CoreError`].
fn api_error(status: StatusCode, body: &Value) -> CoreError {
    let code = match status.as_u16() {
        401 => ErrorCode::Unauthorized,
        403 => ErrorCode::Forbidden,
        404 => ErrorCode::NotFound,
        400 | 422 => ErrorCode::Invalid,
        409 => ErrorCode::Conflict,
        502..=504 => ErrorCode::Unreachable,
        _ => ErrorCode::Other,
    };
    let text = ["message", "error"]
        .iter()
        .find_map(|key| {
            body.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .map(str::to_string)
        .unwrap_or_else(|| status.to_string());
    CoreError::new(code, format!("Argo CD: {text}"))
}

/// Percent-encodes a path segment or query value (names are DNS labels; anything else is escaped).
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// The `items` of a managed-resources answer; the states come as JSON text (`"null"` when missing).
fn parse_managed_resources(answer: &Value) -> Vec<ManagedResource> {
    let items = answer.get("items").and_then(Value::as_array);
    items
        .into_iter()
        .flatten()
        .map(|item| {
            let text = |key: &str| {
                item.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            let group = text("group");
            let kind = text("kind");
            let state = |key: &str| {
                let raw = item.get(key).and_then(Value::as_str)?;
                let mut value: Value = serde_json::from_str(raw).ok()?;
                if value.is_null() {
                    return None;
                }
                clean_state(&mut value, &group, &kind);
                Some(value)
            };
            ManagedResource {
                target_state: state("targetState"),
                live_state: state("liveState"),
                normalized_live_state: state("normalizedLiveState"),
                predicted_live_state: state("predictedLiveState"),
                namespace: text("namespace"),
                name: text("name"),
                group,
                kind,
            }
        })
        .collect()
}

/// Removes `metadata.managedFields`; a core/v1 Secret also loses its values, as in `resources::get::to_json`.
fn clean_state(value: &mut Value, group: &str, kind: &str) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    if let Some(meta) = map.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
    }
    if group.is_empty() && kind == "Secret" {
        hide_secret_values(map);
    }
}

fn hide_secret_values(map: &mut Map<String, Value>) {
    for field in ["data", "stringData"] {
        if let Some(values) = map.get_mut(field).and_then(Value::as_object_mut) {
            for v in values.values_mut() {
                *v = Value::String(String::new());
            }
        }
    }
    let meta = map
        .entry("metadata")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(meta) = meta.as_object_mut() else {
        return;
    };
    let annotations = meta
        .entry("annotations")
        .or_insert_with(|| Value::Object(Map::new()));
    if !annotations.is_object() {
        *annotations = Value::Object(Map::new());
    }
    if let Some(annotations) = annotations.as_object_mut() {
        annotations.remove(LAST_APPLIED_ANNOTATION);
        annotations.insert(
            VALUES_HIDDEN_ANNOTATION.into(),
            Value::String("true".into()),
        );
    }
}

/// `argocd-cm` as key → value; empty when it is missing or cannot be read.
async fn settings(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
) -> CoreResult<std::collections::BTreeMap<String, String>> {
    let api = Api::<ConfigMap>::namespaced(mgr.client(cluster)?, namespace);
    match api.get(SETTINGS_CONFIG_MAP).await {
        Ok(cm) => Ok(cm.data.unwrap_or_default()),
        Err(err) => Ok(absent_as_none(kube_error(err, None))?.unwrap_or_default()),
    }
}

fn admin_enabled(settings: &std::collections::BTreeMap<String, String>) -> bool {
    settings.get("admin.enabled").map(|v| v.trim()) != Some("false")
}

fn login_options_of(settings: &std::collections::BTreeMap<String, String>) -> LoginOptions {
    let account_with_login = settings.iter().any(|(key, value)| {
        let Some(name) = key.strip_prefix("accounts.") else {
            return false;
        };
        !name.contains('.')
            && value.split(',').any(|cap| cap.trim() == "login")
            && settings
                .get(&format!("accounts.{name}.enabled"))
                .map(|v| v.trim())
                != Some("false")
    });
    let configured = |key: &str| settings.get(key).is_some_and(|v| !v.trim().is_empty());
    LoginOptions {
        local_users: admin_enabled(settings) || account_with_login,
        sso: configured("dex.config") || configured("oidc.config"),
    }
}

/// The value of `key` of a Secret as text (`data` is base64 on the wire, decoded by k8s-openapi; `stringData` as
/// is), `None` when missing or empty.
fn secret_key(secret: &Secret, key: &str) -> Option<SecretString> {
    let from_data = secret
        .data
        .as_ref()
        .and_then(|data| data.get(key))
        .and_then(|bytes| String::from_utf8(bytes.0.clone()).ok());
    let from_string_data = || {
        secret
            .string_data
            .as_ref()
            .and_then(|data| data.get(key))
            .cloned()
    };
    from_data
        .or_else(from_string_data)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(SecretString::new)
}

/// Missing objects and objects the user may not read are skipped by the sign-in, not errors.
fn is_absent(err: &CoreError) -> bool {
    matches!(err.code, ErrorCode::NotFound | ErrorCode::Forbidden)
}

fn absent_as_none<T>(err: CoreError) -> CoreResult<Option<T>> {
    if is_absent(&err) { Ok(None) } else { Err(err) }
}

/// Accepts the certificate of a server on the loopback address only (the local end of a port forward); the
/// signatures of the handshake are still checked.
#[derive(Debug)]
struct LoopbackVerifier(Arc<CryptoProvider>);

impl ServerCertVerifier for LoopbackVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match server_name {
            ServerName::IpAddress(ip) if IpAddr::from(*ip).is_loopback() => {
                Ok(ServerCertVerified::assertion())
            }
            _ => Err(rustls::Error::General(
                "the certificate is only skipped for 127.0.0.1".into(),
            )),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    /// A value no answer of the core may carry.
    const PLAIN_VALUE: &str = "s3cr3t-value";

    fn port_of(api: &FakeApi) -> u16 {
        api.url().rsplit(':').next().unwrap().parse().unwrap()
    }

    fn session(token: &str) -> Session {
        Session {
            token: SecretString::new(token),
            username: Some("admin".into()),
        }
    }

    fn managed_answer() -> String {
        let secret = json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": {
                "name": "db", "namespace": "shop",
                "annotations": { LAST_APPLIED_ANNOTATION: format!("{{\"data\":{{\"password\":\"{PLAIN_VALUE}\"}}}}") },
                "managedFields": [{ "manager": "kubectl" }]
            },
            "data": { "password": PLAIN_VALUE },
            "stringData": { "user": PLAIN_VALUE }
        });
        let deploy = |replicas: u32| json!({ "apiVersion": "apps/v1", "kind": "Deployment", "metadata": { "name": "web", "namespace": "shop", "managedFields": [{}] }, "spec": { "replicas": replicas } });
        json!({ "items": [
            { "group": "apps", "kind": "Deployment", "namespace": "shop", "name": "web",
              "targetState": deploy(1).to_string(), "liveState": deploy(3).to_string(),
              "normalizedLiveState": deploy(3).to_string(), "predictedLiveState": deploy(1).to_string() },
            { "kind": "Secret", "namespace": "shop", "name": "db",
              "targetState": "null", "liveState": secret.to_string(),
              "normalizedLiveState": secret.to_string(), "predictedLiveState": secret.to_string() }
        ]})
        .to_string()
    }

    #[tokio::test]
    async fn managed_resources_hide_secret_values_and_keep_the_difference() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api/v1/applications/guestbook/managed-resources" => {
                Reply::json(200, managed_answer())
            }
            _ => Reply::not_found(),
        })
        .await;
        let client = ArgoClient::plain(port_of(&api));

        let items = client
            .managed_resources(&session("tok-1"), "guestbook", Some("argocd"), None)
            .await
            .unwrap();

        assert_eq!(items.len(), 2);
        let web = &items[0];
        assert_eq!(
            (web.group.as_str(), web.kind.as_str(), web.name.as_str()),
            ("apps", "Deployment", "web")
        );
        assert_eq!(web.target_state.as_ref().unwrap()["spec"]["replicas"], 1);
        assert_eq!(web.live_state.as_ref().unwrap()["spec"]["replicas"], 3);
        assert!(
            web.live_state.as_ref().unwrap()["metadata"]
                .get("managedFields")
                .is_none()
        );
        let db = &items[1];
        assert_eq!(db.group, "");
        assert_eq!(db.target_state, None, "\"null\" is a missing object");
        for state in [
            &db.live_state,
            &db.normalized_live_state,
            &db.predicted_live_state,
        ] {
            let state = state.as_ref().unwrap();
            assert_eq!(state["data"]["password"], "");
            assert_eq!(state["stringData"]["user"], "");
            assert_eq!(
                state["metadata"]["annotations"][VALUES_HIDDEN_ANNOTATION],
                "true"
            );
        }
        let sent = serde_json::to_string(&items).unwrap();
        assert!(
            !sent.contains(PLAIN_VALUE),
            "a Secret value left the core: {sent}"
        );
        let request = &api.requests()[0];
        assert_eq!(request.query, "appNamespace=argocd");
        assert_eq!(request.header("authorization"), "Bearer tok-1");
    }

    #[tokio::test]
    async fn a_wrong_password_is_unauthorized_and_the_error_does_not_carry_it() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api/v1/session" => Reply::json(
                401,
                r#"{"error":"Invalid username or password","code":16,"message":"Invalid username or password"}"#,
            ),
            _ => Reply::not_found(),
        })
        .await;
        let client = ArgoClient::plain(port_of(&api));

        let err = client
            .login_password("admin", &SecretString::new(PLAIN_VALUE))
            .await
            .unwrap_err();

        assert_eq!(err.code, ErrorCode::Unauthorized);
        assert!(!err.message.contains(PLAIN_VALUE), "{err}");
        let body = String::from_utf8(api.requests()[0].body.clone()).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({ "username": "admin", "password": PLAIN_VALUE })
        );
    }

    #[tokio::test]
    async fn a_password_sign_in_returns_the_session_token() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api/v1/session" => Reply::json(200, r#"{"token":"jwt-1"}"#),
            "/api/v1/applications/a/managed-resources"
                if req.header("authorization") == "Bearer jwt-1" =>
            {
                Reply::json(200, r#"{"items":[]}"#)
            }
            _ => Reply::json(401, r#"{"error":"no session information"}"#),
        })
        .await;
        let client = ArgoClient::plain(port_of(&api));

        let session = client
            .login_password("admin", &SecretString::new("pw"))
            .await
            .unwrap();

        assert_eq!(session.username.as_deref(), Some("admin"));
        assert!(
            client
                .managed_resources(&session, "a", None, None)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(!format!("{session:?}").contains("jwt-1"));
    }

    #[tokio::test]
    async fn a_token_argo_does_not_know_is_unauthorized_and_a_good_one_names_the_user() {
        let api = FakeApi::start(|req: &Request| {
            match (req.path.as_str(), req.header("authorization")) {
                ("/api/v1/session/userinfo", "Bearer good") => {
                    Reply::json(200, r#"{"loggedIn":true,"username":"ci","iss":"argocd"}"#)
                }
                // What Argo CD answers for a token it does not accept.
                ("/api/v1/session/userinfo", _) => Reply::json(200, "{}"),
                _ => Reply::not_found(),
            }
        })
        .await;
        let client = ArgoClient::plain(port_of(&api));

        let err = client
            .login_token(&SecretString::new("bad"))
            .await
            .unwrap_err();
        let session = client
            .login_token(&SecretString::new("good"))
            .await
            .unwrap();

        assert_eq!(err.code, ErrorCode::Unauthorized);
        assert_eq!(session.username.as_deref(), Some("ci"));
    }

    #[tokio::test]
    async fn an_expired_session_is_unauthorized_and_an_unknown_app_forbidden() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api/v1/applications/old/managed-resources" => {
                Reply::json(401, r#"{"error":"token is expired","code":16}"#)
            }
            _ => Reply::json(403, r#"{"error":"permission denied","code":7}"#),
        })
        .await;
        let client = ArgoClient::plain(port_of(&api));

        let expired = client
            .managed_resources(&session("t"), "old", None, None)
            .await
            .unwrap_err();
        let unknown = client
            .managed_resources(&session("t"), "nope", None, None)
            .await
            .unwrap_err();

        assert_eq!(expired.code, ErrorCode::Unauthorized);
        assert!(expired.message.contains("expired"), "{expired}");
        assert_eq!(unknown.code, ErrorCode::Forbidden);
    }

    #[tokio::test]
    async fn a_closed_port_is_unreachable() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let err = ArgoClient::new(port)
            .login_password("admin", &SecretString::new("pw"))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Unreachable);
    }

    #[tokio::test]
    async fn sign_in_takes_the_first_accepted_candidate_and_without_any_is_unauthorized() {
        let api = FakeApi::start(|req: &Request| {
            let body = String::from_utf8(req.body.clone()).unwrap();
            if req.path == "/api/v1/session" && body.contains("\"right\"") {
                Reply::json(200, r#"{"token":"jwt"}"#)
            } else {
                Reply::json(401, r#"{"error":"Invalid username or password"}"#)
            }
        })
        .await;
        let client = ArgoClient::plain(port_of(&api));
        let password = |p: &str| Credentials::Password {
            username: "admin".into(),
            password: SecretString::new(p),
        };

        let none = sign_in(&client, Vec::new()).await.unwrap_err();
        let refused = sign_in(&client, vec![(CredentialSource::Saved, password("wrong"))])
            .await
            .unwrap_err();
        let (_, source, _) = sign_in(
            &client,
            vec![
                (CredentialSource::Saved, password("wrong")),
                (CredentialSource::Secret, password("right")),
            ],
        )
        .await
        .unwrap();

        assert_eq!(none.code, ErrorCode::Unauthorized);
        assert_eq!(refused.code, ErrorCode::Unauthorized);
        assert_eq!(source, CredentialSource::Secret);
    }

    /// A kube API with `argocd-cm` (`settings`), `argocd-initial-admin-secret` (when `admin_secret`) and a token
    /// Secret labelled as part of Argo CD.
    async fn kube_with(settings: Value, admin_secret: bool) -> FakeApi {
        FakeApi::start(move |req: &Request| {
            let b64 = |v: &str| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, v);
            match req.path.as_str() {
                "/api" => Reply::json(200, API_VERSIONS),
                "/api/v1/namespaces/argocd/configmaps/argocd-cm" => Reply::json(
                    200,
                    json!({ "apiVersion": "v1", "kind": "ConfigMap", "metadata": { "name": "argocd-cm" }, "data": settings }).to_string(),
                ),
                "/api/v1/namespaces/argocd/secrets/argocd-initial-admin-secret" if admin_secret => Reply::json(
                    200,
                    json!({ "apiVersion": "v1", "kind": "Secret", "metadata": { "name": INITIAL_ADMIN_SECRET, "namespace": "argocd", "resourceVersion": "7" }, "data": { "password": b64("initial-pw") } }).to_string(),
                ),
                "/api/v1/namespaces/argocd/secrets" if req.query.contains("part-of") => Reply::json(
                    200,
                    json!({ "apiVersion": "v1", "kind": "SecretList", "metadata": {}, "items": [
                        { "metadata": { "name": "argocd-secret" }, "data": { "admin.password": b64("$2a$10$hash") } },
                        { "metadata": { "name": "ci-token", "namespace": "argocd", "resourceVersion": "9" }, "data": { "token": b64("api-token\n") } }
                    ]}).to_string(),
                ),
                _ => Reply::not_found(),
            }
        })
        .await
    }

    fn summary(found: &[Credentials]) -> Vec<String> {
        found
            .iter()
            .map(|c| match c {
                Credentials::Password { username, password } => {
                    format!("{username}:{}", password.expose())
                }
                Credentials::Token { token } => format!("token:{}", token.expose()),
            })
            .collect()
    }

    #[tokio::test]
    async fn standard_credentials_are_the_initial_admin_password_then_token_secrets() {
        let api = kube_with(json!({}), true).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let found = standard_credentials(&mgr, &id, "argocd").await.unwrap();

        assert_eq!(summary(&found), ["admin:initial-pw", "token:api-token"]);
    }

    #[tokio::test]
    async fn standard_credentials_name_the_secret_and_the_version_they_came_from() {
        let api = kube_with(json!({}), true).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let found = standard_credentials_with_origin(&mgr, &id, "argocd")
            .await
            .unwrap();

        let origins: Vec<&str> = found.iter().map(|(origin, _)| origin.as_str()).collect();
        assert_eq!(
            origins,
            ["argocd/argocd-initial-admin-secret@7", "argocd/ci-token@9"]
        );
        let credentials: Vec<Credentials> = found.into_iter().map(|(_, c)| c).collect();
        assert_eq!(
            summary(&credentials),
            ["admin:initial-pw", "token:api-token"]
        );
    }

    #[tokio::test]
    async fn the_initial_admin_password_is_skipped_when_admin_is_disabled() {
        let api = kube_with(json!({ "admin.enabled": "false" }), true).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let found = standard_credentials(&mgr, &id, "argocd").await.unwrap();

        assert_eq!(summary(&found), ["token:api-token"]);
    }

    #[tokio::test]
    async fn without_the_secrets_there_is_nothing_to_try() {
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/namespaces/argocd/secrets" => Reply::json(
                200,
                r#"{"apiVersion":"v1","kind":"SecretList","metadata":{},"items":[]}"#,
            ),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        assert!(
            standard_credentials(&mgr, &id, "argocd")
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            initial_admin_password(&mgr, &id, "argocd").await.unwrap(),
            None
        );
    }

    /// A kube API where Argo CD is installed in `gitops` (when `installed`: its `argocd-cm` and `argocd-server`) and
    /// a stranger's Service in `aaa` carries the label of `argocd-server`.
    async fn kube_with_a_stranger(installed: bool) -> FakeApi {
        FakeApi::start(move |req: &Request| {
            let list = |kind: &str, items: Value| {
                Reply::json(
                    200,
                    json!({ "apiVersion": "v1", "kind": kind, "metadata": {}, "items": items })
                        .to_string(),
                )
            };
            let service = |ns: &str, name: &str| {
                json!({
                    "metadata": { "name": name, "namespace": ns, "labels": { "app.kubernetes.io/name": "argocd-server" } },
                    "spec": { "ports": [{ "name": "https", "port": 443 }] }
                })
            };
            let meta = |ns: &str, name: &str| {
                json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": { "name": name, "namespace": ns } })
            };
            let stranger = service("aaa", "evil");
            let server = service("gitops", "argocd-server");
            match req.path.as_str() {
                "/api" => Reply::json(200, API_VERSIONS),
                "/api/v1/services" => list(
                    "ServiceList",
                    if installed { json!([stranger, server]) } else { json!([stranger]) },
                ),
                "/api/v1/configmaps" if installed => list(
                    "PartialObjectMetadataList",
                    json!([meta("gitops", SETTINGS_CONFIG_MAP)]),
                ),
                "/api/v1/configmaps" | "/api/v1/secrets" => list("PartialObjectMetadataList", json!([])),
                "/api/v1/namespaces/aaa/services" => list("ServiceList", json!([stranger])),
                "/api/v1/namespaces/gitops/services" if installed => list("ServiceList", json!([server])),
                "/api/v1/namespaces/gitops/services/argocd-server" if installed => {
                    Reply::json(200, server.to_string())
                }
                _ => Reply::not_found(),
            }
        })
        .await
    }

    #[tokio::test]
    async fn the_server_is_found_only_where_argo_cd_is_installed() {
        let api = kube_with_a_stranger(true).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let server = find_server(&mgr, &id).await.unwrap();

        assert_eq!(
            server,
            ArgoServer {
                namespace: "gitops".into(),
                name: "argocd-server".into(),
                port: 443
            }
        );
    }

    #[tokio::test]
    async fn a_labelled_service_where_argo_cd_is_not_installed_is_not_the_server() {
        let api = kube_with_a_stranger(false).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let err = find_server(&mgr, &id).await.unwrap_err();

        assert_eq!(err.code, ErrorCode::NotFound, "{err}");
    }

    /// A kube API where Argo CD is installed in `gitops` and the tenant of `aaa` (who may write only there) planted
    /// Argo CD's look-alikes: `argocd-cm`, a Service with the label of `argocd-server` and a token Secret. With
    /// `marked`, the ClusterRoleBinding of `argocd-application-controller` names the controller's ServiceAccount in
    /// `gitops`; a binding the tenant was given (`aaa-tenant`) names a ServiceAccount `argocd-server` in `aaa`.
    async fn kube_with_a_tenant(marked: bool) -> FakeApi {
        FakeApi::start(move |req: &Request| {
            let b64 = |v: &str| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, v);
            let list = |kind: &str, items: Value| {
                Reply::json(
                    200,
                    json!({ "apiVersion": "v1", "kind": kind, "metadata": {}, "items": items })
                        .to_string(),
                )
            };
            let service = |ns: &str| {
                json!({
                    "metadata": { "name": "argocd-server", "namespace": ns, "labels": { "app.kubernetes.io/name": "argocd-server" } },
                    "spec": { "ports": [{ "name": "https", "port": 443 }] }
                })
            };
            let meta = |ns: &str| {
                json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": { "name": SETTINGS_CONFIG_MAP, "namespace": ns } })
            };
            let token_secret = |ns: &str, name: &str, token: &str| {
                json!({ "metadata": { "name": name, "namespace": ns, "resourceVersion": "1" }, "data": { "token": b64(token) } })
            };
            let binding = |name: &str, sa: &str, ns: &str| {
                json!({
                    "metadata": { "name": name },
                    "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": name },
                    "subjects": [{ "kind": "ServiceAccount", "name": sa, "namespace": ns }]
                })
            };
            let bindings = if marked {
                json!([
                    binding("aaa-tenant", "argocd-server", "aaa"),
                    binding("argocd-application-controller", "argocd-application-controller", "gitops")
                ])
            } else {
                json!([binding("aaa-tenant", "argocd-server", "aaa")])
            };
            match req.path.as_str() {
                "/api" => Reply::json(200, API_VERSIONS),
                "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings" => list("ClusterRoleBindingList", bindings),
                "/api/v1/configmaps" => list("PartialObjectMetadataList", json!([meta("aaa"), meta("gitops")])),
                "/api/v1/secrets" => list("PartialObjectMetadataList", json!([])),
                "/api/v1/namespaces/aaa/services" => list("ServiceList", json!([service("aaa")])),
                "/api/v1/namespaces/gitops/services" => list("ServiceList", json!([service("gitops")])),
                "/api/v1/namespaces/aaa/secrets" => {
                    list("SecretList", json!([token_secret("aaa", "planted", "tenant-token")]))
                }
                "/api/v1/namespaces/gitops/secrets" => {
                    list("SecretList", json!([token_secret("gitops", "ci-token", "real-token")]))
                }
                _ => Reply::not_found(),
            }
        })
        .await
    }

    #[tokio::test]
    async fn a_tenants_look_alike_does_not_win_over_the_installation_its_cluster_binding_names() {
        let api = kube_with_a_tenant(true).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let server = find_server(&mgr, &id).await.unwrap();
        let found = standard_credentials_with_origin(&mgr, &id, &server.namespace)
            .await
            .unwrap();

        assert_eq!(
            server,
            ArgoServer {
                namespace: "gitops".into(),
                name: "argocd-server".into(),
                port: 443
            }
        );
        let origins: Vec<&str> = found.iter().map(|(origin, _)| origin.as_str()).collect();
        assert_eq!(origins, ["gitops/ci-token@1"]);
    }

    #[tokio::test]
    async fn without_a_cluster_binding_two_look_alike_installations_are_an_error_naming_both() {
        let api = kube_with_a_tenant(false).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;

        let err = find_server(&mgr, &id).await.unwrap_err();

        assert_eq!(err.code, ErrorCode::NotFound, "{err}");
        assert!(err.message.starts_with(AMBIGUOUS_INSTALLATION), "{err}");
        assert!(err.message.contains("aaa, gitops"), "{err}");
    }

    #[test]
    fn login_options_follow_argocd_cm() {
        let cm = |pairs: &[(&str, &str)]| -> BTreeMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let default = login_options_of(&cm(&[]));
        let sso_only = login_options_of(&cm(&[
            ("admin.enabled", "false"),
            ("oidc.config", "name: Okta"),
        ]));
        let local_account = login_options_of(&cm(&[
            ("admin.enabled", "false"),
            ("accounts.alice", "apiKey, login"),
            ("dex.config", "connectors: []"),
        ]));
        let disabled_account = login_options_of(&cm(&[
            ("admin.enabled", "false"),
            ("accounts.ci", "apiKey"),
            ("accounts.bob", "login"),
            ("accounts.bob.enabled", "false"),
        ]));

        assert_eq!(
            default,
            LoginOptions {
                local_users: true,
                sso: false
            }
        );
        assert_eq!(
            sso_only,
            LoginOptions {
                local_users: false,
                sso: true
            }
        );
        assert_eq!(
            local_account,
            LoginOptions {
                local_users: true,
                sso: true
            }
        );
        assert_eq!(
            disabled_account,
            LoginOptions {
                local_users: false,
                sso: false
            }
        );
    }

    #[test]
    fn credentials_are_saved_as_documented_json_and_never_printed() {
        let password = Credentials::Password {
            username: "admin".into(),
            password: SecretString::new(PLAIN_VALUE),
        };
        let token = Credentials::Token {
            token: SecretString::new(PLAIN_VALUE),
        };

        assert_eq!(
            serde_json::to_value(&password).unwrap(),
            json!({ "username": "admin", "password": PLAIN_VALUE })
        );
        assert_eq!(
            serde_json::to_value(&token).unwrap(),
            json!({ "token": PLAIN_VALUE })
        );
        assert_eq!(
            serde_json::from_value::<Credentials>(json!({ "token": "t" })).unwrap(),
            Credentials::Token {
                token: SecretString::new("t")
            }
        );
        for printed in [format!("{password:?}"), format!("{token:?}")] {
            assert!(!printed.contains(PLAIN_VALUE), "{printed}");
        }
    }

    #[test]
    fn the_certificate_is_skipped_only_for_the_loopback_address() {
        let verifier = LoopbackVerifier(Arc::new(rustls::crypto::ring::default_provider()));
        let cert = CertificateDer::from(vec![0u8; 4]);
        let check = |name: ServerName<'static>| {
            verifier
                .verify_server_cert(&cert, &[], &name, &[], UnixTime::now())
                .is_ok()
        };

        assert!(check(ServerName::IpAddress(
            IpAddr::V4(Ipv4Addr::LOCALHOST).into()
        )));
        assert!(!check(ServerName::try_from("argocd.example.com").unwrap()));
        assert!(!check(ServerName::IpAddress(
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)).into()
        )));
    }
}
