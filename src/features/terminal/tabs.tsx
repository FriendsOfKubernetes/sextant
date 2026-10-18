// Dock tabs of the terminal feature and the functions that open them.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import type { DebugSpec } from "../../api/generated/DebugSpec";
import { useAppStore } from "../../app/store";
import { Button, ConfirmDialog } from "../../components";
import { i18n } from "../../i18n";
import type { DockTabProps } from "../../layout/dock/registry";
import { DEFAULT_DEBUG_IMAGE, DebugDialog } from "./DebugDialog";
import { FilesDialog } from "./FilesDialog";
import { NodeShellConfirm } from "./NodeShellConfirm";
import { TerminalView } from "./TerminalView";
import type { TerminalSessionFactory } from "./useTerminal";

/** Payload of an "exec" dock tab: a shell in `container` of `pod`. */
export interface ExecTabPayload {
  clusterId: ClusterId;
  pod: ObjectRef;
  container: string;
}

/** Payload of an "exec" dock tab with a shell on `node` (through a temporary privileged pod). */
export interface NodeShellTabPayload {
  clusterId: ClusterId;
  node: string;
}

/**
 * Payload of a "terminal" dock tab: a local shell with `KUBECONFIG` set to `clusterId`, or without a cluster (`null`).
 * `input` is typed into it once, without Enter.
 */
export interface LocalTerminalTabPayload {
  clusterId: ClusterId | null;
  input?: string;
}

/** Payload of an "exec" dock tab with a debug container for `pod` (`kubectl debug`). */
export interface DebugTabPayload {
  clusterId: ClusterId;
  pod: ObjectRef;
  debug: DebugSpec;
}

function isNodeShell(payload: unknown): payload is NodeShellTabPayload {
  return typeof (payload as { node?: unknown }).node === "string";
}

function isDebug(payload: unknown): payload is DebugTabPayload {
  const debug = (payload as { debug?: unknown }).debug;
  return typeof debug === "object" && debug !== null;
}

export function ExecTab({ tab, active }: DockTabProps) {
  if (isNodeShell(tab.payload)) return <NodeShellView payload={tab.payload} active={active} />;
  if (isDebug(tab.payload)) return <DebugView payload={tab.payload} active={active} />;
  return <ContainerShellView payload={tab.payload as ExecTabPayload} active={active} />;
}

function ContainerShellView({ payload, active }: { payload: ExecTabPayload; active: boolean }) {
  const { t } = useTranslation();
  const { clusterId, pod, container } = payload;
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
      <TerminalView factory={factory} active={active} label={t("terminal:terminal")} toolbar={toolbar} />
      {open === "files" && <FilesDialog clusterId={clusterId} pod={pod} container={container} close={close} />}
      {open === "debug" && <DebugLauncher clusterId={clusterId} pod={pod} target={container} close={close} />}
    </>
  );
}

/** The debug dialog for a pod known only by its reference: its containers are read first. */
function DebugLauncher({
  clusterId,
  pod,
  target,
  close,
}: {
  clusterId: ClusterId;
  pod: ObjectRef;
  target: string;
  close: () => void;
}) {
  const [containers, setContainers] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    api.resources.get(clusterId, pod).then(
      (obj) => live && setContainers(shellContainers(obj)),
      () => live && setContainers([target]),
    );
    return () => {
      live = false;
    };
  }, [clusterId, pod, target]);
  if (containers === null) return null;
  return <DebugDialog clusterId={clusterId} pod={pod} containers={containers} target={target} close={close} />;
}

function DebugView({ payload, active }: { payload: DebugTabPayload; active: boolean }) {
  const { t } = useTranslation();
  const { clusterId, pod, debug } = payload;
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
        <ConfirmDialog
          open
          title={t("terminal:debug.reconnectTitle")}
          confirmLabel={t("terminal:debug.reconnect")}
          onConfirm={proceed}
          onCancel={cancel}
        >
          <p>
            {debug.copy
              ? t("terminal:debug.reconnectCopy", { pod: pod.name, image })
              : t("terminal:debug.reconnectEphemeral", { pod: pod.name, image })}
          </p>
        </ConfirmDialog>
      )}
    />
  );
}

