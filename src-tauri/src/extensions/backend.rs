//! Extension backends on the Tauri side (ADR-0131): the component compiled at install (a package whose backend does
//! not fit is refused before consent) and kept compiled in `<data>/extensions-compiled/`, `backend.call` from the
//! extension's own frames, and the [`Host`] a backend reaches Sextant through:
//! - `host.call` is the extension API itself ([`ExtensionApi::call`]): the same grant, confirmations, refusals and
//!   activity log as the frames' calls; `resources.watch` and `backend.call` are not offered;
//! - `credentials.get` reads one of the credentials the manifest declares and the user agreed to, from the OS keyring;
//! - `wasi:http` requests go out only to a host the manifest declares and the user agreed to, over HTTPS on port 443,
//!   never to a forbidden address (checked on every resolved address), with no proxy and no cookies, redirects only to
//!   declared hosts, a 30 s limit and an 8 MiB answer; each request is journaled (method, host, path, status);
//! - `host.log`, stdout and stderr go to a small per-extension log in memory ([`ExtensionHost::backend_log`]).
//!
//! At most [`MAX_CONCURRENT_CALLS`] calls run per extension; a backend that traps, runs out of time or out of memory
//! [`MAX_FAILURES`] times in a row is paused until the extension is reloaded.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sextant_core::extensions::{
    ExtensionManifest, ExtensionSource, InstalledExtension, MANIFEST_FILE, Package,
    resolve_package_file,
};
use sextant_core::{CoreError, CoreResult, ErrorCode};
use sextant_ext_runtime::{
    Backend, CallError, Host, HostFuture, HttpError, HttpRequest, HttpResponse, InvokeError, Level,
    Limits, MAX_COMPONENT_BYTES, Runtime,
};
use ts_rs::TS;

use super::api::ExtensionApi;
use super::{ExtensionHost, lock};
use crate::access_guard::audit::{AuditDecision, AuditEntry, clip};
use crate::access_guard::confirm::ConfirmSource;

/// Calls of one extension's backend running at once; the next ones are refused.
pub const MAX_CONCURRENT_CALLS: usize = 4;
/// Failures (trap, time, memory) in a row after which a backend is paused until the extension is reloaded.
pub const MAX_FAILURES: u32 = 3;
/// Lines kept of a backend's log, and the length of one.
pub const MAX_LOG_LINES: usize = 200;
pub const MAX_LOG_LINE_BYTES: usize = 2000;
/// One HTTP request of a backend, redirects included.
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// An HTTP answer larger than this is refused.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
/// The keyring service credentials are kept under (with user `extension:<id>:<credential>`).
const KEYRING_SERVICE: &str = "sextant";

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

// ---------------------------------------------------------------------------------------------------------------------
// Credentials

/// Where backends' credentials live: the OS keyring, or memory in tests.
pub trait CredentialStore: Send + Sync {
    fn get(&self, extension: &str, credential: &str) -> CoreResult<Option<String>>;
    fn set(&self, extension: &str, credential: &str, value: &str) -> CoreResult<()>;
    fn remove(&self, extension: &str, credential: &str) -> CoreResult<()>;
}

/// The OS keyring (service `sextant`, user `extension:<id>:<credential>`). Errors never carry the value.
pub struct KeyringCredentials;

fn keyring_entry(extension: &str, credential: &str) -> CoreResult<keyring::Entry> {
    keyring::Entry::new(
        KEYRING_SERVICE,
        &format!("extension:{extension}:{credential}"),
    )
    .map_err(|e| CoreError::other(format!("the keyring cannot be used: {e}")))
}

impl CredentialStore for KeyringCredentials {
    fn get(&self, extension: &str, credential: &str) -> CoreResult<Option<String>> {
        match keyring_entry(extension, credential)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CoreError::other(format!("the keyring cannot be read: {e}"))),
        }
    }

    fn set(&self, extension: &str, credential: &str, value: &str) -> CoreResult<()> {
        keyring_entry(extension, credential)?
            .set_password(value)
            .map_err(|e| CoreError::other(format!("the keyring cannot be written: {e}")))
    }

    fn remove(&self, extension: &str, credential: &str) -> CoreResult<()> {
        match keyring_entry(extension, credential)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CoreError::other(format!(
                "the keyring cannot be written: {e}"
            ))),
        }
    }
}

