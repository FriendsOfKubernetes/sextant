//! One error type for the whole core. The frontend receives `{ code, message }` and picks a translated text
//! by `code`; `message` keeps the original text for details. A failed exec plugin's connection error may also carry
//! `pluginOutput`, its masked stderr, for the window only (#256).

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod plugin_output;

pub use plugin_output::ExecSecrets;

/// Machine-readable error category. Serialized in camelCase (`notFound`, `authPlugin`, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ErrorCode {
    /// The API server (or another endpoint) cannot be reached: connection refused, DNS, timeout, TLS.
    Unreachable,
    /// HTTP 401 — credentials missing, expired or rejected.
    Unauthorized,
    /// HTTP 403 — authenticated, but not allowed.
    Forbidden,
    /// HTTP 404 or a missing local file/object.
    NotFound,
    /// HTTP 409 — e.g. a stale `resourceVersion` on replace.
    Conflict,
    /// HTTP 400/422 or input that does not parse (YAML, JSON).
    Invalid,
    /// An exec credential plugin is missing or failed.
    AuthPlugin,
    /// The `helm` binary is not installed.
    HelmMissing,
    /// A local port is already taken.
    PortInUse,
    /// The kubeconfig cannot be read or is malformed.
    Kubeconfig,
    /// The operation took longer than allowed (e.g. a change in the cluster that does not finish).
    Timeout,
    /// Sextant's own rules refused it: the cluster's AI agent access does not allow the call.
    Denied,
    /// Anything else, including "not implemented".
    Other,
}

/// The error every core function returns.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CoreError {
    pub code: ErrorCode,
    pub message: String,
    /// What a failed exec auth plugin printed on stderr, clipped and masked ([`plugin_output::masked_stderr`]), set
    /// only by a connection ([`exec_plugin_error`]) and meant for the window alone (#256): it is never part of
    /// `message`, `Display` or `Debug`, so logs, the activity log and notifications never carry it, and agents and
    /// extensions get the error [`CoreError::without_plugin_output`].
    /// Boxed so the error stays small (`Result`s and structs holding a `CoreError` are everywhere).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    pub plugin_output: Option<Box<String>>,
}

/// `Debug` like the derived one, but the plugin's output is never printed.
impl fmt::Debug for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = f.debug_struct("CoreError");
        debug
            .field("code", &self.code)
            .field("message", &self.message);
        if self.plugin_output.is_some() {
            debug.field("plugin_output", &"<hidden>");
        }
        debug.finish()
    }
}

pub type CoreResult<T> = Result<T, CoreError>;

