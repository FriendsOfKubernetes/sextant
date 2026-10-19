// A terminal dock tab split into panes (#154). The panes are laid out flat (absolutely positioned from the layout
// tree) and keyed by id, so splitting or closing one never remounts — and so never restarts — the shells of the others.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { api, useSettings } from "../../api";
import type { DockTab } from "../../app/store";
import { Button } from "../../components";
import { useClustersStore } from "../clusters/clustersStore";
import { clusterSettingsOf, displayNameOf } from "../clusters/clusterSettings";
import { BroadcastBanner, BroadcastButton, BroadcastConfirm } from "./BroadcastUi";
import { broadcastInput, registerPane, updatePane, useBroadcast } from "./broadcast";
import {
  closePane,
  findPane,
  focusKey,
  MAX_PANES,
  neighbour,
  paneNode,
  paneRects,
  panesOf,
  resizeSplit,
  splitHandles,
  splitPane,
  type LayoutNode,
  type SplitDirection,
  type SplitHandle,
} from "./layout";
import { NewPaneDialog } from "./NewPaneDialog";
import { PaneView, type PaneSpec } from "./paneViews";
import { SnippetsMenu } from "./SnippetsUi";
import type { PaneContext, ShellKind } from "./snippets";
import type { TerminalHandle } from "./TerminalView";

export interface PaneLayoutProps {
  tab: DockTab;
  /** The dock tab is visible. */
  active: boolean;
  first: PaneSpec;
}

/** Keyboard step of a resize handle, as a share of its split. */
const KEY_STEP = 0.05;

export function PaneLayout({ tab, active, first }: PaneLayoutProps) {
  const { t } = useTranslation();
  const [root, setRoot] = useState<LayoutNode<PaneSpec>>(() => paneNode(first));
  const panes = panesOf(root);
  const [focused, setFocused] = useState(panes[0]!.id);
  const current = findPane(root, focused) ?? panes[0]!;
  const [splitting, setSplitting] = useState<SplitDirection | null>(null);
  const handles = useRef(new Map<string, TerminalHandle>());
  const area = useRef<HTMLDivElement | null>(null);
  const multiple = panes.length > 1;

  const split = (direction: SplitDirection, spec: PaneSpec) => {
    const added = paneNode(spec);
    setRoot((r) => splitPane(r, current.id, direction, added));
    setFocused(added.id);
  };
  const close = (id: string) => {
    const next = closePane(root, id);
    if (!next) return;
    const remaining = panesOf(next);
    if (id === focused) setFocused(neighbourAfterClose(root, id) ?? remaining[0]!.id);
    handles.current.delete(id);
    setRoot(next);
  };
  const onKey = useCallback(
    (id: string, e: KeyboardEvent): boolean => {
      const direction = focusKey(e);
      if (!direction || panesOf(root).length < 2) return true;
      e.preventDefault();
      const next = neighbour(root, id, direction);
      if (next) setFocused(next);
      return false;
    },
    [root],
  );

  const rects = paneRects(root);
  const contextOf = usePaneContext();
  const localShell = useLocalShellKind();
  const shell: ShellKind = current.pane.kind === "local" ? localShell : "posix";
  const send = (data: string) => handles.current.get(current.id)?.send(data);
  const focusCurrent = () => handles.current.get(current.id)?.focus();

  return (
    <div className="terminal-panes">
      <div className="terminal-panes__bar" role="toolbar" aria-label={t("terminal:panes.toolbar")}>
        <Button size="compact" icon="columns" disabled={panes.length >= MAX_PANES} onClick={() => setSplitting("row")}>
          {t("terminal:panes.splitRight")}
        </Button>
        <Button size="compact" icon="columns" disabled={panes.length >= MAX_PANES} onClick={() => setSplitting("column")}>
          {t("terminal:panes.splitDown")}
        </Button>
        {multiple && (
          <Button size="compact" icon="close" onClick={() => close(current.id)}>
            {t("terminal:panes.close")}
          </Button>
        )}
        <span className="terminal-panes__spacer" />
        <SnippetsMenu context={contextOf(current.pane)} shell={shell} send={send} afterInsert={focusCurrent} />
        <BroadcastButton tabId={tab.id} />
      </div>
      <div ref={area} className="terminal-panes__area">
        {panes.map((p) => (
          <PaneSlot
            key={p.id}
            id={p.id}
            tab={tab}
            spec={p.pane}
            style={rectStyle(rects.get(p.id))}
            active={active && p.id === current.id}
            focused={multiple && p.id === current.id}
            onFocus={setFocused}
            onKey={onKey}
            onReady={(handle) => handles.current.set(p.id, handle)}
          />
        ))}
        {splitHandles(root).map((h) => (
          <ResizeHandle key={`${h.splitId}:${h.index}`} handle={h} area={area} onResize={(d) => setRoot((r) => resizeSplit(r, h.splitId, h.index, d))} />
        ))}
      </div>
      {splitting && (
        <NewPaneDialog
          current={current.pane}
          direction={splitting}
          close={() => setSplitting(null)}
          onCreate={(spec) => {
            setSplitting(null);
            split(splitting, spec);
          }}
        />
      )}
    </div>
  );
}

