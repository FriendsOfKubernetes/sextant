// Extension API 5 (ADR-0169) in the window, for maps: an entries column's items reading another map by the entry's
// key, a case's `{{value}}` toning the cell's own text, `atLeast` over every key of two maps, and `|quantity` in a
// text. A value that is no number on either side compares nothing: "cannot tell" is never "at the limit".
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ColumnContribution, KubeObject, ProblemCondition } from "../api";
import { computedColumn } from "./columns";
import { evaluate, placeholderText } from "./problemRules";
import { formatList } from "../i18n/format";

const NODE_POOL = { group: "karpenter.sh", kind: "NodePool" };
const pool = (limits: unknown, resources?: unknown): KubeObject =>
  ({ apiVersion: "karpenter.sh/v1", kind: "NodePool", metadata: { name: "p" }, spec: { limits }, status: resources === undefined ? {} : { resources } }) as KubeObject;
const ctx = { now: Date.now(), t: (key: string) => key } as never;

const AT_LIMIT: ProblemCondition = { type: "atLeast", path: ".status.resources|quantity", otherPath: ".spec.limits|quantity", eachKey: true };

const usage = (rest: Partial<ColumnContribution> = {}): ColumnContribution =>
  ({
    kind: NODE_POOL,
    id: "limits",
    title: "Usage / limits",
    paths: [".spec.limits"],
    format: "entries",
    separator: ", ",
    items: {
      with: { used: ".status.resources" },
      cases: [
        { when: { type: "equals", path: ".key", value: "cpu" }, text: "cpu {{.used ?? 0|cpu}}/{{.value|cpu}}" },
        { when: { type: "equals", path: ".key", value: "memory" }, text: "memory {{.used ?? 0|bytes}}/{{.value|bytes}}" },
        { when: { type: "exists", path: ".value" }, text: "{{.key}} {{.used ?? 0|quantity}}/{{.value|quantity}}" },
        { when: { type: "exists", path: ".value" }, text: "{{.key}} {{.used ?? 0|quantity}}/{{.value}}" },
      ],
    },
    cases: [{ when: AT_LIMIT, text: "{{value}}", tone: "error" }],
    ...rest,
  }) as ColumnContribution;

function toneOf(column: ColumnContribution, o: KubeObject): string | undefined {
  const { container } = render(<>{computedColumn("x", column).render!(o, ctx)}</>);
  const el = container.querySelector("[class*='status']") ?? container.firstElementChild;
  return el?.className || undefined;
}

describe("atLeast over every key of two maps (eachKey)", () => {
  it("holds when any key both maps have is at or over, as quantities", () => {
    expect(evaluate(AT_LIMIT, pool({ cpu: "10", memory: "64Gi" }, { cpu: "4", memory: "67108864Ki" })).holds).toBe(true);
    expect(evaluate(AT_LIMIT, pool({ cpu: "10", memory: "64Gi" }, { cpu: "4", memory: "67108863Ki" })).holds).toBe(false);
    // Any resource, not only named ones.
    expect(evaluate(AT_LIMIT, pool({ "example.com/fpga": "2" }, { "example.com/fpga": "2" })).holds).toBe(true);
    expect(evaluate(AT_LIMIT, pool({ cpu: "10" }, { cpu: "10500m" })).holds).toBe(true);
  });

  it("compares nothing it cannot read: no map, a key on one side only, a value that is no quantity", () => {
    expect(evaluate(AT_LIMIT, pool({ cpu: "10" })).holds).toBe(false);
    expect(evaluate(AT_LIMIT, pool(undefined, { cpu: "10" })).holds).toBe(false);
    expect(evaluate(AT_LIMIT, pool({ cpu: "10" }, { memory: "1Ti" })).holds).toBe(false);
    expect(evaluate(AT_LIMIT, pool({ cpu: "lots" }, { cpu: "10" })).holds).toBe(false);
    expect(evaluate(AT_LIMIT, pool({ cpu: "10" }, { cpu: "?" })).holds).toBe(false);
    expect(evaluate(AT_LIMIT, pool(["10"], ["10"])).holds).toBe(false);
  });

  it("adds the offset to each other value, and reads plain numbers without a filter", () => {
    const before = { ...AT_LIMIT, offset: -1 } as ProblemCondition;
    expect(evaluate(before, pool({ nodes: "10" }, { nodes: "9" })).holds).toBe(true);
    expect(evaluate(before, pool({ nodes: "10" }, { nodes: "8" })).holds).toBe(false);
    const plain: ProblemCondition = { type: "atLeast", path: ".status.resources", otherPath: ".spec.limits", eachKey: true };
    expect(evaluate(plain, pool({ nodes: 3 }, { nodes: "3" })).holds).toBe(true);
    expect(evaluate(plain, pool({ memory: "1Gi" }, { memory: "2Gi" })).holds).toBe(false);
  });

  it("means what it did without eachKey", () => {
    const one: ProblemCondition = { type: "atLeast", path: ".status.resources.cpu|quantity", otherPath: ".spec.limits.cpu|quantity" };
    expect(evaluate(one, pool({ cpu: "4" }, { cpu: "4" })).holds).toBe(true);
    expect(evaluate({ type: "atLeast", path: ".status.resources|quantity", otherPath: ".spec.limits|quantity" }, pool({ cpu: "4" }, { cpu: "4" })).holds).toBe(false);
  });
});

