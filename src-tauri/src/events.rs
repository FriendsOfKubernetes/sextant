//! Events the backend emits to the window, and the payloads of events and stream channels.

use serde::{Deserialize, Serialize};
use sextant_core::{ClusterId, ConnectionState, CoreError};
use ts_rs::TS;

/// `cluster-state` — payload [`ClusterStatePayload`].
pub const CLUSTER_STATE: &str = "cluster-state";
/// `portforwards` — payload `ForwardInfo[]`.
pub const PORTFORWARDS: &str = "portforwards";
/// `mcp-status` — payload `McpStatus` (the MCP server started, stopped or failed).
pub const MCP_STATUS: &str = "mcp-status";
/// `mcp-confirm` — payload `ConfirmRequest`; answered with the command `mcp_confirm_answer`.
pub const MCP_CONFIRM: &str = "mcp-confirm";
/// `mcp-audit` — payload `AuditEntry` (one more call of an agent in the journal).
pub const MCP_AUDIT: &str = "mcp-audit";
/// `mcp-diagnostic` — payload `DiagnosticRequest`: the window computes an agent's diagnostic answer (ADR-0094) and
/// answers with the command `mcp_diagnostic_answer`.
pub const MCP_DIAGNOSTIC: &str = "mcp-diagnostic";
/// `extensions-changed` — no payload (`null`): installed extensions, a state or a manifest changed; read
/// `extensions_list` again.
pub const EXTENSIONS_CHANGED: &str = "extensions-changed";
/// `extension-files-changed` — payload [`ExtensionFilesChangedPayload`]: files of an extension changed (development
/// folder, reload, update); reload its frames.
pub const EXTENSION_FILES_CHANGED: &str = "extension-files-changed";
/// `open-about` — no payload (`null`): "About Sextant…" in the tray menu; the window opens the About dialog.
pub const OPEN_ABOUT: &str = "open-about";

// Streams the window opens (watch, logs, terminal sessions, extension watches, GitOps installs, file transfers) are
// not events: each `*_start` command takes a `tauri::ipc::Channel` (`onEvent`) the window created before the start,
// and its payloads (`WatchUpdate`, `LogUpdate`, [`TermPayload`], `InstallEvent`, `TransferEvent`) go through it
// (ADR-0078).

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClusterStatePayload {
    pub cluster_id: ClusterId,
    pub state: ConnectionState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExtensionFilesChangedPayload {
    pub id: String,
}

/// Terminal output. Serialized with a `type` tag; `data` is base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum TermPayload {
    Data { data: String },
    Exit { code: Option<i32> },
    Error { error: CoreError },
}

impl TermPayload {
    pub fn data(bytes: &[u8]) -> Self {
        use base64::Engine as _;
        Self::Data {
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }
}

/// A stream channel for module tests: what the backend sends through it arrives on the receiver as JSON.
#[cfg(test)]
pub(crate) fn test_channel<T>() -> (
    tauri::ipc::Channel<T>,
    std::sync::mpsc::Receiver<serde_json::Value>,
) {
    let (tx, rx) = std::sync::mpsc::channel();
    let channel = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = body {
            // The test may have stopped listening; the stream does not care.
            let _ = tx.send(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, rx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn term_payload_wire_format() {
        let json = serde_json::to_value(TermPayload::data(b"hi")).unwrap();
        assert_eq!(json, serde_json::json!({ "type": "data", "data": "aGk=" }));
        let json = serde_json::to_value(TermPayload::Exit { code: Some(0) }).unwrap();
        assert_eq!(json, serde_json::json!({ "type": "exit", "code": 0 }));
    }

    #[test]
    fn cluster_state_payload_wire_format() {
        let payload = ClusterStatePayload {
            cluster_id: ClusterId::from("abc"),
            state: ConnectionState::Connecting,
        };
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "clusterId": "abc", "state": { "state": "connecting" } })
        );
    }

    #[test]
    fn event_names() {
        assert_eq!(
            [
                MCP_STATUS,
                MCP_CONFIRM,
                MCP_AUDIT,
                MCP_DIAGNOSTIC,
                OPEN_ABOUT
            ],
            [
                "mcp-status",
                "mcp-confirm",
                "mcp-audit",
                "mcp-diagnostic",
                "open-about"
            ]
        );
    }
}
