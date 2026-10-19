// axe-core over every page a feature registers (#158), on a connected cluster that has no objects yet: headings,
// landmarks, names of controls and tables. Pages with data are covered by src/test/a11y.test.tsx.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend, type ResourceKind, type WatchSpec } from "../api";
import { App } from "../app/App";
import "../app/features";
import { resetAppStore, useAppStore } from "../app/store";
import { getPages } from "../layout/pages";
import { getResourceDefs, resetClusterKinds } from "../resources";
import { axeViolations } from "./axe";

const KINDS: ResourceKind[] = getResourceDefs().map((d) => ({
  kindRef: d.kind,
  plural: `${d.kind.kind.toLowerCase()}s`,
  namespaced: d.namespaced ?? true,
  verbs: ["list", "watch"],
  printerColumns: [],
}));

let backend: MockBackend;
let watches: string[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  watches = [];
  backend = mockBackend({
    cluster_kinds: () => KINDS,
    watch_start: (args) => {
      const id = `${(args.spec as WatchSpec).kind.kind}-${watches.length + 1}`;
      watches.push(id);
      return id;
    },
    watch_stop: () => undefined,
  });
});
afterEach(() => {
  backend.restore();
  resetClusterKinds();
});

const settle = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

// axe walks the whole rendered page: under a full parallel run that takes longer than the default 5 s.
describe("accessibility of every page (axe)", { timeout: 30_000 }, () => {
  it.each(getPages().map((p) => p.id))("page %s", async (id) => {
    render(<App />);
    act(() => useAppStore.getState().setActiveCluster("c1"));
    act(() => useAppStore.getState().setView("c1", id));
    await settle(200);
    for (const w of watches) act(() => backend.emit(`watch:${w}`, { type: "snapshot", items: [] }));
    await settle(50);
    expect(await axeViolations(document)).toEqual([]);
  });
});
