import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, mockBackend, type MockBackend } from "../api";
import { createBridge, type Bridge, type BridgeUi } from "./bridge";
import { MAX_DOCUMENTS_PER_FRAME, type HostContext, type RequestId } from "./protocol";

const CONTEXT: HostContext = {
  apiVersion: 1,
  extensionId: "demo.ext",
  view: "page",
  contribution: "overview",
  clusterId: "c1",
  namespaces: null,
  theme: "dark",
  language: "en",
  tokens: { "--color-bg": "#111" },
  selection: [],
  resourceVersion: null,
};

let backend: MockBackend;
let frame: HTMLIFrameElement;
let other: HTMLIFrameElement;
let posted: unknown[];
type Fn = (arg?: unknown) => void;
let ui: { [K in keyof BridgeUi]: ReturnType<typeof vi.fn<Fn>> };
let bridge: Bridge;
let onResize: ReturnType<typeof vi.fn<(height: number) => void>>;
let onFrameError: ReturnType<typeof vi.fn<(message: string) => void>>;

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);
// Document ids (`doc`), as the SDK makes them up: 128 random bits in hex.
const DOC_A = "a".repeat(32);
const DOC_B = "b".repeat(32);

/** A message from the frame; `doc` is document A's unless the message names one (or `null`: none at all). */
function send(data: unknown, source: Window | null = frame.contentWindow) {
  const withDoc =
    typeof data === "object" && data !== null && !("doc" in data) ? { doc: DOC_A, ...data } : data;
  if (typeof withDoc === "object" && withDoc !== null && (withDoc as { doc?: unknown }).doc === null) {
    delete (withDoc as { doc?: unknown }).doc;
  }
  bridge.handle(new MessageEvent("message", { data: withDoc, source }));
}

/** Waits until the host has posted `count` messages to the frame. */
async function postedCount(count: number) {
  await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(count));
}

beforeEach(() => {
  backend = mockBackend();
  frame = document.createElement("iframe");
  other = document.createElement("iframe");
  document.body.append(frame, other);
  posted = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => void posted.push(message));
  ui = { openDetails: vi.fn<Fn>(), navigate: vi.fn<Fn>(), notify: vi.fn<Fn>(), close: vi.fn<Fn>() };
  onResize = vi.fn<(height: number) => void>();
  onFrameError = vi.fn<(message: string) => void>();
  bridge = createBridge({
    extensionId: "demo.ext",
    frame: () => frame.contentWindow,
    context: () => CONTEXT,
    ui,
    onResize,
    onFrameError,
  });
});

afterEach(() => {
  bridge.dispose();
  frame.remove();
  other.remove();
  backend.restore();
});

