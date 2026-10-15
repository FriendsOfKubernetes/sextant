import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "./mockBackend";
import type { KindRef } from "./types";
import { useWatch, type WatchState } from "./useWatch";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const spec = (namespaces: string[] | null = null) => ({
  kind: POD,
  namespaces,
  labelSelector: null,
  fieldSelector: null,
});
const pod = (uid: string, name = uid) => ({ kind: "Pod", metadata: { uid, name, namespace: "default" } });

let backend: MockBackend | null = null;
afterEach(() => {
  backend?.restore();
  backend = null;
});

function setup() {
  let next = 0;
  backend = mockBackend({
    watch_start: () => `watch-${++next}`,
    watch_stop: () => undefined,
  });
  return backend;
}

async function listening(b: MockBackend, id: string) {
  await waitFor(() => expect(b.listenerCount(`watch:${id}`)).toBe(1));
}

describe("useWatch", () => {
  it("starts a watch and turns the snapshot into a map by uid", async () => {
    const b = setup();
    const { result } = renderHook(() => useWatch("c1", spec(["default"])));
    expect(result.current.status).toBe("loading");
    await listening(b, "watch-1");
    expect(b.calls.find((c) => c.cmd === "watch_start")?.args).toEqual({
      clusterId: "c1",
      spec: spec(["default"]),
      streamId: expect.any(String),
    });

    act(() => b.emit("watch:watch-1", { type: "snapshot", items: [pod("a"), pod("b")] }));
    expect(result.current.status).toBe("ready");
    expect([...result.current.items.keys()].sort()).toEqual(["a", "b"]);
    expect(result.current.items.get("a")?.metadata?.name).toBe("a");
  });

  it("a snapshot the backend sends while watch_start is still answering is not lost", async () => {
    backend = mockBackend({
      watch_start: (args) => {
        // The backend lists at once and emits before its answer reaches the window.
        backend!.emit(`watch:${args.streamId as string}`, { type: "snapshot", items: [pod("early")] });
        return undefined;
      },
    });
    const { result } = renderHook(() => useWatch("c1", spec()));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect([...result.current.items.keys()]).toEqual(["early"]);
  });

  it("applies a delta as one batch: one new map with every change", async () => {
    const b = setup();
    const seen: WatchState[] = [];
    const { result } = renderHook(() => {
      const state = useWatch("c1", spec());
      seen.push(state);
      return state;
    });
    await listening(b, "watch-1");
    act(() => b.emit("watch:watch-1", { type: "snapshot", items: [pod("a"), pod("b"), pod("c")] }));
    const before = result.current.items;
    const renders = seen.length;

    const upserted = Array.from({ length: 100 }, (_, i) => pod(`n${i}`));
    act(() => b.emit("watch:watch-1", { type: "delta", upserted: [...upserted, pod("a", "a2")], deleted: ["b"] }));

    expect(seen.length).toBe(renders + 1);
    const after = result.current.items;
    expect(after).not.toBe(before);
    expect(after.size).toBe(3 - 1 + 100);
    expect(after.get("a")?.metadata?.name).toBe("a2");
    expect(after.has("b")).toBe(false);
    // The previous map is not mutated (React sees a new value).
    expect(before.size).toBe(3);
  });

  it("a delta that changes nothing keeps the state and its map; the next real one still renders", async () => {
    const b = setup();
    const seen: WatchState[] = [];
    const { result } = renderHook(() => {
      const state = useWatch("c1", spec());
      seen.push(state);
      return state;
    });
    await listening(b, "watch-1");
    act(() => b.emit("watch:watch-1", { type: "snapshot", items: [pod("a"), pod("b")] }));
    const before = result.current;

    // The backend reports deletions of objects the window never had (deleted before they were listed).
    act(() => b.emit("watch:watch-1", { type: "delta", upserted: [], deleted: ["gone"] }));
    act(() => b.emit("watch:watch-1", { type: "delta", upserted: [], deleted: [] }));
    // The same state object: memoized consumers recompute nothing (React may still call the hook once to bail out).
    expect(result.current).toBe(before);
    expect(result.current.items).toBe(before.items);
    const quiet = seen.length;

    act(() => b.emit("watch:watch-1", { type: "delta", upserted: [pod("c")], deleted: ["a", "gone"] }));
    expect(seen.length).toBe(quiet + 1);
    expect(result.current.items).not.toBe(before.items);
    expect([...result.current.items.keys()].sort()).toEqual(["b", "c"]);
    expect(before.items.size).toBe(2);
  });

  it("keeps the data while reconnecting and replaces it with the next snapshot", async () => {
    const b = setup();
    const { result } = renderHook(() => useWatch("c1", spec()));
    await listening(b, "watch-1");
    act(() => b.emit("watch:watch-1", { type: "snapshot", items: [pod("a"), pod("b")] }));
    act(() => b.emit("watch:watch-1", { type: "reconnecting" }));
    expect(result.current.status).toBe("reconnecting");
    expect(result.current.items.size).toBe(2);

    act(() => b.emit("watch:watch-1", { type: "snapshot", items: [pod("c")] }));
    expect(result.current.status).toBe("ready");
    expect([...result.current.items.keys()]).toEqual(["c"]);
  });

  it("reports an error from the stream with its code", async () => {
    const b = setup();
    const { result } = renderHook(() => useWatch("c1", spec()));
    await listening(b, "watch-1");
    act(() => b.emit("watch:watch-1", { type: "error", code: "forbidden", message: "secrets is forbidden" }));
    expect(result.current.status).toBe("error");
    expect(result.current.error?.code).toBe("forbidden");
    expect(result.current.error?.message).toBe("secrets is forbidden");
  });

  it("reports a watch that cannot start", async () => {
    backend = mockBackend({
      watch_start: () => {
        throw { code: "notFound", message: "the cluster does not serve Nope (v1)" };
      },
    });
    const { result } = renderHook(() => useWatch("c1", spec()));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.code).toBe("notFound");
  });

  it("stops the subscription on unmount and when the spec changes", async () => {
    const b = setup();
    const { rerender, unmount, result } = renderHook(({ ns }) => useWatch("c1", spec(ns)), {
      initialProps: { ns: ["a"] as string[] | null },
    });
    await listening(b, "watch-1");
    act(() => b.emit("watch:watch-1", { type: "snapshot", items: [pod("x")] }));

    // An equal spec (new object, same value) does not restart the watch.
    rerender({ ns: ["a"] });
    expect(b.calls.filter((c) => c.cmd === "watch_start")).toHaveLength(1);

    const streamIds = () => b.calls.filter((c) => c.cmd === "watch_start").map((c) => c.args.streamId);
    const [first] = streamIds();
    rerender({ ns: null });
    await listening(b, "watch-2");
    expect(b.calls).toContainEqual({ cmd: "watch_stop", args: { subscriptionId: first } });
    expect(b.listenerCount("watch:watch-1")).toBe(0);
    expect(result.current.status).toBe("loading");
    expect(result.current.items.size).toBe(0);

    unmount();
    const [, second] = streamIds();
    await waitFor(() => expect(b.calls).toContainEqual({ cmd: "watch_stop", args: { subscriptionId: second } }));
    expect(b.listenerCount("watch:watch-2")).toBe(0);
  });

  it("does nothing without a cluster or spec", () => {
    const b = setup();
    const { result } = renderHook(() => useWatch(null, null));
    expect(result.current.status).toBe("loading");
    expect(b.calls).toHaveLength(0);
  });
});
