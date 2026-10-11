//! One error type for the whole core. The frontend receives `{ code, message }` and picks a translated text
//! by `code`; `message` keeps the original text for details.

use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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
    /// Anything else, including "not implemented".
    Other,
}

/// The error every core function returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CoreError {
    pub code: ErrorCode,
    pub message: String,
}

pub type CoreResult<T> = Result<T, CoreError>;

impl CoreError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
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

impl From<kube::Error> for CoreError {
    fn from(err: kube::Error) -> Self {
        use kube::Error as E;
        use kube::client::AuthError as A;
        let code = match &err {
            E::Api(status) => code_for_http_status(status.code),
            E::HyperError(_) | E::Service(_) | E::UpgradeConnection(_) | E::ReadEvents(_) => {
                ErrorCode::Unreachable
            }
            E::RustlsTls(_) | E::TlsRequired => ErrorCode::Unreachable,
            E::Auth(auth) => match auth {
                A::AuthExecStart(_)
                | A::AuthExecRun { .. }
                | A::AuthExecParse(_)
                | A::AuthExecSerialize(_)
                | A::AuthExec(_)
                | A::ExecPluginFailed
                | A::MissingCommand
                | A::ExecMissingClusterInfo => ErrorCode::AuthPlugin,
                _ => ErrorCode::Unauthorized,
            },
            E::InferConfig(_) | E::InferKubeconfig(_) => ErrorCode::Kubeconfig,
            E::SerdeError(_) | E::BuildRequest(_) => ErrorCode::Invalid,
            _ => ErrorCode::Other,
        };
        // `kube::Error::Api` displays as "ApiError: <message>: <reason> (<debug>)"; the plain message reads better.
        let message = match &err {
            E::Api(status) if !status.message.is_empty() => status.message.clone(),
            _ => err.to_string(),
        };
        Self::new(code, message)
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

    #[test]
    fn parse_errors_map_to_invalid() {
        let yaml_err = serde_yaml::from_str::<serde_yaml::Value>("a: [").unwrap_err();
        assert_eq!(CoreError::from(yaml_err).code, ErrorCode::Invalid);
        let json_err = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        assert_eq!(CoreError::from(json_err).code, ErrorCode::Invalid);
    }
}
