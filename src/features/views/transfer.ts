// Export and import of views, pins, workspaces and shareable cluster settings (#149).
//
// The file names clusters by reference only — the kubeconfig source's kind and path and the context name — never a
// file's contents, credentials, tokens, the MCP token, extensions or their grants. Cluster settings are limited to
// the shareable ones (display name, colour, icon, namespace filter, "Preview changes") plus, only when the user
// ticks it, the agent access rules. An import is parsed strictly (an unknown field is an error naming it), previewed
// section by section (added / changed / kept / skipped or missing) and applied only after the user confirms; a
// changed entry replaces the local one only when the user also allows overwriting.
import type { AppSettings, ClusterId, ClusterInfo, ClusterSettings, KubeconfigSource } from "../../api";
import type { ClusterAccess } from "../../api/generated/ClusterAccess";
import type { ClusterIcon } from "../../api/generated/ClusterIcon";
import type { SourceKind } from "../../api/generated/SourceKind";
import { clusterSettingsOf } from "../clusters/clusterSettings";
import {
  MAX_PINS,
  MAX_VIEWS,
  MAX_WORKSPACES,
  cleanName,
  isPinned,
  type Pin,
  type SavedView,
  type Workspace,
} from "./model";

export const EXPORT_FORMAT = "sextant-workspace";
export const EXPORT_VERSION = 1;

/** The cluster settings an export may carry. */
export interface SharedClusterSettings {
  displayName: string | null;
  color: string | null;
  icon: ClusterIcon | null;
  namespaces: string[] | null;
  previewChanges: boolean | null;
  /** Only when "Include agent access rules" was ticked. */
  agentAccess?: ClusterAccess;
}

export interface ExportedCluster {
  /** The exporting machine's `ClusterId` (the same on a machine with the same path and context). */
  id: string;
  context: string;
  source: { kind: SourceKind; path: string };
  settings: SharedClusterSettings;
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  clusters: ExportedCluster[];
  views: SavedView[];
  pins: Pin[];
  workspaces: Workspace[];
}

export interface ExportOptions {
  includeAgentAccess: boolean;
}

function sharedSettings(settings: ClusterSettings, includeAgentAccess: boolean): SharedClusterSettings {
  const shared: SharedClusterSettings = {
    displayName: settings.displayName ?? null,
    color: settings.color ?? null,
    icon: settings.icon ?? null,
    namespaces: settings.namespaces ?? null,
    previewChanges: settings.previewChanges ?? null,
  };
  if (includeAgentAccess) shared.agentAccess = { preset: settings.agentAccess.preset, rules: settings.agentAccess.rules };
  return shared;
}

/** The export of `settings`: every known cluster by reference, with its shareable settings, and all views, pins, workspaces. */
export function buildExport(
  settings: AppSettings,
  clusters: ClusterInfo[],
  sources: KubeconfigSource[],
  options: ExportOptions,
): ExportFile {
  const exported: ExportedCluster[] = [];
  for (const cluster of clusters) {
    const source = sources.find((s) => s.id === cluster.sourceId);
    if (!source) continue;
    exported.push({
      id: cluster.id,
      context: cluster.context,
      source: { kind: source.kind, path: source.path },
      settings: sharedSettings(clusterSettingsOf(settings, cluster.id), options.includeAgentAccess),
    });
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    clusters: exported,
    views: settings.views.map((v) => ({ ...v })),
    pins: settings.pins.map((p) => ({ ...p })),
    workspaces: settings.workspaces.map((w) => ({ ...w })),
  };
}

export function exportText(file: ExportFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---- strict parsing ----

export class ImportError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
  }
}

type Json = unknown;

class Reader {
  readonly problems: string[] = [];

