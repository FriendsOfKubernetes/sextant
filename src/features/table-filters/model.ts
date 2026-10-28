import type { KubeObject } from "../../api";
import type { ColumnFilter } from "../../api/generated/ColumnFilter";
import type { FilterCondition } from "../../api/generated/FilterCondition";
import type { FilterExpression } from "../../api/generated/FilterExpression";
import type { FilterValue } from "../../api/generated/FilterValue";
import type { TableFilters } from "../../api/generated/TableFilters";
import type { CellContext, ColumnDef, ColumnFilterValue } from "../../resources/registry";

export const EMPTY_TABLE_FILTERS: TableFilters = { columns: {}, advanced: null };

export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (typeof value === "number" && !Number.isFinite(value));
}

/** A typed, case-insensitive key; persisted values themselves retain their spelling. */
export function filterValueKey(value: FilterValue | undefined): string {
  if (isEmptyValue(value)) return "empty";
  return typeof value === "string" ? `s:${value.toLowerCase()}` : `${typeof value}:${value}`;
}

export function readFilterValue(column: ColumnDef, obj: KubeObject, context: CellContext): ColumnFilterValue {
  return column.filter?.value ? column.filter.value(obj, context) : column.value(obj);
}

/** Age checkboxes use whole-minute buckets; conditions still compare the exact duration in milliseconds. */
export function valueForSelection(value: FilterValue | undefined, column: ColumnDef): FilterValue {
  if (isEmptyValue(value)) return null;
  return column.filter?.type === "age" && typeof value === "number" ? Math.floor(value / 60_000) * 60_000 : value!;
}

function anyValue(value: ColumnFilterValue, test: (value: FilterValue | undefined) => boolean): boolean {
  if (!Array.isArray(value)) return test(value as FilterValue | undefined);
  if (value.length === 0) return test(null);
  for (const item of value) if (test(item)) return true;
  return false;
}

const nonEmpty = (value: FilterValue | undefined) => !isEmptyValue(value);

function conditionPredicate(condition: FilterCondition): (value: ColumnFilterValue) => boolean {
  const { operator, value, upper } = condition;
  if (operator === "empty") return (raw) => !anyValue(raw, nonEmpty);
  if (operator === "notEmpty") return (raw) => anyValue(raw, nonEmpty);
  if (typeof value === "string") {
    const wanted = value.toLowerCase();
    const positive = (v: FilterValue | undefined): boolean => {
      if (typeof v !== "string" || isEmptyValue(v)) return false;
      const text = v.toLowerCase();
      switch (operator) {
        case "eq": case "neq": return text === wanted;
        case "contains": case "notContains": return text.includes(wanted);
        case "startsWith": return text.startsWith(wanted);
        case "endsWith": return text.endsWith(wanted);
        default: return false;
      }
    };
    return operator === "neq" || operator === "notContains"
      ? (raw) => !anyValue(raw, positive)
      : (raw) => anyValue(raw, positive);
  }
  if (operator === "neq" && (typeof value === "number" || typeof value === "boolean")) {
    const applicable = (v: FilterValue | undefined) => typeof v === typeof value && (typeof v !== "number" || Number.isFinite(v));
    return (raw) => {
      if (!Array.isArray(raw)) return applicable(raw as FilterValue | undefined) && raw !== value;
      let present = false;
      for (const v of raw) if (applicable(v)) { if (v === value) return false; present = true; }
      return present;
    };
  }
  if (typeof value === "boolean") {
    const test = (v: FilterValue | undefined) => typeof v === "boolean" && v === value;
    return (raw) => anyValue(raw, test);
  }
  const test = (raw: FilterValue | undefined) => {
    // Text that is a number ("3" in a label or annotation) compares as one; other text never does.
    const v = typeof raw === "string" ? numberOf(raw) : raw;
    if (typeof v !== "number" || !Number.isFinite(v) || typeof value !== "number") return false;
    switch (operator) {
      case "eq": return v === value;
      case "gt": return v > value;
      case "gte": return v >= value;
      case "lt": return v < value;
      case "lte": return v <= value;
      case "between": return typeof upper === "number" && v >= value && v <= upper;
      default: return false;
    }
  };
  return (raw) => anyValue(raw, test);
}

function numberOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export function columnFilterCount(filter: ColumnFilter | undefined): number {
  return Number(!!filter?.values?.values.length) + Number(!!filter?.condition);
}

function expressionColumns(expression: FilterExpression | null, into = new Set<string>()): Set<string> {
  if (expression?.type === "rule") into.add(expression.column);
  else if (expression) for (const child of expression.children) expressionColumns(child, into);
  return into;
}

function expressionCount(expression: FilterExpression | null): number {
  if (!expression) return 0;
  if (expression.type === "rule") return 1;
  let count = 0;
  for (const child of expression.children) count += expressionCount(child);
  return count;
}

export function filterCount(filters: TableFilters): number {
  let count = expressionCount(filters.advanced);
  for (const filter of Object.values(filters.columns)) count += columnFilterCount(filter);
  return count;
}

