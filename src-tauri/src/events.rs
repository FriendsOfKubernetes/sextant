//! Events the backend emits to the window, and their payloads.

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
/// `extensions-changed` — no payload (`null`): installed extensions, a state or a manifest changed; read
/// `extensions_list` again.
pub const EXTENSIONS_CHANGED: &str = "extensions-changed";
/// `extension-files-changed` — payload [`ExtensionFilesChangedPayload`]: files of an extension changed (development
/// folder, reload, update); reload its frames.
pub const EXTENSION_FILES_CHANGED: &str = "extension-files-changed";
/// `open-about` — no payload (`null`): "About Sextant…" in the tray menu; the window opens the About dialog.
pub const OPEN_ABOUT: &str = "open-about";

/// `watch:<subscriptionId>` — payload `WatchUpdate`.
pub fn watch_event(subscription_id: &str) -> String {
    format!("watch:{subscription_id}")
}

/// `logs:<streamId>` — payload `LogUpdate`.
pub fn logs_event(stream_id: &str) -> String {
    format!("logs:{stream_id}")
}

/// `term:<sessionId>` — payload [`TermPayload`].
pub fn term_event(session_id: &str) -> String {
    format!("term:{session_id}")
}

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
        assert_eq!(watch_event("watch-1"), "watch:watch-1");
        assert_eq!(logs_event("logs-2"), "logs:logs-2");
        assert_eq!(term_event("term-3"), "term:term-3");
        assert_eq!(
            [MCP_STATUS, MCP_CONFIRM, MCP_AUDIT, OPEN_ABOUT],
            ["mcp-status", "mcp-confirm", "mcp-audit", "open-about"]
        );
    }
}
