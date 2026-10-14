// An extension's content: its entry page in a sandboxed iframe (no `allow-same-origin`: an opaque origin with no way
// into Sextant's window, its IPC or its storage), talking to the window only through the message bridge. A failure —
// an error the frame reports, or the frame failing to load — shows "Extension failed: … · Reload" in its place; the
// rest of the window is not affected. The frame reloads when the extension's files change (development mode).
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, ExtensionInfo, ObjectRef } from "../api";
import { useAppStore } from "../app/store";
import { Button } from "../components";
import { createBridge, type Bridge } from "./bridge";
import {
  frameUrl,
  PROTOCOL_VERSION,
  SETTINGS_CONTRIBUTION,
  VIEW,
  type FrameView,
  type HostContext,
} from "./protocol";
import { useExtension, useExtensionFiles } from "./store";
import { useFrameTheme } from "./theme";
import { hostUi } from "./ui";
import "./extensions.css";

/** The sandbox of every extension frame (spec, story 10). */
export const FRAME_SANDBOX = "allow-scripts allow-forms allow-popups-to-escape-sandbox";
/** Height of a details section until its frame says how tall it is. */
const DEFAULT_SECTION_HEIGHT = 120;

export interface ExtensionFrameProps {
  extensionId: string;
  view: FrameView;
  /** The manifest id of the contribution (`settings` for the settings section). */
  contribution: string;
  /** What the frame shows, for its accessible name (the contribution's title). */
  title: string;
  clusterId: ClusterId | null;
  /** Details: the shown object; action: the objects it runs on. */
  selection?: readonly ObjectRef[];
  /** Details: the shown object's `resourceVersion`, so the frame learns that it changed. */
  resourceVersion?: string | null;
  /** Height follows the frame's `resize` messages (details sections). */
  autoHeight?: boolean;
  /** `ui.close`. */
  onClose?: () => void;
  className?: string;
}

const NO_SELECTION: readonly ObjectRef[] = [];

/** The frame of an active extension; nothing when the extension is not installed, not active or has no entry. */
export function ExtensionFrame(props: ExtensionFrameProps) {
  const info = useExtension(props.extensionId);
  const files = useExtensionFiles(props.extensionId);
  const [attempt, setAttempt] = useState(0);
  // What the frame reported (`{type: "error"}`) or why it did not load; `null` while it runs.
  const [failure, setFailure] = useState<{ attempt: number; message: string } | null>(null);
  if (!info || info.state !== "active" || !info.entryUrl) return null;
  const reload = () => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };
  if (failure && failure.attempt === attempt) {
    return <FrameFailure message={failure.message} onReload={reload} className={props.className} />;
  }
  return (
    <FrameBoundary key={`${files}:${attempt}`} onReload={reload} className={props.className}>
      <FrameView
        {...props}
        info={info}
        entryUrl={info.entryUrl}
        onFailed={(message) => setFailure({ attempt, message })}
      />
    </FrameBoundary>
  );
}

/** The extension's own section of Settings (`contributes.settings`), for Settings → Extensions; else nothing. */
export function ExtensionSettingsFrame({ extensionId }: { extensionId: string }) {
  const info = useExtension(extensionId);
  const clusterId = useAppStore((s) => s.activeClusterId);
  const settings = info?.manifest?.contributes.settings;
  if (!settings) return null;
  return (
    <ExtensionFrame
      extensionId={extensionId}
      view={VIEW.settings}
      contribution={SETTINGS_CONTRIBUTION}
      title={settings.title}
      clusterId={clusterId}
      className="ext-frame--settings"
      autoHeight
    />
  );
}

interface BoundaryProps {
  onReload: () => void;
  className?: string;
  children: ReactNode;
}

interface BoundaryState {
  failure: string | null;
}

/** Catches what goes wrong while drawing the frame, so it never takes the rest of the window with it. */
class FrameBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failure: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("extension frame failed", error, info.componentStack);
  }

  render() {
    if (this.state.failure !== null) {
      return <FrameFailure message={this.state.failure} onReload={this.props.onReload} className={this.props.className} />;
    }
    return this.props.children;
  }
}

function FrameFailure({ message, onReload, className }: { message: string; onReload: () => void; className?: string }) {
  const { t } = useTranslation();
  const text = message.trim() || t("mcp:extensionHost.failedUnknown");
  return (
    <div className={className ? `ext-failed ${className}` : "ext-failed"} role="alert">
      <span className="ext-failed__text">{t("mcp:extensionHost.failed", { message: text })}</span>
      <Button size="compact" onClick={onReload}>
        {t("mcp:extensionHost.reload")}
      </Button>
    </div>
  );
}

function FrameView({
  info,
  entryUrl,
  view,
  contribution,
  title,
  clusterId,
  selection = NO_SELECTION,
  resourceVersion = null,
  autoHeight = false,
  onClose,
  className,
  onFailed,
}: ExtensionFrameProps & { info: ExtensionInfo; entryUrl: string; onFailed: (message: string) => void }) {
  const { t, i18n } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<Bridge | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const { theme, tokens } = useFrameTheme();
  const selectionKey = JSON.stringify(selection);

  const context: HostContext = useMemo(
    () => ({
      apiVersion: PROTOCOL_VERSION,
      extensionId: info.id,
      view,
      contribution,
      clusterId,
      theme,
      language: i18n.language,
      tokens,
      selection: JSON.parse(selectionKey) as ObjectRef[],
      resourceVersion,
    }),
    [info.id, view, contribution, clusterId, theme, i18n.language, tokens, selectionKey, resourceVersion],
  );
  const latest = useRef({ context, onClose, onFailed });
  latest.current = { context, onClose, onFailed };

  useEffect(() => {
    const current = createBridge({
      extensionId: info.id,
      frame: () => frame.current?.contentWindow ?? null,
      context: () => latest.current.context,
      ui: hostUi({ extensionId: info.id, extensionName: info.name, close: () => latest.current.onClose?.() }),
      onResize: autoHeight ? setHeight : undefined,
      onFrameError: (message) => latest.current.onFailed(message),
    });
    bridge.current = current;
    window.addEventListener("message", current.handle);
    return () => {
      window.removeEventListener("message", current.handle);
      current.dispose();
      bridge.current = null;
    };
  }, [info.id, info.name, autoHeight]);

  // A new context (theme, language, cluster, selection, a changed object) goes to the frame at once.
  useEffect(() => bridge.current?.pushContext(), [context]);

  return (
    <iframe
      ref={frame}
      className={className ? `ext-frame ${className}` : "ext-frame"}
      title={t("mcp:extensionHost.frameTitle", { title, extension: info.name })}
      src={frameUrl(entryUrl, view, contribution)}
      sandbox={FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      style={autoHeight ? { height: height ?? DEFAULT_SECTION_HEIGHT } : undefined}
      // A load after the first is a new document: the bridge closes what the previous one opened.
      onLoad={() => bridge.current?.frameLoaded()}
      onError={() => onFailed("")}
    />
  );
}
