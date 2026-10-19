// Dock tabs of the terminal feature and the functions that open them.
import { useState } from "react";
import type { ClusterId, KubeObject, ObjectRef } from "../../api";
import type { DebugSpec } from "../../api/generated/DebugSpec";
import { useAppStore } from "../../app/store";
import { i18n } from "../../i18n";
import type { DockTabProps } from "../../layout/dock/registry";
import { PaneLayout } from "./PaneLayout";
import type { PaneSpec } from "./paneViews";

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

/** The first pane of an "exec" dock tab, from the tab's payload. */
export function execPaneSpec(payload: unknown): PaneSpec {
  if (isNodeShell(payload)) return { kind: "node", clusterId: payload.clusterId, node: payload.node };
  if (isDebug(payload)) return { kind: "debug", clusterId: payload.clusterId, pod: payload.pod, debug: payload.debug };
  const { clusterId, pod, container } = payload as ExecTabPayload;
  return { kind: "exec", clusterId, pod, container };
}

/** The first pane of a "terminal" dock tab, from the tab's payload. */
export function localPaneSpec(payload: unknown): PaneSpec {
  const { clusterId, input } = payload as LocalTerminalTabPayload;
  return { kind: "local", clusterId, input };
}

export function ExecTab({ tab, active }: DockTabProps) {
  const [first] = useState(() => execPaneSpec(tab.payload));
  return <PaneLayout tab={tab} active={active} first={first} />;
}

export function LocalTerminalTab({ tab, active }: DockTabProps) {
  const [first] = useState(() => localPaneSpec(tab.payload));
  return <PaneLayout tab={tab} active={active} first={first} />;
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
