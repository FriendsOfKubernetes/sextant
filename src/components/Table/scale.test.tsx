// Scale of the resource table (#157): the watch state, the search, the sort and a whole render with 10k–50k pods.
// The timings run only with SEXTANT_SCALE=1 (see src/test/scale.ts); the checks of the same code paths always run.
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyWatchUpdate, mockBackend, type KindRef, type KubeObject, type MockBackend, type WatchState } from "../../api";
import { resetAppStore } from "../../app/store";
import { resetActions } from "../../features/actions/registry";
import "../../resources";
import { findResourceDef } from "../../resources";
import { asItems, MEASURE, median, report, scalePods } from "../../test/scale";
import { compareCellValues, ResourceTable } from "./ResourceTable";
import { compileSearch, matchesSearch } from "./search";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const EMPTY: WatchState = { items: new Map(), status: "loading" };
const SIZES = [10_000, 50_000];

describe.skipIf(!MEASURE)("scale measurements", () => {
  it("watch state: a snapshot, a delta and a list in parts", () => {
    for (const n of SIZES) {
      const pods = scalePods(n);
      const snapshot = median(() => applyWatchUpdate(EMPTY, { type: "snapshot", items: asItems(pods) }));
      const full = applyWatchUpdate(EMPTY, { type: "snapshot", items: asItems(pods) });
      const delta = median(() => applyWatchUpdate(full, { type: "delta", upserted: asItems(pods.slice(0, 10)), deleted: [] }), 21);
      const parts = median(() => {
        let state = EMPTY;
        for (let i = 0; i < n; i += 500) state = applyWatchUpdate(state, { type: "snapshotPart", items: asItems(pods.slice(i, i + 500)) });
        return applyWatchUpdate(state, { type: "snapshotEnd", items: [], deleted: [] });
      }, 3);
      // The window's heap per object: the pods as the channel delivers them (parsed JSON), kept in a watch's map
      // (without a forced GC only the smaller list reads reliably).
      if (n === SIZES[0]) {
      const json = JSON.stringify(pods);
      const before = process.memoryUsage().heapUsed;
      const kept = applyWatchUpdate(EMPTY, { type: "snapshot", items: JSON.parse(json) as never });
      const perObject = (process.memoryUsage().heapUsed - before) / kept.items.size;
      report(`watch state ${n}: ${(json.length / n).toFixed(0)} B of JSON and about ${perObject.toFixed(0)} B of heap per pod`);
      }
      report(`watch state ${n}: snapshot ${snapshot.toFixed(1)} ms, delta of 10 ${delta.toFixed(2)} ms, ${n / 500} parts ${parts.toFixed(1)} ms`);
    }
  });

  it("search and sort", () => {
    const def = findResourceDef(POD)!;
    const name = def.columns.find((c) => c.id === "name")!;
    const age = def.columns.find((c) => c.id === "age");
    for (const n of SIZES) {
      const pods = scalePods(n);
      const perObject = median(() => pods.filter((p) => matchesSearch(p, "web-1 team")));
      const text = median(() => pods.filter(compileSearch("web-1 team", "/Pod")));
      const selector = median(() => pods.filter(compileSearch("app=web-3", "/Pod")));
      const byName = median(() => {
        const values = pods.map((p) => name.value(p));
        return values.sort(compareCellValues);
      }, 3);
      const byAge = age
        ? median(() => {
            const values = pods.map((p) => age.value(p));
            return values.sort(compareCellValues);
          }, 3)
        : NaN;
      report(`search/sort ${n}: text search parsed per object ${perObject.toFixed(1)} ms, compiled ${text.toFixed(1)} ms, label term ${selector.toFixed(1)} ms, sort by name ${byName.toFixed(1)} ms, by age ${byAge.toFixed(1)} ms`);
    }
  });
});

let backend: MockBackend;

beforeEach(() => {
  resetAppStore();
  resetActions();
  backend = mockBackend({ watch_start: () => undefined, watch_stop: () => undefined });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 1200 : 0;
  });
});

afterEach(() => backend.restore());

async function streamOf(): Promise<string> {
  await waitFor(() => expect(backend.calls.some((c) => c.cmd === "watch_start")).toBe(true));
  const call = backend.calls.find((c) => c.cmd === "watch_start")!;
  return (call.args as { streamId: string }).streamId;
}

/** Milliseconds from the snapshot to the table's first rows on screen. */
async function renderTable(pods: KubeObject[]): Promise<{ took: number; rows: number }> {
  backend.calls.length = 0;
  const view = render(<ResourceTable clusterId="c1" kind={POD} namespaces={null} />);
  const id = await streamOf();
  const start = performance.now();
  act(() => backend.emit(`watch:${id}`, { type: "snapshot", items: asItems(pods) }));
  const rows = (await screen.findAllByRole("row", undefined, { timeout: 60_000 })).length;
  const took = performance.now() - start;
  view.unmount();
  return { took, rows };
}

describe.skipIf(!MEASURE)("scale of a table render", () => {
  it("first rows after a snapshot", async () => {
    for (const n of SIZES) {
      const pods = scalePods(n);
      await renderTable(pods.slice(0, 100));
      const { took } = await renderTable(pods);
      report(`table render ${n}: snapshot to rows ${took.toFixed(0)} ms`);
    }
  }, 120_000);
});

describe("the measured code paths", () => {
  it("a table shows a few hundred pods of the scale fixture", async () => {
    const { rows } = await renderTable(scalePods(300));
    expect(rows).toBeGreaterThan(1);
  });
});
