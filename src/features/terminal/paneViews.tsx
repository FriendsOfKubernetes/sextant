// What runs in one pane of a terminal dock tab: a local shell, a shell in a container, a shell on a node or a debug
// container. Each pane is its own backend session (flow control and caps apply per pane).
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import type { DebugSpec } from "../../api/generated/DebugSpec";
import { Button, ConfirmDialog } from "../../components";
import { DEFAULT_DEBUG_IMAGE, DebugDialog } from "./DebugDialog";
import { FilesDialog } from "./FilesDialog";
import { KubectlBar } from "./KubectlBar";
import { NodeShellConfirm } from "./NodeShellConfirm";
import { TerminalView, type TerminalHandle } from "./TerminalView";
import type { TerminalSessionFactory, UseTerminalOptions } from "./useTerminal";

export type PaneSpec =
  | { kind: "local"; clusterId: ClusterId | null; input?: string }
  | { kind: "exec"; clusterId: ClusterId; pod: ObjectRef; container: string }
  | { kind: "node"; clusterId: ClusterId; node: string }
  | { kind: "debug"; clusterId: ClusterId; pod: ObjectRef; debug: DebugSpec };

/** What the pane layout adds to every pane. */
export interface PaneExtras {
  banner?: ReactNode;
  inputOptions?: UseTerminalOptions;
  onReady?: (handle: TerminalHandle) => void;
}

export interface PaneViewProps {
  spec: PaneSpec;
  /** Visible and focused: the terminal is fitted and takes the keyboard focus. */
  active: boolean;
  extras?: PaneExtras;
}

export function PaneView({ spec, active, extras = {} }: PaneViewProps) {
  switch (spec.kind) {
    case "local":
      return <LocalShellView spec={spec} active={active} extras={extras} />;
    case "exec":
      return <ContainerShellView spec={spec} active={active} extras={extras} />;
    case "node":
      return <NodeShellView spec={spec} active={active} extras={extras} />;
    case "debug":
      return <DebugView spec={spec} active={active} extras={extras} />;
  }
}

type ViewProps<K extends PaneSpec["kind"]> = { spec: Extract<PaneSpec, { kind: K }>; active: boolean; extras: PaneExtras };

function ContainerShellView({ spec, active, extras }: ViewProps<"exec">) {
  const { t } = useTranslation();
  const { clusterId, pod, container } = spec;
  const [open, setOpen] = useState<"debug" | "files" | null>(null);
  const factory = useCallback<TerminalSessionFactory>(
    (cols, rows, streamId, onEvent) => api.terminal.exec(clusterId, pod, container, cols, rows, streamId, onEvent),
    [clusterId, pod, container],
  );
  const close = () => setOpen(null);
  const toolbar = (
    <>
      <Button size="compact" icon="download" onClick={() => setOpen("files")}>
        {t("terminal:files.action")}
      </Button>
      <Button size="compact" icon="shell" onClick={() => setOpen("debug")}>
        {t("terminal:debug.action")}
      </Button>
    </>
  );
  return (
    <>
      <TerminalView factory={factory} active={active} label={t("terminal:terminal")} toolbar={toolbar} {...extras} />
      {open === "files" && <FilesDialog clusterId={clusterId} pod={pod} container={container} close={close} />}
      {open === "debug" && <DebugLauncher clusterId={clusterId} pod={pod} target={container} close={close} />}
    </>
  );
}

/** The debug dialog for a pod known only by its reference: its containers are read first. */
export function DebugLauncher({
  clusterId,
  pod,
  target,
  close,
  onStart,
}: {
  clusterId: ClusterId;
  pod: ObjectRef;
  target?: string;
  close: () => void;
  onStart?: (debug: DebugSpec) => void;
}) {
  const [containers, setContainers] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    api.resources.get(clusterId, pod).then(
      (obj) => live && setContainers(containersOf(obj)),
      () => live && setContainers(target ? [target] : []),
    );
    return () => {
      live = false;
    };
  }, [clusterId, pod, target]);
  if (containers === null) return null;
  return (
    <DebugDialog clusterId={clusterId} pod={pod} containers={containers} target={target} close={close} onStart={onStart} />
  );
}

function containersOf(pod: KubeObject): string[] {
  const spec = pod.spec as { containers?: { name?: unknown }[] } | undefined;
  return (spec?.containers ?? []).map((c) => c.name).filter((n): n is string => typeof n === "string");
}

function DebugView({ spec, active, extras }: ViewProps<"debug">) {
  const { t } = useTranslation();
  const { clusterId, pod, debug } = spec;
  const factory = useCallback<TerminalSessionFactory>(
    (cols, rows, streamId, onEvent) => api.terminal.debug(clusterId, pod, debug, cols, rows, streamId, onEvent),
    [clusterId, pod, debug],
  );
  const image = debug.image || DEFAULT_DEBUG_IMAGE;
  return (
    <TerminalView
      factory={factory}
      active={active}
      label={t("terminal:debug.label", { pod: pod.name })}
      connectingText={
        debug.copy
          ? t("terminal:debug.startingCopy", { pod: pod.name, image })
          : t("terminal:debug.starting", { pod: pod.name, image })
      }
      // Every new session adds another ephemeral container or makes a new copy: asked about first.
      confirmReconnect={(proceed, cancel) => (
        <DebugConfirm debug={debug} pod={pod.name} onConfirm={proceed} onCancel={cancel} />
      )}
      {...extras}
    />
  );
}

/** Asks before another debug container is started for `pod` (a reconnect, or a new pane like an existing one). */
export function DebugConfirm({
  debug,
  pod,
  onConfirm,
  onCancel,
}: {
  debug: DebugSpec;
  pod: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const image = debug.image || DEFAULT_DEBUG_IMAGE;
  return (
    <ConfirmDialog
      open
      title={t("terminal:debug.reconnectTitle")}
      confirmLabel={t("terminal:debug.reconnect")}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p>
        {debug.copy
          ? t("terminal:debug.reconnectCopy", { pod, image })
          : t("terminal:debug.reconnectEphemeral", { pod, image })}
      </p>
    </ConfirmDialog>
  );
}

function NodeShellView({ spec, active, extras }: ViewProps<"node">) {
  const { t } = useTranslation();
  const { clusterId, node } = spec;
  const factory = useCallback<TerminalSessionFactory>(
    (cols, rows, streamId, onEvent) => api.terminal.nodeShell(clusterId, node, cols, rows, streamId, onEvent),
    [clusterId, node],
  );
  return (
    <TerminalView
      factory={factory}
      active={active}
      label={t("terminal:node.label", { node })}
      connectingText={t("terminal:node.starting", { node })}
      // Every new session is a new privileged pod: asked about like the first one.
      confirmReconnect={(proceed, cancel) => <NodeShellConfirm node={node} onConfirm={proceed} onCancel={cancel} />}
      {...extras}
    />
  );
}

function LocalShellView({ spec, active, extras }: ViewProps<"local">) {
  const { t } = useTranslation();
  const { clusterId, input } = spec;
  const factory = useCallback<TerminalSessionFactory>(
    (cols, rows, streamId, onEvent) => api.terminal.local(clusterId, cols, rows, streamId, onEvent),
    [clusterId],
  );
  return (
    <TerminalView
      factory={factory}
      active={active}
      label={t("terminal:terminal")}
      kubeconfigNotice={clusterId !== null}
      initialInput={input}
      {...extras}
      banner={
        clusterId !== null || extras.banner ? (
          <>
            {clusterId !== null && <KubectlBar clusterId={clusterId} />}
            {extras.banner}
          </>
        ) : undefined
      }
    />
  );
}
