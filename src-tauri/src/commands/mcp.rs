//! The MCP server for AI agents: its status, token, journal and the answers to its confirmation requests. The server
//! itself starts and stops with `settings.mcp` (`settings_update`, application start).

use sextant_core::{ClusterId, CoreError, ErrorCode};
use tauri::State;

use crate::mcp::McpStatus;
use crate::mcp::audit::AuditEntry;
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

/// The path of the running Sextant executable, for the Claude Desktop snippet (`<path> mcp`).
#[tauri::command]
pub async fn mcp_binary_path() -> Result<String, CoreError> {
    let path = std::env::current_exe().map_err(CoreError::from)?;
    Ok(path.to_string_lossy().into_owned())
}

/// The token file could not be read or written; the message names no token.
fn token_error(error: std::io::Error) -> CoreError {
    CoreError::new(
        ErrorCode::Other,
        format!("the MCP token file cannot be used: {error}"),
    )
}
