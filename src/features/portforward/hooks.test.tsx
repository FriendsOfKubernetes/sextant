import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { events, mockBackend, type ForwardInfo, type MockBackend } from "../../api";
import { usePortForwards, startForward, stopForward, restartForward } from "./hooks";

const info = (id: string): ForwardInfo => ({
  id, cluster: "c1", target: { type: "service", namespace: "ns", name: "web" },
  remotePort: 80, localPort: 8080, status: { state: "active" }, source: "user",
});

let backend: MockBackend;
afterEach(() => { cleanup(); backend.restore(); vi.restoreAllMocks(); });

describe("shared port forwards", () => {
  it("shares one list request between independent consumers", async () => {
    backend = mockBackend({ portforward_list: () => [info("first")] });
    const first = renderHook(usePortForwards);
    const second = renderHook(usePortForwards);
    await waitFor(() => expect(first.result.current.loaded && second.result.current.loaded).toBe(true));
    expect(backend.calls.filter(c => c.cmd === "portforward_list")).toHaveLength(1);
    expect(backend.listenerCount("portforwards")).toBe(1);
    act(() => backend.emit("portforwards", [info("newer")]));
    expect(first.result.current.forwards).toBe(second.result.current.forwards);
    expect(first.result.current.forwards[0]?.id).toBe("newer");
    first.unmount();
    expect(backend.listenerCount("portforwards")).toBe(1);
    second.unmount();
    await waitFor(() => expect(backend.listenerCount("portforwards")).toBe(0));
  });

  it("does not replace a newer event with a failed initial list", async () => {
    let reject!: (error: unknown) => void;
    backend = mockBackend({ portforward_list: () => new Promise((_resolve, fail) => { reject = fail; }) });
    const view = renderHook(usePortForwards);
    await waitFor(() => expect(reject).toBeTypeOf("function"));
    act(() => backend.emit("portforwards", [info("newer")]));
    await act(async () => { reject({ code: "unreachable", message: "old request" }); });
    expect(view.result.current.forwards[0]?.id).toBe("newer");
    expect(view.result.current.error).toBeNull();
  });

  it("ignores late success and releases old requests across reacquisition", async () => {
    let resolve!: (rows: ForwardInfo[]) => void;
    backend = mockBackend({ portforward_list: () => new Promise<ForwardInfo[]>(done => { resolve = done; }) });
    const old = renderHook(usePortForwards);
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    old.unmount();
    backend.on("portforward_list", () => [info("fresh")]);
    const current = renderHook(usePortForwards);
    await waitFor(() => expect(current.result.current.forwards[0]?.id).toBe("fresh"));
    await act(async () => { resolve([info("obsolete")]); });
    expect(current.result.current.forwards[0]?.id).toBe("fresh");
    expect(backend.listenerCount("portforwards")).toBe(1);
  });

  it("keeps an event newer than a successful initial list", async () => {
    let resolve!: (rows: ForwardInfo[]) => void;
    backend = mockBackend({ portforward_list: () => new Promise<ForwardInfo[]>(done => { resolve = done; }) });
    const view = renderHook(usePortForwards);
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    act(() => backend.emit("portforwards", [info("event")]));
    await act(async () => { resolve([info("old")]); });
    expect(view.result.current.forwards[0]?.id).toBe("event");
  });

  it("recovers from initial load failure when an event arrives", async () => {
    backend = mockBackend({ portforward_list: () => { throw { code: "unreachable", message: "offline" }; } });
    const view = renderHook(usePortForwards);
    await waitFor(() => expect(view.result.current.error?.message).toBe("offline"));
    act(() => backend.emit("portforwards", [info("live")]));
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.loaded).toBe(true);
  });

  it("reconciles a successful start without duplicating its event", async () => {
    backend = mockBackend({ portforward_list: () => [], portforward_start: () => {
      backend.emit("portforwards", [info("new")]);
      return info("new");
    } });
    const view = renderHook(usePortForwards);
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    await act(async () => { await startForward("c1", info("new").target, 80, null); });
    expect(view.result.current.forwards).toEqual([info("new")]);
  });

  it("deduplicates stops, exposes pending state and reconciles without an event", async () => {
    let finish!: () => void;
    backend = mockBackend({ portforward_list: () => [info("old")], portforward_stop: () => new Promise<void>(done => { finish = done; }) });
    const view = renderHook(usePortForwards);
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = stopForward("old"); second = stopForward("old"); });
    expect(first).toBe(second);
    expect(view.result.current.pending.has("old")).toBe(true);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => { finish(); await first; });
    expect(view.result.current.forwards).toEqual([]);
    expect(view.result.current.pending.size).toBe(0);
    expect(backend.calls.filter(c => c.cmd === "portforward_stop")).toHaveLength(1);
  });

  it("keeps a failed stop visible and releases pending state", async () => {
    backend = mockBackend({ portforward_list: () => [info("old")], portforward_stop: () => { throw { code: "denied", message: "refused" }; } });
    const view = renderHook(usePortForwards);
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    await act(async () => { await expect(stopForward("old")).rejects.toMatchObject({ code: "denied" }); });
    expect(view.result.current.forwards).toEqual([info("old")]);
    expect(view.result.current.pending.size).toBe(0);
  });

  it("restarts only after the old listener is stopped, preserving all parameters", async () => {
    let finish!: () => void;
    backend = mockBackend({ portforward_list: () => [info("old")],
      portforward_stop: () => new Promise<void>(done => { finish = done; }), portforward_start: () => info("new") });
    const view = renderHook(usePortForwards);
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    let task!: Promise<ForwardInfo>;
    act(() => { task = restartForward(info("old")); });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(backend.calls.some(c => c.cmd === "portforward_start")).toBe(false);
    await act(async () => { finish(); await task; });
    expect(backend.calls.find(c => c.cmd === "portforward_start")?.args).toEqual({ clusterId: "c1", target: info("old").target, remotePort: 80, localPort: 8080 });
    expect(view.result.current.forwards).toEqual([info("new")]);
  });

  it("does not start after a stop failure and never restarts internal forwards", async () => {
    backend = mockBackend({ portforward_list: () => [], portforward_stop: () => { throw { code: "denied", message: "refused" }; } });
    await expect(restartForward(info("old"))).rejects.toMatchObject({ code: "denied" });
    await expect(restartForward({ ...info("internal"), source: "vcluster" })).rejects.toMatchObject({ code: "denied" });
    expect(backend.calls.some(c => c.cmd === "portforward_start")).toBe(false);
    expect(backend.calls.filter(c => c.cmd === "portforward_stop")).toHaveLength(1);
  });

  it("allows retry of an already removed forward and preserves start failure", async () => {
    backend = mockBackend({ portforward_list: () => [], portforward_stop: () => { throw { code: "notFound", message: "gone" }; },
      portforward_start: () => { throw { code: "portInUse", message: "taken" }; } });
    await expect(restartForward(info("old"))).rejects.toMatchObject({ code: "portInUse" });
    expect(backend.calls.map(c => c.cmd)).toEqual(["portforward_stop", "portforward_start"]);
  });

  it("does not resurrect a forward removed by an event before its start reply", async () => {
    let finish!: (value: ForwardInfo) => void;
    backend = mockBackend({ portforward_list: () => [], portforward_start: () => new Promise<ForwardInfo>(done => { finish = done; }) });
    const view = renderHook(usePortForwards);
    await waitFor(() => expect(view.result.current.loaded).toBe(true));
    let task!: Promise<ForwardInfo>;
    act(() => { task = startForward("c1", info("new").target, 80, null); });
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    act(() => { backend.emit("portforwards", [info("new")]); backend.emit("portforwards", []); });
    await act(async () => { finish(info("new")); await task; });
    expect(view.result.current.forwards).toEqual([]);
  });

  it("accepts the initial list after a command completes during listener registration", async () => {
    let register!: (stop: () => void) => void;
    vi.spyOn(events, "onPortForwards").mockImplementation(() => new Promise(done => { register = done; }));
    backend = mockBackend({ portforward_list: () => [info("old"), info("new")], portforward_start: () => info("new") });
    const view = renderHook(usePortForwards);
    await act(async () => { await startForward("c1", info("new").target, 80, null); register(() => undefined); });
    await waitFor(() => expect(backend.calls.some(c => c.cmd === "portforward_list")).toBe(true));
    await waitFor(() => expect(view.result.current.forwards).toEqual([info("old"), info("new")]));
  });
});