describe("extension message bridge", () => {
  it("ignores messages from any window but the frame's own, and messages without sextant: 1", async () => {
    backend.on("extension_call", () => ({ ok: true }));
    send({ sextant: 1, doc: DOC_A, id: 1, method: "clusters.list" }, other.contentWindow);
    send({ sextant: 1, doc: DOC_A, id: 2, method: "clusters.list" }, window);
    send({ sextant: 1, doc: DOC_A, id: 3, method: "clusters.list" }, null);
    send({ sextant: 2, id: 4, method: "clusters.list" });
    send({ id: 5, method: "clusters.list" });
    send("clusters.list");
    send({ sextant: 1, doc: DOC_A, id: 6, method: "ui.close" }, other.contentWindow);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls("extension_call")).toHaveLength(0);
    expect(ui.close).not.toHaveBeenCalled();
    expect(posted).toEqual([]);

    // The same call from the frame itself is served.
    send({ sextant: 1, doc: DOC_A, id: 7, method: "clusters.list" });
    await postedCount(1);
    expect(calls("extension_call")).toHaveLength(1);
    expect(posted).toEqual([{ sextant: 1, doc: DOC_A, id: 7, result: { ok: true } }]);
  });

  it("answers an unknown method with invalid and never asks the backend", async () => {
    send({ sextant: 1, doc: DOC_A, id: "a", method: "terminal.exec", params: { cmd: "sh" } });
    send({ sextant: 1, doc: DOC_A, id: "b", method: "__proto__" });
    await postedCount(2);
    expect(posted[0]).toMatchObject({ sextant: 1, doc: DOC_A, id: "a", error: { code: "invalid" } });
    expect(posted[1]).toMatchObject({ sextant: 1, doc: DOC_A, id: "b", error: { code: "invalid" } });
    expect(backend.calls.filter((c) => c.cmd.startsWith("extension_"))).toEqual([]);
  });

  it("forwards API methods to the backend as the extension and returns the result", async () => {
    backend.on("extension_call", () => ({ items: [{ metadata: { name: "web-1" } }] }));
    send({ sextant: 1, doc: DOC_A, id: 7, method: "resources.list", params: { clusterId: "c1", kind: { kind: "Pod" } } });
    await postedCount(1);
    expect(calls("extension_call")[0]!.args).toEqual({
      extensionId: "demo.ext",
      method: "resources.list",
      params: { clusterId: "c1", kind: { kind: "Pod" } },
      streamId: undefined,
    });
    expect(posted[0]).toEqual({ sextant: 1, doc: DOC_A, id: 7, result: { items: [{ metadata: { name: "web-1" } }] } });
  });

  it("passes the backend's refusal on as an error with its code", async () => {
    backend.on("extension_call", () => {
      throw { code: "denied", message: "Modify ConfigMaps in team-a is not granted" };
    });
    send({ sextant: 1, doc: DOC_A, id: 8, method: "resources.patch", params: {} });
    await postedCount(1);
    expect(posted[0]).toEqual({
      sextant: 1,
      doc: DOC_A,
      id: 8,
      error: { code: "denied", message: "Modify ConfigMaps in team-a is not granted" },
    });
  });

  it("sends the context on ready and on request", async () => {
    send({ sextant: 1, type: "ready" });
    send({ sextant: 1, doc: DOC_A, id: 9, method: "context.get" });
    await postedCount(2);
    expect(posted[0]).toEqual({ sextant: 1, doc: DOC_A, type: "context", context: CONTEXT });
    expect(posted[1]).toEqual({ sextant: 1, doc: DOC_A, id: 9, result: CONTEXT });
    bridge.pushContext();
    expect(posted[2]).toEqual({ sextant: 1, doc: DOC_A, type: "context", context: CONTEXT });
  });

  it("handles ui methods in the window", async () => {
    const ref = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "a", name: "web-1" };
    send({ sextant: 1, doc: DOC_A, id: 1, method: "ui.openDetails", params: ref });
    send({ sextant: 1, doc: DOC_A, id: 2, method: "ui.navigate", params: { page: "overview" } });
    send({ sextant: 1, doc: DOC_A, id: 3, method: "ui.notify", params: { text: "done" } });
    send({ sextant: 1, doc: DOC_A, id: 4, method: "ui.close" });
    await postedCount(4);
    expect(ui.openDetails).toHaveBeenCalledWith(ref);
    expect(ui.navigate).toHaveBeenCalledWith({ page: "overview" });
    expect(ui.notify).toHaveBeenCalledWith({ text: "done" });
    expect(ui.close).toHaveBeenCalled();
    expect(posted).toEqual([1, 2, 3, 4].map((id) => ({ sextant: 1, doc: DOC_A, id, result: null })));
    expect(calls("extension_call")).toHaveLength(0);
  });

  it("answers a failing ui method with the error", async () => {
    ui.navigate.mockImplementation(() => {
      throw new ApiError("notFound", "no page nope");
    });
    send({ sextant: 1, doc: DOC_A, id: 1, method: "ui.navigate", params: { page: "nope" } });
    await postedCount(1);
    expect(posted[0]).toEqual({ sextant: 1, doc: DOC_A, id: 1, error: { code: "notFound", message: "no page nope" } });
  });

  it("reports resize and errors of the frame", () => {
    send({ sextant: 1, type: "resize", height: 240 });
    send({ sextant: 1, type: "resize", height: 999_999 });
    send({ sextant: 1, type: "resize", height: "tall" });
    send({ sextant: 1, type: "error", message: "TypeError: x is undefined" });
    expect(onResize.mock.calls).toEqual([[240], [5000]]);
    expect(onFrameError).toHaveBeenCalledWith("TypeError: x is undefined");
  });

  it("streams a watch under the id of its call, stops it on unwatch and on dispose", async () => {
    backend.on("extension_call", () => null);
    backend.on("extension_watch_stop", () => undefined);
    send({ sextant: 1, doc: DOC_A, id: "w1", method: "resources.watch", params: { clusterId: "c1", kind: { kind: "Pod" } } });
    await vi.waitFor(() => expect(calls("extension_call")).toHaveLength(1));
    const streamId = calls("extension_call")[0]!.args.streamId as string;
    expect(streamId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    await postedCount(1);
    expect(posted[0]).toEqual({ sextant: 1, doc: DOC_A, id: "w1", result: { stream: "w1" } });

    backend.emit(`ext-watch:${streamId}`, { type: "snapshot", items: [] });
    expect(posted[1]).toEqual({ sextant: 1, doc: DOC_A, stream: "w1", event: { type: "snapshot", items: [] } });

    // The same id cannot open a second stream while the first is open.
    send({ sextant: 1, doc: DOC_A, id: "w1", method: "resources.watch", params: {} });
    await postedCount(3);
    expect(posted[2]).toMatchObject({ id: "w1", error: { code: "invalid" } });

    send({ sextant: 1, doc: DOC_A, id: 2, method: "resources.unwatch", params: { stream: "w1" } });
    await vi.waitFor(() => expect(calls("extension_watch_stop")).toHaveLength(1));
    expect(calls("extension_watch_stop")[0]!.args).toEqual({ extensionId: "demo.ext", streamId });
    expect(backend.listenerCount(`ext-watch:${streamId}`)).toBe(0);

    send({ sextant: 1, doc: DOC_A, id: "w2", method: "resources.watch", params: {} });
    await vi.waitFor(() => expect(calls("extension_call")).toHaveLength(2));
    const second = calls("extension_call")[1]!.args.streamId as string;
    await vi.waitFor(() => expect(posted).toContainEqual({ sextant: 1, doc: DOC_A, id: "w2", result: { stream: "w2" } }));
    bridge.dispose();
    await vi.waitFor(() => expect(calls("extension_watch_stop")).toHaveLength(2));
    expect(calls("extension_watch_stop")[1]!.args).toEqual({ extensionId: "demo.ext", streamId: second });
  });

  it("answers a watch that could not start with its error", async () => {
    backend.on("extension_call", () => {
      throw { code: "denied", message: "Read Secrets is not granted" };
    });
    send({ sextant: 1, doc: DOC_A, id: "w", method: "resources.watch", params: {} });
    await postedCount(1);
    expect(posted[0]).toEqual({ sextant: 1, doc: DOC_A, id: "w", error: { code: "denied", message: "Read Secrets is not granted" } });
  });

  it("posts nothing after it is disposed", async () => {
    let finish: (value: unknown) => void = () => {};
    backend.on("extension_call", () => new Promise((resolve) => (finish = resolve)));
    send({ sextant: 1, doc: DOC_A, id: 1, method: "kinds", params: { clusterId: "c1" } });
    await vi.waitFor(() => expect(calls("extension_call")).toHaveLength(1));
    bridge.dispose();
    finish([]);
    await new Promise((r) => setTimeout(r, 20));
    send({ sextant: 1, doc: DOC_A, id: 2, method: "context.get" });
    expect(posted).toEqual([]);
  });
});