/// Credentials in memory (tests).
#[derive(Default)]
pub struct MemoryCredentials(Mutex<HashMap<(String, String), String>>);

impl CredentialStore for MemoryCredentials {
    fn get(&self, extension: &str, credential: &str) -> CoreResult<Option<String>> {
        Ok(lock(&self.0)
            .get(&(extension.to_owned(), credential.to_owned()))
            .cloned())
    }

    fn set(&self, extension: &str, credential: &str, value: &str) -> CoreResult<()> {
        lock(&self.0).insert(
            (extension.to_owned(), credential.to_owned()),
            value.to_owned(),
        );
        Ok(())
    }

    fn remove(&self, extension: &str, credential: &str) -> CoreResult<()> {
        lock(&self.0).remove(&(extension.to_owned(), credential.to_owned()));
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The log

/// The level of a backend log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BackendLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// One line of a backend's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BackendLogLine {
    #[ts(type = "number")]
    pub at: u64,
    pub level: BackendLogLevel,
    pub message: String,
}

fn clip_line(text: &str) -> String {
    let text = text.trim_end_matches('\n');
    if text.len() <= MAX_LOG_LINE_BYTES {
        return text.to_owned();
    }
    let mut end = MAX_LOG_LINE_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

// ---------------------------------------------------------------------------------------------------------------------
// The host's state

/// The runtime, compiled backends, running calls, failures and logs. Part of [`ExtensionHost`].
pub(super) struct Backends {
    runtime: OnceLock<Result<Arc<Runtime>, String>>,
    /// Id → (source and version it was compiled for, the backend).
    compiled: Mutex<HashMap<String, (String, Backend)>>,
    running: Mutex<HashMap<String, usize>>,
    failures: Mutex<HashMap<String, u32>>,
    logs: Mutex<HashMap<String, VecDeque<BackendLogLine>>>,
    /// `<data>/extensions-compiled/<id>/<version>.cwasm` (packages only; a development folder compiles in memory).
    compiled_dir: PathBuf,
    pub(super) credentials: Arc<dyn CredentialStore>,
}

impl Backends {
    pub(super) fn new(data_dir: &Path, credentials: Arc<dyn CredentialStore>) -> Self {
        Self {
            runtime: OnceLock::new(),
            compiled: Mutex::new(HashMap::new()),
            running: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            logs: Mutex::new(HashMap::new()),
            compiled_dir: data_dir.join("extensions-compiled"),
            credentials,
        }
    }

    fn runtime(&self) -> CoreResult<Arc<Runtime>> {
        self.runtime
            .get_or_init(|| Runtime::new().map(Arc::new))
            .clone()
            .map_err(|e| CoreError::other(format!("extension backends cannot run here: {e}")))
    }

    fn log(&self, id: &str, level: BackendLogLevel, message: &str) {
        let mut logs = lock(&self.logs);
        let lines = logs.entry(id.to_owned()).or_default();
        for line in message.lines().filter(|l| !l.trim().is_empty()) {
            if lines.len() >= MAX_LOG_LINES {
                lines.pop_front();
            }
            lines.push_back(BackendLogLine {
                at: now_ms(),
                level,
                message: clip_line(line),
            });
        }
    }
}

/// Counts a running call of one extension; dropped when the call ends.
struct Running<'a> {
    backends: &'a Backends,
    id: String,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let mut running = lock(&self.backends.running);
        if let Some(count) = running.get_mut(&self.id) {
            *count = count.saturating_sub(1);
        }
    }
}

fn compile_error(err: impl std::fmt::Display) -> CoreError {
    invalid(format!("{MANIFEST_FILE}: backend.module: {err}"))
}

