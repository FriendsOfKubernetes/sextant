import { describe, expect, it } from "vitest";
import { readTableFilters } from "./validation";

const condition = { operator: "eq", value: false };
const rule = { type: "rule", column: "enabled", condition };
const table = { columns: { owner: { values: { mode: "exclude", values: [null, "Job", false, 0] }, condition: null } }, advanced: rule };

describe("table filter boundary", () => {
  it("roundtrips canonical primitives with no language or UI IDs", () => expect(readTableFilters(table)).toEqual(table));
  it("normalizes empty selections, columns and root groups", () => {
    expect(readTableFilters({ columns: { owner: { values: { mode: "include", values: [] } } }, advanced: { type: "group", operator: "or", children: [] } }))
      .toEqual({ columns: {}, advanced: null });
    expect(readTableFilters({ advanced: { type: "group", operator: "and", children: [rule] } }).advanced).toEqual(rule);
  });
  it("rejects an entire expression if one OR child is malformed and reports its path", () => {
    expect(() => readTableFilters({ advanced: { type: "group", operator: "or", children: [rule,
      { type: "rule", column: "x", condition: { operator: "contains", value: 2 } }] } }, "$.views[0].tableFilters"))
      .toThrow("$.views[0].tableFilters.advanced.children[1].condition.value");
  });
  it.each([
    null, [], { extra: true }, { columns: { owner: { condition: { operator: "regex", value: ".*" } } } },
    { advanced: { ...rule, id: "ui-only" } }, { advanced: { ...rule, column: "a\n" } },
    { advanced: { ...rule, condition: { operator: "empty", value: null } } },
    { advanced: { ...rule, condition: { operator: "eq", value: null } } },
    { advanced: { ...rule, condition: { operator: "gt", value: Infinity } } },
    { advanced: { ...rule, condition: { operator: "between", value: 2, upper: 1 } } },
    { advanced: { type: "group", operator: "or", children: [rule, { type: "group", operator: "and", children: [] }] } },
    { columns: { owner: { values: { mode: "include", values: Array(1001).fill("x") } } } },
    { advanced: { ...rule, column: "x".repeat(513) } },
    { advanced: { ...rule, condition: { operator: "eq", value: "😀".repeat(1001) } } },
  ])("rejects malformed or unbounded input atomically (%#)", (raw) => expect(() => readTableFilters(raw)).toThrow());
  it("accepts the Unicode character cap, not the UTF-16 byte length", () => {
    const raw = { advanced: { ...rule, condition: { operator: "eq", value: "😀".repeat(1000) } } };
    expect(readTableFilters(raw).advanced).toEqual(raw.advanced);
  });
  it("checks original nodes/depth before simplifying one-child groups", () => {
    let nested: unknown = rule;
    for (let i = 0; i < 7; i++) nested = { type: "group", operator: "and", children: [nested] };
    expect(readTableFilters({ advanced: nested }).advanced).toEqual(rule);
    expect(() => readTableFilters({ advanced: { type: "group", operator: "and", children: [nested] } })).toThrow();
    expect(() => readTableFilters({ advanced: { type: "group", operator: "or", children: Array(200).fill(rule) } })).toThrow();
    expect(() => readTableFilters({ columns: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i), {}])) })).toThrow();
  });
  it("bounds quick and advanced rules together", () => {
    const columns = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i), { condition }]));
    expect(() => readTableFilters({ columns, advanced: rule })).toThrow();
  });
});
