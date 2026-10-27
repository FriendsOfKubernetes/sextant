import { describe, expect, it } from "vitest";
import type { ColumnDef } from "../../resources/registry";
import { conditionDraft, draftCondition } from "./ConditionFields";

const column: ColumnDef = { id: "metric", value: () => undefined };
describe("condition editor canonical values", () => {
  it("roundtrips CPU, memory and duration units without persisting unit labels", () => {
    for (const [filter, value] of [[{ type: "number", unit: "cpu" }, 250], [{ type: "number", unit: "bytes" }, 2 * 1024 ** 2],
      [{ type: "age" }, 3_600_000]] as const) {
      const definition = { ...column, filter };
      const condition = { operator: "gte" as const, value };
      expect(draftCondition(conditionDraft(definition, condition), definition, filter.type)).toEqual(condition);
    }
  });
  it("preserves a draft's canonical factor if its column disappears while editing", () => {
    const memory: ColumnDef = { ...column, filter: { type: "number", unit: "bytes" } };
    const condition = { operator: "gt" as const, value: 2 * 1024 ** 2 };
    expect(draftCondition(conditionDraft(memory, condition), column, "number")).toEqual(condition);
  });
  it("validates inclusive ranges, decimal signs, empty operands and false", () => {
    const draft = conditionDraft(column);
    expect(draftCondition({ ...draft, operator: "between", value: "1,5", upper: "2.5" }, column, "number"))
      .toEqual({ operator: "between", value: 1.5, upper: 2.5 });
    expect(draftCondition({ ...draft, operator: "between", value: "2", upper: "1" }, column, "number")).toBeNull();
    expect(draftCondition({ ...draft, operator: "eq", value: "" }, column, "number")).toBeNull();
    expect(draftCondition({ ...draft, operator: "empty", value: "999" }, column, "number")).toEqual({ operator: "empty" });
    expect(draftCondition({ ...draft, operator: "eq", value: "false" }, column, "boolean")).toEqual({ operator: "eq", value: false });
    expect(draftCondition({ ...draft, operator: "eq", value: "" }, column, "boolean")).toBeNull();
    expect(draftCondition({ ...draft, operator: "gt", value: "1" }, column, "boolean")).toBeNull();
    expect(draftCondition({ ...draft, operator: "contains", value: "123" }, column, "number")).toBeNull();
    expect(draftCondition({ ...draft, value: "😀".repeat(1001) }, column, "string")).toBeNull();
  });
});
