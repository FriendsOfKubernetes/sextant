import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KubeObject, type MockBackend, type ResourceKind, type WatchSpec } from "../api";
import { CRD_REFRESH_DELAY, resetClusterKinds, useClusterKinds, watchCrdChanges } from "./useKinds";

const served = (group: string, kind: string): ResourceKind => ({
  kindRef: { group, version: "v1", kind },
  plural: `${kind.toLowerCase()}s`,
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const crd = (uid: string, generation = 1): KubeObject => ({
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: { name: `${uid}.demo.sextant.dev`, uid, generation },
});

let backend: MockBackend;
let kinds: ResourceKind[];
let watches: WatchSpec[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetClusterKinds();
  kinds = [served("", "Pod"), served("demo.sextant.dev", "Widget")];
  watches = [];
  backend = mockBackend({
    cluster_kinds: () => kinds,
    cluster_kinds_refresh: () => undefined,
    watch_start: (args) => {
      watches.push(args.spec as WatchSpec);
      return "crds";
    },
    watch_stop: () => undefined,
  });
});

afterEach(() => {
  backend.restore();
  resetClusterKinds();
  vi.useRealTimers();
});

const refreshes = () => backend.calls.filter((c) => c.cmd === "cluster_kinds_refresh");
const loads = () => backend.calls.filter((c) => c.cmd === "cluster_kinds").length;
const names = (list: ResourceKind[] | null) => (list ?? []).map((k) => k.kindRef.kind);

async function watching() {
  const hook = renderHook(() => useClusterKinds("c1"));
  await waitFor(() => expect(names(hook.result.current.kinds)).toEqual(["Pod", "Widget"]));
  const stop = watchCrdChanges("c1");
  await waitFor(() => expect(backend.listenerCount("watch:crds")).toBe(1));
  act(() => backend.emit("watch:crds", { type: "snapshot", items: [crd("widgets")] }));
  return { hook, stop };
}

const later = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));

describe("CRD changes refresh the discovery without reconnecting", () => {
  it("watches only the metadata of CustomResourceDefinitions", async () => {
    const { stop } = await watching();
    expect(watches).toEqual([
      {
        kind: { group: "apiextensions.k8s.io", version: "v1", kind: "CustomResourceDefinition" },
        namespaces: null,
        labelSelector: null,
        fieldSelector: null,
        metadataOnly: true,
      },
    ]);
    stop();
  });

  it("a batch of new CRDs refreshes the backend's and the window's kinds once, after a pause", async () => {
    const { hook, stop } = await watching();
    await later(CRD_REFRESH_DELAY * 2);
    expect(refreshes()).toHaveLength(0);
    const loadsBefore = loads();

    kinds = [...kinds, served("source.toolkit.fluxcd.io", "GitRepository"), served("kustomize.toolkit.fluxcd.io", "Kustomization")];
    act(() => backend.emit("watch:crds", { type: "delta", upserted: [crd("gitrepositories")], deleted: [] }));
    await later(CRD_REFRESH_DELAY / 2);
    act(() => backend.emit("watch:crds", { type: "delta", upserted: [crd("kustomizations")], deleted: [] }));
    await later(CRD_REFRESH_DELAY / 2);
    expect(refreshes()).toHaveLength(0);
    await later(CRD_REFRESH_DELAY);

    expect(refreshes()).toEqual([{ cmd: "cluster_kinds_refresh", args: { clusterId: "c1" } }]);
    await waitFor(() =>
      expect(names(hook.result.current.kinds)).toEqual(["Pod", "Widget", "GitRepository", "Kustomization"]),
    );
    expect(loads()).toBe(loadsBefore + 1);
    stop();
  });

  it("a deleted CRD refreshes too; the old kinds stay shown until the new ones come", async () => {
    const { hook, stop } = await watching();
    kinds = [served("", "Pod")];
    act(() => backend.emit("watch:crds", { type: "delta", upserted: [], deleted: ["widgets"] }));
    await later(CRD_REFRESH_DELAY);
    expect(refreshes()).toHaveLength(1);
    expect(hook.result.current.kinds).not.toBeNull();
    await waitFor(() => expect(names(hook.result.current.kinds)).toEqual(["Pod"]));
    stop();
  });

  it("an unchanged CRD (status only) and the first list change nothing; a new version (generation) does", async () => {
    const { stop } = await watching();
    act(() => backend.emit("watch:crds", { type: "delta", upserted: [crd("widgets", 1)], deleted: [] }));
    await later(CRD_REFRESH_DELAY * 2);
    expect(refreshes()).toHaveLength(0);

    act(() => backend.emit("watch:crds", { type: "delta", upserted: [crd("widgets", 2)], deleted: [] }));
    await later(CRD_REFRESH_DELAY);
    expect(refreshes()).toHaveLength(1);
    stop();
  });

  it("one watch per cluster however many use it; it stops with the last", async () => {
    const { stop } = await watching();
    const second = watchCrdChanges("c1");
    expect(watches).toHaveLength(1);
    stop();
    expect(backend.calls.some((c) => c.cmd === "watch_stop")).toBe(false);
    second();
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "watch_stop")).toBe(true));
  });
});
