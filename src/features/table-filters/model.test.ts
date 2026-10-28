import { describe, expect, it, vi } from "vitest";
import type { KubeObject } from "../../api";
import type { FilterCondition } from "../../api/generated/FilterCondition";
import type { FilterExpression } from "../../api/generated/FilterExpression";
import type { TableFilters } from "../../api/generated/TableFilters";
import type { CellContext, ColumnDef } from "../../resources/registry";
import { compileTableFilters, EMPTY_TABLE_FILTERS } from "./model";

const context: CellContext = { clusterId: "cluster-a", kind: { group: "", version: "v1", kind: "Pod" }, now: 500_000 };
const owner: ColumnDef = { id: "owner", value: (o) => o.owner as string | undefined };
const count: ColumnDef = { id: "count", value: (o) => o.count as number | undefined, filter: { type: "number" } };
const enabled: ColumnDef = { id: "enabled", value: (o) => o.enabled as boolean | undefined, filter: { type: "boolean" } };
const columns = [owner, count, enabled];
const rule = (column: string, condition: FilterCondition): FilterExpression => ({ type: "rule", column, condition });
const quick = (column: string, condition: FilterCondition): TableFilters => ({
  columns: { [column]: { values: null, condition } }, advanced: null,
});
const keeps = (filters: TableFilters, objects: KubeObject[], defs = columns) => {
  const compiled = compileTableFilters(filters, defs);
  return objects.filter((o) => compiled.matches(o, context));
};