  object(value: Json, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, Json> | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.problems.push(`${path}: not an object`);
      return null;
    }
    const record = value as Record<string, Json>;
    const known = new Set([...required, ...optional]);
    for (const key of Object.keys(record)) if (!known.has(key)) this.problems.push(`${path}.${key}: unknown field`);
    for (const key of required) if (!(key in record)) this.problems.push(`${path}.${key}: missing`);
    return record;
  }

  string(value: Json, path: string, { empty = true, max = 4096 } = {}): string {
    if (typeof value !== "string") {
      this.problems.push(`${path}: not a string`);
      return "";
    }
    if (!empty && !value.trim()) this.problems.push(`${path}: empty`);
    if (Array.from(value).length > max) this.problems.push(`${path}: longer than ${max} characters`);
    return value;
  }

  nullableString(value: Json, path: string, max = 4096): string | null {
    return value === null ? null : this.string(value, path, { max });
  }

  boolean(value: Json, path: string): boolean {
    if (typeof value !== "boolean") this.problems.push(`${path}: not true or false`);
    return value === true;
  }

  id(value: Json, path: string): string {
    const id = this.string(value, path);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) this.problems.push(`${path}: not a valid id`);
    return id;
  }

  array(value: Json, path: string, max: number): Json[] {
    if (!Array.isArray(value)) {
      this.problems.push(`${path}: not a list`);
      return [];
    }
    if (value.length > max) this.problems.push(`${path}: more than ${max} entries`);
    return value.slice(0, max);
  }

  strings(value: Json, path: string, max: number): string[] {
    return this.array(value, path, max).map((v, i) => this.string(v, `${path}[${i}]`, { max: 253 }));
  }
}

function readView(r: Reader, value: Json, path: string): SavedView | null {
  const o = r.object(
    value,
    path,
    ["id", "name", "cluster", "group", "kind", "namespaces", "search", "onlyProblems", "labelSelector", "sort", "hiddenColumns"],
  );
  if (!o) return null;
  let sort: SavedView["sort"] = null;
  if (o.sort !== null && o.sort !== undefined) {
    const s = r.object(o.sort, `${path}.sort`, ["column", "desc"]);
    if (s) sort = { column: r.string(s.column, `${path}.sort.column`, { empty: false, max: 253 }), desc: r.boolean(s.desc, `${path}.sort.desc`) };
  }
  const name = r.string(o.name, `${path}.name`, { empty: false, max: 120 });
  return {
    id: r.id(o.id, `${path}.id`),
    name: cleanName(name) ?? name,
    cluster: r.nullableString(o.cluster, `${path}.cluster`, 128),
    group: r.string(o.group, `${path}.group`, { max: 253 }),
    kind: r.string(o.kind, `${path}.kind`, { empty: false, max: 253 }),
    namespaces: o.namespaces === null ? null : r.strings(o.namespaces, `${path}.namespaces`, 1000),
    search: r.string(o.search, `${path}.search`, { max: 1000 }),
    onlyProblems: r.boolean(o.onlyProblems, `${path}.onlyProblems`),
    labelSelector: r.string(o.labelSelector, `${path}.labelSelector`, { max: 1000 }),
    sort,
    hiddenColumns: r.strings(o.hiddenColumns, `${path}.hiddenColumns`, 200),
  };
}

function readPin(r: Reader, value: Json, path: string): Pin | null {
  const o = r.object(value, path, ["id", "cluster", "target"]);
  if (!o) return null;
  const id = r.id(o.id, `${path}.id`);
  const cluster = r.string(o.cluster, `${path}.cluster`, { empty: false, max: 128 });
  const type = (o.target as { type?: unknown } | null)?.type;
  if (type === "view") {
    const t = r.object(o.target, `${path}.target`, ["type", "view"]);
    if (!t) return null;
    return { id, cluster, target: { type: "view", view: r.id(t.view, `${path}.target.view`) } };
  }
  if (type === "object") {
    const t = r.object(o.target, `${path}.target`, ["type", "group", "version", "kind", "namespace", "name"]);
    if (!t) return null;
    return {
      id,
      cluster,
      target: {
        type: "object",
        group: r.string(t.group, `${path}.target.group`, { max: 253 }),
        version: r.string(t.version, `${path}.target.version`, { max: 63 }),
        kind: r.string(t.kind, `${path}.target.kind`, { empty: false, max: 253 }),
        namespace: r.nullableString(t.namespace, `${path}.target.namespace`, 253),
        name: r.string(t.name, `${path}.target.name`, { empty: false, max: 253 }),
      },
    };
  }
  r.problems.push(`${path}.target.type: not "object" or "view"`);
  return null;
}