impl CoreError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            plugin_output: None,
        }
    }

    /// What a failed exec plugin printed ([`CoreError::plugin_output`]), if anything.
    pub fn plugin_output(&self) -> Option<&str> {
        self.plugin_output.as_deref().map(String::as_str)
    }

    /// The error without what an exec plugin printed: for agents and extensions, which only ever get the message.
    pub fn without_plugin_output(mut self) -> Self {
        self.plugin_output = None;
        self
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Other, message)
    }

    /// Placeholder result of functions that a later stage implements.
    pub fn not_implemented() -> Self {
        Self::other("not implemented")
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for CoreError {}

/// Runs `call`, giving up after `limit` with a `timeout` error naming `what` ("scaling deploy/web"). The call is
/// dropped at the limit, so a request still waiting for the server is cancelled.
pub async fn with_timeout<T>(
    limit: Duration,
    what: &str,
    call: impl Future<Output = CoreResult<T>>,
) -> CoreResult<T> {
    match tokio::time::timeout(limit, call).await {
        Ok(result) => result,
        Err(_) => Err(CoreError::new(
            ErrorCode::Timeout,
            format!(
                "{what} did not finish in {} s; it may still complete in the cluster",
                limit.as_secs()
            ),
        )),
    }
}

/// Maps an HTTP status code from the API server to an [`ErrorCode`].
pub fn code_for_http_status(status: u16) -> ErrorCode {
    match status {
        401 => ErrorCode::Unauthorized,
        403 => ErrorCode::Forbidden,
        404 | 410 => ErrorCode::NotFound,
        409 => ErrorCode::Conflict,
        400 | 422 => ErrorCode::Invalid,
        502..=504 => ErrorCode::Unreachable,
        _ => ErrorCode::Other,
    }
}

/// Every `kube::Error` becomes a [`CoreError`] through [`kube_error`], so auth-plugin failures are sanitized the same
/// way everywhere (connect, watch, get, logs, exec), including a token refresh that fails mid-stream.
impl From<kube::Error> for CoreError {
    fn from(err: kube::Error) -> Self {
        kube_error(err, None)
    }
}

/// Converts a kube error. The message keeps the whole cause chain ("client error (Connect): tcp connect error:
/// Connection refused"), so the user sees why; API errors keep the server's own message.
///
/// Auth errors are the exception, found whether kube returns them directly or wrapped in a service error:
/// kube-rs puts the whole exec command (its env and arguments, which often carry tokens) and the plugin's
/// stdout/stderr into their text, so only the plugin's command (`plugin`, when the caller knows it: the command as
/// the kubeconfig writes it, without arguments or env) and the exit code are kept.
pub fn kube_error(err: kube::Error, plugin: Option<&str>) -> CoreError {
    use kube::Error as E;
    if let Some(auth) = find_auth_error(&err) {
        return auth_error(auth, plugin);
    }
    let code = match &err {
        // A change answered with 504 ([`crate::cluster::CHANGE_TIMED_OUT`]) timed out; the server is not unreachable.
        E::Api(status) if status.message == crate::cluster::CHANGE_TIMED_OUT => ErrorCode::Timeout,
        E::Api(status) => code_for_http_status(status.code),
        E::HyperError(_) | E::Service(_) | E::UpgradeConnection(_) | E::ReadEvents(_) => {
            ErrorCode::Unreachable
        }
        E::RustlsTls(_) | E::TlsRequired => ErrorCode::Unreachable,
        E::InferConfig(_) | E::InferKubeconfig(_) => ErrorCode::Kubeconfig,
        E::SerdeError(_) | E::BuildRequest(_) => ErrorCode::Invalid,
        _ => ErrorCode::Other,
    };
    let message = match &err {
        // `kube::Error::Api` displays as "ApiError: <message>: <reason> (<debug>)"; the plain message reads better.
        E::Api(status) if !status.message.is_empty() => status.message.clone(),
        _ => with_causes(&err),
    };
    CoreError::new(code, message)
}

/// The error text followed by every cause that is not already part of it.
fn with_causes(err: &dyn std::error::Error) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}

/// The auth error inside `err`, whether kube returns it directly or wrapped in a service error.
fn find_auth_error(err: &kube::Error) -> Option<&kube::client::AuthError> {
    if let kube::Error::Auth(auth) = err {
        return Some(auth);
    }
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        if let Some(auth) = cause.downcast_ref::<kube::client::AuthError>() {
            return Some(auth);
        }
        source = cause.source();
    }
    None
}

/// [`kube_error`] for a connection whose exec plugin is known: when the plugin ran and failed, its stderr goes into
/// [`CoreError::plugin_output`], clipped and masked, with `secrets` (the values of its env and arguments) masked
/// wherever they appear (#256). Its stdout (the ExecCredential) is never read.
pub fn exec_plugin_error(
    err: kube::Error,
    plugin: Option<&str>,
    secrets: &ExecSecrets,
) -> CoreError {
    let output = match find_auth_error(&err) {
        Some(kube::client::AuthError::AuthExecRun { out, .. }) => {
            plugin_output::masked_stderr(&out.stderr, secrets)
        }
        _ => None,
    };
    let mut core = kube_error(err, plugin);
    if core.code == ErrorCode::AuthPlugin {
        core.plugin_output = output.map(Box::new);
    }
    core
}

/// How the message of an exec plugin that cannot be found begins (code `authPlugin`): the window shows its hint on
/// it (regenerate a kubeconfig written elsewhere, or a tool installed after Sextant started) (#253).
pub const EXEC_PLUGIN_NOT_FOUND: &str = "the auth plugin was not found";