impl ExtensionHost {
    fn backends(&self) -> &Backends {
        &self.inner.backends
    }

    /// At install, before consent: a package's backend must compile and fit (ADR-0131).
    pub(super) fn check_backend(&self, package: &Package) -> CoreResult<()> {
        let Some(backend) = &package.manifest.backend else {
            return Ok(());
        };
        let bytes = package.read(&backend.module, MAX_COMPONENT_BYTES as u64)?;
        self.backends()
            .runtime()?
            .compile(&bytes)
            .map(|_| ())
            .map_err(compile_error)
    }

    /// Drops what was compiled for `id` and its failure count (a reload, a change of its folder, a removal).
    pub(super) fn forget_backend(&self, id: &str) {
        lock(&self.backends().compiled).remove(id);
        lock(&self.backends().failures).remove(id);
    }

    /// Removes the compiled code and the credentials of a removed extension.
    pub(super) fn remove_backend(&self, entry: &InstalledExtension) {
        self.forget_backend(&entry.id);
        lock(&self.backends().logs).remove(&entry.id);
        let _ = std::fs::remove_dir_all(self.backends().compiled_dir.join(&entry.id));
        if let Some(granted) = &entry.granted_backend {
            for credential in &granted.credentials {
                let _ = self.backends().credentials.remove(&entry.id, credential);
            }
        }
    }