describe("|quantity in a text", () => {
  it("writes a quantity's amount in the UI language, whole ones without fraction digits", () => {
    const o = { spec: { a: "20", b: "1k", c: "1500m", d: "x", e: 3 } };
    expect(placeholderText(o, ".spec.a|quantity")).toBe("20");
    expect(placeholderText(o, ".spec.b|quantity")).toBe("1000");
    expect(placeholderText(o, ".spec.c|quantity")).toBe("1.50");
    expect(placeholderText(o, ".spec.e|quantity")).toBe("3");
    expect(placeholderText(o, ".spec.d|quantity")).toBeUndefined();
    expect(placeholderText(o, ".spec.d ?? 0|quantity")).toBe("0");
  });
});

describe("an entries column's items", () => {
  it("are the entries in key order, each with the other map's value at its key", () => {
    const column = computedColumn("x", usage({ cases: undefined }));
    expect(column.searchText!(pool({ memory: "1000Gi", cpu: "1000" }, { cpu: "12", memory: "48093964Ki" }), ctx)).toBe("cpu 12/1000, memory 45.9GiB/1000GiB");
    // Nothing in use is 0; a resource of no known unit as a number; a limit that is no quantity as written.
    expect(column.searchText!(pool({ cpu: "4", "nvidia.com/gpu": "8", pods: "lots" }), ctx)).toBe("cpu 0/4, nvidia.com/gpu 0/8, pods 0/lots");
    expect(column.searchText!(pool({ nodes: "1k" }, { nodes: "1500m" }), ctx)).toBe("nodes 1.50/1000");
    expect(column.searchText!(pool({}), ctx)).toBeUndefined();
  });

  it("leave out an entry no case holds for, and join with the UI language's list without a separator", () => {
    const column = computedColumn(
      "x",
      usage({ separator: undefined, cases: undefined, items: { with: { used: ".status.resources" }, cases: [{ when: { type: "exists", path: ".used" }, text: "{{.key}}" }] } }),
    );
    expect(column.searchText!(pool({ cpu: "4", memory: "1Gi", nodes: "3" }, { cpu: "1", nodes: "2" }), ctx)).toBe(formatList(["cpu", "nodes"]));
  });

  it("never read cluster text as a placeholder", () => {
    const column = computedColumn("x", usage({ items: { cases: [{ when: { type: "exists", path: ".value" }, text: "{{.key}}={{.value}}" }] } }));
    expect(column.searchText!(pool({ "a{{.value}}": "{{.key}}" }), ctx)).toBe("a{{.value}}={{.key}}");
  });
});

describe("{{value}} in a column case's text", () => {
  it("is the text the cell shows without cases, toned by the case", () => {
    const column = usage();
    const reached = pool({ cpu: "64", "nvidia.com/gpu": "8" }, { cpu: "64", "nvidia.com/gpu": "8" });
    expect(computedColumn("x", column).searchText!(reached, ctx)).toBe("cpu 64/64, nvidia.com/gpu 8/8");
    expect(toneOf(column, reached)).toContain("danger");
    const under = pool({ cpu: "64" }, { cpu: "3" });
    expect(computedColumn("x", column).searchText!(under, ctx)).toBe("cpu 3/64");
    expect(toneOf(column, under) ?? "").not.toContain("danger");
  });

  it("holds only where the cell has a text, and keeps the rest of the case's text", () => {
    const column = usage({ cases: [{ when: { type: "exists", path: ".metadata.name" }, text: "{{ value }} ({{.metadata.name}})" }] });
    expect(computedColumn("x", column).searchText!(pool({ cpu: "4" }), ctx)).toBe("cpu 0/4 (p)");
    expect(computedColumn("x", column).searchText!(pool({}), ctx)).toBeUndefined();
  });
});
