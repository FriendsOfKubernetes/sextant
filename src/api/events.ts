// Backend events (interfaces.md, "Events"). Each `on*` resolves to an unsubscribe function. Streams the window opens
// (watch, logs, terminal sessions, extension watches, GitOps installs, file transfers) are not events: their payloads
// come through the channel of their `*_start` command (`openStream`, ADR-0078).
import type { AuditEntry } from "./generated/AuditEntry";
import type { ClusterStatePayload } from "./generated/ClusterStatePayload";
import type { ConfirmRequest } from "./generated/ConfirmRequest";
import type { ExtensionFilesChangedPayload } from "./generated/ExtensionFilesChangedPayload";
import type { ForwardInfo } from "./generated/ForwardInfo";
import type { McpStatus } from "./generated/McpStatus";
import { subscribe, type Unsubscribe } from "./transport";

export const events = {
  onClusterState: (handler: (payload: ClusterStatePayload) => void): Promise<Unsubscribe> =>
    subscribe("cluster-state", handler),
  onPortForwards: (handler: (list: ForwardInfo[]) => void): Promise<Unsubscribe> =>
    subscribe("portforwards", handler),
  /**
   * An AI agent or an extension (`request.source`) asks to run something; answer with
   * `api.mcp.confirmAnswer(id, approved)`.
   */
  onMcpConfirm: (handler: (request: ConfirmRequest) => void): Promise<Unsubscribe> => subscribe("mcp-confirm", handler),
  /** A new call of an agent was written to the journal. */
  onMcpAudit: (handler: (entry: AuditEntry) => void): Promise<Unsubscribe> => subscribe("mcp-audit", handler),
  onMcpStatus: (handler: (status: McpStatus) => void): Promise<Unsubscribe> => subscribe("mcp-status", handler),
  /** The list of installed extensions changed (installed, enabled, disabled, removed, reloaded); ask `list` again. */
  onExtensionsChanged: (handler: () => void): Promise<Unsubscribe> => subscribe("extensions-changed", () => handler()),
  /** Files of an extension running from a folder changed (development mode): its frames reload. */
  onExtensionFilesChanged: (handler: (payload: ExtensionFilesChangedPayload) => void): Promise<Unsubscribe> =>
    subscribe("extension-files-changed", handler),
  /** "About Sextant…" was chosen in the tray menu (the window is already back); open the About dialog. */
  onOpenAbout: (handler: () => void): Promise<Unsubscribe> => subscribe("open-about", () => handler()),
  /** A new call of an extension was written to the extensions' journal. */
  onExtAudit: (handler: (entry: AuditEntry) => void): Promise<Unsubscribe> => subscribe("ext-audit", handler),
};