    /// The backend's log, oldest first.
    pub fn backend_log(&self, id: &str) -> Vec<BackendLogLine> {
        lock(&self.backends().logs)
            .get(id)
            .map(|lines| lines.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Which of an installed extension's declared credentials the user has entered.
    pub fn credentials_status(&self, id: &str) -> CoreResult<Vec<(String, bool)>> {
        let entry = self.installed_one(id).ok_or_else(|| {
            CoreError::new(ErrorCode::NotFound, format!("`{id}` is not installed"))
        })?;
        let declared = entry
            .granted_backend
            .map(|g| g.credentials)
            .unwrap_or_default();
        declared
            .into_iter()
            .map(|c| {
                let set = self.backends().credentials.get(id, &c)?.is_some();
                Ok((c, set))
            })
            .collect()
    }

    /// Stores (or, with `None`, removes) a credential the user entered; only a declared and granted one.
    pub fn set_credential(
        &self,
        id: &str,
        credential: &str,
        value: Option<&str>,
    ) -> CoreResult<()> {
        let entry = self.installed_one(id).ok_or_else(|| {
            CoreError::new(ErrorCode::NotFound, format!("`{id}` is not installed"))
        })?;
        let granted = entry
            .granted_backend
            .map(|g| g.credentials)
            .unwrap_or_default();
        if !granted.iter().any(|c| c == credential) {
            return Err(invalid(format!("`{id}` has no credential `{credential}`")));
        }
        match value {
            Some(value) if !value.is_empty() => {
                if value.len() > 16 * 1024 {
                    return Err(invalid("A credential is at most 16 KB"));
                }
                self.backends().credentials.set(id, credential, value)
            }
            _ => self.backends().credentials.remove(id, credential),
        }
    }

    /// The compiled backend of an active entry: from memory, from the compiled file of its version, or compiled now.
    fn compiled_backend(
        &self,
        entry: &InstalledExtension,
        manifest: &ExtensionManifest,
    ) -> CoreResult<Backend> {
        let module = manifest
            .backend
            .as_ref()
            .map(|b| b.module.clone())
            .ok_or_else(|| invalid(format!("`{}` has no backend", entry.id)))?;
        let key = format!("{:?}|{}|{module}", entry.source, entry.version);
        if let Some((k, backend)) = lock(&self.backends().compiled).get(&entry.id)
            && *k == key
        {
            return Ok(backend.clone());
        }
        let runtime = self.backends().runtime()?;
        let packaged = !matches!(entry.source, ExtensionSource::Folder { .. });
        let cache = self
            .backends()
            .compiled_dir
            .join(&entry.id)
            .join(format!("{}.cwasm", entry.version));
        let from_cache = packaged
            .then(|| std::fs::read(&cache).ok())
            .flatten()
            .and_then(|bytes| runtime.load(&bytes).ok());
        let backend = match from_cache {
            Some(backend) => backend,
            None => {
                let root = self
                    .root_of(entry)
                    .ok_or_else(|| invalid(format!("`{}` is not installed", entry.id)))?;
                let mut bytes = Vec::new();
                std::io::Read::read_to_end(
                    &mut std::io::Read::take(
                        resolve_package_file(&root, &module)?,
                        MAX_COMPONENT_BYTES as u64 + 1,
                    ),
                    &mut bytes,
                )
                .map_err(CoreError::from)?;
                let backend = runtime.compile(&bytes).map_err(compile_error)?;
                if packaged && let Ok(compiled) = backend.serialize() {
                    let written = std::fs::create_dir_all(cache.parent().unwrap_or(&cache))
                        .and_then(|()| {
                            let temp =
                                cache.with_extension(format!("cwasm.{}.tmp", std::process::id()));
                            std::fs::write(&temp, compiled)?;
                            std::fs::rename(&temp, &cache)
                        });
                    if let Err(err) = written {
                        eprintln!("Sextant: a compiled extension backend could not be kept: {err}");
                    }
                }
                backend
            }
        };
        lock(&self.backends().compiled).insert(entry.id.clone(), (key, backend.clone()));
        Ok(backend)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// backend.call

/// `backend.call` params: `{ method, params }`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackendCallParams {
    method: String,
    #[serde(default)]
    params: Value,
}

fn is_method_name(text: &str) -> bool {
    (1..=100).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':' | b'/'))
}

impl ExtensionApi {
    /// `backend.call` of one of `extension_id`'s frames: runs its backend's `handle(method, params)` within the
    /// limits, and journals the call.
    pub(super) async fn backend_call(
        self: &Arc<Self>,
        host: &ExtensionHost,
        extension_id: &str,
        params: Value,
    ) -> CoreResult<Value> {
        let at = now_ms();
        let started = Instant::now();
        let parsed: Result<BackendCallParams, _> = serde_json::from_value(params);
        let method = parsed
            .as_ref()
            .map(|p| p.method.clone())
            .unwrap_or_default();
        let result = self.run_backend(host, extension_id, parsed).await;
        self.journal(AuditEntry {
            at,
            source: ConfirmSource::Extension,
            principal: format!(
                "Extension {}",
                host.info(extension_id)
                    .map_or_else(|| extension_id.to_owned(), |i| i.name)
            ),
            client: clip(extension_id),
            cluster_id: None,
            cluster_name: None,
            tool: "backend.call".to_owned(),
            target: clip(&method),
            decision: AuditDecision::Allowed,
            result: match &result {
                Ok(_) => "ok".to_owned(),
                Err(e) => super::api::code_name(e.code),
            },
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        });
        result
    }

