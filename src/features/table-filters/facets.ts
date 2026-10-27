import type { KubeObject } from "../../api";
import type { FilterValue } from "../../api/generated/FilterValue";
import type { CellContext, ColumnDef } from "../../resources/registry";
import { filterValueKey, isEmptyValue, readFilterValue, valueForSelection } from "./model";

export interface FacetOption { value: FilterValue; count: number }

/** Called only for the open editor. Memory is bounded by the displayed candidates plus the saved selection. */
export function buildFacetOptions(
  objects: Iterable<KubeObject>, column: ColumnDef, context: CellContext,
  { selected = [], query = "", limit = 200, accept, label = String }: {
    selected?: readonly FilterValue[];
    query?: string;
    limit?: number;
    accept?: (obj: KubeObject) => boolean;
    label?: (value: FilterValue) => string;
  } = {},
): { options: FacetOption[]; truncated: boolean; type: ReturnType<typeof filterType> | null } {
  const options = new Map<string, FacetOption & { row: number }>();
  const pinned = new Set(selected.map(filterValueKey));
  for (const value of selected) options.set(filterValueKey(value), { value, count: 0, row: -1 });
  const wanted = query.trim().toLowerCase();
  let candidates = 0;
  let row = 0;
  let truncated = false;
  let type: ReturnType<typeof filterType> | null = column.filter?.type ?? null;
  const visit = (raw: FilterValue | undefined) => {
    if (type === null && !isEmptyValue(raw)) type = typeof raw === "number" ? "number" : typeof raw === "boolean" ? "boolean" : "string";
    const value = valueForSelection(raw, column);
    const key = filterValueKey(value);
    let option = options.get(key);
    if (!option) {
      if (wanted && !label(value).toLowerCase().includes(wanted)) return;
      // Always retain the empty entry, so it can precede the selected values too.
      if (candidates >= limit && !isEmptyValue(value)) { truncated = true; return; }
      option = { value, count: 0, row: -1 };
      options.set(key, option);
      candidates++;
    }
    if (option.row !== row) { option.count++; option.row = row; }
  };
  for (const obj of objects) {
    row++;
    if (accept && !accept(obj)) continue;
    const raw = readFilterValue(column, obj, context);
    if (Array.isArray(raw)) {
      if (raw.length === 0) visit(null);
      else for (const value of raw) visit(value);
    } else visit(raw as FilterValue | undefined);
  }
  return {
    options: [...options.values()]
      .filter(({ value }) => !wanted || label(value).toLowerCase().includes(wanted))
      .sort((a, b) => Number(isEmptyValue(b.value)) - Number(isEmptyValue(a.value))
        || Number(pinned.has(filterValueKey(b.value))) - Number(pinned.has(filterValueKey(a.value))))
      .map(({ value, count }) => ({ value, count })),
    truncated,
    type,
  };
}

export function filterType(column: ColumnDef, options: readonly FacetOption[] = []): "string" | "number" | "boolean" | "age" {
  if (column.filter?.type) return column.filter.type;
  const value = options.find((o) => !isEmptyValue(o.value))?.value;
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
}

/** The advanced editor needs types, not value indexes. Stop at the first scalar (at most 64 inspected rows). */
export function sampleFilterType(column: ColumnDef, objects: Iterable<KubeObject>, context: CellContext): ReturnType<typeof filterType> | null {
  if (column.filter?.type) return column.filter.type;
  let inspected = 0;
  for (const obj of objects) {
    const raw = readFilterValue(column, obj, context);
    const value = Array.isArray(raw) ? raw.find((value) => !isEmptyValue(value)) : raw;
    if (!isEmptyValue(value)) return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
    if (++inspected === 64) break;
  }
  return null;
}