function NodeShellView({ payload, active }: { payload: NodeShellTabPayload; active: boolean }) {
  const { t } = useTranslation();
  const { clusterId, node } = payload;
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
    />
  );
}

export function LocalTerminalTab({ tab, active }: DockTabProps) {
  const { t } = useTranslation();
  const { clusterId, input } = tab.payload as LocalTerminalTabPayload;
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
    />
  );
}

/** Containers a shell can be opened in (regular containers; init containers are gone once the pod runs). */
export function shellContainers(pod: KubeObject): string[] {
  const spec = pod.spec as { containers?: { name?: unknown }[] } | undefined;
  return (spec?.containers ?? []).map((c) => c.name).filter((n): n is string => typeof n === "string");
}

/** The container `kubectl exec` would pick: the `kubectl.kubernetes.io/default-container` one, else the first. */
export function defaultContainer(pod: KubeObject): string | undefined {
  const containers = shellContainers(pod);
  const annotations = (pod.metadata as { annotations?: Record<string, string> } | undefined)?.annotations;
  const preferred = annotations?.["kubectl.kubernetes.io/default-container"];
  return preferred && containers.includes(preferred) ? preferred : containers[0];
}

/** Opens a new shell tab for `container` of `pod`. Returns the tab id. */
export function openExecTab(clusterId: ClusterId, pod: ObjectRef, container: string, containerCount = 1): string {
  const payload: ExecTabPayload = { clusterId, pod, container };
  return useAppStore.getState().openDockTab({
    type: "exec",
    title:
      containerCount > 1
        ? i18n.t("terminal:shell.tabTitleContainer", { pod: pod.name, container })
        : i18n.t("terminal:shell.tabTitle", { pod: pod.name }),
    payload,
  });
}

/** Opens a new tab with a shell on `node` of `clusterId` (the caller asked the user first). Returns the tab id. */
export function openNodeShellTab(clusterId: ClusterId, node: string): string {
  const payload: NodeShellTabPayload = { clusterId, node };
  return useAppStore.getState().openDockTab({
    type: "exec",
    title: i18n.t("terminal:node.tabTitle", { node }),
    payload,
  });
}

/** Opens a new tab with a debug container for `pod` as `debug` says (the user chose it in the debug dialog). */
export function openDebugTab(clusterId: ClusterId, pod: ObjectRef, debug: DebugSpec): string {
  const payload: DebugTabPayload = { clusterId, pod, debug };
  return useAppStore.getState().openDockTab({
    type: "exec",
    title: debug.copy
      ? i18n.t("terminal:debug.tabTitleCopy", { pod: pod.name })
      : i18n.t("terminal:debug.tabTitle", { pod: pod.name }),
    payload,
  });
}

/**
 * Opens a local terminal without a cluster with `command` typed in but not run (e.g. a cloud CLI's sign-in command).
 * Returns the tab id.
 */
export function openCommandTerminalTab(command: string): string {
  const payload: LocalTerminalTabPayload = { clusterId: null, input: command };
  return useAppStore.getState().openDockTab({
    type: "terminal",
    title: i18n.t("terminal:local.tabTitlePlain"),
    payload,
  });
}

/** Opens a new local terminal tab for `clusterId`; `name` is the cluster's display name. Returns the tab id. */
export function openLocalTerminalTab(clusterId: ClusterId, name: string): string {
  const payload: LocalTerminalTabPayload = { clusterId };
  return useAppStore.getState().openDockTab({
    type: "terminal",
    title: i18n.t("terminal:local.tabTitle", { cluster: name }),
    payload,
  });
}
