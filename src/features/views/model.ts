// Saved views, pins and workspaces (#149): what they are and how they change the settings. Pure functions over
// `AppSettings` plus the few calls that apply a view to the window. Everything lives in settings.json
// (`views`, `pins`, `workspaces`, `activeWorkspace`; written by the frontend, read leniently by the backend).
import { getSettingsSnapshot, type AppSettings, type ClusterId, type KindRef, type ObjectRef } from "../../api";
import type { CustomColumnSpec } from "../../api/generated/CustomColumnSpec";
import type { Pin } from "../../api/generated/Pin";
import type { SavedView } from "../../api/generated/SavedView";
import type { Workspace } from "../../api/generated/Workspace";
import { DEFAULT_TABLE_STATE, EMPTY_CLUSTER_VIEW, tableStateOf, useAppStore } from "../../app/store";
import { parseViewId, viewIdOf } from "../../resources";
import { selectNamespaces } from "../namespaces";
import { shownColumns } from "../custom-columns/model";

export type { Pin, SavedView, Workspace };

/** The backend's caps (`settings/views.rs`): more is left out when the file is read. */
export const MAX_VIEWS = 500;
export const MAX_PINS = 500;
export const MAX_WORKSPACES = 100;
export const MAX_NAME_CHARS = 120;

