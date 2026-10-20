//! The MCP server built into Sextant: AI agents (Claude Code, Claude Desktop, Cursor) reach the user's clusters
//! through it, within the access rules of each cluster (`sextant_core::access`).
//!
//! - `paths`, `token` — where the files are and the token every request must carry;
//! - `server` — start/stop by the settings, the MCP handler, the tool set (`all_tools`);
//! - `http` — `127.0.0.1:<port>/mcp` with the Host/Origin/token/body checks before MCP;
//! - `guard` — the permission check of every call, confirmation in the window, the journal record;
//! - `confirm`, `audit` — waiting confirmations (`mcp-confirm`), the journal (`mcp-audit`);
//! - `tools`, `tools_read` — the tool registry and the reading tools;
//! - `dry_run` — what `apply_yaml` / `patch_resource` with `dryRun: true` return;
//! - `window`, `tools_diagnose`, `diagnose_answers` — the read-only diagnostic tools the window computes (ADR-0094).

pub mod audit;
pub mod confirm;
pub mod context;
pub mod diagnose_answers;
pub mod dry_run;
pub mod guard;
pub mod http;
pub mod paths;
pub mod server;
pub mod token;
pub mod tools;
pub mod tools_diagnose;
pub mod tools_read;
pub mod tools_write;
pub mod window;

#[cfg(test)]
mod tests;

pub use context::{McpContext, McpEvent};
pub use server::{McpServer, McpState, McpStatus};