function readWorkspace(r: Reader, value: Json, path: string): Workspace | null {
  const o = r.object(value, path, ["id", "name", "clusters"]);
  if (!o) return null;
  const name = r.string(o.name, `${path}.name`, { empty: false, max: 120 });
  return {
    id: r.id(o.id, `${path}.id`),
    name: cleanName(name) ?? name,
    clusters: r.strings(o.clusters, `${path}.clusters`, 1000),
  };
}

function readIcon(r: Reader, value: Json, path: string): ClusterIcon | null {
  if (value === null) return null;
  const type = (value as { type?: unknown } | null)?.type;
  if (type === "text") {
    const o = r.object(value, path, ["type", "text"]);
    return o ? { type: "text", text: r.string(o.text, `${path}.text`, { empty: false, max: 16 }) } : null;
  }
  if (type === "image") {
    const o = r.object(value, path, ["type", "dataUrl"]);
    if (!o) return null;
    const dataUrl = r.string(o.dataUrl, `${path}.dataUrl`, { max: 200_000 });
    if (!dataUrl.startsWith("data:image/png;base64,")) r.problems.push(`${path}.dataUrl: not a PNG data URL`);
    return { type: "image", dataUrl };
  }
  r.problems.push(`${path}.type: not "text" or "image"`);
  return null;
}

function readAccess(r: Reader, value: Json, path: string): ClusterAccess | undefined {
  // The rules are kept as written: the backend reads them strictly (ADR-0041), so a shape it does not know turns the
  // access Off rather than open.
  const o = r.object(value, path, ["preset", "rules"]);
  if (!o) return undefined;
  const preset = r.string(o.preset, `${path}.preset`) as ClusterAccess["preset"];
  if (!["off", "readOnly", "readWrite", "full", "custom"].includes(preset)) r.problems.push(`${path}.preset: unknown preset`);
  const rules = r.array(o.rules, `${path}.rules`, 200) as ClusterAccess["rules"];
  return { preset, rules };
}

function readCluster(r: Reader, value: Json, path: string): ExportedCluster | null {
  const o = r.object(value, path, ["id", "context", "source", "settings"]);
  if (!o) return null;
  const src = r.object(o.source, `${path}.source`, ["kind", "path"]);
  // Only a reference: the kind is shown, never used to read anything, so a kind of a newer Sextant is accepted.
  const kind = src ? (r.string(src.kind, `${path}.source.kind`, { empty: false, max: 32 }) as SourceKind) : "addedFile";
  const s = r.object(
    o.settings,
    `${path}.settings`,
    ["displayName", "color", "icon", "namespaces", "previewChanges"],
    ["agentAccess"],
  );
  const settings: SharedClusterSettings = {
    displayName: s ? r.nullableString(s.displayName, `${path}.settings.displayName`, 120) : null,
    color: s ? r.nullableString(s.color, `${path}.settings.color`, 32) : null,
    icon: s ? readIcon(r, s.icon, `${path}.settings.icon`) : null,
    namespaces: s && s.namespaces !== null ? r.strings(s.namespaces, `${path}.settings.namespaces`, 1000) : null,
    previewChanges: s && s.previewChanges !== null ? r.boolean(s.previewChanges, `${path}.settings.previewChanges`) : null,
  };
  if (s && "agentAccess" in s) settings.agentAccess = readAccess(r, s.agentAccess, `${path}.settings.agentAccess`);
  return {
    id: r.string(o.id, `${path}.id`, { empty: false, max: 128 }),
    context: r.string(o.context, `${path}.context`, { empty: false, max: 253 }),
    source: { kind, path: src ? r.string(src.path, `${path}.source.path`, { max: 4096 }) : "" },
    settings,
  };
}

