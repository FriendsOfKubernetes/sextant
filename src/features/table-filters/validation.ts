import type { ColumnFilter } from "../../api/generated/ColumnFilter";
import type { FilterCondition } from "../../api/generated/FilterCondition";
import type { FilterExpression } from "../../api/generated/FilterExpression";
import type { FilterOperator } from "../../api/generated/FilterOperator";
import type { FilterValue } from "../../api/generated/FilterValue";
import type { TableFilters } from "../../api/generated/TableFilters";

/** Mirrors settings/filters.rs. Checked on edits/import, never in a row predicate. */
export const FILTER_LIMITS = { tables: 512, columns: 200, nodes: 200, conditions: 200, depth: 8, values: 1000, text: 1000, id: 512 };
export class TableFilterLimitError extends Error {}
const operators = new Set<FilterOperator>(["eq", "neq", "contains", "notContains", "startsWith", "endsWith", "gt", "gte", "lt", "lte", "between", "empty", "notEmpty"]);
function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
function object(raw: unknown, path: string, keys?: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(path, "not an object");
  if (keys) for (const key of Object.keys(raw)) if (!keys.includes(key)) fail(`${path}.${key}`, "unknown field");
  return raw as Record<string, unknown>;
}
function bounded(text: string, cap: number): boolean {
  let length = 0;
  for (const _ of text) if (++length > cap) return false;
  return true;
}
function id(raw: unknown, path: string): string {
  if (typeof raw !== "string" || !raw.trim() || !bounded(raw, FILTER_LIMITS.id) || /\p{Cc}/u.test(raw)) return fail(path, "invalid column id");
  return raw;
}
function scalar(raw: unknown, path: string): FilterValue {
  if (raw === null || typeof raw === "boolean") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && bounded(raw, FILTER_LIMITS.text)) return raw;
  return fail(path, "invalid or too long value");
}
function comparisonValue(raw: unknown, operator: FilterOperator, path: string): Exclude<FilterValue, null> {
  const value = scalar(raw, path);
  if (value === null) fail(path, "a comparison needs a non-null value");
  if (["contains", "notContains", "startsWith", "endsWith"].includes(operator) && typeof value !== "string") fail(path, "not a string");
  if (["gt", "gte", "lt", "lte", "between"].includes(operator) && typeof value !== "number") fail(path, "not a number");
  return value;
}
function upperBound(raw: unknown, value: FilterValue, path: string): number {
  const upper = scalar(raw, path);
  if (typeof upper !== "number" || typeof value !== "number" || upper < value) fail(path, "not a valid upper bound");
  return upper;
}
function condition(raw: unknown, path: string): FilterCondition {
  const o = object(raw, path, ["operator", "value", "upper"]);
  const operator = o.operator as FilterOperator;
  if (!operators.has(operator)) return fail(`${path}.operator`, "unknown operator");
  if (operator === "empty" || operator === "notEmpty") {
    if ("value" in o || "upper" in o) fail(path, "this operator has no operands");
    return { operator };
  }
  const value = comparisonValue(o.value, operator, `${path}.value`);
  if (operator === "between") return { operator, value, upper: upperBound(o.upper, value, `${path}.upper`) };
  if ("upper" in o) fail(`${path}.upper`, "unexpected upper bound");
  return { operator, value };
}

interface FilterBudget { conditions: number; nodes: number }
function addCondition(budget: FilterBudget, path: string): void {
  if (++budget.conditions > FILTER_LIMITS.conditions) fail(path, "too many conditions");
}
function columnValues(raw: unknown, path: string): ColumnFilter["values"] {
  const values = object(raw, path, ["mode", "values"]);
  if (values.mode !== "include" && values.mode !== "exclude") fail(`${path}.mode`, "unknown mode");
  if (!Array.isArray(values.values) || values.values.length > FILTER_LIMITS.values) fail(`${path}.values`, "invalid or too many selected values");
  const read = (values.values as unknown[]).map((v, i) => scalar(v, `${path}.values[${i}]`));
  return read.length ? { mode: values.mode as "include" | "exclude", values: read } : null;
}
function columnFilter(raw: unknown, path: string, budget: FilterBudget): ColumnFilter {
  const c = object(raw, path, ["values", "condition"]);
  const filter: ColumnFilter = { values: null, condition: null };
  if (c.values !== undefined && c.values !== null) {
    filter.values = columnValues(c.values, `${path}.values`);
    if (filter.values) addCondition(budget, path);
  }
  if (c.condition !== undefined && c.condition !== null) {
    filter.condition = condition(c.condition, `${path}.condition`);
    addCondition(budget, path);
  }
  return filter;
}
function readColumns(source: Record<string, unknown>, path: string, budget: FilterBudget): TableFilters["columns"] {
  const columns: [string, ColumnFilter][] = [];
  for (const [key, raw] of Object.entries(source)) {
    const at = `${path}.columns.${key}`;
    id(key, at);
    const filter = columnFilter(raw, at, budget);
    if (filter.values || filter.condition) columns.push([key, filter]);
  }
  return Object.fromEntries(columns);
}
function expressionGroup(e: Record<string, unknown>, path: string, depth: number, budget: FilterBudget): FilterExpression | null {
  object(e, path, ["type", "operator", "children"]);
  if (e.type !== "group" || (e.operator !== "and" && e.operator !== "or")) return fail(path, "invalid expression group");
  if (!Array.isArray(e.children) || e.children.length > FILTER_LIMITS.nodes - budget.nodes) return fail(`${path}.children`, "invalid or too many children");
  if (!e.children.length) return depth === 1 ? null : fail(path, "empty nested group");
  const children = e.children.map((child, i) => expression(child, `${path}.children[${i}]`, depth + 1, budget)!);
  return children.length === 1 ? children[0]! : { type: "group", operator: e.operator, children };
}
function expression(raw: unknown, path: string, depth: number, budget: FilterBudget): FilterExpression | null {
  if (++budget.nodes > FILTER_LIMITS.nodes || depth > FILTER_LIMITS.depth) return fail(path, "expression exceeds its limits");
  const e = object(raw, path);
  if (e.type === "rule") {
    object(e, path, ["type", "column", "condition"]);
    addCondition(budget, path);
    return { type: "rule", column: id(e.column, `${path}.column`), condition: condition(e.condition, `${path}.condition`) };
  }
  return expressionGroup(e, path, depth, budget);
}

export function readTableFilters(raw: unknown, path = "$"): TableFilters {
  const o = object(raw, path, ["columns", "advanced"]);
  const source = o.columns === undefined ? {} : object(o.columns, `${path}.columns`);
  if (Object.keys(source).length > FILTER_LIMITS.columns) fail(`${path}.columns`, "too many columns");
  const budget: FilterBudget = { conditions: 0, nodes: 0 };
  return {
    columns: readColumns(source, path, budget),
    advanced: o.advanced == null ? null : expression(o.advanced, `${path}.advanced`, 1, budget),
  };
}

export function readTableFilterMap(raw: unknown, path = "$"): Record<string, TableFilters> {
  const entries = Object.entries(object(raw, path));
  if (entries.length > FILTER_LIMITS.tables) throw new TableFilterLimitError(`${path}: too many tables`);
  return Object.fromEntries(entries.map(([key, raw]) => {
    id(key, `${path}.${key}`);
    if (!/^kind:[^/]*\/[^/]+$/.test(key) || !key.slice(key.indexOf("/") + 1).trim()) fail(`${path}.${key}`, "invalid resource view id");
    return [key, readTableFilters(raw, `${path}.${key}`)];
  }));
}