/// An auth error without anything the exec plugin was given or printed. `plugin` is its command as the kubeconfig
/// writes it (a path is not a secret; its arguments and env are never part of it).
fn auth_error(auth: &kube::client::AuthError, plugin: Option<&str>) -> CoreError {
    use kube::client::AuthError as A;
    let name = plugin.map_or_else(
        || "the auth plugin".to_owned(),
        |p| format!("the auth plugin '{p}'"),
    );
    let message = match auth {
        A::AuthExecStart(io) => start_error_message(io, plugin, cfg!(windows)),
        A::AuthExecRun { status, .. } => match status.code() {
            Some(exit) => format!("{name} failed with exit code {exit}"),
            None => format!("{name} was terminated by a signal"),
        },
        A::AuthExecParse(_) => format!("{name} printed something that is not an ExecCredential"),
        A::AuthExecSerialize(_) | A::AuthExec(_) => format!("{name} failed"),
        A::ExecPluginFailed => format!("{name} returned no status"),
        A::MissingCommand | A::ExecMissingClusterInfo => auth.to_string(),
        // Token files, basic auth, refresh: messages hold paths and reasons, not credentials.
        other => return CoreError::new(ErrorCode::Unauthorized, other.to_string()),
    };
    CoreError::new(ErrorCode::AuthPlugin, message)
}

/// Why the exec plugin `command` could not be started, in plain words: which file or folder is missing, or that it
/// cannot be run ([`crate::kubeconfig::validate::start_failure`]); the OS text follows in parentheses. A missing
/// file or folder starts with [`EXEC_PLUGIN_NOT_FOUND`].
fn start_error_message(io: &std::io::Error, command: Option<&str>, windows: bool) -> String {
    use crate::kubeconfig::validate::{ExecMissing, command_folder, start_failure};
    let Some(command) = command else {
        return format!("cannot run the auth plugin: {io}");
    };
    match start_failure(io.kind(), io.raw_os_error(), windows, command) {
        Some(ExecMissing::NotOnPath) => {
            format!("{EXEC_PLUGIN_NOT_FOUND}: '{command}' is in no folder of Sextant's PATH ({io})")
        }
        Some(ExecMissing::FileMissing) => {
            format!("{EXEC_PLUGIN_NOT_FOUND}: the file '{command}' does not exist ({io})")
        }
        Some(ExecMissing::FolderMissing) => match command_folder(command) {
            Some(folder) => format!(
                "{EXEC_PLUGIN_NOT_FOUND}: '{command}' — the folder '{}' does not exist on this computer ({io})",
                folder.display()
            ),
            None => format!(
                "{EXEC_PLUGIN_NOT_FOUND}: the folder of '{command}' does not exist on this computer ({io})"
            ),
        },
        Some(ExecMissing::NotExecutable) => format!(
            "cannot run the auth plugin '{command}': the file is not executable or cannot be opened ({io})"
        ),
        None => format!("cannot run the auth plugin '{command}': {io}"),
    }
}

/// Errors of `kube::runtime::watcher` (watch subscriptions).
impl From<kube::runtime::watcher::Error> for CoreError {
    fn from(err: kube::runtime::watcher::Error) -> Self {
        use kube::runtime::watcher::Error as W;
        match err {
            W::InitialListFailed(e) | W::WatchStartFailed(e) | W::WatchFailed(e) => e.into(),
            W::WatchError(status) => {
                CoreError::new(code_for_http_status(status.code), status.message)
            }
            W::NoResourceVersion => CoreError::other(err.to_string()),
        }
    }
}

impl From<kube::config::KubeconfigError> for CoreError {
    fn from(err: kube::config::KubeconfigError) -> Self {
        Self::new(ErrorCode::Kubeconfig, err.to_string())
    }
}

impl From<kube::config::InferConfigError> for CoreError {
    fn from(err: kube::config::InferConfigError) -> Self {
        Self::new(ErrorCode::Kubeconfig, err.to_string())
    }
}