/** Parses an export file strictly; throws `ImportError` listing every problem (unknown fields included). */
export function parseImport(text: string): ExportFile {
  let json: Json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ImportError(["the file is not JSON"]);
  }
  const r = new Reader();
  const o = r.object(json, "$", ["format", "version", "clusters", "views", "pins", "workspaces"]);
  if (!o) throw new ImportError(r.problems);
  if (o.format !== EXPORT_FORMAT) throw new ImportError([`$.format: not "${EXPORT_FORMAT}"`]);
  if (o.version !== EXPORT_VERSION) throw new ImportError([`$.version: ${String(o.version)} is not supported`]);
  const file: ExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    clusters: r.array(o.clusters, "$.clusters", 1000).flatMap((c, i) => readCluster(r, c, `$.clusters[${i}]`) ?? []),
    views: r.array(o.views, "$.views", MAX_VIEWS).flatMap((v, i) => readView(r, v, `$.views[${i}]`) ?? []),
    pins: r.array(o.pins, "$.pins", MAX_PINS).flatMap((p, i) => readPin(r, p, `$.pins[${i}]`) ?? []),
    workspaces: r
      .array(o.workspaces, "$.workspaces", MAX_WORKSPACES)
      .flatMap((w, i) => readWorkspace(r, w, `$.workspaces[${i}]`) ?? []),
  };
  if (r.problems.length > 0) throw new ImportError(r.problems.slice(0, 50));
  return file;
}

// ---- preview ----

export type EntryStatus = "added" | "changed" | "kept" | "skipped";

export interface PlannedEntry<T> {
  status: EntryStatus;
  /** What would be stored (cluster ids already mapped to this machine). */
  entry: T;
  /** The name shown in the preview. */
  label: string;
}

export type SharedField = keyof SharedClusterSettings;

export interface PlannedCluster {
  /** The exporting machine's id. */
  exportedId: string;
  context: string;
  sourcePath: string;
  /** This machine's cluster, `null` when it has none (listed as missing, never created). */
  localId: ClusterId | null;
  /**
   * How `localId` was found: `exact` — the same id, or the same kubeconfig path and context; `name` — only the
   * context name is the same (the only local cluster with it), so it may be an unrelated cluster: agent access rules
   * are never applied to it. `null` when there is no local cluster.
   */
  match: ClusterMatch | null;
  /** The file's agent access rules are left out because the cluster matched by name only. */
  agentAccessSkipped: boolean;
  /** Fields the file sets on an empty local value (applied on confirmation). */
  added: SharedField[];
  /** Fields the file sets to another value than the local one (applied only when overwriting is allowed). */
  changed: SharedField[];
  incoming: SharedClusterSettings;
}

export type ClusterMatch = "exact" | "name";