    async fn run_backend(
        self: &Arc<Self>,
        host: &ExtensionHost,
        extension_id: &str,
        parsed: Result<BackendCallParams, serde_json::Error>,
    ) -> CoreResult<Value> {
        let call = parsed.map_err(|e| invalid(format!("backend.call: {e}")))?;
        if !is_method_name(&call.method) {
            return Err(invalid(
                "backend.call: `method` must be 1–100 letters, digits and . _ - : /",
            ));
        }
        let (blocking_host, id) = (host.clone(), extension_id.to_owned());
        let (entry, manifest) = tauri::async_runtime::spawn_blocking(move || {
            let entry = blocking_host.active(&id).ok_or_else(|| {
                CoreError::new(
                    ErrorCode::Forbidden,
                    format!("`{id}` is not installed and active"),
                )
            })?;
            let manifest = blocking_host
                .info(&id)
                .and_then(|i| i.manifest)
                .ok_or_else(|| invalid(format!("the manifest of `{id}` cannot be read")))?;
            Ok::<_, CoreError>((entry, manifest))
        })
        .await
        .map_err(|e| CoreError::other(e.to_string()))??;
        let Some(declared) = manifest.backend.clone() else {
            return Err(invalid(format!("`{extension_id}` has no backend")));
        };
        let backends = host.backends();
        if lock(&backends.failures)
            .get(extension_id)
            .copied()
            .unwrap_or(0)
            >= MAX_FAILURES
        {
            return Err(CoreError::new(
                ErrorCode::Conflict,
                "The backend failed three times in a row and is paused; reload the extension",
            ));
        }
        {
            let mut running = lock(&backends.running);
            let count = running.entry(extension_id.to_owned()).or_insert(0);
            if *count >= MAX_CONCURRENT_CALLS {
                return Err(CoreError::new(
                    ErrorCode::Conflict,
                    format!(
                        "{MAX_CONCURRENT_CALLS} backend calls are already running; try again when one ends"
                    ),
                ));
            }
            *count += 1;
        }
        let _running = Running {
            backends,
            id: extension_id.to_owned(),
        };
        let (blocking_host, blocking_entry, blocking_manifest) =
            (host.clone(), entry.clone(), manifest.clone());
        let backend = tauri::async_runtime::spawn_blocking(move || {
            blocking_host.compiled_backend(&blocking_entry, &blocking_manifest)
        })
        .await
        .map_err(|e| CoreError::other(e.to_string()))??;
        let runtime = backends.runtime()?;
        let granted =
            entry
                .granted_backend
                .clone()
                .unwrap_or(sextant_core::extensions::BackendGrant {
                    hosts: Vec::new(),
                    credentials: Vec::new(),
                });
        let backend_host: Arc<dyn Host> = Arc::new(BackendHost {
            api: Arc::clone(self),
            host: host.clone(),
            id: extension_id.to_owned(),
            name: manifest.name.clone(),
            // Active means the manifest asks for nothing beyond the grant: its own lists are the ones in force.
            hosts: declared.network.hosts.clone(),
            credentials: declared
                .credentials
                .iter()
                .map(|c| c.id.clone())
                .filter(|c| granted.credentials.contains(c))
                .collect(),
        });
        let params = serde_json::to_string(&call.params).map_err(|e| invalid(e.to_string()))?;
        let answer = runtime
            .invoke(
                &backend,
                backend_host,
                &call.method,
                &params,
                &Limits::default(),
            )
            .await;
        let failed = matches!(
            answer,
            Err(InvokeError::Timeout | InvokeError::OutOfMemory | InvokeError::Trap(_))
        );
        {
            let mut failures = lock(&backends.failures);
            if failed {
                *failures.entry(extension_id.to_owned()).or_insert(0) += 1;
            } else {
                failures.remove(extension_id);
            }
        }
        match answer {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|_| CoreError::other("The backend answered with text that is not JSON")),
            Err(InvokeError::Backend(message)) => Err(CoreError::other(message)),
            Err(InvokeError::Timeout) => Err(CoreError::new(
                ErrorCode::Timeout,
                InvokeError::Timeout.to_string(),
            )),
            Err(InvokeError::PayloadTooLarge) => {
                Err(invalid(InvokeError::PayloadTooLarge.to_string()))
            }
            Err(other) => {
                backends.log(extension_id, BackendLogLevel::Error, &other.to_string());
                Err(CoreError::other(other.to_string()))
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The host a backend sees

struct BackendHost {
    api: Arc<ExtensionApi>,
    host: ExtensionHost,
    id: String,
    name: String,
    hosts: Vec<String>,
    credentials: Vec<String>,
}

fn call_error(err: CoreError) -> CallError {
    CallError {
        code: super::api::code_name(err.code),
        message: err.without_plugin_output().message,
    }
}

/// A URL a backend may request: HTTPS, port 443, no user or password, a declared host.
fn allowed_url(url: &reqwest::Url, hosts: &[String]) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|h| hosts.iter().any(|allowed| allowed.eq_ignore_ascii_case(h)))
}

impl BackendHost {
    fn journal_http(
        &self,
        method: &str,
        url: &reqwest::Url,
        decision: AuditDecision,
        result: String,
        started: Instant,
    ) {
        self.api.journal(AuditEntry {
            at: now_ms(),
            source: ConfirmSource::Extension,
            principal: format!("Extension {}", self.name),
            client: clip(&self.id),
            cluster_id: None,
            cluster_name: None,
            tool: "http".to_owned(),
            // The path only: a query string can carry a token.
            target: clip(&format!(
                "{method} {}{}",
                url.host_str().unwrap_or_default(),
                url.path()
            )),
            decision,
            result,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        });
    }
}

impl Host for BackendHost {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: &'a str,
    ) -> HostFuture<'a, Result<String, CallError>> {
        Box::pin(async move {
            let params: Value = serde_json::from_str(params).map_err(|e| CallError {
                code: "invalid".to_owned(),
                message: format!("{method}: the parameters are not JSON: {e}"),
            })?;
            if method == "credentials.get" {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !self.credentials.iter().any(|c| c == name) {
                    return Err(CallError {
                        code: "forbidden".to_owned(),
                        message: format!("the manifest declares no credential `{name}`"),
                    });
                }
                let (store, id, name) = (
                    Arc::clone(&self.host.backends().credentials),
                    self.id.clone(),
                    name.to_owned(),
                );
                let value = tauri::async_runtime::spawn_blocking(move || store.get(&id, &name))
                    .await
                    .map_err(|e| call_error(CoreError::other(e.to_string())))?
                    .map_err(call_error)?;
                return Ok(json!(value).to_string());
            }
            if matches!(method, "resources.watch" | "backend.call") {
                return Err(CallError {
                    code: "invalid".to_owned(),
                    message: format!("{method} is not available to a backend"),
                });
            }
            let answer = self
                .api
                .call(&self.host, &self.id, method, params, None)
                .await
                .map_err(call_error)?;
            Ok(answer.to_string())
        })
    }