impl From<std::io::Error> for CoreError {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind as K;
        let code = match err.kind() {
            K::NotFound => ErrorCode::NotFound,
            K::AddrInUse => ErrorCode::PortInUse,
            K::ConnectionRefused
            | K::ConnectionReset
            | K::ConnectionAborted
            | K::NotConnected
            | K::TimedOut
            | K::HostUnreachable
            | K::NetworkUnreachable => ErrorCode::Unreachable,
            K::InvalidData | K::InvalidInput => ErrorCode::Invalid,
            _ => ErrorCode::Other,
        };
        Self::new(code, err.to_string())
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(err: serde_json::Error) -> Self {
        Self::new(ErrorCode::Invalid, err.to_string())
    }
}

impl From<serde_yaml::Error> for CoreError {
    fn from(err: serde_yaml::Error) -> Self {
        Self::new(ErrorCode::Invalid, err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api_error(code: u16, message: &str) -> kube::Error {
        kube::Error::Api(
            kube::core::Status {
                code,
                message: message.to_owned(),
                reason: "Reason".to_owned(),
                ..Default::default()
            }
            .boxed(),
        )
    }

    #[test]
    fn serializes_as_camel_case_code_and_message() {
        let json = serde_json::to_value(CoreError::new(ErrorCode::NotFound, "gone")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "notFound", "message": "gone" })
        );
        let json = serde_json::to_value(ErrorCode::AuthPlugin).unwrap();
        assert_eq!(json, "authPlugin");
        assert_eq!(
            serde_json::to_value(ErrorCode::PortInUse).unwrap(),
            "portInUse"
        );
        assert_eq!(
            serde_json::to_value(ErrorCode::HelmMissing).unwrap(),
            "helmMissing"
        );
    }

    #[test]
    fn not_implemented_is_other() {
        let err = CoreError::not_implemented();
        assert_eq!(err.code, ErrorCode::Other);
        assert_eq!(err.message, "not implemented");
    }

    #[test]
    fn api_status_codes_map_to_error_codes() {
        let cases = [
            (401, ErrorCode::Unauthorized),
            (403, ErrorCode::Forbidden),
            (404, ErrorCode::NotFound),
            (409, ErrorCode::Conflict),
            (422, ErrorCode::Invalid),
            (400, ErrorCode::Invalid),
            (500, ErrorCode::Other),
        ];
        for (status, expected) in cases {
            let err = CoreError::from(api_error(status, "pods is forbidden"));
            assert_eq!(err.code, expected, "status {status}");
            assert_eq!(err.message, "pods is forbidden");
        }
    }