/** How the local shell quotes: PowerShell on Windows, a POSIX shell on Linux and macOS (read once per window). */
let localShellKind: ShellKind | null = null;
let localShellLookup: Promise<ShellKind> | null = null;

function useLocalShellKind(): ShellKind {
  const [kind, setKind] = useState<ShellKind>(localShellKind ?? "unknown");
  useEffect(() => {
    if (localShellKind) return;
    let live = true;
    localShellLookup ??= api.about.info().then(
      (info) => {
        const found: ShellKind = info.os === "Windows" ? "powershell" : info.os === "Linux" || info.os === "macOS" ? "posix" : "unknown";
        localShellKind = found;
        return found;
      },
      () => {
        localShellLookup = null;
        return "unknown" as const;
      },
    );
    void localShellLookup.then((found) => live && setKind(found));
    return () => {
      live = false;
    };
  }, []);
  return kind;
}

/** For tests: forget the local shell kind read from the backend. */
export function resetLocalShellKind(): void {
  localShellKind = null;
  localShellLookup = null;
}

/** The pane that takes the focus when `id` closes: its neighbour to the left, above, right or below. */
function neighbourAfterClose(root: LayoutNode<PaneSpec>, id: string): string | null {
  for (const direction of ["left", "up", "right", "down"] as const) {
    const next = neighbour(root, id, direction);
    if (next) return next;
  }
  return null;
}

function rectStyle(rect: { x: number; y: number; w: number; h: number } | undefined): CSSProperties {
  if (!rect) return { display: "none" };
  const pct = (n: number) => `${(n * 100).toFixed(4)}%`;
  return { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) };
}

interface PaneSlotProps {
  id: string;
  tab: DockTab;
  spec: PaneSpec;
  style: CSSProperties;
  active: boolean;
  /** Outlined as the focused pane (only when the tab has several). */
  focused: boolean;
  onFocus: (id: string) => void;
  onKey: (id: string, e: KeyboardEvent) => boolean;
  onReady: (handle: TerminalHandle) => void;
}

