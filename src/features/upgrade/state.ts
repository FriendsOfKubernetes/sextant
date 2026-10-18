// State of the "Upgrade readiness" page per cluster, kept while the app runs (a module store, not saved): the last scan
// (bounded by the backend's caps), the chosen target version and the filters. A scan runs when the page is first
// opened for a cluster and when the user asks again; an answer that arrives after a newer scan started is dropped.
import { create } from "zustand";
import { api, toApiError, type ApiError, type ClusterId, type UpgradeScan } from "../../api";
import { SOURCE_TYPES, type SourceType } from "./evaluate";
import { scanApis, type Minor } from "./table";

export const UPGRADE_PAGE = "upgradeReadiness";

export interface UpgradePageState {
  scan: UpgradeScan | null;
  error: ApiError | null;
  loading: boolean;
  /** When the shown scan finished (ms). */
  scannedAt: number | null;
  /** `null` = the default (the next minor of the cluster). */
  target: Minor | null;
  sources: SourceType[];
  /** Show findings that are only traces of old writes. */
  history: boolean;
}

const EMPTY: UpgradePageState = Object.freeze({
  scan: null,
  error: null,
  loading: false,
  scannedAt: null,
  target: null,
  sources: [...SOURCE_TYPES],
  history: false,
}) as UpgradePageState;

interface Store {
  clusters: Record<ClusterId, UpgradePageState>;
  patch(clusterId: ClusterId, patch: Partial<UpgradePageState>): void;
}

export const useUpgradeStore = create<Store>()((set) => ({
  clusters: {},
  patch: (clusterId, patch) =>
    set((s) => ({ clusters: { ...s.clusters, [clusterId]: { ...(s.clusters[clusterId] ?? EMPTY), ...patch } } })),
}));

export function useUpgradeState(clusterId: ClusterId): UpgradePageState {
  return useUpgradeStore((s) => s.clusters[clusterId] ?? EMPTY);
}

const latest = new Map<ClusterId, number>();
let counter = 0;

/** Scans the cluster (read-only) and keeps the answer; a newer scan of the same cluster wins. */
export async function runScan(clusterId: ClusterId): Promise<void> {
  const id = ++counter;
  latest.set(clusterId, id);
  const { patch } = useUpgradeStore.getState();
  patch(clusterId, { loading: true, error: null });
  try {
    const scan = await api.upgrade.scan(clusterId, scanApis());
    if (latest.get(clusterId) !== id) return;
    patch(clusterId, { scan, loading: false, scannedAt: Date.now() });
  } catch (e) {
    if (latest.get(clusterId) !== id) return;
    patch(clusterId, { error: toApiError(e), loading: false });
  }
}

/** Forgets every cluster's page state (tests). */
export function resetUpgradeState(): void {
  latest.clear();
  useUpgradeStore.setState({ clusters: {} });
}
