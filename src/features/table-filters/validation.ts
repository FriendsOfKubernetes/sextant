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
function condition(raw: unknown, path: string): FilterCondition {
  const o = object(raw, path, ["operator", "value", "upper"]);
  const operator = o.operator as FilterOperator;
  if (!operators.has(operator)) return fail(`${path}.operator`, "unknown operator");
  if (operator === "empty" || operator === "notEmpty") {
    if ("value" in o || "upper" in o) fail(path, "this operator has no operands");
    return { operator };
  }
  const value = scalar(o.value, `${path}.value`);
  if (value === null) fail(`${path}.value`, "a comparison needs a non-null value");
  if (["contains", "notContains", "startsWith", "endsWith"].includes(operator) && typeof value !== "string") fail(`${path}.value`, "not a string");
  if (["gt", "gte", "lt", "lte", "between"].includes(operator) && typeof value !== "number") fail(`${path}.value`, "not a number");
  if (operator === "between") {
    const upper = scalar(o.upper, `${path}.upper`);
    if (typeof upper !== "number" || typeof value !== "number" || upper < value) fail(`${path}.upper`, "not a valid upper bound");
    return { operator, value, upper };
  }
  if ("upper" in o) fail(`${path}.upper`, "unexpected upper bound");
  return { operator, value };
}

export function readTableFilters(raw: unknown, path = "$"): TableFilters {
  const o = object(raw, path, ["columns", "advanced"]);
  const source = o.columns === undefined ? {} : object(o.columns, `${path}.columns`);
  if (Object.keys(source).length > FILTER_LIMITS.columns) fail(`${path}.columns`, "too many columns");
  const columns: [string, ColumnFilter][] = [];
  let count = 0;
  let nodes = 0;
  const addCondition = (at: string) => { if (++count > FILTER_LIMITS.conditions) fail(at, "too many conditions"); };
  for (const [key, raw] of Object.entries(source)) {
    const at = `${path}.columns.${key}`;
    id(key, at);
    const c = object(raw, at, ["values", "condition"]);
    const filter: ColumnFilter = { values: null, condition: null };
    if (c.values !== undefined && c.values !== null) {
      const values = object(c.values, `${at}.values`, ["mode", "values"]);
      if (values.mode !== "include" && values.mode !== "exclude") fail(`${at}.values.mode`, "unknown mode");
      if (!Array.isArray(values.values) || values.values.length > FILTER_LIMITS.values) fail(`${at}.values.values`, "invalid or too many selected values");
      const read = (values.values as unknown[]).map((v, i) => scalar(v, `${at}.values.values[${i}]`));
      if (read.length) { filter.values = { mode: values.mode as "include" | "exclude", values: read }; addCondition(at); }
    }
    if (c.condition !== undefined && c.condition !== null) { filter.condition = condition(c.condition, `${at}.condition`); addCondition(at); }
    if (filter.values || filter.condition) columns.push([key, filter]);
  }
  const expression = (raw: unknown, at: string, depth: number): FilterExpression | null => {
    if (++nodes > FILTER_LIMITS.nodes || depth > FILTER_LIMITS.depth) return fail(at, "expression exceeds its limits");
    const e = object(raw, at);
    if (e.type === "rule") {
      object(e, at, ["type", "column", "condition"]);
      addCondition(at);
      return { type: "rule", column: id(e.column, `${at}.column`), condition: condition(e.condition, `${at}.condition`) };
    }
    object(e, at, ["type", "operator", "children"]);
    if (e.type !== "group" || (e.operator !== "and" && e.operator !== "or")) return fail(at, "invalid expression group");
    if (!Array.isArray(e.children) || e.children.length > FILTER_LIMITS.nodes - nodes) return fail(`${at}.children`, "invalid or too many children");
    if (!e.children.length) return depth === 1 ? null : fail(at, "empty nested group");
    const children = e.children.map((child, i) => expression(child, `${at}.children[${i}]`, depth + 1)!);
    return children.length === 1 ? children[0]! : { type: "group", operator: e.operator, children };
  };
  return { columns: Object.fromEntries(columns), advanced: o.advanced == null ? null : expression(o.advanced, `${path}.advanced`, 1) };
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