    fn log(&self, level: Level, message: &str) {
        let level = match level {
            Level::Debug => BackendLogLevel::Debug,
            Level::Info => BackendLogLevel::Info,
            Level::Warn => BackendLogLevel::Warn,
            Level::Error => BackendLogLevel::Error,
        };
        self.host.backends().log(&self.id, level, message);
    }

    fn http(&self, request: HttpRequest) -> HostFuture<'static, Result<HttpResponse, HttpError>> {
        let hosts = self.hosts.clone();
        let this = BackendHost {
            api: Arc::clone(&self.api),
            host: self.host.clone(),
            id: self.id.clone(),
            name: self.name.clone(),
            hosts: self.hosts.clone(),
            credentials: Vec::new(),
        };
        Box::pin(async move {
            let started = Instant::now();
            let method = request.method.as_str().to_owned();
            let Ok(url) = reqwest::Url::parse(&request.uri.to_string()) else {
                return Err(HttpError::Denied);
            };
            if !allowed_url(&url, &hosts) {
                this.journal_http(
                    &method,
                    &url,
                    AuditDecision::Denied,
                    "denied".to_owned(),
                    started,
                );
                return Err(HttpError::Denied);
            }
            let result = send(&url, request, hosts).await;
            let outcome = match &result {
                Ok(response) => response.status.as_u16().to_string(),
                Err(HttpError::Denied) => "denied".to_owned(),
                Err(HttpError::Timeout) => "timeout".to_owned(),
                Err(HttpError::TooLarge) => "tooLarge".to_owned(),
                Err(HttpError::Dns(_)) => "dns".to_owned(),
                Err(HttpError::Failed(_)) => "failed".to_owned(),
            };
            this.journal_http(&method, &url, AuditDecision::Allowed, outcome, started);
            result
        })
    }
}

