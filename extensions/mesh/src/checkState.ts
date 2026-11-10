// The form of the Istio request check (#155), and how a VirtualService's "Check a request…" opens the page prefilled.
// As the built-in kept it per cluster in the window's memory while Sextant ran, it is kept per cluster in the
// extension's session storage (`storage` with `session: true`): in memory for this run only, never written to disk —
// the headers too, which may carry credentials.
import type { JsonValue, Sextant } from "@sextant/extension-sdk";
import type { MeshRequestInput } from "./engine/routing";

export const MESH_CHECK_PAGE = "request-check";

/** The HTTP methods of the form, as Sextant's Gateway API request check offers them. */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

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

export interface ClusterCheck {
  form: MeshForm;
  checked: MeshForm | null;
}

const storageKey = (clusterId: string) => `check:${clusterId}`;

/** A kept form, read leniently (anything unexpected gives the empty form's value). */
function formOf(value: unknown): MeshForm | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (key: keyof MeshForm) => (typeof v[key] === "string" ? (v[key] as string) : EMPTY_MESH_FORM[key]);
  return {
    url: text("url"),
    method: text("method"),
    headers: text("headers"),
    from: v.from === "gateway" ? "gateway" : "mesh",
    namespace: text("namespace"),
    labels: text("labels"),
    gateway: text("gateway"),
  };
}

const stored = (form: MeshForm): JsonValue => ({
  url: form.url,
  method: form.method,
  headers: form.headers,
  from: form.from,
  namespace: form.namespace,
  labels: form.labels,
  gateway: form.gateway,
});

/** The cluster's form and the one last checked, as stored; the empty form without one. */
export async function loadCheck(sextant: Sextant, clusterId: string): Promise<ClusterCheck> {
  try {
    const value = (await sextant.storage.get(storageKey(clusterId), { session: true })) as unknown;
    const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return { form: formOf(v.form) ?? EMPTY_MESH_FORM, checked: formOf(v.checked) };
  } catch {
    return { form: EMPTY_MESH_FORM, checked: null };
  }
}

export async function saveCheck(sextant: Sextant, clusterId: string, check: ClusterCheck): Promise<void> {
  await sextant.storage.set(storageKey(clusterId), { form: stored(check.form), checked: check.checked ? stored(check.checked) : null }, { session: true });
}

/** Opens the request check with `form` filled in and checked, closing the details panel as the built-in did. */
export async function openMeshCheck(sextant: Sextant, prefill: Partial<MeshForm>): Promise<void> {
  const clusterId = sextant.context.clusterId;
  if (!clusterId) return;
  const form = { ...EMPTY_MESH_FORM, ...prefill };
  await saveCheck(sextant, clusterId, { form, checked: form }).catch(() => undefined);
  await sextant.ui.navigate(MESH_CHECK_PAGE, { closeDetails: true }).catch(() => undefined);
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

/** `name: value` lines (blank lines skipped; a later line with the same name wins), as Sextant's request check. */
export function parseHeaderLines(text: string): { headers: Record<string, string>; badLines: number[] } {
  const headers: Record<string, string> = {};
  const badLines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!name || /\s/.test(name)) {
      badLines.push(i + 1);
      return;
    }
    headers[name] = line.slice(colon + 1).trim();
  });
  return { headers, badLines };
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
