// The frame client against a test double of Sextant's window: what it sends, and how it reads what comes back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, isSextantError, SextantError, type Sextant, type WatchUpdate } from "../src";
import type { FrameMessage, HostContext } from "../src/protocol";

const CONTEXT: HostContext = {
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

let hostFrame: HTMLIFrameElement;
let host: Window;
let sent: FrameMessage[];
let clients: Sextant[];

type Request = Extract<FrameMessage, { method: string }>;
const requests = () => sent.filter((m): m is Request => "method" in m);
const lastRequest = () => requests().at(-1)!;
const docOf = () => sent[0]!.doc;

/** A message from the window to the frame. */
function deliver(data: unknown, source: unknown = host) {
  window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }));
}
const answer = (id: string | number, result: unknown, doc = docOf()) => deliver({ sextant: 1, doc, id, result });
const refuse = (id: string | number, code: string, message: string) =>
  deliver({ sextant: 1, doc: docOf(), id, error: { code, message } });
const sendContext = (context: HostContext = CONTEXT, doc = docOf()) =>
  deliver({ sextant: 1, doc, type: "context", context });

/** Connects and answers `ready` with `context`. */
async function connected(context: HostContext = CONTEXT, options = {}): Promise<Sextant> {
  const pending = connect({ host, ...options });
  sendContext(context);
  const client = await pending;
  clients.push(client);
  return client;
}

/** Waits for the request after `count` requests and returns it. */
async function nextRequest(count: number): Promise<Request> {
  await vi.waitFor(() => expect(requests().length).toBeGreaterThan(count));
  return requests()[count]!;
}

beforeEach(() => {
  hostFrame = document.createElement("iframe");
  document.body.append(hostFrame);
  host = hostFrame.contentWindow!;
  sent = [];
  clients = [];
  vi.spyOn(host, "postMessage").mockImplementation((message: unknown) => void sent.push(structuredClone(message) as FrameMessage));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const client of clients) client.disconnect();
  hostFrame.remove();
  vi.useRealTimers();
});

describe("connect", () => {
  it("says ready first, with a 128-bit document id, and resolves with the first context", async () => {
    const pending = connect({ host });
    expect(sent[0]).toEqual({ sextant: 1, doc: expect.stringMatching(/^[0-9a-f]{32}$/), type: "ready" });
    sendContext();
    const client = await pending;
    clients.push(client);
    expect(client.context).toEqual(CONTEXT);
    expect(host.postMessage).toHaveBeenCalledWith(sent[0], "*");
  });

  it("makes up a new document id for every connection", async () => {
    const first = await connected();
    const firstDoc = docOf();
    first.disconnect();
    sent = [];
    await connected();
    expect(docOf()).not.toBe(firstDoc);
  });

  it("ignores contexts for another document, from another window or without sextant: 1", async () => {
    const pending = connect({ host, connectTimeoutMs: 1000 });
    let done = false;
    void pending.then(() => (done = true));
    sendContext(CONTEXT, "f".repeat(32));
    deliver({ sextant: 1, doc: docOf(), type: "context", context: CONTEXT }, window);
    deliver({ sextant: 2, doc: docOf(), type: "context", context: CONTEXT });
    deliver({ doc: docOf(), type: "context", context: CONTEXT });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    sendContext();
    clients.push(await pending);
  });

  it("says ready again until the window answers", async () => {
    vi.useFakeTimers();
    const pending = connect({ host });
    expect(sent.filter((m) => "type" in m && m.type === "ready")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    const readies = sent.filter((m) => "type" in m && m.type === "ready");
    expect(readies.length).toBeGreaterThan(2);
    expect(new Set(readies.map((m) => m.doc)).size).toBe(1);
    sendContext();
    clients.push(await pending);
    const after = sent.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.length).toBe(after);
  });

  it("fails with a timeout when no context comes", async () => {
    vi.useFakeTimers();
    const pending = connect({ host, connectTimeoutMs: 3000 });
    const outcome = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(3001);
    const err = await outcome;
    expect(isSextantError(err, "timeout")).toBe(true);
    expect((err as Error).message).toMatch(/inside Sextant/);
  });

  it("fails at once outside a frame", async () => {
    await expect(connect({ host: window })).rejects.toMatchObject({ code: "invalid" });
  });

  it("returns the same connection to every caller of the document", async () => {
    const parent = vi.spyOn(window, "parent", "get").mockReturnValue(host);
    const a = connect();
    const b = connect();
    expect(sent.filter((m) => "type" in m && m.type === "ready")).toHaveLength(1);
    sendContext();
    expect(await a).toBe(await b);
    clients.push(await a);
    parent.mockRestore();
  });
});

