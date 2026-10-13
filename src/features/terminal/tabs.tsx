// Dock tabs of the terminal feature and the functions that open them.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { i18n } from "../../i18n";
import type { DockTabProps } from "../../layout/dock/registry";
import { NodeShellConfirm } from "./NodeShellConfirm";
import { TerminalView } from "./TerminalView";

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

function isNodeShell(payload: unknown): payload is NodeShellTabPayload {
  return typeof (payload as { node?: unknown }).node === "string";
}

export function ExecTab({ tab, active }: DockTabProps) {
  return isNodeShell(tab.payload) ? (
    <NodeShellView payload={tab.payload} active={active} />
  ) : (
    <ContainerShellView payload={tab.payload as ExecTabPayload} active={active} />
  );
}

function ContainerShellView({ payload, active }: { payload: ExecTabPayload; active: boolean }) {
  const { t } = useTranslation();
  const { clusterId, pod, container } = payload;
  const factory = useCallback(
    (cols: number, rows: number, streamId: string) => api.terminal.exec(clusterId, pod, container, cols, rows, streamId),
    [clusterId, pod, container],
  );
  return <TerminalView factory={factory} active={active} label={t("terminal:terminal")} />;
}

function NodeShellView({ payload, active }: { payload: NodeShellTabPayload; active: boolean }) {
  const { t } = useTranslation();
  const { clusterId, node } = payload;
  const factory = useCallback(
    (cols: number, rows: number, streamId: string) => api.terminal.nodeShell(clusterId, node, cols, rows, streamId),
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
  const factory = useCallback(
    (cols: number, rows: number, streamId: string) => api.terminal.local(clusterId, cols, rows, streamId),
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
