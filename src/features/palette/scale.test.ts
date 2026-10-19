// Scale of the palette's object search (#157): matching a query against the names of 10k–50k indexed objects. The
// timings run only with SEXTANT_SCALE=1 (see src/test/scale.ts); the check of the same path always runs.
import { act, renderHook, waitFor } from "@testing-library/react";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { applyWatchUpdate, mockBackend, type KindRef, type ResourceKind, type WatchState } from "../../api";
import "../../resources";
import { asItems, MEASURE, median, report, scalePods } from "../../test/scale";
import { objectGroups } from "./items";
import { MAX_INDEXED_OBJECTS, resetObjectIndex, useObjectIndex, type IndexedKind } from "./objectIndex";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const RK: ResourceKind = { kindRef: POD, plural: "pods", namespaced: true, verbs: ["list", "watch"], printerColumns: [] };
const t = ((key: string) => key) as unknown as TFunction;

function index(n: number): IndexedKind[] {
  const empty: WatchState = { items: new Map(), status: "loading" };
  const state = applyWatchUpdate(empty, { type: "snapshot", items: asItems(scalePods(n)) });
  return [{ kind: POD, resourceKind: RK, state }];
}

describe.skipIf(!MEASURE)("scale measurements", () => {
  it("object search", () => {
    for (const n of [10_000, 50_000]) {
      const indexed = index(n);
      const build = median(() => index(n), 3);
      const narrow = median(() => objectGroups(t, "c1", indexed, { kind: null, words: ["web-4242"] }));
      const broad = median(() => objectGroups(t, "c1", indexed, { kind: null, words: ["w"] }));
      const twoWords = median(() => objectGroups(t, "c1", indexed, { kind: null, words: ["web", "team-7"] }));
      report(`palette ${n}: index state ${build.toFixed(1)} ms, query "web-4242" ${narrow.toFixed(1)} ms, query "w" ${broad.toFixed(1)} ms, query "web team-7" ${twoWords.toFixed(1)} ms`);
    }
  });
});

describe("the measured code path", () => {
  it("finds the best match first and keeps a few results per kind", () => {
    const groups = objectGroups(t, "c1", index(2000), { kind: null, words: ["web-1234"] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items[0]!.label).toBe("web-1234-7f9c6d5b8-x01234");
    expect(groups[0]!.items.length).toBeLessThanOrEqual(10);
  });
});

describe("the index on a large cluster", () => {
  it("keeps at most MAX_INDEXED_OBJECTS of a kind and knows how many there are", async () => {
    const backend = mockBackend({ watch_start: () => "w1", watch_stop: () => undefined });
    try {
      const kinds = [{ kind: POD, resourceKind: RK }];
      const { result } = renderHook(() => useObjectIndex("c1", kinds));
      await waitFor(() => expect(backend.listenerCount("watch:w1")).toBe(1));
      const start = backend.calls.find((c) => c.cmd === "watch_start")!;
      expect(start.args.options).toEqual({ progressive: false, maxObjects: MAX_INDEXED_OBJECTS });
      act(() => backend.emit("watch:w1", { type: "snapshot", items: asItems(scalePods(3)) }));
      act(() => backend.emit("watch:w1", { type: "capped", total: 90_000 }));
      await waitFor(() => expect(result.current.kinds[0]?.state.total).toBe(90_000));
      resetObjectIndex();
    } finally {
      backend.restore();
    }
  });
});
