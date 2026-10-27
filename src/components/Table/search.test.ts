// The table search over every shown column (#279): what a column's text is, that it is built once per object, that an
// age matches as shown and as time passes, and that 20 000 rows stay fast to search.
import { describe, expect, it, vi } from "vitest";
import type { KubeObject } from "../../api";
import { i18n } from "../../i18n";
import "../../resources";
import { findResourceDef } from "../../resources";
import type { ColumnDef } from "../../resources/registry";
import { scalePod, scalePods } from "../../test/scale";
import { compileSearch, createRowText, hasPlainTerms } from "./search";

const POD = { group: "", version: "v1", kind: "Pod" };
const t = (key: string, options?: { count?: number }) => i18n.t(key, options);
const NOW = Date.parse("2026-10-01T10:05:00Z");

function podColumns(): ColumnDef[] {
  return findResourceDef(POD)!.columns;
}

function search(query: string, objects: KubeObject[], columns = podColumns(), now = NOW): string[] {
  const rows = createRowText(columns, t);
  const matches = compileSearch(query, "/Pod", undefined, (obj) => rows.textOf(obj, now));
  return objects.filter(matches).map((o) => o.metadata!.name!);
}

describe("search over the shown columns", () => {
  const pods = [scalePod(1), scalePod(97), scalePod(2)];

  it("matches the node, the status, the QoS class and the owner, not only the name", () => {
    expect(search("node-97", pods)).toEqual([pods[1]!.metadata!.name]);
    expect(search("pending", pods)).toEqual([pods[1]!.metadata!.name]);
    expect(search("BURSTABLE", pods)).toHaveLength(3);
    expect(search("ReplicaSet/web-2-", pods)).toEqual([pods[2]!.metadata!.name]);
    // Every word must match, each in any column.
    expect(search("running node-2", pods)).toEqual([pods[2]!.metadata!.name]);
  });

  it("matches the age as the cell shows it, as of the table's clock", () => {
    expect(search("5m", pods)).toHaveLength(3);
    expect(search("5m", pods, podColumns(), NOW + 60 * 60_000)).toEqual([]);
    expect(search("1h", pods, podColumns(), NOW + 60 * 60_000)).toHaveLength(3);
  });

  it("matches a number only where the cell shows it, and never across two columns", () => {
    const columns: ColumnDef[] = [
      { id: "name", value: (o) => o.metadata?.name },
      { id: "count", value: () => 42, render: () => null },
      { id: "restarts", value: () => 7 },
      { id: "phase", value: () => "Running" },
    ];
    const obj: KubeObject = { metadata: { name: "a" } };
    expect(search("42", [obj], columns)).toEqual([]);
    expect(search("7", [obj], columns)).toEqual(["a"]);
    // "a" ends one line and "7" starts the next: no "a7" match.
    expect(search("a7", [obj], columns)).toEqual([]);
  });

  it("builds a row's texts once per object, and the timed ones again only when the clock moved", () => {
    const value = vi.fn((o: KubeObject) => o.metadata?.name);
    const timed = vi.fn(() => "x");
    const rows = createRowText(
      [
        { id: "name", value },
        { id: "age", value: () => 0, searchText: timed, searchTextTimed: true },
      ],
      t,
    );
    const obj: KubeObject = { metadata: { name: "web" } };
    rows.textOf(obj, 1);
    rows.textOf(obj, 1);
    rows.textOf(obj, 2);
    expect(value).toHaveBeenCalledTimes(1);
    expect(timed).toHaveBeenCalledTimes(2);
    expect(rows.timed).toBe(true);
    // A changed object (the watch replaces it) is read again.
    rows.textOf({ metadata: { name: "web" } }, 2);
    expect(value).toHaveBeenCalledTimes(2);
  });

  it("keeps the selector terms as they were", () => {
    expect(hasPlainTerms("app=web tier!=db")).toBe(false);
    expect(hasPlainTerms("app=web node-1")).toBe(true);
    // A label term does not match a column's text.
    expect(search("phase=Running", pods)).toEqual([]);
    expect(search("app=web-1", pods)).toEqual([pods[0]!.metadata!.name]);
  });

  it("searches 20 000 pods quickly: the first search builds the texts, the next ones reuse them", () => {
    const many = scalePods(20_000);
    const rows = createRowText(podColumns(), t);
    const run = (query: string) => {
      const matches = compileSearch(query, "/Pod", undefined, (obj) => rows.textOf(obj, NOW));
      const start = performance.now();
      const found = many.filter(matches).length;
      return { found, ms: performance.now() - start };
    };
    const first = run("node-17");
    const next = run("node-171");
    const typed = run("pending node-1");
    expect(first.found).toBe(880);
    expect(next.found).toBe(80);
    expect(typed.found).toBeGreaterThan(0);
    // Generous bounds for a loaded CI machine; locally the first takes ~180 ms and the next ~20 ms.
    expect(first.ms).toBeLessThan(2000);
    expect(next.ms).toBeLessThan(500);
    expect(typed.ms).toBeLessThan(500);
  });
});
