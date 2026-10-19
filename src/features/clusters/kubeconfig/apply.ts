// Writing a previewed kubeconfig change and following it in the window: the settings are read again (the backend
// moved a renamed cluster's settings to its new id), clusters whose context is gone are dropped from the window, the
// cluster list and the credential expiry are read again, and an open cluster that was renamed is opened under its
// new id.
import { create } from "zustand";
import { api, withBackendSettingsChange, type ClusterInfo, type EditOutcome, type KubeconfigEdit } from "../../../api";
import { useAppStore } from "../../../app/store";
import { disconnectCluster, refreshClusters, selectCluster } from "../clustersStore";
import { refreshCredentials } from "./credentials";

export async function applyKubeconfigEdit(edit: KubeconfigEdit, base: string): Promise<EditOutcome> {
  const outcome = await withBackendSettingsChange(() => api.kubeconfig.editApply(edit, base));
  const active = useAppStore.getState().activeClusterId;
  const reopen = outcome.renamed.find((r) => r.from === active);
  const gone = [...outcome.renamed.map((r) => r.from), ...outcome.removed];
  // The backend has disconnected them; this clears them from the window too.
  await Promise.all(gone.map((id) => disconnectCluster(id).catch(() => undefined)));
  await refreshClusters();
  void refreshCredentials();
  if (reopen) selectCluster(reopen.to);
  return outcome;
}

export type ContextEditKind = "rename" | "namespace" | "duplicate" | "delete";

interface EditRequest {
  kind: ContextEditKind;
  cluster: ClusterInfo;
}

/** The context change the dialog is open for (from the cluster menu). */
export const useContextEditStore = create<{ request: EditRequest | null; mergeOpen: boolean }>()(() => ({
  request: null,
  mergeOpen: false,
}));

export function openContextEdit(kind: ContextEditKind, cluster: ClusterInfo): void {
  useContextEditStore.setState({ request: { kind, cluster } });
}

export function closeContextEdit(): void {
  useContextEditStore.setState({ request: null });
}

export function openMerge(open = true): void {
  useContextEditStore.setState({ mergeOpen: open });
}
