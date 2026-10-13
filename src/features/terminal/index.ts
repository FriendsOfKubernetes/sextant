// Terminals (task 07): the "Shell" action on pods (a shell in a container) and the dock's "Terminal" button (a local
// shell whose `kubectl` talks to the active cluster). Both run in "exec" / "terminal" dock tabs with xterm.js.
import { createElement } from "react";
import { loadSettings, type ClusterId } from "../../api";
import { registerDockAction, registerDockTab } from "../../layout/dock/registry";
import { registerAction } from "../actions/registry";
import { displayNameOf } from "../clusters/clusterSettings";
import { useClustersStore } from "../clusters/clustersStore";
import { ContainerPicker } from "./ContainerPicker";
import { defaultContainer, ExecTab, LocalTerminalTab, openExecTab, openLocalTerminalTab, shellContainers } from "./tabs";
import "./terminal.css";

registerDockTab("exec", ExecTab);
registerDockTab("terminal", LocalTerminalTab);

registerAction("exec", {
  labelKey: "terminal:shell.action",
  icon: "shell",
  appliesTo: (obj, kind) =>
    kind.group === "" &&
    kind.kind === "Pod" &&
    (obj.status as { phase?: string } | undefined)?.phase === "Running" &&
    shellContainers(obj).length > 0,
  run: ({ clusterId, objects, refs, openDialog }) => {
    const obj = objects[0];
    const pod = refs[0];
    if (!obj || !pod) return;
    const containers = shellContainers(obj);
    const preferred = defaultContainer(obj);
    if (containers.length === 1 && preferred) {
      openExecTab(clusterId, pod, preferred, 1);
      return;
    }
    openDialog((close) => createElement(ContainerPicker, { clusterId, pod, containers, preferred, close }));
  },
});

registerDockAction({
  id: "terminal",
  order: 20,
  labelKey: "terminal:local.open",
  icon: "shell",
  available: ({ activeClusterId }) => activeClusterId !== null,
  run: ({ activeClusterId }) => {
    if (activeClusterId) void openLocalTerminal(activeClusterId);
  },
});

/** Opens a local terminal for `clusterId`, titled with the cluster's display name. Resolves to the tab id. */
export async function openLocalTerminal(clusterId: ClusterId): Promise<string> {
  const settings = await loadSettings().catch(() => null);
  const cluster = useClustersStore.getState().clusters.find((c) => c.id === clusterId);
  return openLocalTerminalTab(clusterId, cluster ? displayNameOf(cluster, settings) : clusterId);
}

export { ContainerPicker, type ContainerPickerProps } from "./ContainerPicker";
export {
  defaultContainer,
  openExecTab,
  openLocalTerminalTab,
  shellContainers,
  type ExecTabPayload,
  type LocalTerminalTabPayload,
} from "./tabs";
export { TerminalView, type TerminalViewProps } from "./TerminalView";
export { useTerminal, type TerminalSessionFactory, type TerminalStatus, type UseTerminal } from "./useTerminal";