describe("resource table filter predicates", () => {
  it("excludes the visible owner kind case-insensitively and keeps missing owners", () => {
    const rows = [{ owner: "Job" }, { owner: "job" }, { owner: "ReplicaSet" }, {}];
    expect(keeps({ columns: { owner: { values: { mode: "exclude", values: ["Job"] }, condition: null } }, advanced: null }, rows))
      .toEqual([rows[2], rows[3]]);
  });

  it("excludes every selected owner kind while retaining unselected and missing owners", () => {
    const rows = [{ owner: "Job" }, { owner: "cronjob" }, { owner: "ReplicaSet" }, {}, { owner: null }, { owner: "" }];
    const filters: TableFilters = {
      columns: { owner: { values: { mode: "exclude", values: ["Job", "CronJob"] }, condition: null } }, advanced: null,
    };
    expect(keeps(filters, rows)).toEqual(rows.slice(2));
  });

  it("has no restriction when there are no filters", () => {
    expect(keeps(EMPTY_TABLE_FILTERS, [{}, { count: 0 }])).toHaveLength(2);
  });

  it.each(["neq", "notContains"] as const)("%s retains empty strings, nulls and absent values", (operator) => {
    expect(keeps(quick("owner", { operator, value: "Job" }), [{}, { owner: null }, { owner: "" }, { owner: "Job" }]))
      .toHaveLength(3);
  });

  it.each([
    ["eq", "job", ["Job"]], ["neq", "job", ["CronJob", "ReplicaSet"]],
    ["contains", "JOB", ["Job", "CronJob"]], ["notContains", "JOB", ["ReplicaSet"]],
    ["startsWith", "cron", ["CronJob"]], ["endsWith", "SET", ["ReplicaSet"]],
  ] as const)("implements %s without regex or localized display parsing", (operator, value, expected) => {
    expect(keeps(quick("owner", { operator, value }), ["Job", "CronJob", "ReplicaSet"].map((owner) => ({ owner })))
      .map((o) => o.owner)).toEqual(expected);
  });

  it.each([
    ["eq", 0, undefined, [0]], ["neq", 1, undefined, [0, 2]], ["gt", 1, undefined, [2]],
    ["gte", 1, undefined, ["1", 1, 2]], ["lt", 1, undefined, [0]], ["lte", 1, undefined, ["1", 0, 1]],
    ["between", 0, 1, ["1", 0, 1]],
  ] as const)("implements numeric %s, excluding missing numbers and comparing text that is a number (#294)", (operator, value, upper, expected) => {
    expect(keeps(quick("count", { operator, value, ...(upper === undefined ? {} : { upper }) }),
      [{}, { count: null }, { count: "1" }, ...[0, 1, 2].map((count) => ({ count }))]).map((o) => o.count)).toEqual(expected);
  });

  it("compares a text column numerically only where the text is a number (a label such as \"3\")", () => {
    const replicas: ColumnDef = { id: "replicas", value: (o) => o.replicas as string | undefined };
    const rows = [{ replicas: "3" }, { replicas: " 10 " }, { replicas: "2" }, { replicas: "x3" }, { replicas: "" }];
    expect(keeps(quick("replicas", { operator: "gt", value: 2 }), rows, [replicas]).map((o) => o.replicas)).toEqual(["3", " 10 "]);
  });

  it("keeps every row while a column has no values yet, and says which column waits (#294)", () => {
    let ready = false;
    const cpu: ColumnDef = { id: "cpu", value: (o) => o.cpu as number | undefined, filter: { type: "number", ready: () => ready } };
    const rows = [{ cpu: 50 }, { cpu: 500 }, {}];
    const filters: TableFilters = { columns: { cpu: { values: null, condition: { operator: "gt", value: 100 } } },
      advanced: { type: "rule", column: "cpu", condition: { operator: "lt", value: 1000 } } };
    const compiled = compileTableFilters(filters, [cpu]);
    expect(rows.filter((o) => compiled.matches(o, context))).toHaveLength(3);
    expect(compiled.notReadyColumns(context)).toEqual(["cpu"]);
    ready = true;
    expect(rows.filter((o) => compiled.matches(o, context))).toEqual([{ cpu: 500 }]);
    expect(compiled.notReadyColumns(context)).toEqual([]);
  });

  it("distinguishes false, zero and empty values", () => {
    expect(keeps(quick("enabled", { operator: "eq", value: false }), [{}, { enabled: false }, { enabled: true }]))
      .toEqual([{ enabled: false }]);
    expect(keeps(quick("count", { operator: "empty" }), [{}, { count: null }, { count: 0 }, { count: NaN }, { count: "" }]))
      .toHaveLength(4);
    expect(keeps(quick("count", { operator: "notEmpty" }), [{}, { count: 0 }, { count: false }]))
      .toEqual([{ count: 0 }, { count: false }]);
  });

  it("treats selected null as empty without confusing typed scalars", () => {
    const rows = [{}, { owner: null }, { owner: "" }, { owner: false }, { owner: 0 }, { owner: "0" }];
    expect(keeps({ columns: { owner: { condition: null, values: { mode: "include", values: [null, 0] } } }, advanced: null }, rows))
      .toEqual([rows[0], rows[1], rows[2], rows[4]]);
  });

  it("combines quick filters and nested AND/OR with the same column read once per row", () => {
    const value = vi.fn((o: KubeObject) => o.count as number);
    const compiled = compileTableFilters({ columns: { count: { values: null, condition: { operator: "gte", value: 1 } } },
      advanced: { type: "group", operator: "or", children: [rule("count", { operator: "eq", value: 2 }),
        { type: "group", operator: "and", children: [rule("owner", { operator: "empty" }), rule("count", { operator: "gte", value: 3 })] }] } },
    [{ ...count, value }, owner]);
    const rows = [{ count: 0 }, { count: 1, owner: "Job" }, { count: 2, owner: "Job" }, { count: 3 }];
    expect(rows.filter((o) => compiled.matches(o, context))).toEqual([rows[2], rows[3]]);
    expect(value).toHaveBeenCalledTimes(rows.length);
    expect(compiled.activeCount).toBe(4);
  });

  it("requires both a selected numeric value and the same column's condition, reading it once", () => {
    const value = vi.fn((o: KubeObject) => o.count as number | undefined);
    const compiled = compileTableFilters({
      columns: { count: { values: { mode: "include", values: [0, 2] }, condition: { operator: "gte", value: 1 } } },
      advanced: null,
    }, [{ ...count, value }]);
    const rows = [{ count: 0 }, { count: 1 }, { count: 2 }, {}];
    expect(rows.filter((o) => compiled.matches(o, context))).toEqual([rows[2]]);
    expect(value.mock.calls.map(([row]) => row)).toEqual(rows);
    expect(compiled.activeCount).toBe(2);
  });

  it.each([
    ["or", "Job", true],
    ["and", "ReplicaSet", false],
  ] as const)("short-circuits an advanced %s before reading an independent second column", (operator, first, expected) => {
    const firstValue = vi.fn(() => first);
    const secondValue = vi.fn(() => 2);
    const compiled = compileTableFilters({ columns: {}, advanced: { type: "group", operator, children: [
      rule("owner", { operator: "eq", value: "Job" }), rule("count", { operator: "eq", value: 2 }),
    ] } }, [{ ...owner, value: firstValue }, { ...count, value: secondValue }]);
    expect(compiled.matches({}, context)).toBe(expected);
    expect(firstValue).toHaveBeenCalledOnce();
    expect(secondValue).not.toHaveBeenCalled();
  });

  it("short-circuits an earlier failing condition without reading other columns", () => {
    const value = vi.fn(() => "Job");
    const compiled = compileTableFilters({ columns: { count: { values: null, condition: { operator: "gt", value: 5 } },
      owner: { values: null, condition: { operator: "eq", value: "Job" } } }, advanced: null }, [count, { ...owner, value }]);
    expect(compiled.matches({ count: 0 }, context)).toBe(false);
    expect(value).not.toHaveBeenCalled();
  });

  it("suspends unavailable quick columns and the entire dependent advanced expression", () => {
    const compiled = compileTableFilters({ columns: { removed: { values: null, condition: { operator: "eq", value: "x" } },
      count: { values: null, condition: { operator: "gt", value: 0 } } }, advanced: { type: "group", operator: "or", children: [
        rule("owner", { operator: "eq", value: "Job" }), rule("removed", { operator: "eq", value: "x" })] } }, columns);
    expect(compiled.unavailableColumns).toEqual(["removed"]);
    expect(compiled.advancedUnavailable).toBe(true);
    expect(compiled.matches({ count: 1, owner: "ReplicaSet" }, context)).toBe(true);
    expect(compiled.matches({ count: 0, owner: "Job" }, context)).toBe(false);
  });

  it("uses explicit raw semantics and context instead of a sorting value", () => {
    const age: ColumnDef = { id: "age", value: () => -400_000, filter: { type: "age", value: (o, ctx) => ctx.now - (o.created as number) } };
    const compiled = compileTableFilters(quick("age", { operator: "gt", value: 100_000 }), [age]);
    expect(compiled.needsTime).toBe(true);
    expect(compiled.matches({ created: 400_000 }, context)).toBe(false);
    expect(compiled.matches({ created: 400_000 }, { ...context, now: 500_001 })).toBe(true);
  });

  it("matches multi-valued columns with any positive and no negative member", () => {
    const status: ColumnDef = { id: "status", value: () => "Ready Progressing", filter: { value: (o) => o.status as string[] } };
    const rows = [{ status: ["Ready", "Progressing"] }, { status: ["Failed"] }, { status: [] }];
    expect(keeps(quick("status", { operator: "contains", value: "ready" }), rows, [status])).toEqual([rows[0]]);
    expect(keeps(quick("status", { operator: "notContains", value: "ready" }), rows, [status])).toEqual([rows[1], rows[2]]);
  });

  it("requires no equal numeric/boolean member for neq, and still excludes missing typed values", () => {
    const multiple: ColumnDef = { ...count, filter: { value: (o) => o.values as (number | boolean | null)[] } };
    const rows = [{ values: [1, 2] }, { values: [2, 3] }, { values: [] }, { values: [null] }];
    expect(keeps(quick("count", { operator: "neq", value: 1 }), rows, [multiple])).toEqual([rows[1]]);
    const boolRows = [{ values: [true, false] }, { values: [false] }, { values: [] }];
    expect(keeps(quick("count", { operator: "neq", value: true }), boolRows, [multiple])).toEqual([boolRows[1]]);
  });

  it("scans 20,000 live objects with bounded getter work and no retained row cache", () => {
    let reads = 0;
    const compiled = compileTableFilters({ columns: {}, advanced: { type: "group", operator: "or", children: [
      rule("count", { operator: "eq", value: 1 }), rule("count", { operator: "gte", value: 2 }),
      rule("count", { operator: "lt", value: 0 })] } }, [{ ...count, value: (o) => { reads++; return o.count as number; } }]);
    let matched = 0;
    const row = { count: 0 };
    for (let i = 0; i < 20_000; i++) {
      row.count = i % 3;
      if (compiled.matches(row, context)) matched++;
    }
    expect(matched).toBe(13_333);
    expect(reads).toBe(20_000);
    row.count = -1;
    expect(compiled.matches(row, context)).toBe(true);
    expect(reads).toBe(20_001);
  });
});