/** A new id for a view, pin or workspace (`[A-Za-z0-9_-]{1,64}`, what the backend accepts). */
export function newId(prefix: "v" | "p" | "w"): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}${Date.now().toString(36)}${random}`;
}

/** A name as stored: trimmed and at most `MAX_NAME_CHARS` characters; `null` when empty. */
export function cleanName(name: string): string | null {
  const trimmed = Array.from(name.trim()).slice(0, MAX_NAME_CHARS).join("");
  return trimmed ? trimmed : null;
}

/** The view id (sidebar entry) a saved view opens. */
export function viewIdOfSaved(view: Pick<SavedView, "group" | "kind">): string {
  return viewIdOf({ group: view.group, kind: view.kind });
}

/**
 * The open table of `clusterId` as a saved view: kind, namespaces, search, "Only problems", label selector, sort and
 * hidden columns. `null` while no kind table is open.
 */
export function captureView(
  clusterId: ClusterId,
  name: string,
  scope: "cluster" | "all",
  id: string = newId("v"),
): SavedView | null {
  const cv = useAppStore.getState().clusterViews[clusterId] ?? EMPTY_CLUSTER_VIEW;
  const kind = parseViewId(cv.view);
  const clean = cleanName(name);
  if (!kind || !cv.view || !clean) return null;
  const table = tableStateOf(cv, cv.view);
  return {
    id,
    name: clean,
    cluster: scope === "cluster" ? clusterId : null,
    group: kind.group,
    kind: kind.kind,
    namespaces: cv.namespaces && cv.namespaces.length > 0 ? [...cv.namespaces] : null,
    search: cv.search,
    onlyProblems: table.onlyProblems,
    labelSelector: table.labelSelector.trim(),
    sort: table.sort ? { ...table.sort } : null,
    hiddenColumns: [...table.hiddenColumns],
    ...viewColumnsOf(clusterId, kind, table.viewColumns),
  };
}

/**
 * The custom columns the table shows (#214: this cluster's, every cluster's and the open view's), as a saved view
 * carries them; nothing when there are none, so a view without them is written as before.
 */
function viewColumnsOf(
  clusterId: ClusterId,
  kind: { group: string; kind: string },
  viewColumns: readonly CustomColumnSpec[] | undefined,
): Pick<SavedView, "customColumns"> {
  const shown = shownColumns(getSettingsSnapshot(), clusterId, { group: kind.group, kind: kind.kind }, viewColumns);
  return shown.length > 0 ? { customColumns: shown.map((c) => ({ ...c.spec })) } : {};
}

/**
 * Puts `view` into `clusterId`'s view state: its kind, search and table, then its namespaces (saved as the cluster's
 * filter). Showing the cluster is the caller's (`openSavedView`).
 */
export async function applyView(clusterId: ClusterId, view: SavedView): Promise<void> {
  const app = useAppStore.getState();
  app.openTableView(clusterId, viewIdOfSaved(view), view.search, {
    ...DEFAULT_TABLE_STATE,
    onlyProblems: view.onlyProblems,
    labelSelector: view.labelSelector,
    sort: view.sort ? { ...view.sort } : null,
    hiddenColumns: [...view.hiddenColumns],
    ...(view.customColumns && view.customColumns.length > 0
      ? { viewColumns: view.customColumns.map((c) => ({ ...c })) }
      : {}),
  });
  await selectNamespaces(clusterId, view.namespaces);
}

// ---- workspaces ----

/** The active workspace, if the stored id names one. */
export function activeWorkspace(settings: AppSettings | null): Workspace | null {
  if (!settings?.activeWorkspace) return null;
  return settings.workspaces.find((w) => w.id === settings.activeWorkspace) ?? null;
}

/**
 * Whether the rail shows `clusterId`: every cluster without an active workspace, otherwise the workspace's clusters
 * (and the active cluster, so the one in use never disappears; it stays connected either way).
 */
export function inWorkspace(settings: AppSettings | null, clusterId: ClusterId, activeClusterId?: ClusterId | null): boolean {
  const workspace = activeWorkspace(settings);
  if (!workspace) return true;
  return clusterId === activeClusterId || workspace.clusters.includes(clusterId);
}

/** Clusters the rail shows, in their order. */
export function workspaceClusters<T extends { id: ClusterId }>(
  clusters: T[],
  settings: AppSettings | null,
  activeClusterId: ClusterId | null,
): T[] {
  if (!activeWorkspace(settings)) return clusters;
  return clusters.filter((c) => inWorkspace(settings, c.id, activeClusterId));
}

/** Views offered in `clusterId`: its own and those for every cluster, in the user's order. */
export function viewsFor(settings: AppSettings | null, clusterId: ClusterId): SavedView[] {
  return (settings?.views ?? []).filter((v) => v.cluster === null || v.cluster === clusterId);
}

/** Pins on the strip of `clusterId`, in the user's order (a pin of a view that is gone is skipped). */
export function pinsFor(settings: AppSettings | null, clusterId: ClusterId): Pin[] {
  const views = new Set((settings?.views ?? []).map((v) => v.id));
  return (settings?.pins ?? []).filter(
    (p) => p.cluster === clusterId && (p.target.type === "object" || views.has(p.target.view)),
  );
}

// ---- changes (each returns the next settings) ----

export function withView(settings: AppSettings, view: SavedView): AppSettings {
  const index = settings.views.findIndex((v) => v.id === view.id);
  if (index >= 0) return { ...settings, views: settings.views.map((v, i) => (i === index ? view : v)) };
  if (settings.views.length >= MAX_VIEWS) return settings;
  return { ...settings, views: [...settings.views, view] };
}

export function renameView(settings: AppSettings, id: string, name: string): AppSettings {
  const clean = cleanName(name);
  if (!clean) return settings;
  return { ...settings, views: settings.views.map((v) => (v.id === id ? { ...v, name: clean } : v)) };
}

/** Moves a view one place up (`-1`) or down (`1`) in the whole list. */
export function moveView(settings: AppSettings, id: string, by: -1 | 1): AppSettings {
  const views = [...settings.views];
  const index = views.findIndex((v) => v.id === id);
  const target = index + by;
  if (index < 0 || target < 0 || target >= views.length) return settings;
  const [moved] = views.splice(index, 1);
  views.splice(target, 0, moved!);
  return { ...settings, views };
}

/** Deletes a view and the pins of it. */
export function deleteView(settings: AppSettings, id: string): AppSettings {
  return {
    ...settings,
    views: settings.views.filter((v) => v.id !== id),
    pins: settings.pins.filter((p) => !(p.target.type === "view" && p.target.view === id)),
  };
}

export function objectPinOf(clusterId: ClusterId, ref: ObjectRef): Pin {
  return {
    id: newId("p"),
    cluster: clusterId,
    target: {
      type: "object",
      group: ref.kind.group,
      version: ref.kind.version,
      kind: ref.kind.kind,
      namespace: ref.namespace ?? null,
      name: ref.name,
    },
  };
}

function samePin(a: Pin, b: Pin): boolean {
  if (a.cluster !== b.cluster || a.target.type !== b.target.type) return false;
  if (a.target.type === "view" && b.target.type === "view") return a.target.view === b.target.view;
  if (a.target.type === "object" && b.target.type === "object")
    return (
      a.target.group === b.target.group &&
      a.target.kind === b.target.kind &&
      a.target.namespace === b.target.namespace &&
      a.target.name === b.target.name
    );
  return false;
}

export function isPinned(settings: AppSettings | null, pin: Pin): boolean {
  return (settings?.pins ?? []).some((p) => samePin(p, pin));
}

/** Pins `pin`, or unpins it when an equal pin is already there. */
export function togglePin(settings: AppSettings, pin: Pin): AppSettings {
  if (isPinned(settings, pin)) return { ...settings, pins: settings.pins.filter((p) => !samePin(p, pin)) };
  if (settings.pins.length >= MAX_PINS) return settings;
  return { ...settings, pins: [...settings.pins, pin] };
}

export function unpin(settings: AppSettings, id: string): AppSettings {
  return { ...settings, pins: settings.pins.filter((p) => p.id !== id) };
}

export function withWorkspace(settings: AppSettings, workspace: Workspace): AppSettings {
  const index = settings.workspaces.findIndex((w) => w.id === workspace.id);
  if (index >= 0)
    return { ...settings, workspaces: settings.workspaces.map((w, i) => (i === index ? workspace : w)) };
  if (settings.workspaces.length >= MAX_WORKSPACES) return settings;
  return { ...settings, workspaces: [...settings.workspaces, workspace] };
}

export function deleteWorkspace(settings: AppSettings, id: string): AppSettings {
  return {
    ...settings,
    workspaces: settings.workspaces.filter((w) => w.id !== id),
    activeWorkspace: settings.activeWorkspace === id ? null : settings.activeWorkspace,
  };
}

/** Switches the rail to a workspace (`null`: every cluster). Never connects or disconnects anything. */
export function switchWorkspace(settings: AppSettings, id: string | null): AppSettings {
  return { ...settings, activeWorkspace: id && settings.workspaces.some((w) => w.id === id) ? id : null };
}

/** The `ObjectRef` a pinned object opens. */
export function refOfPin(pin: Pin): ObjectRef | null {
  if (pin.target.type !== "object") return null;
  const kind: KindRef = { group: pin.target.group, version: pin.target.version, kind: pin.target.kind };
  return { kind, namespace: pin.target.namespace, name: pin.target.name };
}