/** Explicit removal may prune groups. Unavailable columns are never removed from an expression implicitly. */
function withoutExpressionColumn(expression: FilterExpression | null, column: string): FilterExpression | null {
  if (!expression) return null;
  if (expression.type === "rule") return expression.column === column ? null : expression;
  const children: FilterExpression[] = [];
  for (const child of expression.children) {
    const kept = withoutExpressionColumn(child, column);
    if (kept) children.push(kept);
  }
  return children.length === 0 ? null : children.length === 1 ? children[0]! : { ...expression, children };
}

export function withoutColumnFilter(filters: TableFilters, column: string): TableFilters {
  const columns = { ...filters.columns };
  delete columns[column];
  return { columns, advanced: withoutExpressionColumn(filters.advanced, column) };
}

export function withColumnFilter(filters: TableFilters, column: string, filter: ColumnFilter): TableFilters {
  const columns = { ...filters.columns };
  if (columnFilterCount(filter)) columns[column] = filter;
  else delete columns[column];
  return { ...filters, columns };
}

type RowPredicate = (obj: KubeObject, context: CellContext) => boolean;

/** Compile once per configuration/schema, with O(referenced columns) scratch space, never a cache of rows. */
export function compileTableFilters(filters: TableFilters, columns: readonly ColumnDef[]) {
  const definitions = new Map(columns.map((column) => [column.id, column]));
  const advancedColumns = expressionColumns(filters.advanced);
  const references = new Set([...Object.keys(filters.columns), ...advancedColumns]);
  const unavailableColumns = [...references].filter((id) => !definitions.has(id));
  const advancedUnavailable = unavailableColumns.some((id) => advancedColumns.has(id));
  const indexes = new Map<string, number>();
  const values: ColumnFilterValue[] = [];
  const stamps = new Uint32Array(references.size);
  let rowVersion = 0;
  let needsTime = false;
  const getter = (id: string) => {
    const column = definitions.get(id)!;
    if (column.filter?.type === "age") needsTime = true;
    let index = indexes.get(id);
    if (index === undefined) { index = indexes.size; indexes.set(id, index); }
    const slot = index;
    return (obj: KubeObject, context: CellContext): ColumnFilterValue => {
      if (stamps[slot] !== rowVersion) {
        values[slot] = readFilterValue(column, obj, context);
        stamps[slot] = rowVersion;
      }
      return values[slot];
    };
  };
  // A column whose values are not there yet (metrics still loading or failing) keeps every row: its conditions wait.
  const readiness = [...references].flatMap((id) => {
    const ready = definitions.get(id)?.filter?.ready;
    return ready ? [[id, ready] as const] : [];
  });
  const readyOf = new Map(readiness);
  const predicates: RowPredicate[] = [];
  for (const [id, filter] of Object.entries(filters.columns)) {
    const column = definitions.get(id);
    if (!column) continue;
    const read = getter(id);
    const ready = readyOf.get(id);
    if (filter.values?.values.length) {
      const selected = new Set(filter.values.values.map(filterValueKey));
      const exclude = filter.values.mode === "exclude";
      const containsValue = (v: FilterValue | undefined) => selected.has(filterValueKey(valueForSelection(v, column)));
      predicates.push((obj, context) => {
        if (ready && !ready(context)) return true;
        const contains = anyValue(read(obj, context), containsValue);
        return exclude ? !contains : contains;
      });
    }
    if (filter.condition) {
      const test = conditionPredicate(filter.condition);
      predicates.push((obj, context) => (ready && !ready(context)) || test(read(obj, context)));
    }
  }
  const compileExpression = (expression: FilterExpression): RowPredicate => {
    if (expression.type === "rule") {
      const read = getter(expression.column);
      const test = conditionPredicate(expression.condition);
      return (obj, context) => test(read(obj, context));
    }
    const children = expression.children.map(compileExpression);
    return expression.operator === "and"
      ? (obj, context) => { for (const child of children) if (!child(obj, context)) return false; return true; }
      : (obj, context) => { for (const child of children) if (child(obj, context)) return true; return false; };
  };
  if (filters.advanced && !advancedUnavailable) {
    // Like an unavailable column, a column without values yet pauses the whole expression, never part of a group.
    const expression = compileExpression(filters.advanced);
    const waits = readiness.filter(([id]) => advancedColumns.has(id)).map(([, ready]) => ready);
    predicates.push(waits.length === 0 ? expression : (obj, context) => waits.some((ready) => !ready(context)) || expression(obj, context));
  }
  return {
    matches: (obj: KubeObject, context: CellContext): boolean => {
      rowVersion = (rowVersion + 1) >>> 0;
      if (rowVersion === 0) { stamps.fill(0); rowVersion = 1; }
      for (const test of predicates) if (!test(obj, context)) return false;
      return true;
    },
    activeCount: filterCount(filters),
    columnIds: [...references],
    activeColumnIds: [...indexes.keys()],
    unavailableColumns,
    advancedUnavailable,
    /** The referenced columns whose values are not there now: their conditions keep every row until they are. */
    notReadyColumns: (context: CellContext): string[] => readiness.filter(([, ready]) => !ready(context)).map(([id]) => id),
    needsTime,
  };
}
