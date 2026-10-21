// State of the "Connectivity" page: the form of each cluster and the tab, kept while the app runs (a module store, not
// saved), and the way details panels open the page prefilled (`openConnectivity`).
import { create } from "zustand";
import type { ClusterId } from "../../api";
import { useAppStore } from "../../app/store";
import type { Protocol } from "./model";

/** `view` of the page in the app store (`registerPage`). */
export const CONNECTIVITY_PAGE = "networkConnectivity";

export type SourceType = "pod" | "labels" | "external";
export type DestinationType = "pod" | "service" | "external";
export type ConnectivityTab = "check" | "map" | "coverage";

export interface ConnectivityForm {
  sourceType: SourceType;
  sourceNamespace: string;
  sourcePod: string;
  sourceLabels: string;
  sourceIp: string;
  destinationType: DestinationType;
  destinationNamespace: string;
  destinationPod: string;
  service: string;
  /** Index in the Service's `spec.ports`, as text ("" = none chosen). */
  servicePort: string;
  /** A number, or a container port's name (pod destinations). */
  port: string;
  protocol: Protocol;
  destinationIp: string;
}

export interface ClusterConnectivity {
  form: ConnectivityForm;
  /** The form as last checked; no result before the first check. */
  checked: ConnectivityForm | null;
  tab: ConnectivityTab;
  /** The namespace the policy map shows. */
  mapNamespace: string;
}

export const EMPTY_FORM: ConnectivityForm = Object.freeze({
  sourceType: "pod",
  sourceNamespace: "",
  sourcePod: "",
  sourceLabels: "",
  sourceIp: "",
  destinationType: "pod",
  destinationNamespace: "",
  destinationPod: "",
  service: "",
  servicePort: "",
  port: "",
  protocol: "TCP",
  destinationIp: "",
}) as ConnectivityForm;

const EMPTY: ClusterConnectivity = Object.freeze({ form: EMPTY_FORM, checked: null, tab: "check", mapNamespace: "" }) as ClusterConnectivity;

interface ConnectivityState {
  clusters: Record<ClusterId, ClusterConnectivity>;
  patch(clusterId: ClusterId, patch: Partial<ClusterConnectivity>): void;
}

export const useConnectivityStore = create<ConnectivityState>()((set) => ({
  clusters: {},
  patch: (clusterId, patch) =>
    set((s) => ({ clusters: { ...s.clusters, [clusterId]: { ...(s.clusters[clusterId] ?? EMPTY), ...patch } } })),
}));

export function useClusterConnectivity(clusterId: ClusterId): ClusterConnectivity {
  return useConnectivityStore((s) => s.clusters[clusterId] ?? EMPTY);
}

/** Forgets every cluster's form (tests). */
export function resetConnectivity(): void {
  useConnectivityStore.setState({ clusters: {} });
}

export type ConnectivityPrefill =
  | { tab: "check"; form: Partial<ConnectivityForm> }
  | { tab: "map"; namespace: string };

/** Shows the page prefilled (and closes the details panel). A check prefill does not check yet. */
export function openConnectivity(clusterId: ClusterId, prefill: ConnectivityPrefill): void {
  const { patch } = useConnectivityStore.getState();
  const current = useConnectivityStore.getState().clusters[clusterId] ?? EMPTY;
  if (prefill.tab === "map") patch(clusterId, { tab: "map", mapNamespace: prefill.namespace });
  else patch(clusterId, { tab: "check", form: { ...current.form, ...prefill.form }, checked: null });
  const app = useAppStore.getState();
  app.closeDetails();
  app.setView(clusterId, CONNECTIVITY_PAGE);
}
