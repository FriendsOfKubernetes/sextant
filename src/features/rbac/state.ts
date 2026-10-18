// State of the Permissions page (`RbacPage.tsx`) per cluster, kept while the app runs (a module store, not saved):
// the open tab, the chosen subject and namespace, the reverse query and the "Can I" form. Details sections open the
// page on a subject with `openRbacPage`.
import { create } from "zustand";
import type { ClusterId } from "../../api";
import { useAppStore } from "../../app/store";
import type { Subject } from "./engine";

/** `view` of the page in the app store (`registerPage`). */
export const RBAC_PAGE = "rbacPermissions";

export type RbacTab = "subject" | "whoCan" | "canI";

export interface WhoCanForm {
  mode: "resource" | "url";
  verb: string;
  /** `pods`, `deployments.apps`, `*`. */
  resource: string;
  subresource: string;
  name: string;
  /** Empty for any namespace. */
  namespace: string;
  url: string;
}

export interface CanIForm {
  verb: string;
  resource: string;
  subresource: string;
  name: string;
  namespace: string;
}

export interface RbacPageState {
  tab: RbacTab;
  subject: Subject | null;
  /** Namespace of the subject's permissions; `null` = all namespaces. */
  namespace: string | null;
  search: string;
  whoCan: WhoCanForm;
  /** The form as last submitted; no answer before. */
  whoCanAsked: WhoCanForm | null;
  /** Namespace of the rules review ("Can I" tab). */
  reviewNamespace: string;
  canI: CanIForm;
}

export const EMPTY_WHO_CAN: WhoCanForm = Object.freeze({
  mode: "resource",
  verb: "get",
  resource: "",
  subresource: "",
  name: "",
  namespace: "",
  url: "",
}) as WhoCanForm;

export const EMPTY_CAN_I: CanIForm = Object.freeze({ verb: "get", resource: "", subresource: "", name: "", namespace: "" }) as CanIForm;

const EMPTY: RbacPageState = Object.freeze({
  tab: "subject",
  subject: null,
  namespace: null,
  search: "",
  whoCan: EMPTY_WHO_CAN,
  whoCanAsked: null,
  reviewNamespace: "default",
  canI: EMPTY_CAN_I,
}) as RbacPageState;

interface Store {
  clusters: Record<ClusterId, RbacPageState>;
  patch(clusterId: ClusterId, patch: Partial<RbacPageState>): void;
}

export const useRbacStore = create<Store>()((set) => ({
  clusters: {},
  patch: (clusterId, patch) =>
    set((s) => ({ clusters: { ...s.clusters, [clusterId]: { ...(s.clusters[clusterId] ?? EMPTY), ...patch } } })),
}));

export function useRbacPageState(clusterId: ClusterId): RbacPageState {
  return useRbacStore((s) => s.clusters[clusterId] ?? EMPTY);
}

/** Shows the page on `subject` (its permissions in `namespace`, `null` = all) and closes the details panel. */
export function openRbacPage(clusterId: ClusterId, subject: Subject, namespace: string | null = null): void {
  useRbacStore.getState().patch(clusterId, { tab: "subject", subject, namespace, search: "" });
  const app = useAppStore.getState();
  app.closeDetails();
  app.setView(clusterId, RBAC_PAGE);
}

/** Forgets every cluster's page state (tests). */
export function resetRbacPageState(): void {
  useRbacStore.setState({ clusters: {} });
}
