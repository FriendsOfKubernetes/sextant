import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend } from "./mockBackend";
import type { KindRef, WatchSpec } from "./types";
import { useWatch } from "./useWatch";
import { acquireWatch, dropClusterWatches, openWatchCount, resetWatchRegistry, watchStateOf } from "./watchRegistry";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const spec = (namespaces: string[] | null = null): WatchSpec => ({ kind: POD, namespaces, labelSelector: null, fieldSelector: null });
const pod = (uid: string) => ({ kind: "Pod", metadata: { uid, name: uid, namespace: "default" } });

let backend: MockBackend;
let next: number;
beforeEach(() => {
  resetWatchRegistry();
  next = 0;
  backend = mockBackend({ watch_start: () => `watch-${++next}`, watch_stop: () => undefined });
});
afterEach(() => {
  backend.restore();
  vi.useRealTimers();
});

const starts = () => backend.calls.filter((c) => c.cmd === "watch_start");
const stops = () => backend.calls.filter((c) => c.cmd === "watch_stop");

describe("the shared watch registry", () => {
  it("gives views asking for the same list one stream and closes it with the last of them", async () => {
    const first = renderHook(() => useWatch("c1", spec()));
    const second = renderHook(() => useWatch("c1", { ...spec(), metadataOnly: false }));
    await waitFor(() => expect(backend.listenerCount("watch:watch-1")).toBe(1));
    act(() => backend.emit("watch:watch-1", { type: "snapshot", items: [pod("a")] }));
    expect(first.result.current.items.size).toBe(1);
    expect(second.result.current.items.size).toBe(1);
    expect(starts()).toHaveLength(1);

    // A table asking for a cap joins the uncapped stream: it gets every object, nothing is listed twice.
    const capped = renderHook(() => useWatch("c1", spec(), { progressive: true, maxObjects: 10 }));
    expect(capped.result.current.items.size).toBe(1);
    expect(starts()).toHaveLength(1);
    capped.unmount();

    first.unmount();
    expect(openWatchCount()).toBe(1);
    second.unmount();
    expect(openWatchCount()).toBe(0);
    await waitFor(() => expect(stops()).toHaveLength(1));
  });

  it("reopens a capped watch without its cap when a view wants every object, keeping the rows meanwhile", async () => {
    const table = renderHook(() => useWatch("c1", spec(), { progressive: true, maxObjects: 1 }));
    await waitFor(() => expect(backend.listenerCount("watch:watch-1")).toBe(1));
    expect(starts()[0]!.args.options).toEqual({ progressive: true, maxObjects: 1 });
    act(() => backend.emit("watch:watch-1", { type: "snapshot", items: [pod("a")] }));
    act(() => backend.emit("watch:watch-1", { type: "capped", total: 2 }));
    const map = renderHook(() => useWatch("c1", spec()));
    await waitFor(() => expect(backend.listenerCount("watch:watch-2")).toBe(1));
    expect(starts()[1]!.args.options).toBeUndefined();
    expect(map.result.current.items.size).toBe(1);
    expect(map.result.current.total).toBeUndefined();
    act(() => backend.emit("watch:watch-2", { type: "snapshot", items: [pod("a"), pod("b")] }));
    expect(table.result.current.items.size).toBe(2);
    expect(openWatchCount()).toBe(1);
  });

  it("does not hand a failed watch to the next view: a retry starts anew", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const release = acquireWatch("c1", spec(), { linger: 5000 });
    await waitFor(() => expect(backend.listenerCount("watch:watch-1")).toBe(1));
    act(() => backend.emit("watch:watch-1", { type: "error", code: "other", message: "boom" }));
    release();
    expect(openWatchCount()).toBe(0);
    const again = acquireWatch("c1", spec());
    await waitFor(() => expect(starts()).toHaveLength(2));
    again();
  });

  it("keeps a watch open for the linger a holder asked for", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const release = acquireWatch("c1", spec(), { linger: 5000 });
    await waitFor(() => expect(starts()).toHaveLength(1));
    release();
    expect(openWatchCount()).toBe(1);
    // Taken again within the linger: the same stream.
    const again = acquireWatch("c1", spec());
    again();
    await act(() => vi.advanceTimersByTimeAsync(5001));
    expect(openWatchCount()).toBe(0);
    expect(starts()).toHaveLength(1);
  });

  it("watches anew after the cluster's watches were dropped", async () => {
    const view = renderHook(() => useWatch("c1", spec()));
    await waitFor(() => expect(backend.listenerCount("watch:watch-1")).toBe(1));
    act(() => backend.emit("watch:watch-1", { type: "snapshot", items: [pod("a")] }));
    act(() => dropClusterWatches("c1"));
    await waitFor(() => expect(backend.listenerCount("watch:watch-2")).toBe(1));
    expect(view.result.current.status).toBe("loading");
    act(() => backend.emit("watch:watch-2", { type: "snapshot", items: [pod("b")] }));
    expect([...view.result.current.items.keys()]).toEqual(["b"]);
    expect(watchStateOf("c1", spec()).items.size).toBe(1);
  });
});