/** One pane: its terminal, registered for broadcast; the broadcast banner and confirmation when it is a target. */
function PaneSlot({ id, tab, spec, style, active, focused, onFocus, onKey, onReady }: PaneSlotProps) {
  const label = usePaneLabel(spec);
  const handle = useRef<TerminalHandle | null>(null);
  const info = useMemo(
    () => ({ id, tabId: tab.id, tabTitle: tab.title, clusterId: spec.clusterId, label }),
    [id, tab.id, tab.title, spec.clusterId, label],
  );
  const infoRef = useRef(info);
  infoRef.current = info;
  // Registered once per pane (unregistering ends a broadcast that targets it); the description follows changes.
  useEffect(() => registerPane(infoRef.current, (data) => handle.current?.send(data)), [id]);
  useEffect(() => updatePane(info), [info]);
  const target = useBroadcast((s) => s.targets?.includes(id) ?? false);
  const asking = useBroadcast((s) => s.asking === id);
  // The confirmation had the keyboard: give it back to the terminal once answered.
  const wasAsking = useRef(false);
  useEffect(() => {
    if (wasAsking.current && !asking) handle.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  const ready = useCallback(
    (h: TerminalHandle) => {
      handle.current = h;
      onReady(h);
    },
    [onReady],
  );
  const extras = useMemo(
    () => ({
      banner: target ? <BroadcastBanner /> : undefined,
      inputOptions: {
        interceptInput: (data: string) => broadcastInput(id, data),
        onKey: (e: KeyboardEvent) => onKey(id, e),
      },
      onReady: ready,
    }),
    [target, id, onKey, ready],
  );
  const className = ["terminal-panes__pane", focused && "terminal-panes__pane--focused", target && "terminal-panes__pane--broadcast"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={className} style={style} onFocusCapture={() => onFocus(id)} onMouseDown={() => onFocus(id)}>
      <PaneView spec={spec} active={active} extras={extras} />
      {asking && <BroadcastConfirm />}
    </div>
  );
}

/** What a pane shows in the broadcast target list. */
function usePaneLabel(spec: PaneSpec): string {
  const { t } = useTranslation();
  switch (spec.kind) {
    case "local":
      return t("terminal:panes.localLabel");
    case "exec":
      return t("terminal:panes.execLabel", { pod: spec.pod.name, container: spec.container });
    case "node":
      return t("terminal:node.label", { node: spec.node });
    case "debug":
      return t("terminal:debug.label", { pod: spec.pod.name });
  }
}

/**
 * The placeholder values of a pane: its pod, namespace and container, and its cluster's display and context name. A
 * local terminal takes the namespace when the cluster's namespace filter selects exactly one.
 */
function usePaneContext(): (spec: PaneSpec) => PaneContext {
  const clusters = useClustersStore((s) => s.clusters);
  const { settings } = useSettings();
  return useCallback(
    (spec: PaneSpec) => {
      const context: PaneContext = {};
      const cluster = spec.clusterId ? clusters.find((c) => c.id === spec.clusterId) : undefined;
      if (cluster) {
        context.context = cluster.context;
        context.cluster = displayNameOf(cluster, settings ?? null);
      }
      switch (spec.kind) {
        case "exec":
          context.namespace = spec.pod.namespace ?? undefined;
          context.pod = spec.pod.name;
          context.container = spec.container;
          break;
        case "debug":
          context.namespace = spec.pod.namespace ?? undefined;
          context.pod = spec.pod.name;
          context.container = spec.debug.target ?? undefined;
          break;
        case "local": {
          const namespaces = spec.clusterId && settings ? clusterSettingsOf(settings, spec.clusterId).namespaces : null;
          if (namespaces?.length === 1) context.namespace = namespaces[0];
          break;
        }
        case "node":
          break;
      }
      return context;
    },
    [clusters, settings],
  );
}

/** The draggable border between two panes; arrow keys move it too. */
function ResizeHandle({
  handle,
  area,
  onResize,
}: {
  handle: SplitHandle;
  area: RefObject<HTMLDivElement | null>;
  onResize: (delta: number) => void;
}) {
  const { t } = useTranslation();
  const row = handle.direction === "row";
  const pct = (n: number) => `${(n * 100).toFixed(4)}%`;
  const style: CSSProperties = row
    ? { left: pct(handle.x), top: pct(handle.y), height: pct(handle.length) }
    : { left: pct(handle.x), top: pct(handle.y), width: pct(handle.length) };
  const onPointerDown = (e: ReactPointerEvent) => {
    const el = area.current;
    if (!el) return;
    e.preventDefault();
    const box = el.getBoundingClientRect();
    const total = (row ? box.width : box.height) * handle.extent;
    if (total <= 0) return;
    let last = row ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const now = row ? ev.clientX : ev.clientY;
      const delta = (now - last) / total;
      last = now;
      if (delta !== 0) onResize(delta);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const back = row ? "ArrowLeft" : "ArrowUp";
    const forward = row ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    onResize(e.key === forward ? KEY_STEP : -KEY_STEP);
  };
  return (
    <div
      className={`terminal-panes__handle terminal-panes__handle--${handle.direction}`}
      style={style}
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={t("terminal:panes.resize")}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