export interface ImportPlan {
  clusters: PlannedCluster[];
  views: PlannedEntry<SavedView>[];
  pins: PlannedEntry<Pin>[];
  workspaces: PlannedEntry<Workspace>[];
  /** Whether the file carries agent access rules that would change a cluster matched exactly (applied only when the
   *  user ticks it). */
  hasAgentAccess: boolean;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isEmptyValue(field: SharedField, value: unknown): boolean {
  if (field === "agentAccess") {
    const access = value as ClusterAccess | undefined;
    return !access || (access.preset === "off" && access.rules.length === 0);
  }
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

/**
 * This machine's cluster for an exported one: the same id or the same source path and context (`exact`), else the
 * only cluster with that context name (`name`, which may be an unrelated cluster).
 */
function matchCluster(
  exported: ExportedCluster,
  clusters: ClusterInfo[],
  sources: KubeconfigSource[],
): { cluster: ClusterInfo; match: ClusterMatch } | null {
  const byId = clusters.find((c) => c.id === exported.id);
  if (byId) return { cluster: byId, match: "exact" };
  const byPath = clusters.find(
    (c) => c.context === exported.context && sources.find((s) => s.id === c.sourceId)?.path === exported.source.path,
  );
  if (byPath) return { cluster: byPath, match: "exact" };
  const byContext = clusters.filter((c) => c.context === exported.context);
  return byContext.length === 1 ? { cluster: byContext[0]!, match: "name" } : null;
}

/** What importing `file` would do to `settings`, section by section. Nothing is changed. */
export function planImport(
  file: ExportFile,
  settings: AppSettings,
  clusters: ClusterInfo[],
  sources: KubeconfigSource[],
): ImportPlan {
  const idMap = new Map<string, ClusterId>();
  const plannedClusters: PlannedCluster[] = file.clusters.map((exported) => {
    const matched = matchCluster(exported, clusters, sources);
    const local = matched?.cluster ?? null;
    if (local) idMap.set(exported.id, local.id);
    const added: SharedField[] = [];
    const changed: SharedField[] = [];
    let agentAccessSkipped = false;
    if (local) {
      const current = clusterSettingsOf(settings, local.id);
      const currentShared = sharedSettings(current, true);
      for (const field of Object.keys(exported.settings) as SharedField[]) {
        const incoming = exported.settings[field];
        if (incoming === undefined || isEmptyValue(field, incoming)) continue;
        // Agent access goes only to the very cluster it was exported from, never to one that shares a name.
        if (field === "agentAccess" && matched?.match !== "exact") {
          agentAccessSkipped = true;
          continue;
        }
        const now = currentShared[field];
        if (same(now, incoming)) continue;
        // Any agent access here, Off included, is a choice: replacing it is a change (it needs overwriting).
        if (field !== "agentAccess" && isEmptyValue(field, now)) added.push(field);
        else changed.push(field);
      }
    }
    return {
      exportedId: exported.id,
      context: exported.context,
      sourcePath: exported.source.path,
      localId: local?.id ?? null,
      match: matched?.match ?? null,
      agentAccessSkipped,
      added,
      changed,
      incoming: exported.settings,
    };
  });
  // A cluster id the file has no entry for is taken as this machine's id when it is one.
  const mapCluster = (id: string): ClusterId | null =>
    idMap.get(id) ?? (clusters.some((c) => c.id === id) ? id : null);

  const views: PlannedEntry<SavedView>[] = file.views.map((view) => {
    const cluster = view.cluster === null ? null : mapCluster(view.cluster);
    const entry = { ...view, cluster };
    if (view.cluster !== null && cluster === null) return { status: "skipped", entry, label: view.name };
    const local = settings.views.find((v) => v.id === view.id);
    const status: EntryStatus = !local ? "added" : same(local, entry) ? "kept" : "changed";
    return { status, entry, label: view.name };
  });
  const viewIds = new Set([
    ...settings.views.map((v) => v.id),
    ...views.filter((v) => v.status !== "skipped").map((v) => v.entry.id),
  ]);
  const viewNames = new Map([...settings.views, ...file.views].map((v) => [v.id, v.name]));

  const pins: PlannedEntry<Pin>[] = file.pins.map((pin) => {
    const cluster = mapCluster(pin.cluster);
    const entry = { ...pin, cluster: cluster ?? pin.cluster };
    const label =
      pin.target.type === "object"
        ? `${pin.target.kind} ${pin.target.namespace ? `${pin.target.namespace}/` : ""}${pin.target.name}`
        : (viewNames.get(pin.target.view) ?? pin.target.view);
    if (!cluster || (pin.target.type === "view" && !viewIds.has(pin.target.view)))
      return { status: "skipped", entry, label };
    return { status: isPinned(settings, entry) ? "kept" : "added", entry, label };
  });

  const workspaces: PlannedEntry<Workspace>[] = file.workspaces.map((workspace) => {
    const mapped = workspace.clusters.map(mapCluster).filter((id): id is ClusterId => id !== null);
    const entry = { ...workspace, clusters: [...new Set(mapped)] };
    const local = settings.workspaces.find((w) => w.id === workspace.id);
    const status: EntryStatus = !local ? "added" : same(local, entry) ? "kept" : "changed";
    return { status, entry, label: workspace.name };
  });

  return {
    clusters: plannedClusters,
    views,
    pins,
    workspaces,
    hasAgentAccess: plannedClusters.some((c) => c.added.includes("agentAccess") || c.changed.includes("agentAccess")),
  };
}

export interface ApplyOptions {
  /** Replace changed entries and changed cluster settings; otherwise the local ones stay. */
  overwrite: boolean;
  /** Apply the agent access rules the file carries. */
  agentAccess: boolean;
}

/** `settings` with the plan applied (only what the preview listed; nothing for missing clusters). */
export function applyImport(settings: AppSettings, plan: ImportPlan, options: ApplyOptions): AppSettings {
  const clustersNext = { ...settings.clusters };
  for (const planned of plan.clusters) {
    if (!planned.localId) continue;
    const fields = [...planned.added, ...(options.overwrite ? planned.changed : [])].filter(
      (f) => f !== "agentAccess" || (options.agentAccess && planned.match === "exact"),
    );
    if (fields.length === 0) continue;
    const current: ClusterSettings = clusterSettingsOf(settings, planned.localId);
    const patch: Partial<ClusterSettings> = {};
    for (const field of fields) {
      const value = planned.incoming[field];
      if (field === "agentAccess") {
        if (value) {
          patch.agentAccess = value as ClusterAccess;
          // A chosen access replaces one this version could not read.
          delete (current as Partial<ClusterSettings>).agentAccessUnrecognised;
        }
      } else (patch as Record<string, unknown>)[field] = value;
    }
    clustersNext[planned.localId] = { ...current, ...patch };
  }

  let views = [...settings.views];
  for (const p of plan.views) {
    if (p.status === "added" && views.length < MAX_VIEWS) views.push(p.entry);
    else if (p.status === "changed" && options.overwrite) views = views.map((v) => (v.id === p.entry.id ? p.entry : v));
  }
  const pins = [...settings.pins];
  for (const p of plan.pins) {
    if (p.status !== "added" || pins.length >= MAX_PINS) continue;
    // A pin id already used here (another pin) gets the file's pin under a new id.
    const entry = pins.some((x) => x.id === p.entry.id) ? { ...p.entry, id: `${p.entry.id.slice(0, 56)}i${pins.length}` } : p.entry;
    pins.push(entry);
  }
  let workspaces = [...settings.workspaces];
  for (const p of plan.workspaces) {
    if (p.status === "added" && workspaces.length < MAX_WORKSPACES) workspaces.push(p.entry);
    else if (p.status === "changed" && options.overwrite)
      workspaces = workspaces.map((w) => (w.id === p.entry.id ? p.entry : w));
  }
  return { ...settings, clusters: clustersNext, views, pins, workspaces };
}

/** How many entries of the plan would change something with these options. */
export function countChanges(plan: ImportPlan, options: ApplyOptions): number {
  const entries = [...plan.views, ...plan.pins, ...plan.workspaces];
  const fromEntries = entries.filter((e) => e.status === "added" || (e.status === "changed" && options.overwrite)).length;
  const fromClusters = plan.clusters.filter((c) =>
    [...c.added, ...(options.overwrite ? c.changed : [])].some(
      (f) => f !== "agentAccess" || (options.agentAccess && c.match === "exact"),
    ),
  ).length;
  return fromEntries + fromClusters;
}