describe("documents in the frame", () => {
  const watchCalls = () => calls("extension_call").filter((c) => c.args.method === "resources.watch");
  const stopped = () => calls("extension_watch_stop").map((c) => c.args.streamId);
  const settle = () => new Promise((r) => setTimeout(r, 20));

  async function openWatch(doc: string, id: RequestId) {
    send({ sextant: 1, doc, id, method: "resources.watch", params: {} });
    await vi.waitFor(() => expect(posted).toContainEqual({ sextant: 1, doc, id, result: { stream: id } }));
    return watchCalls().at(-1)!.args.streamId as string;
  }

  beforeEach(() => {
    backend.on("extension_call", () => null);
    backend.on("extension_watch_stop", () => undefined);
  });

  it("ignores a message without a valid doc", async () => {
    send({ sextant: 1, doc: null, id: 1, method: "clusters.list" });
    send({ sextant: 1, doc: "short", id: 2, method: "clusters.list" });
    send({ sextant: 1, doc: 42, type: "ready" });
    await settle();
    expect(calls("extension_call")).toHaveLength(0);
    expect(posted).toEqual([]);
  });

  it("keeps a new document that starts before the load apart from the old one, and ends the old one at the load", async () => {
    bridge.frameLoaded();
    send({ sextant: 1, doc: DOC_A, type: "ready" });
    const oldStream = await openWatch(DOC_A, 1);

    // The page reloads: the new document says ready and watches with id 1 before the frame's load event.
    send({ sextant: 1, doc: DOC_B, type: "ready" });
    expect(posted.at(-1)).toEqual({ sextant: 1, doc: DOC_B, type: "context", context: CONTEXT });
    const newStream = await openWatch(DOC_B, 1);
    expect(newStream).not.toBe(oldStream);
    expect(posted).not.toContainEqual(expect.objectContaining({ doc: DOC_B, error: expect.anything() }));

    // An update of the old watch is the old document's: it never goes out as document B's.
    posted.length = 0;
    backend.emit(`ext-watch:${oldStream}`, { type: "reconnecting" });
    backend.emit(`ext-watch:${newStream}`, { type: "snapshot", items: [] });
    expect(posted.filter((m) => (m as { doc?: string }).doc === DOC_B)).toEqual([
      { sextant: 1, doc: DOC_B, stream: 1, event: { type: "snapshot", items: [] } },
    ]);

    bridge.frameLoaded();
    await vi.waitFor(() => expect(stopped()).toEqual([oldStream]));
    expect(backend.listenerCount(`ext-watch:${newStream}`)).toBe(1);
    expect(posted.at(-1)).toMatchObject({ doc: DOC_B, type: "context" });
    // The old document's late messages are ignored.
    send({ sextant: 1, doc: DOC_A, id: 5, method: "clusters.list" });
    await settle();
    expect(calls("extension_call").filter((c) => c.args.method === "clusters.list")).toHaveLength(0);
  });

  it("drops the answers of a document that ended", async () => {
    let finish: (value: unknown) => void = () => {};
    backend.on("extension_call", () => new Promise((r) => (finish = r)));
    // Document A says ready before its load, as the SDK does.
    send({ sextant: 1, doc: DOC_A, type: "ready" });
    bridge.frameLoaded();
    send({ sextant: 1, doc: DOC_A, id: 2, method: "kinds", params: { clusterId: "c1" } });
    await vi.waitFor(() => expect(calls("extension_call")).toHaveLength(1));
    // `location.reload()` of a document without the SDK: nothing said ready since the previous load.
    bridge.frameLoaded();
    finish([]);
    await settle();
    expect(posted).not.toContainEqual(expect.objectContaining({ id: 2 }));
  });

  it("ends a document that said ready after its load once the next one says ready", async () => {
    bridge.frameLoaded();
    // Async start-up: document A says ready after the frame's load.
    send({ sextant: 1, doc: DOC_A, type: "ready" });
    const oldStream = await openWatch(DOC_A, 1);
    bridge.frameLoaded();
    // Document B starts late too.
    send({ sextant: 1, doc: DOC_B, type: "ready" });
    await vi.waitFor(() => expect(stopped()).toEqual([oldStream]));
    expect(backend.listenerCount(`ext-watch:${oldStream}`)).toBe(0);
    posted.length = 0;
    backend.emit(`ext-watch:${oldStream}`, { type: "reconnecting" });
    const newStream = await openWatch(DOC_B, 1);
    expect(newStream).not.toBe(oldStream);
    expect(posted.filter((m) => (m as { stream?: unknown }).stream !== undefined)).toEqual([]);
  });

  it("ends the oldest document that is neither current nor kept when a frame reaches its document limit", async () => {
    bridge.frameLoaded();
    send({ sextant: 1, doc: DOC_A, type: "ready" });
    // The current document makes up seven more ids and opens a watch under each: the frame is full.
    const filler = Array.from({ length: MAX_DOCUMENTS_PER_FRAME - 1 }, (_, i) => `${i}`.repeat(32));
    const fillerStreams: string[] = [];
    for (const doc of filler) fillerStreams.push(await openWatch(doc, 1));
    const currentStream = await openWatch(DOC_A, 1);

    // The next document still gets its context, and the oldest stray document ends for it.
    send({ sextant: 1, doc: DOC_B, type: "ready" });
    expect(posted.at(-1)).toEqual({ sextant: 1, doc: DOC_B, type: "context", context: CONTEXT });
    await vi.waitFor(() => expect(stopped()).toEqual([fillerStreams[0]]));
    expect(stopped()).not.toContain(currentStream);
    await openWatch(DOC_B, 1);
    send({ sextant: 1, doc: filler[0], id: 2, method: "clusters.list" });
    await settle();
    expect(calls("extension_call").filter((c) => c.args.method === "clusters.list")).toHaveLength(0);
  });

  it("limits open watches per document", async () => {
    send({ sextant: 1, doc: DOC_A, type: "ready" });
    for (let id = 1; id <= 32; id++) await openWatch(DOC_A, id);
    send({ sextant: 1, doc: DOC_A, id: 33, method: "resources.watch", params: {} });
    await vi.waitFor(() =>
      expect(posted.at(-1)).toMatchObject({ doc: DOC_A, id: 33, error: { code: "invalid" } }),
    );
    // Another document has a limit of its own.
    send({ sextant: 1, doc: DOC_B, type: "ready" });
    await openWatch(DOC_B, 1);
  });
});
