// Which install dialog is open: opened from the cluster menu and from the "GitOps" section of the cluster settings,
// drawn once by `InstallHost`, which is why this is a small module store.
import { create } from "zustand";
import type { ClusterId, GitopsTool } from "../../api";

export interface InstallTarget {
  clusterId: ClusterId;
  tool: GitopsTool;
}

interface InstallState {
  target: InstallTarget | null;
}

export const useInstallDialog = create<InstallState>(() => ({ target: null }));

export function openInstall(clusterId: ClusterId, tool: GitopsTool): void {
  useInstallDialog.setState({ target: { clusterId, tool } });
}

export function closeInstall(): void {
  useInstallDialog.setState({ target: null });
}
