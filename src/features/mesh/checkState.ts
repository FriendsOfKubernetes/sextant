// The form of the Istio request check (#155), kept per cluster while the app runs, and how other views open the page
// prefilled (a VirtualService's "Check a request…").
import { create } from "zustand";
import type { ClusterId } from "../../api";
import { useAppStore } from "../../app/store";
import { parseHeaderLines } from "../gateway-api/checkState";
import type { MeshRequestInput } from "./routing";

export const MESH_CHECK_PAGE = "istioRequestCheck";

export interface MeshForm {
  url: string;
  method: string;
  headers: string;
  from: "mesh" | "gateway";
  /** The caller's namespace (from the mesh). */
  namespace: string;
  /** The caller's labels, `key=value` separated by commas or new lines. */
  labels: string;
  /** `namespace/name` of an Istio Gateway. */
  gateway: string;
}

export const EMPTY_MESH_FORM: MeshForm = {
  url: "",
  method: "GET",
  headers: "",
  from: "mesh",
  namespace: "default",
  labels: "",
  gateway: "",
};

interface ClusterCheck {
  form: MeshForm;
  checked: MeshForm | null;
}

interface MeshCheckState {
  byCluster: Record<string, ClusterCheck>;
  patch: (clusterId: ClusterId, change: Partial<ClusterCheck>) => void;
}

export const useMeshCheckStore = create<MeshCheckState>()((set) => ({
  byCluster: {},
  patch: (clusterId, change) =>
    set((s) => ({
      byCluster: { ...s.byCluster, [clusterId]: { ...(s.byCluster[clusterId] ?? { form: EMPTY_MESH_FORM, checked: null }), ...change } },
    })),
}));

export function useMeshCheck(clusterId: ClusterId): ClusterCheck {
  return useMeshCheckStore((s) => s.byCluster[clusterId]) ?? { form: EMPTY_MESH_FORM, checked: null };
}

/** `key=value` pairs separated by commas or new lines; `bad` lists what could not be read. */
export function parseLabels(text: string): { labels: Record<string, string>; bad: string[] } {
  const labels: Record<string, string> = {};
  const bad: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    const key = eq > 0 ? item.slice(0, eq).trim() : "";
    if (!key) bad.push(item);
    else labels[key] = item.slice(eq + 1).trim();
  }
  return { labels, bad };
}

/** The engine's input for a form, and what of it could not be read. */
export function meshInputOf(form: MeshForm): { input: MeshRequestInput; badLines: number[]; badLabels: string[] } {
  const { headers, badLines } = parseHeaderLines(form.headers);
  const { labels, bad } = parseLabels(form.labels);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    input: {
      url: form.url,
      method: form.method,
      headers: lower,
      from: form.from === "gateway" ? { type: "gateway", gateway: form.gateway } : { type: "mesh", namespace: form.namespace.trim() || "default", labels },
    },
    badLines,
    badLabels: bad,
  };
}

/** Opens the request check with `form` filled in and checked. */
export function openMeshCheck(clusterId: ClusterId, prefill: Partial<MeshForm>): void {
  const form = { ...EMPTY_MESH_FORM, ...prefill };
  useMeshCheckStore.getState().patch(clusterId, { form, checked: form });
  const app = useAppStore.getState();
  app.closeDetails();
  app.setView(clusterId, MESH_CHECK_PAGE);
}

/** Forgets every cluster's form (tests). */
export function resetMeshChecks(): void {
  useMeshCheckStore.setState({ byCluster: {} });
}