    #[test]
    fn exec_plugin_failures_map_to_auth_plugin() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "No such file or directory");
        let err = CoreError::from(kube::Error::Auth(kube::client::AuthError::AuthExecStart(
            io,
        )));
        assert_eq!(err.code, ErrorCode::AuthPlugin);
    }

    /// A failed exec plugin as kube-rs reports it: the command line with env and arguments, and the output.
    #[cfg(unix)]
    fn exec_run_error() -> kube::client::AuthError {
        use std::os::unix::process::ExitStatusExt as _;
        let status = std::process::ExitStatus::from_raw(3 << 8);
        kube::client::AuthError::AuthExecRun {
            cmd: r#"VAULT_TOKEN="ENV-SECRET-123" "/usr/local/bin/vault-login" "--password=ARG-SECRET""#
                .to_owned(),
            status,
            out: std::process::Output {
                status,
                stdout: b"token: OUT-SECRET-456".to_vec(),
                stderr: b"ERR-SECRET-789".to_vec(),
            },
        }
    }

    /// [`kube_error`] (every path but a connection: watches, reads, a token refresh mid-stream) keeps nothing the
    /// plugin was given or printed, not even its masked stderr.
    #[cfg(unix)]
    #[test]
    fn exec_plugin_errors_from_kube_carry_no_env_args_or_output() {
        const SECRETS: [&str; 4] = [
            "ENV-SECRET-123",
            "ARG-SECRET",
            "OUT-SECRET-456",
            "ERR-SECRET-789",
        ];
        // Directly, and wrapped in a service error the way a token refresh fails in the middle of a watch.
        let direct = kube::Error::Auth(exec_run_error());
        let wrapped = kube::Error::Service(Box::new(exec_run_error()));
        for err in [direct, wrapped] {
            let core = CoreError::from(err);
            assert_eq!(core.code, ErrorCode::AuthPlugin, "{core}");
            assert!(
                core.message.contains("exit code 3"),
                "keeps the exit code: {core}"
            );
            let json = serde_json::to_string(&core).unwrap();
            for secret in SECRETS {
                assert!(!json.contains(secret), "{secret} leaked in {json}");
            }
        }
        // With the plugin's command known (as `ClusterManager::connect` knows it), only the command is added.
        let named = kube_error(kube::Error::Auth(exec_run_error()), Some("vault-login"));
        assert!(named.message.contains("'vault-login'"), "{named}");
        assert!(!named.message.contains("ARG-SECRET"), "{named}");
    }

    /// The rule since #256: the plugin's stderr reaches the window masked, in its own field; stdout, the command
    /// line's env and arguments never; the message, `Display` and `Debug` stay without any of it.
    #[cfg(unix)]
    #[test]
    fn a_connection_error_carries_the_plugins_stderr_masked_and_apart_from_the_message() {
        use std::os::unix::process::ExitStatusExt as _;
        let status = std::process::ExitStatus::from_raw(1 << 8);
        let run = || {
            kube::client::AuthError::AuthExecRun {
            cmd: r#"VAULT_TOKEN="ENV-SECRET-123" "vault-login" "--password=ARG-SECRET""#.to_owned(),
            status,
            out: std::process::Output {
                status,
                stdout: b"token: OUT-SECRET-456".to_vec(),
                stderr: b"\x1b[31mERROR\x1b[0m: not logged in, run 'vault login'\nVAULT_TOKEN ENV-SECRET-123 \
                          rejected (--password ARG-SECRET)\n"
                    .to_vec(),
            },
        }
        };
        let exec: kube::config::ExecConfig = serde_yaml::from_str(
            "command: vault-login\nargs: [\"--password=ARG-SECRET\"]\nenv: [{name: VAULT_TOKEN, value: ENV-SECRET-123}]\n",
        )
        .unwrap();
        let secrets = ExecSecrets::of(&exec);
        let direct = kube::Error::Auth(run());
        let wrapped = kube::Error::Service(Box::new(run()));
        for err in [direct, wrapped] {
            let core = exec_plugin_error(err, Some("vault-login"), &secrets);
            assert_eq!(core.code, ErrorCode::AuthPlugin, "{core}");
            assert_eq!(
                core.message,
                "the auth plugin 'vault-login' failed with exit code 1"
            );
            assert_eq!(
                core.plugin_output(),
                Some(
                    "ERROR: not logged in, run 'vault login'\nVAULT_TOKEN <hidden> rejected (--password <hidden>)"
                )
            );
            let json = serde_json::to_value(&core).unwrap();
            assert_eq!(json["pluginOutput"], core.plugin_output().unwrap());
            let shown = [json.to_string(), format!("{core}"), format!("{core:?}")];
            for text in &shown {
                for secret in ["ENV-SECRET-123", "ARG-SECRET", "OUT-SECRET-456"] {
                    assert!(!text.contains(secret), "{secret} leaked in {text}");
                }
            }
            for text in &shown[1..] {
                assert!(!text.contains("not logged in"), "the output is in {text}");
            }
            let bare = core.without_plugin_output();
            assert_eq!(bare.plugin_output, None);
            assert!(
                !serde_json::to_string(&bare)
                    .unwrap()
                    .contains("pluginOutput")
            );
        }
        // An error that is not the plugin's run carries nothing extra.
        let other = exec_plugin_error(
            api_error(401, "Unauthorized"),
            Some("vault-login"),
            &secrets,
        );
        assert_eq!(other.plugin_output, None);
    }

    #[test]
    fn a_plugin_that_cannot_start_is_named_by_its_command_with_what_is_missing() {
        use std::io::{Error, ErrorKind};
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("yc").display().to_string();
        let folder = dir.path().join("yandex-cloud").join("bin");
        let deep = folder.join("yc").display().to_string();
        let enoent = || {
            Error::new(
                ErrorKind::NotFound,
                "No such file or directory (os error 2)",
            )
        };

        let message = start_error_message(&enoent(), Some("yc"), false);
        assert!(message.starts_with(EXEC_PLUGIN_NOT_FOUND), "{message}");
        assert!(
            message.contains("'yc' is in no folder of Sextant's PATH"),
            "{message}"
        );

        let message = start_error_message(&enoent(), Some(&file), false);
        assert!(message.starts_with(EXEC_PLUGIN_NOT_FOUND), "{message}");
        assert!(
            message.contains(&format!("the file '{file}' does not exist")),
            "{message}"
        );

        let message = start_error_message(&enoent(), Some(&deep), false);
        assert!(message.starts_with(EXEC_PLUGIN_NOT_FOUND), "{message}");
        assert!(message.contains(&format!("'{deep}'")), "{message}");
        assert!(
            message.contains(&format!("the folder '{}' does not exist", folder.display())),
            "{message}"
        );

        // Windows' ERROR_PATH_NOT_FOUND, read as Windows means it, for a kubeconfig written in WSL.
        let message = start_error_message(
            &Error::from_raw_os_error(3),
            Some("/home/user/yandex-cloud/bin/yc"),
            true,
        );
        assert!(message.starts_with(EXEC_PLUGIN_NOT_FOUND), "{message}");
        assert!(
            message.contains("the folder '/home/user/yandex-cloud/bin' does not exist"),
            "{message}"
        );

        let message = start_error_message(
            &Error::new(
                ErrorKind::PermissionDenied,
                "Permission denied (os error 13)",
            ),
            Some(&file),
            false,
        );
        assert!(!message.starts_with(EXEC_PLUGIN_NOT_FOUND), "{message}");
        assert!(message.contains("not executable"), "{message}");

        let message = start_error_message(&Error::other("busy"), Some(&file), false);
        assert_eq!(
            message,
            format!("cannot run the auth plugin '{file}': busy")
        );
        let message = start_error_message(&enoent(), None, false);
        assert!(
            message.starts_with("cannot run the auth plugin: "),
            "{message}"
        );
    }

    #[test]
    fn kubeconfig_errors_map_to_kubeconfig() {
        let err = CoreError::from(kube::config::KubeconfigError::CurrentContextNotSet);
        assert_eq!(err.code, ErrorCode::Kubeconfig);
    }

    #[test]
    fn io_errors_map_by_kind() {
        let not_found = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        assert_eq!(CoreError::from(not_found).code, ErrorCode::NotFound);
        let in_use = std::io::Error::new(std::io::ErrorKind::AddrInUse, "busy");
        assert_eq!(CoreError::from(in_use).code, ErrorCode::PortInUse);
        let refused = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused");
        assert_eq!(CoreError::from(refused).code, ErrorCode::Unreachable);
    }

    #[tokio::test(start_paused = true)]
    async fn a_call_slower_than_the_limit_gives_timeout() {
        let started = tokio::time::Instant::now();
        let slow = async {
            tokio::time::sleep(Duration::from_secs(300)).await;
            Ok::<_, CoreError>(())
        };
        let err = with_timeout(Duration::from_secs(30), "scaling", slow)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout, "{err}");
        assert!(err.message.contains("scaling"), "{err}");
        assert!(err.message.contains("30 s"), "{err}");
        assert_eq!(started.elapsed(), Duration::from_secs(30));
        assert_eq!(serde_json::to_value(ErrorCode::Timeout).unwrap(), "timeout");
    }

    #[tokio::test(start_paused = true)]
    async fn a_call_within_the_limit_keeps_its_result() {
        let quick = async {
            tokio::time::sleep(Duration::from_secs(29)).await;
            Err::<(), _>(CoreError::new(ErrorCode::Conflict, "stale"))
        };
        let err = with_timeout(Duration::from_secs(30), "scaling", quick)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert_eq!(
            with_timeout(Duration::from_secs(30), "x", async { Ok(7) }).await,
            Ok(7)
        );
    }

    #[test]
    fn parse_errors_map_to_invalid() {
        let yaml_err = serde_yaml::from_str::<serde_yaml::Value>("a: [").unwrap_err();
        assert_eq!(CoreError::from(yaml_err).code, ErrorCode::Invalid);
        let json_err = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        assert_eq!(CoreError::from(json_err).code, ErrorCode::Invalid);
    }
}
