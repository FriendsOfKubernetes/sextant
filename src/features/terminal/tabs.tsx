// Dock tabs of the terminal feature and the functions that open them.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { i18n } from "../../i18n";
import type { DockTabProps } from "../../layout/dock/registry";
import { TerminalView } from "./TerminalView";

/** Payload of an "exec" dock tab: a shell in `container` of `pod`. */
export interface ExecTabPayload {
  clusterId: ClusterId;
  pod: ObjectRef;
  container: string;
}

/** Payload of a "terminal" dock tab: a local shell with `KUBECONFIG` set to `clusterId`. */
export interface LocalTerminalTabPayload {
  clusterId: ClusterId;
}

export function ExecTab({ tab, active }: DockTabProps) {
  const { t } = useTranslation();
  const { clusterId, pod, container } = tab.payload as ExecTabPayload;
  const factory = useCallback(
    (cols: number, rows: number) => api.terminal.exec(clusterId, pod, container, cols, rows),
    [clusterId, pod, container],
  );
  return <TerminalView factory={factory} active={active} label={t("terminal:terminal")} />;
}

export function LocalTerminalTab({ tab, active }: DockTabProps) {
  const { t } = useTranslation();
  const { clusterId } = tab.payload as LocalTerminalTabPayload;
  const factory = useCallback(
    (cols: number, rows: number) => api.terminal.local(clusterId, cols, rows),
    [clusterId],
  );
  return <TerminalView factory={factory} active={active} label={t("terminal:terminal")} />;
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

/** Opens a new local terminal tab for `clusterId`; `name` is the cluster's display name. Returns the tab id. */
export function openLocalTerminalTab(clusterId: ClusterId, name: string): string {
  const payload: LocalTerminalTabPayload = { clusterId };
  return useAppStore.getState().openDockTab({
    type: "terminal",
    title: i18n.t("terminal:local.tabTitle", { cluster: name }),
    payload,
  });
}