describe("calls", () => {
  it("send the method with a fresh id and the context's cluster, and resolve with the result", async () => {
    const sextant = await connected();
    const list = sextant.resources.list({ kind: { kind: "Pod" }, namespace: "default" });
    const get = sextant.resources.get({ clusterId: "c2", ref: { kind: { kind: "Pod" }, namespace: "a", name: "web" } });
    const [first, second] = requests();
    expect(first).toEqual({
      sextant: 1,
      doc: docOf(),
      id: expect.anything(),
      method: "resources.list",
      params: { clusterId: "c1", kind: { kind: "Pod" }, namespace: "default" },
    });
    expect(second!.params).toEqual({ clusterId: "c2", ref: { kind: { kind: "Pod" }, namespace: "a", name: "web" } });
    expect(first!.id).not.toEqual(second!.id);
    answer(second!.id, { metadata: { name: "web" } });
    answer(first!.id, { items: [], truncated: false });
    await expect(list).resolves.toEqual({ items: [], truncated: false });
    await expect(get).resolves.toEqual({ metadata: { name: "web" } });
  });

  it("send every method's parameters in the shape Sextant reads", async () => {
    const sextant = await connected();
    const ref = { kind: { group: "demo.sextant.dev", kind: "Widget" }, namespace: "ns", name: "w" };
    const calls: [() => Promise<unknown>, string, unknown][] = [
      [() => sextant.clusters.list(), "clusters.list", undefined],
      [() => sextant.kinds(), "kinds", { clusterId: "c1" }],
      [() => sextant.resources.apply({ yaml: "kind: X" }), "resources.apply", { clusterId: "c1", yaml: "kind: X" }],
      [
        () => sextant.resources.patch({ ref, patch: { spec: { replicas: 2 } }, patchType: "merge" }),
        "resources.patch",
        { clusterId: "c1", ref, patch: { spec: { replicas: 2 } }, patchType: "merge" },
      ],
      [() => sextant.resources.delete({ ref }), "resources.delete", { clusterId: "c1", ref }],
      [
        () => sextant.logs.tail({ namespace: "ns", pod: "p", lines: 10 }),
        "logs.tail",
        { clusterId: "c1", namespace: "ns", pod: "p", lines: 10 },
      ],
      [
        () => sextant.secret.value({ namespace: "ns", name: "s", key: "k" }),
        "secret.value",
        { clusterId: "c1", namespace: "ns", name: "s", key: "k" },
      ],
      [() => sextant.storage.get("size"), "storage.get", { key: "size" }],
      [() => sextant.storage.set("size", { step: 2 }), "storage.set", { key: "size", value: { step: 2 } }],
      [() => sextant.storage.remove("size"), "storage.remove", { key: "size" }],
      [() => sextant.ui.openDetails(ref), "ui.openDetails", ref],
      [() => sextant.ui.navigate("pods"), "ui.navigate", { page: "pods" }],
      [() => sextant.ui.notify("Scaled"), "ui.notify", { text: "Scaled" }],
      [() => sextant.ui.close(), "ui.close", undefined],
      [() => sextant.refreshContext(), "context.get", undefined],
    ];
    for (const [call, method, params] of calls) {
      const count = requests().length;
      const pending = call();
      const request = await nextRequest(count);
      expect(request.method).toBe(method);
      expect(request.params).toEqual(params);
      if (params === undefined) expect("params" in request).toBe(false);
      answer(request.id, method === "context.get" ? CONTEXT : null);
      await pending;
    }
  });

  it("leave out fields that are undefined (Sextant refuses unknown and malformed fields)", async () => {
    const sextant = await connected();
    void sextant.resources.list({ kind: { kind: "Pod" }, namespace: undefined, labelSelector: undefined }).catch(() => null);
    expect(lastRequest().params).toEqual({ clusterId: "c1", kind: { kind: "Pod" } });
  });

  it("fail with Sextant's code and message, and say so in the console", async () => {
    const sextant = await connected();
    const patch = sextant.resources.patch({
      ref: { kind: { kind: "Pod" }, namespace: "a", name: "web" },
      patch: {},
      patchType: "merge",
    });
    refuse(lastRequest().id, "denied", "Extension Demo may not modify Pods in a");
    const err = await patch.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SextantError);
    expect(err).toMatchObject({ code: "denied", message: "Extension Demo may not modify Pods in a", method: "resources.patch" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("resources.patch"), expect.anything());
  });

  it("ignore answers for another document", async () => {
    const sextant = await connected();
    const list = sextant.clusters.list();
    let settled = false;
    void list.then(() => (settled = true));
    answer(lastRequest().id, [], "e".repeat(32));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    answer(lastRequest().id, []);
    await expect(list).resolves.toEqual([]);
  });

  it("time out with a clear error, and ignore a late answer", async () => {
    const sextant = await connected();
    vi.useFakeTimers();
    const list = sextant.clusters.list({ timeoutMs: 500 });
    const outcome = list.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(501);
    const err = (await outcome) as SextantError;
    expect(err.code).toBe("timeout");
    expect(err.message).toContain("clusters.list");
    answer(lastRequest().id, []);
  });

  it("without a cluster in the context and none given, fail without asking", async () => {
    const sextant = await connected({ ...CONTEXT, clusterId: null });
    const count = requests().length;
    await expect(sextant.resources.list({ kind: { kind: "Pod" } })).rejects.toMatchObject({ code: "invalid" });
    expect(requests().length).toBe(count);
  });
});

