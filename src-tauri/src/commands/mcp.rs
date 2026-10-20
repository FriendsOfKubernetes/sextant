//! The MCP server for AI agents: its status, token, journal and the answers to its confirmation requests. The server
//! itself starts and stops with `settings.mcp` (`settings_update`, application start).

use sextant_core::{ClusterId, CoreError, ErrorCode};
use tauri::State;

use crate::mcp::McpStatus;
use crate::mcp::audit::AuditEntry;
use crate::mcp::window::DiagnosticAnswer;
use crate::state::AppState;

/// Off, running at `url`, or an error (port taken, …).
#[tauri::command]
pub async fn mcp_status(state: State<'_, AppState>) -> Result<McpStatus, CoreError> {
    Ok(state.mcp.status())
}

/// The token for the snippets (created on first use). Shown only when the user asks for it.
#[tauri::command]
pub async fn mcp_token(state: State<'_, AppState>) -> Result<String, CoreError> {
    let token = state.mcp.token().map_err(token_error)?;
    Ok(token.as_str().to_owned())
}

/// A new token: the old one stops working at once and every agent session ends.
#[tauri::command]
pub async fn mcp_regenerate_token(state: State<'_, AppState>) -> Result<String, CoreError> {
    let token = state.mcp.regenerate_token().await.map_err(token_error)?;
    Ok(token.as_str().to_owned())
}

/// The journal, newest first; only one cluster's calls when `clusterId` is given.
#[tauri::command]
pub async fn mcp_audit_list(
    state: State<'_, AppState>,
    cluster_id: Option<ClusterId>,
) -> Result<Vec<AuditEntry>, CoreError> {
    Ok(state.mcp.context().audit.list(cluster_id.as_ref()))
}

#[tauri::command]
pub async fn mcp_audit_clear(state: State<'_, AppState>) -> Result<(), CoreError> {
    state.mcp.context().audit.clear().map_err(CoreError::from)
}

/// The user's answer to an `mcp-confirm` request; `notFound` when it no longer waits (timed out, server stopped).
#[tauri::command]
pub async fn mcp_confirm_answer(
    state: State<'_, AppState>,
    id: String,
    approved: bool,
) -> Result<(), CoreError> {
    state.mcp.context().confirmations.answer(&id, approved)
}

/// The window's answer to an `mcp-diagnostic` request (ADR-0094); `notFound` when it no longer waits (timed out, the
/// call was dropped). The backend checks and filters the answer before the agent reads it.
#[tauri::command]
pub async fn mcp_diagnostic_answer(
    state: State<'_, AppState>,
    id: String,
    answer: DiagnosticAnswer,
) -> Result<(), CoreError> {
    state.mcp.context().window.answer(&id, answer)
}

/// The path of the running Sextant executable, for the Claude Desktop snippet (`<path> mcp`).
#[tauri::command]
pub async fn mcp_binary_path() -> Result<String, CoreError> {
    let path = std::env::current_exe().map_err(CoreError::from)?;
    Ok(executable_text(&path))
}

/// The path as text for the snippet. Linux appends " (deleted)" to `/proc/self/exe` when the file was replaced while
/// the application runs (an updated package); the new file is at the path without it.
fn executable_text(path: &std::path::Path) -> String {
    let text = path.to_string_lossy();
    text.strip_suffix(" (deleted)").unwrap_or(&text).to_string()
}

/// The token file could not be read or written; the message names no token.
fn token_error(error: std::io::Error) -> CoreError {
    CoreError::new(
        ErrorCode::Other,
        format!("the MCP token file cannot be used: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::executable_text;

    #[test]
    fn a_replaced_binary_gives_its_path_without_the_deleted_mark() {
        assert_eq!(
            executable_text(Path::new("/usr/bin/sextant (deleted)")),
            "/usr/bin/sextant"
        );
        assert_eq!(
            executable_text(Path::new("/usr/bin/sextant")),
            "/usr/bin/sextant"
        );
    }
}
