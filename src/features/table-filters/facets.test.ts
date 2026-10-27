import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import type { CellContext, ColumnDef } from "../../resources/registry";
import { buildFacetOptions, filterType } from "./facets";
import { filterUnits, parseFilterNumber } from "./units";
import { withoutColumnFilter } from "./model";

const ctx: CellContext = { clusterId: "a", kind: { group: "", version: "v1", kind: "Pod" }, now: 0 };
const column: ColumnDef = { id: "value", value: (o) => o.value as string | number | boolean | undefined };

describe("lazy bounded filter facets", () => {
  it("keeps empty first above selected values, with zero/false distinct and missing selections retained", () => {
    const result = buildFacetOptions([{}, { value: "Job" }, { value: "job" }, { value: 0 }, { value: false }], column, ctx,
      { selected: ["Job", "CronJob"] });
    expect(result.options).toEqual([{ value: null, count: 1 }, { value: "Job", count: 2 }, { value: "CronJob", count: 0 },
      { value: 0, count: 1 }, { value: false, count: 1 }]);
  });

  it("bounds high-cardinality lists without retaining a full per-column index", () => {
    function* rows(): Iterable<KubeObject> { for (let i = 0; i < 20_000; i++) yield { value: `value-${i}` }; yield {}; }
    const result = buildFacetOptions(rows(), column, ctx, { selected: ["absent"], limit: 20 });
    expect(result.truncated).toBe(true);
    expect(result.options).toHaveLength(22);
    expect(result.options[0]!.value).toBeNull();
    expect(result.options[1]).toEqual({ value: "absent", count: 0 });
    const searched = buildFacetOptions(rows(), column, ctx, { query: "value-19999", limit: 20 });
    expect(searched.options).toEqual([{ value: "value-19999", count: 1 }]);
    expect(searched.truncated).toBe(false);
  });

  it("counts rows once for repeated members and applies only the namespace/search base restriction", () => {
    const many: ColumnDef = { ...column, filter: { value: (o) => o.value as string[] } };
    expect(buildFacetOptions([{ value: ["Job", "Job"] }, { value: ["Job"], omit: true }, { value: [] }], many, ctx,
      { accept: (o) => !o.omit }).options).toEqual([{ value: null, count: 1 }, { value: "Job", count: 1 }]);
  });

  it("can search localized empty and boolean labels without persisting those labels", () => {
    expect(buildFacetOptions([{}, { value: false }], column, ctx, { query: "нет", label: (v) => v === false ? "Нет" : "(пусто)" }).options)
      .toEqual([{ value: false, count: 1 }]);
  });

  it("uses whole-minute age selections but explicit numeric/boolean column types win over samples", () => {
    const age: ColumnDef = { ...column, filter: { type: "age" } };
    expect(buildFacetOptions([{ value: 60_001 }, { value: 119_999 }], age, ctx).options).toEqual([{ value: 60_000, count: 2 }]);
    expect(filterType(column, [{ value: false, count: 1 }])).toBe("boolean");
    expect(filterType(age)).toBe("age");
  });
});

describe("canonical filter units and explicit clearing", () => {
  it("normalizes CPU, memory and time independently of a decimal sign", () => {
    expect(parseFilterNumber("0,25", filterUnits({ ...column, filter: { unit: "cpu" } })[1]!.factor)).toBe(250);
    expect(parseFilterNumber("1.5", filterUnits({ ...column, filter: { unit: "bytes" } })[2]!.factor)).toBe(1.5 * 1024 ** 2);
    expect(parseFilterNumber("2", filterUnits({ ...column, filter: { type: "age" } })[2]!.factor)).toBe(7_200_000);
    for (const bad of ["", "Infinity", "1,234.5", "1 000", "NaN", "1e999"]) expect(parseFilterNumber(bad)).toBeNull();
  });

  it("removes all column rules and simplifies empty/single groups without touching other quick filters", () => {
    const other = { values: null, condition: { operator: "eq" as const, value: 0 } };
    const remaining = { type: "rule" as const, column: "count", condition: { operator: "gte" as const, value: 1 } };
    const result = withoutColumnFilter({ columns: { owner: other, count: other }, advanced: { type: "group", operator: "and", children: [
      { type: "rule", column: "owner", condition: { operator: "eq", value: "Job" } },
      { type: "group", operator: "or", children: [remaining] }] } }, "owner");
    expect(result).toEqual({ columns: { count: other }, advanced: remaining });
  });
});