describe("watch", () => {
  const params = { kind: { kind: "Pod" }, namespaces: ["default"] };
  const snapshot: WatchUpdate = { type: "snapshot", items: [{ metadata: { name: "web", uid: "1" } }] };
  const delta: WatchUpdate = { type: "delta", upserted: [], deleted: ["1"] };

  it("delivers updates sent before and after the answer to the callback", async () => {
    const sextant = await connected();
    const updates: WatchUpdate[] = [];
    const watch = sextant.resources.watch(params, (u) => updates.push(u));
    const request = lastRequest();
    expect(request).toMatchObject({ method: "resources.watch", params: { clusterId: "c1", ...params } });
    expect(watch.stream).toBe(request.id);
    deliver({ sextant: 1, doc: docOf(), stream: request.id, event: snapshot });
    answer(request.id, { stream: request.id });
    await watch.started;
    deliver({ sextant: 1, doc: docOf(), stream: request.id, event: delta });
    deliver({ sextant: 1, doc: "e".repeat(32), stream: request.id, event: delta });
    deliver({ sextant: 1, doc: docOf(), stream: "other", event: delta });
    expect(updates).toEqual([snapshot, delta]);
  });

  it("is an async iterator that ends on unwatch, which tells the window", async () => {
    const sextant = await connected();
    const watch = sextant.resources.watch(params);
    const id = lastRequest().id;
    answer(id, { stream: id });
    const seen: WatchUpdate[] = [];
    const loop = (async () => {
      for await (const update of watch) seen.push(update);
    })();
    deliver({ sextant: 1, doc: docOf(), stream: id, event: snapshot });
    await vi.waitFor(() => expect(seen).toEqual([snapshot]));
    const stop = watch.unwatch();
    const request = await nextRequest(requests().length - 1);
    expect(lastRequest()).toMatchObject({ method: "resources.unwatch", params: { stream: id } });
    answer(lastRequest().id, null);
    await stop;
    await loop;
    expect(request).toBeDefined();
    deliver({ sextant: 1, doc: docOf(), stream: id, event: delta });
    expect(seen).toEqual([snapshot]);
    expect(watch.closed).toBe(true);
  });

  it("breaking out of the loop stops the watch", async () => {
    const sextant = await connected();
    const watch = sextant.resources.watch(params);
    const id = lastRequest().id;
    answer(id, { stream: id });
    deliver({ sextant: 1, doc: docOf(), stream: id, event: snapshot });
    for await (const update of watch) {
      expect(update).toEqual(snapshot);
      break;
    }
    expect(lastRequest()).toMatchObject({ method: "resources.unwatch", params: { stream: id } });
  });

  it("that cannot start fails `started`, the iterator and onError", async () => {
    const sextant = await connected();
    const onError = vi.fn();
    const watch = sextant.resources.watch(params, { onError });
    refuse(lastRequest().id, "denied", "may not read Pods");
    await expect(watch.started).rejects.toMatchObject({ code: "denied" });
    await expect(
      (async () => {
        for await (const _ of watch) void _;
      })(),
    ).rejects.toMatchObject({ code: "denied" });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "denied" }));
    expect(watch.closed).toBe(true);
  });
});

