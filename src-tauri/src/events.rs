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
/// `mcp-diagnostic-cancel` — payload `DiagnosticCancel`: the backend no longer waits for that request (timed out, the
/// call was dropped, the server stopped); the window drops its worker and lets go of its watches.
pub const MCP_DIAGNOSTIC_CANCEL: &str = "mcp-diagnostic-cancel";
/// `extensions-changed` — no payload (`null`): installed extensions, a state or a manifest changed; read
/// `extensions_list` again.
pub const EXTENSIONS_CHANGED: &str = "extensions-changed";
/// `extension-files-changed` — payload [`ExtensionFilesChangedPayload`]: files of an extension changed (development
/// folder, reload, update); reload its frames.
pub const EXTENSION_FILES_CHANGED: &str = "extension-files-changed";
/// `open-about` — no payload (`null`): "About Sextant…" in the tray menu; the window opens the About dialog.
pub const OPEN_ABOUT: &str = "open-about";
/// `open-settings` — no payload (`null`): "Settings…" (Cmd+,) in the macOS app menu; the window opens Settings.
pub const OPEN_SETTINGS: &str = "open-settings";
/// `close-tab` — no payload (`null`): "Close Tab" (Cmd+W) in the macOS app menu; the window closes its active dock tab,
/// or, with nothing to close, asks to close the window (`window_close`).
pub const CLOSE_TAB: &str = "close-tab";
/// `vcluster-links` — payload `VclusterLink[]`: the virtual clusters Sextant forwards for changed (ADR-0122); the window
/// reads the cluster list again.
pub const VCLUSTER_LINKS: &str = "vcluster-links";

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

/// How a terminal session ended, serialized with a `type` tag. Its output is no payload: it comes through the same
/// channel as raw bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum TermPayload {
    Exit { code: Option<i32> },
    Error { error: CoreError },
}

impl TermPayload {
    /// The payload as the JSON body of a [`TermChannel`] message.
    pub fn body(&self) -> tauri::ipc::InvokeResponseBody {
        tauri::ipc::InvokeResponseBody::Json(
            serde_json::to_string(self).expect("a TermPayload serializes"),
        )
    }
}

/// A terminal session's channel: output as raw bytes (`InvokeResponseBody::Raw`, an `ArrayBuffer` in the window) and
/// the end as a JSON [`TermPayload`]. Raw output is written to the terminal as it comes, where base64 in JSON cost
/// the window a JSON text, a string, a decoded string and a copy per message: several times the output in garbage
/// that JavaScriptCore collects late (#321).
pub type TermChannel = tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>;

/// A stream channel for module tests: what the backend sends through it arrives on the receiver as JSON, raw bytes
/// (a terminal's output) as `{"type": "data", "data": <base64>}`.
#[cfg(test)]
pub(crate) fn test_channel<T>() -> (
    tauri::ipc::Channel<T>,
    std::sync::mpsc::Receiver<serde_json::Value>,
) {
    use base64::Engine as _;
    let (tx, rx) = std::sync::mpsc::channel();
    let channel = tauri::ipc::Channel::new(move |body| {
        let value = match body {
            tauri::ipc::InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
            tauri::ipc::InvokeResponseBody::Raw(bytes) => serde_json::json!({
                "type": "data",
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
        };
        // The test may have stopped listening; the stream does not care.
        let _ = tx.send(value);
        Ok(())
    });
    (channel, rx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn term_payload_wire_format() {
        let json = serde_json::to_value(TermPayload::Exit { code: Some(0) }).unwrap();
        assert_eq!(json, serde_json::json!({ "type": "exit", "code": 0 }));
        let tauri::ipc::InvokeResponseBody::Json(text) = (TermPayload::Exit { code: None }).body()
        else {
            panic!("a TermPayload goes as JSON");
        };
        assert_eq!(text, r#"{"type":"exit","code":null}"#);
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
                MCP_DIAGNOSTIC_CANCEL,
                OPEN_ABOUT
            ],
            [
                "mcp-status",
                "mcp-confirm",
                "mcp-audit",
                "mcp-diagnostic",
                "mcp-diagnostic-cancel",
                "open-about"
            ]
        );
    }
}
