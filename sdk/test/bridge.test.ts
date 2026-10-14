// The SDK against Sextant's real host side (src/extensions/bridge.ts) with a mock backend: proves that both speak
// the same protocol — documents, ready and context, ids, answers, errors, watch streams and unwatch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend } from "../../src/api";
import { createBridge, type Bridge } from "../../src/extensions/bridge";
import type { HostContext as HostSideContext } from "../../src/extensions/protocol";
import { connect, type Sextant, type WatchUpdate } from "../src";

const CONTEXT: HostSideContext = {
  apiVersion: 1,
  extensionId: "demo.ext",
  view: "page",
  contribution: "overview",
  clusterId: "c1",
  theme: "dark",
  language: "en",
  tokens: { "--color-text": "#dcddde" },
  selection: [],
  resourceVersion: null,
};

let backend: MockBackend;
let bridge: Bridge;
let frameElement: HTMLIFrameElement;
let hostElement: HTMLIFrameElement;
let context: HostSideContext;
let sextant: Sextant | null;
const ui = { openDetails: vi.fn(), navigate: vi.fn(), notify: vi.fn(), close: vi.fn() };
const onFrameError = vi.fn();
const onResize = vi.fn();

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  backend = mockBackend();
  context = CONTEXT;
  sextant = null;
  // The frame's window as the host sees it, and the host's window as the frame sees it: two windows whose
  // postMessage carries a copy of the message to the other side, as a browser does.
  frameElement = document.createElement("iframe");
  hostElement = document.createElement("iframe");
  document.body.append(frameElement, hostElement);
  const frameWindow = frameElement.contentWindow!;
  const hostWindow = hostElement.contentWindow!;
  vi.spyOn(frameWindow, "postMessage").mockImplementation((message: unknown) => {
    window.dispatchEvent(new MessageEvent("message", { data: structuredClone(message), source: hostWindow }));
  });
  vi.spyOn(hostWindow, "postMessage").mockImplementation((message: unknown) => {
    bridge.handle(new MessageEvent("message", { data: structuredClone(message), source: frameWindow }));
  });
  bridge = createBridge({
    extensionId: "demo.ext",
    frame: () => frameWindow,
    context: () => context,
    ui,
    onFrameError,
    onResize,
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  sextant?.disconnect();
  bridge.dispose();
  frameElement.remove();
  hostElement.remove();
  backend.restore();
});

async function connected(): Promise<Sextant> {
  sextant = await connect({ host: hostElement.contentWindow!, connectTimeoutMs: 2000 });
  return sextant;
}

describe("the SDK with Sextant's bridge", () => {
  it("connects: ready, then the context", async () => {
    const client = await connected();
    expect(client.context).toEqual(CONTEXT);
  });

  it("calls the backend as the extension and gets the result", async () => {
    backend.on("extension_call", (args) => (args.method === "resources.list" ? { items: [], truncated: false } : null));
    const client = await connected();
    await expect(client.resources.list({ kind: { kind: "Pod" }, namespace: "default" })).resolves.toEqual({
      items: [],
      truncated: false,
    });
    expect(calls("extension_call")[0]!.args).toEqual({
      extensionId: "demo.ext",
      method: "resources.list",
      params: { clusterId: "c1", kind: { kind: "Pod" }, namespace: "default" },
      streamId: undefined,
    });
  });

  it("passes refusals on with their code", async () => {
    backend.on("extension_call", () => {
      throw { code: "denied", message: "Extension Demo may not modify Pods" };
    });
    const client = await connected();
    await expect(
      client.resources.patch({ ref: { kind: { kind: "Pod" }, namespace: "a", name: "w" }, patch: {}, patchType: "merge" }),
    ).rejects.toMatchObject({ code: "denied", message: "Extension Demo may not modify Pods", method: "resources.patch" });
  });

  it("answers ui and context calls in the window", async () => {
    const client = await connected();
    await client.ui.navigate("pods");
    await client.ui.notify("Hello");
    await client.ui.openDetails({ kind: { group: "", version: "v1", kind: "Pod" }, namespace: "a", name: "w" });
    await client.ui.close();
    expect(ui.navigate).toHaveBeenCalledWith({ page: "pods" });
    expect(ui.notify).toHaveBeenCalledWith({ text: "Hello" });
    expect(ui.openDetails).toHaveBeenCalledWith({ kind: { group: "", version: "v1", kind: "Pod" }, namespace: "a", name: "w" });
    expect(ui.close).toHaveBeenCalled();
    context = { ...CONTEXT, clusterId: "c2" };
    await expect(client.refreshContext()).resolves.toMatchObject({ clusterId: "c2" });
    expect(client.context.clusterId).toBe("c2");
  });

  it("follows pushed contexts", async () => {
    const client = await connected();
    const seen: string[] = [];
    client.onContextChange((now) => seen.push(now.theme));
    context = { ...CONTEXT, theme: "light" };
    bridge.pushContext();
    expect(seen).toEqual(["light"]);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("streams a watch and stops it on unwatch", async () => {
    backend.on("extension_call", () => null);
    backend.on("extension_watch_stop", () => undefined);
    const client = await connected();
    const updates: WatchUpdate[] = [];
    const watch = client.resources.watch({ kind: { kind: "Pod" } }, (u) => updates.push(u));
    await watch.started;
    const streamId = calls("extension_call")[0]!.args.streamId as string;
    expect(calls("extension_call")[0]!.args.params).toEqual({ clusterId: "c1", kind: { kind: "Pod" } });
    backend.emit(`ext-watch:${streamId}`, { type: "snapshot", items: [{ metadata: { name: "web", uid: "1" } }] });
    backend.emit(`ext-watch:${streamId}`, { type: "delta", upserted: [], deleted: ["1"] });
    expect(updates).toEqual([
      { type: "snapshot", items: [{ metadata: { name: "web", uid: "1" } }] },
      { type: "delta", upserted: [], deleted: ["1"] },
    ]);
    await watch.unwatch();
    await vi.waitFor(() => expect(calls("extension_watch_stop")).toHaveLength(1));
    expect(calls("extension_watch_stop")[0]!.args).toEqual({ extensionId: "demo.ext", streamId });
  });

  it("a watch that cannot start fails with the backend's error", async () => {
    backend.on("extension_call", () => {
      throw { code: "notFound", message: "the cluster does not serve the kind Widget" };
    });
    const client = await connected();
    const watch = client.resources.watch({ kind: { kind: "Widget" } });
    await expect(watch.started).rejects.toMatchObject({ code: "notFound" });
  });

  it("an unknown method is refused as invalid", async () => {
    const client = await connected();
    await expect(client.call("terminal.exec" as never, undefined as never)).rejects.toMatchObject({ code: "invalid" });
  });

  it("reports errors and sizes to the host", async () => {
    const client = await connected();
    client.reportError(new TypeError("x is undefined"));
    client.resize(240);
    expect(onFrameError).toHaveBeenCalledWith("TypeError: x is undefined");
    expect(onResize).toHaveBeenCalledWith(240);
  });

  it("a reloaded document starts afresh: the old one's answers do not reach it", async () => {
    backend.on("extension_call", () => new Promise(() => undefined));
    const first = await connected();
    void first.clusters.list().catch(() => undefined);
    first.disconnect();
    bridge.frameLoaded();
    bridge.frameLoaded();
    const second = await connected();
    expect(second.context).toEqual(CONTEXT);
  });
});
