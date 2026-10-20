// Custom columns (#214) in the settings: which columns a table shows and how the list changes. The list is
// `AppSettings.customColumns` (frontend-written, read leniently with the same caps by the backend); a saved view
// carries the columns its table showed (`SavedView.customColumns`), shown as the table's "view columns" while the
// view's table state lasts (`TableState.viewColumns`).
import { useMemo, useSyncExternalStore } from "react";
import { getSettingsSnapshot, subscribeSettings, type AppSettings, type ClusterId, type KubeObject } from "../../api";
import type { CustomColumn } from "../../api/generated/CustomColumn";
import type { ColumnDef } from "../../resources/registry";
import {
  cellValue,
  columnIdOf,
  isAllowedSpec,
  parseFieldPath,
  readColumn,
  type CustomColumnSpec,
  type SpecTarget,
} from "./path";

export type { CustomColumn };

/** Most custom columns in all (Rust `MAX_CUSTOM_COLUMNS`). */
export const MAX_CUSTOM_COLUMNS = 1000;
/** Most custom columns of one kind in one scope (Rust `MAX_COLUMNS_PER_KIND`). */
export const MAX_COLUMNS_PER_KIND = 20;

export interface KindName {
  group: string;
  kind: string;
}

/** Where a shown column comes from: this cluster's list, the list of every cluster, or the open saved view. */
export type ColumnScope = "cluster" | "all" | "view";

export interface ShownColumn {
  id: string;
  spec: CustomColumnSpec;
  scope: ColumnScope;
}

function specOf(c: CustomColumn): CustomColumnSpec {
  return { source: c.source, path: c.path, title: c.title };
}

function sameTable(c: CustomColumn, cluster: string | null, kind: KindName): boolean {
  return c.cluster === cluster && c.group === kind.group && c.kind === kind.kind;
}

/**
 * The custom columns of `kind`'s table in `clusterId`, in the order they were added: this cluster's and every
 * cluster's (one of a cluster wins over the same column for every cluster), then the view's columns not among them.
 * Columns the rules do not allow on this kind (a hand-edited file) are left out.
 */
export function shownColumns(
  settings: AppSettings | null,
  clusterId: ClusterId,
  target: SpecTarget,
  viewColumns: readonly CustomColumnSpec[] = [],
): ShownColumn[] {
  const out: ShownColumn[] = [];
  const index = new Map<string, number>();
  const add = (spec: CustomColumnSpec, scope: ColumnScope) => {
    if (!isAllowedSpec(target, spec)) return;
    const id = columnIdOf(spec.source, spec.path);
    const at = index.get(id);
    if (at === undefined) {
      index.set(id, out.length);
      out.push({ id, spec, scope });
    } else if (scope === "cluster" && out[at]!.scope === "all") out[at] = { id, spec, scope };
  };
  for (const c of settings?.customColumns ?? []) {
    if (c.group !== target.group || c.kind !== target.kind) continue;
    if (c.cluster === clusterId) add(specOf(c), "cluster");
    else if (c.cluster === null) add(specOf(c), "all");
  }
  for (const spec of viewColumns) add(spec, "view");
  return out;
}

/** Why a column cannot be stored: the kind has {@link MAX_COLUMNS_PER_KIND} already, or it is there already. */
export type AddProblem = "full" | "duplicate" | "tooMany";

/** `settings` with `spec` added for `kind` in `cluster` (`null` = every cluster), or why not. */
export function withColumn(
  settings: AppSettings,
  cluster: ClusterId | null,
  kind: KindName,
  spec: CustomColumnSpec,
): AppSettings | { problem: AddProblem } {
  const list = settings.customColumns ?? [];
  const table = list.filter((c) => sameTable(c, cluster, kind));
  if (table.some((c) => c.source === spec.source && c.path === spec.path)) return { problem: "duplicate" };
  if (table.length >= MAX_COLUMNS_PER_KIND) return { problem: "full" };
  if (list.length >= MAX_CUSTOM_COLUMNS) return { problem: "tooMany" };
  const column: CustomColumn = { cluster, group: kind.group, kind: kind.kind, ...spec };
  return { ...settings, customColumns: [...list, column] };
}

/** `settings` without the column `id` of `kind` in `cluster` (`null` = the one for every cluster). */
export function withoutColumn(settings: AppSettings, cluster: ClusterId | null, kind: KindName, id: string): AppSettings {
  const list = settings.customColumns ?? [];
  const kept = list.filter((c) => !(sameTable(c, cluster, kind) && columnIdOf(c.source, c.path) === id));
  return kept.length === list.length ? settings : { ...settings, customColumns: kept };
}

/** The table column of a custom column; `separator` joins list values (`common:list.separator`). */
export function columnDefOf(column: ShownColumn, separator: string): ColumnDef {
  const { spec } = column;
  const steps = spec.source === "field" ? parseFieldPath(spec.path) : null;
  return {
    id: column.id,
    title: spec.title || spec.path,
    value: (obj: KubeObject) => cellValue(readColumn(obj, spec.source, steps, spec.path), separator),
    width: "minmax(100px, 1fr)",
  };
}

/** {@link shownColumns} of the current settings, the same array while they do not change. */
export function useShownColumns(
  clusterId: ClusterId | null,
  target: SpecTarget,
  viewColumns: readonly CustomColumnSpec[] | undefined,
): ShownColumn[] {
  const { group, kind, metadataOnly } = target;
  const relevant = useSyncExternalStore(subscribeSettings, () => relevantOf(getSettingsSnapshot(), group, kind));
  const viewKey = JSON.stringify(viewColumns ?? []);
  return useMemo(() => {
    if (clusterId === null) return [];
    const list = JSON.parse(relevant) as CustomColumn[];
    const views = JSON.parse(viewKey) as CustomColumnSpec[];
    return shownColumns({ customColumns: list } as AppSettings, clusterId, { group, kind, metadataOnly }, views);
  }, [clusterId, relevant, viewKey, group, kind, metadataOnly]);
}

/** The stored columns of one kind as a string, so other settings changes do not count. */
function relevantOf(settings: AppSettings | null, group: string, kind: string): string {
  return JSON.stringify((settings?.customColumns ?? []).filter((c) => c.group === group && c.kind === kind));
}
