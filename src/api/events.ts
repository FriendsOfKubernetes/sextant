// Backend events (interfaces.md, "Events"). Each `on*` resolves to an unsubscribe function.
import type { AuditEntry } from "./generated/AuditEntry";
import type { ClusterStatePayload } from "./generated/ClusterStatePayload";
import type { ConfirmRequest } from "./generated/ConfirmRequest";
import type { ExtensionFilesChangedPayload } from "./generated/ExtensionFilesChangedPayload";
import type { ForwardInfo } from "./generated/ForwardInfo";
import type { LogUpdate } from "./generated/LogUpdate";
import type { McpStatus } from "./generated/McpStatus";
import type { TermPayload } from "./generated/TermPayload";
import type { WatchUpdate } from "./generated/WatchUpdate";
import { subscribe, type Unsubscribe } from "./transport";

export const events = {
  onClusterState: (handler: (payload: ClusterStatePayload) => void): Promise<Unsubscribe> =>
    subscribe("cluster-state", handler),
  onWatch: (subscriptionId: string, handler: (update: WatchUpdate) => void): Promise<Unsubscribe> =>
    subscribe(`watch:${subscriptionId}`, handler),
  onLogs: (streamId: string, handler: (update: LogUpdate) => void): Promise<Unsubscribe> =>
    subscribe(`logs:${streamId}`, handler),
  onTerm: (sessionId: string, handler: (payload: TermPayload) => void): Promise<Unsubscribe> =>
    subscribe(`term:${sessionId}`, handler),
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
  /** Updates of an extension's `resources.watch` stream (`api.extensions.call(…, streamId)`). */
  onExtWatch: (streamId: string, handler: (update: WatchUpdate) => void): Promise<Unsubscribe> =>
    subscribe(`ext-watch:${streamId}`, handler),
  /** A new call of an extension was written to the extensions' journal. */
  onExtAudit: (handler: (entry: AuditEntry) => void): Promise<Unsubscribe> => subscribe("ext-audit", handler),
};