describe("context, theme, size and errors", () => {
  it("follows context changes and applies the theme", async () => {
    const sextant = await connected();
    expect(document.documentElement.style.getPropertyValue("--color-text")).toBe("#dcddde");
    const seen: [string, string][] = [];
    const off = sextant.onContextChange((now, before) => seen.push([before.theme, now.theme]));
    const themes: string[] = [];
    sextant.onThemeChange((now) => themes.push(now.theme));
    sendContext({ ...CONTEXT, theme: "light", tokens: { "--color-text": "#1f2328" } });
    expect(seen).toEqual([["dark", "light"]]);
    expect(themes).toEqual(["light"]);
    expect(sextant.context.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--color-text")).toBe("#1f2328");
    // A context with the same look is not a theme change.
    sendContext({ ...CONTEXT, theme: "light", tokens: { "--color-text": "#1f2328" }, clusterId: "c2" });
    expect(themes).toEqual(["light"]);
    off();
    sendContext();
    expect(seen).toHaveLength(2);
  });

  it("can leave the theme alone", async () => {
    document.documentElement.removeAttribute("style");
    await connected(CONTEXT, { theme: false });
    expect(document.documentElement.style.getPropertyValue("--color-text")).toBe("");
  });

  it("reports uncaught errors and unhandled rejections to the window", async () => {
    await connected();
    window.dispatchEvent(new ErrorEvent("error", { message: "TypeError: x is undefined", error: new TypeError("x") }));
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    Object.defineProperty(rejection, "reason", { value: new SextantError("denied", "no") });
    window.dispatchEvent(rejection);
    const errors = sent.filter((m) => "type" in m && m.type === "error");
    expect(errors).toEqual([
      { sextant: 1, doc: docOf(), type: "error", message: "TypeError: x is undefined" },
      { sextant: 1, doc: docOf(), type: "error", message: "SextantError: no" },
    ]);
  });

  it("asks for a height, and keeps a details section as tall as its content", async () => {
    const observers: { callback: () => void; targets: Element[] }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets: Element[] = [];
        constructor(readonly callback: () => void) {
          observers.push(this);
        }
        observe(target: Element) {
          this.targets.push(target);
        }
        disconnect() {}
      },
    );
    const sextant = await connected({ ...CONTEXT, view: "details" });
    sextant.resize(120.4);
    expect(sent.filter((m) => "type" in m && m.type === "resize").at(-1)).toEqual({
      sextant: 1,
      doc: docOf(),
      type: "resize",
      height: 121,
    });
    expect(observers).toHaveLength(1);
    expect(observers[0]!.targets).toContain(document.body);
    observers[0]!.callback();
    expect(sent.filter((m) => "type" in m && m.type === "resize").length).toBeGreaterThanOrEqual(2);
    sextant.disconnect();
    sent = [];
    // The settings section is sized by its content too; a page is not.
    clients.push(await connected({ ...CONTEXT, view: "settings" }));
    expect(observers).toHaveLength(2);
    sent = [];
    clients.push(await connected({ ...CONTEXT, view: "page" }));
    expect(observers).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});