fn client(hosts: Vec<String>) -> Result<reqwest::Client, HttpError> {
    // reqwest is built without a crypto provider; ring is the one the app uses.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else if allowed_url(attempt.url(), &hosts) {
            attempt.follow()
        } else {
            attempt.error("a redirect to a host the extension does not declare")
        }
    });
    reqwest::Client::builder()
        .redirect(policy)
        .no_proxy()
        .https_only(true)
        .dns_resolver(Arc::new(crate::image_files::registry::FilteringResolver))
        .connect_timeout(Duration::from_secs(10))
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!(
            "Sextant/",
            env!("CARGO_PKG_VERSION"),
            " (extension backend)"
        ))
        .build()
        .map_err(|e| HttpError::Failed(e.without_url().to_string()))
}

async fn send(
    url: &reqwest::Url,
    request: HttpRequest,
    hosts: Vec<String>,
) -> Result<HttpResponse, HttpError> {
    let client = client(hosts)?;
    let mut headers = request.headers;
    headers.remove(reqwest::header::HOST);
    let sent = client
        .request(request.method, url.clone())
        .headers(headers)
        .body(request.body)
        .send()
        .await;
    let mut response = sent.map_err(|e| {
        let e = e.without_url();
        if e.is_timeout() {
            HttpError::Timeout
        } else if e.is_redirect() {
            HttpError::Denied
        } else if e.is_connect() && e.to_string().contains("dns") {
            HttpError::Dns(e.to_string())
        } else {
            HttpError::Failed(e.to_string())
        }
    })?;
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
    {
        return Err(HttpError::TooLarge);
    }
    let status = response.status();
    let mut headers = response.headers().clone();
    headers.remove(reqwest::header::SET_COOKIE);
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        if e.is_timeout() {
            HttpError::Timeout
        } else {
            HttpError::Failed(e.without_url().to_string())
        }
    })? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(HttpError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse {
        status,
        headers,
        body: body.into(),
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands (window only: the credentials form and the log of Settings → Extensions)

/// One credential a backend declares, and whether the user entered it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CredentialStatus {
    pub id: String,
    /// The manifest's label; the id when the manifest cannot be read.
    pub label: String,
    pub set: bool,
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> CoreResult<T> + Send + 'static,
) -> CoreResult<T> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| CoreError::other(e.to_string()))?
}

/// The credentials an installed extension's backend was granted, and which are entered. Never a value.
#[tauri::command]
pub async fn extension_credentials(
    host: tauri::State<'_, ExtensionHost>,
    id: String,
) -> CoreResult<Vec<CredentialStatus>> {
    let host = host.inner().clone();
    blocking(move || {
        let labels: HashMap<String, String> = host
            .info(&id)
            .and_then(|i| i.manifest)
            .and_then(|m| m.backend)
            .map(|b| b.credentials.into_iter().map(|c| (c.id, c.label)).collect())
            .unwrap_or_default();
        Ok(host
            .credentials_status(&id)?
            .into_iter()
            .map(|(credential, set)| CredentialStatus {
                label: labels
                    .get(&credential)
                    .cloned()
                    .unwrap_or_else(|| credential.clone()),
                id: credential,
                set,
            })
            .collect())
    })
    .await
}

/// Stores the value the user typed for a credential, or with `value` null or empty removes it.
#[tauri::command]
pub async fn extension_credential_set(
    host: tauri::State<'_, ExtensionHost>,
    id: String,
    credential: String,
    value: Option<String>,
) -> CoreResult<()> {
    let host = host.inner().clone();
    blocking(move || host.set_credential(&id, &credential, value.as_deref())).await
}

/// The backend's log, oldest first.
#[tauri::command]
pub async fn extension_backend_log(
    host: tauri::State<'_, ExtensionHost>,
    id: String,
) -> CoreResult<Vec<BackendLogLine>> {
    Ok(host.backend_log(&id))
}

#[cfg(test)]
mod tests;
