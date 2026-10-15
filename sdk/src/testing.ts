// A stand-in for Sextant's window, for an extension's unit tests (in a DOM environment such as jsdom): the real client
// talks to it over `postMessage`, and it answers from a table of handlers. Import it from
// `@sextant/extension-sdk/testing`.
//
//   const host = await startTestHost({ context: { view: "action", selection: [ref] }, handlers: {
//     "resources.get": () => widget,
//     "resources.patch": ({ patch }) => ({ ...widget, ...patch }),
//   } });
//   await scale(host.sextant, 5);
//   expect(host.calls.at(-1)).toMatchObject({ method: "resources.patch" });
//   host.close();
import type { WatchUpdate } from "./api";
import { connect, type Sextant } from "./client";
import { SextantError } from "./errors";
import { PROTOCOL_VERSION, type HostContext, type RequestId } from "./protocol";

/** A handler's answer: a value (or a promise of one); throwing a `SextantError` or `{code, message}` refuses. */
export type TestHandler = (params: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface TestHostOptions {
  context?: Partial<HostContext>;
  /** Answers by method; without one, a method fails with `notFound` (storage, ui and watch have defaults). */
  handlers?: Record<string, TestHandler>;
}

export interface TestCall {
  method: string;
  params: unknown;
}

export interface TestWatch {
  stream: RequestId;
  params: unknown;
  /** Sends an update of this watch. */
  emit(update: WatchUpdate): void;
  /** The frame stopped it. */
  stopped: boolean;
}

export interface TestHost {
  sextant: Sextant;
  /** Every call the frame made, in order. */
  readonly calls: TestCall[];
  /** Watches the frame opened, in order. */
  readonly watches: TestWatch[];
  /** The extension's storage (`storage.*`). */
  readonly storage: Map<string, unknown>;
  /** Notices (`ui.notify`) and whether `ui.close` was called. */
  readonly notices: string[];
  readonly closedByFrame: boolean;
  /** Errors the frame reported (`{type: "error"}`) and heights it asked for. */
  readonly errors: string[];
  readonly heights: number[];
  /** Changes the context and sends it to the frame. */
  setContext(patch: Partial<HostContext>): void;
  /** Disconnects the client and removes the stand-in. */
  close(): void;
}

export const TEST_CONTEXT: HostContext = {
  apiVersion: PROTOCOL_VERSION,
  extensionId: "test.extension",
  view: "page",
  contribution: "main",
  clusterId: "test-cluster",
  namespaces: null,
  theme: "light",
  language: "en",
  tokens: {},
  selection: [],
  resourceVersion: null,
};

/** Starts the stand-in and connects a client to it. */
export async function startTestHost(options: TestHostOptions = {}): Promise<TestHost> {
  const element = document.createElement("iframe");
  document.body.append(element);
  const hostWindow = element.contentWindow!;
  let context: HostContext = { ...TEST_CONTEXT, ...options.context };
  let doc: string | null = null;
  const calls: TestCall[] = [];
  const watches: TestWatch[] = [];
  const storage = new Map<string, unknown>();
  const notices: string[] = [];
  const errors: string[] = [];
  const heights: number[] = [];
  let closedByFrame = false;

  const toFrame = (message: Record<string, unknown>) => {
    if (doc === null) return;
    const data = structuredClone({ sextant: PROTOCOL_VERSION, doc, ...message });
    window.dispatchEvent(new MessageEvent("message", { data, source: hostWindow }));
  };

  const defaults: Record<string, TestHandler> = {
    "context.get": () => context,
    "storage.get": ({ key }) => (storage.has(key) ? storage.get(key) : null),
    "storage.set": ({ key, value }) => void storage.set(key, value),
    "storage.remove": ({ key }) => void storage.delete(key),
    "ui.notify": ({ text }) => void notices.push(text),
    "ui.close": () => void (closedByFrame = true),
    "ui.navigate": () => null,
    "ui.openDetails": () => null,
  };
  const handlers = { ...defaults, ...options.handlers };

  const answer = async (id: RequestId, method: string, params: unknown) => {
    try {
      if (method === "resources.watch") {
        const watch: TestWatch = {
          stream: id,
          params,
          stopped: false,
          emit: (update) => {
            if (!watch.stopped) toFrame({ stream: id, event: update });
          },
        };
        if (handlers["resources.watch"]) await handlers["resources.watch"](params);
        watches.push(watch);
        toFrame({ id, result: { stream: id } });
        return;
      }
      if (method === "resources.unwatch") {
        const stream = (params as { stream: RequestId }).stream;
        for (const w of watches) if (w.stream === stream) w.stopped = true;
        toFrame({ id, result: null });
        return;
      }
      const handler = handlers[method];
      if (!handler) throw new SextantError("notFound", `the test host has no handler for ${method}`);
      const result = await handler(params);
      toFrame({ id, result: result === undefined ? null : result });
    } catch (err) {
      const record = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; message?: unknown };
      const code = typeof record.code === "string" ? record.code : "other";
      const message = typeof record.message === "string" ? record.message : String(err);
      toFrame({ id, error: { code, message } });
    }
  };

  hostWindow.postMessage = ((message: unknown) => {
    const data = structuredClone(message) as Record<string, unknown>;
    if (data.sextant !== PROTOCOL_VERSION || typeof data.doc !== "string") return;
    if (data.type === "ready") {
      doc = data.doc;
      toFrame({ type: "context", context });
    } else if (data.type === "error") {
      errors.push(String(data.message));
    } else if (data.type === "resize") {
      heights.push(Number(data.height));
    } else if (typeof data.method === "string") {
      calls.push({ method: data.method, params: data.params });
      void answer(data.id as RequestId, data.method, data.params);
    }
  }) as Window["postMessage"];

  const sextant = await connect({ host: hostWindow });
  return {
    sextant,
    calls,
    watches,
    storage,
    notices,
    errors,
    heights,
    get closedByFrame() {
      return closedByFrame;
    },
    setContext(patch) {
      context = { ...context, ...patch };
      toFrame({ type: "context", context });
    },
    close() {
      sextant.disconnect();
      element.remove();
    },
  };
}
