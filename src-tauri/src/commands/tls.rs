//! Certificates of TLS Secrets (#138), parsed in the core: the window gets the certificates' fields, never a Secret
//! value. Read with the user's own credentials; window only — neither MCP agents nor extensions have these.

use sextant_core::tls::{self, SecretCertificates, TlsExpiryScan};
use sextant_core::{ClusterId, CoreError};
use tauri::State;

use crate::state::AppState;

/// What the certificates in a Secret's `tls.crt` (and `ca.crt`) say. No `tls.crt` is `notFound`, one that does not
/// parse is `invalid`, no permission to read the Secret is `forbidden`.
#[tauri::command]
pub async fn tls_certificate_info(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespace: String,
    name: String,
) -> Result<SecretCertificates, CoreError> {
    tls::secret_certificates(&state.clusters, &cluster_id, &namespace, &name).await
}

/// The `kubernetes.io/tls` Secrets of `namespaces` (`null`: all namespaces) with when each expires; capped at
/// `tls::SCAN_MAX_SECRETS`.
#[tauri::command]
pub async fn tls_expiry_scan(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    namespaces: Option<Vec<String>>,
) -> Result<TlsExpiryScan, CoreError> {
    tls::expiry_scan(&state.clusters, &cluster_id, namespaces.as_deref()).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_can_read_certificates_of_secrets() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(
            !tools
                .iter()
                .any(|t| t.contains("tls") || t.contains("cert")),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods
                .iter()
                .any(|m| m.contains("tls") || m.contains("cert")),
            "{methods:?}"
        );
    }
}
