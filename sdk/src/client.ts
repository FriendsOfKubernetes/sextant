// The frame side of Sextant's extension protocol (Sextant's `src/extensions/protocol.ts`).
//
// `connect()` makes up the document id (`doc`, 128 random bits), says `ready` at once (and again until the window
// answers), and resolves with the first context sent to this document. Every message carries `doc`; messages from any
// window but the parent, without `sextant: 1` or for another document are ignored. Calls get ids of their own and
// answers are matched by id; a call without an answer in time fails with `timeout`. `resources.watch` updates arrive
// under the id of the watch call, so the client listens before it sends the call.
import type {
  ApplyParams,
  CallOptions,
  ClusterSummary,
  DeleteParams,
  GetParams,
  JsonValue,
  KindsParams,
  KubeObject,
  ListParams,
  ListResult,
  LogsParams,
  Methods,
  ObjectRef,
  PatchParams,
  RefInput,
  ResourceKind,
  SecretParams,
  WatchParams,
  WatchUpdate,
} from "./api";
import { SextantError, toSextantError } from "./errors";
import { PROTOCOL_VERSION, type FrameMessage, type HostContext, type RequestId } from "./protocol";
import { applyTheme, type ThemeOptions } from "./theme";

export interface ConnectOptions {
  /** Apply Sextant's theme (CSS variables, `data-theme`, base styles) and follow its changes. Default `true`. */
  theme?: boolean | ThemeOptions;
  /** Report uncaught errors and unhandled rejections to Sextant, which shows "Extension failed". Default `true`. */
  reportErrors?: boolean;
  /** Keep the frame as tall as its content. Default: `true` in a details section and the settings section, whose
   * frames Sextant sizes by the content (`view` `details` or `settings`). */
  autoResize?: boolean;
  /** Write failed calls to the console. Default `true`. */
  logFailures?: boolean;
  /** How long to wait for Sextant's first context, in milliseconds. Default 10 000. */
  connectTimeoutMs?: number;
  /** Default answer timeout of reads and other calls. Default 60 000. */
  timeoutMs?: number;
  /** Default answer timeout of changes (apply, patch, delete), which may wait for the user's "Allow". Default 180 000. */
  changeTimeoutMs?: number;
  /** The window to talk to. Default `window.parent`; for tests. */
  host?: Window;
  /** The frame's own window. Default `window`; for tests. */
  window?: Window;
}

/** What to do with the updates of a watch. */
export interface WatchHandlers {
  onUpdate?: (update: WatchUpdate) => void;
  /** The watch could not start (refused, timed out). */
  onError?: (error: SextantError) => void;
}

/** An open `resources.watch`: updates by callback or `for await`; `unwatch()` (or leaving the loop) stops it. */
export interface Watch extends AsyncIterable<WatchUpdate> {
  /** The id of the watch call, which names its updates. */
  readonly stream: RequestId;
  /** Resolves when Sextant runs the watch; rejects with the reason it does not. */
  readonly started: Promise<void>;
  /** The watch ended (unwatched, failed to start, or the connection was closed). */
  readonly closed: boolean;
  /** Adds a listener of updates; returns the function that removes it. */
  onUpdate(listener: (update: WatchUpdate) => void): () => void;
  unwatch(): Promise<void>;
}

export interface Sextant {
  /** Where the frame is shown, as of the last context Sextant sent. */
  readonly context: HostContext;
  /** Called with the new and the previous context whenever Sextant sends one; returns the unsubscribe function. */
  onContextChange(listener: (context: HostContext, previous: HostContext) => void): () => void;
  /** Called when the theme or its tokens change. */
  onThemeChange(listener: (context: HostContext) => void): () => void;
  /** Asks Sextant for the context again (`context.get`). */
  refreshContext(options?: CallOptions): Promise<HostContext>;

  clusters: { list(options?: CallOptions): Promise<ClusterSummary[]> };
  /** The kinds the cluster serves that the extension may use. */
  kinds(params?: KindsParams, options?: CallOptions): Promise<ResourceKind[]>;
  resources: {
    list<T = KubeObject>(params: ListParams, options?: CallOptions): Promise<ListResult<T>>;
    get<T = KubeObject>(params: GetParams, options?: CallOptions): Promise<T>;
    /** Watches objects: a snapshot first, then deltas (objects changed, uids deleted), batched by Sextant. */
    watch(
      params: WatchParams,
      handlers?: WatchHandlers | ((update: WatchUpdate) => void),
      options?: CallOptions,
    ): Watch;
    /** Applies YAML documents (server-side apply); the objects applied. */
    apply(params: ApplyParams, options?: CallOptions): Promise<ObjectRef[]>;
    patch<T = KubeObject>(params: PatchParams, options?: CallOptions): Promise<T>;
    delete(params: DeleteParams, options?: CallOptions): Promise<void>;
  };
  logs: { tail(params: LogsParams, options?: CallOptions): Promise<string> };
  /** One value of a Secret (needs the "Secret values" permission). */
  secret: { value(params: SecretParams, options?: CallOptions): Promise<string> };
  /**
   * The extension's own backend (ADR-0131), when its manifest declares one: `handle(method, params)` of its
   * WebAssembly component, with the answer it returns. A call is limited to 10 s and 1 MB each way.
   */
  backend: {
    call<T = JsonValue>(method: string, params?: JsonValue, options?: CallOptions): Promise<T>;
  };
  /** The extension's own data, kept by Sextant (at most 1 MB in all). */
  storage: {
    get<T extends JsonValue = JsonValue>(key: string, options?: CallOptions): Promise<T | null>;
    set(key: string, value: JsonValue, options?: CallOptions): Promise<void>;
    remove(key: string, options?: CallOptions): Promise<void>;
  };
  ui: {
    /** Opens the details panel of an object (in the active cluster). */
    openDetails(ref: RefInput | ObjectRef, options?: CallOptions): Promise<void>;
    /** Opens a page: one of the extension's own page ids, a Sextant page, or a table view (`kind:<group>/<Kind>`). */
    navigate(page: string, options?: CallOptions): Promise<void>;
    /** A short notice in Sextant's window (at most 500 characters). */
    notify(text: string, options?: CallOptions): Promise<void>;
    /** Closes the action's window or the dock tab. */
    close(options?: CallOptions): Promise<void>;
  };
  /** Any method, by name. */
  call<M extends keyof Methods>(method: M, params: Methods[M]["params"], options?: CallOptions): Promise<Methods[M]["result"]>;
  /** Asks to be `height` CSS pixels tall (details sections); default: the height of the content. */
  resize(height?: number): void;
  /** Keeps the frame as tall as its content until the returned function is called. */
  autoResize(): () => void;
  /** Reports an error to Sextant, which shows "Extension failed" with its message. */
  reportError(error: unknown): void;
  /** Stops listening: open watches end, pending calls fail. */
  disconnect(): void;
}

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_CHANGE_TIMEOUT = 180_000;
/** Views whose frame Sextant sizes by the content (`resize`); a details tab fills the panel and ignores it. */
const AUTO_HEIGHT_VIEWS: ReadonlySet<string> = new Set(["details", "settings"]);
const CHANGES: ReadonlySet<string> = new Set(["resources.apply", "resources.patch", "resources.delete"]);
/** `ready` is said again after these delays (ms) until a context comes; then every 2 s. */
const READY_RETRIES = [100, 250, 500, 1000];

const connections = new WeakMap<Window, Promise<Sextant>>();

/**
 * Connects the page to Sextant. Every call in the same document gets the same connection (unless `host` is given).
 * Fails with `invalid` outside a Sextant frame and with `timeout` when Sextant does not answer.
 */
export function connect(options: ConnectOptions = {}): Promise<Sextant> {
  const win = options.window ?? window;
  if (options.host) return open(win, options.host, options);
  let connection = connections.get(win);
  if (!connection) {
    connection = open(win, win.parent, options);
    connections.set(win, connection);
    connection.catch(() => connections.delete(win));
  }
  return connection;
}

/** 128 random bits as 32 hex digits. */
function newDocumentId(win: Window): string {
  const bytes = new Uint8Array(16);
  win.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON as Sextant reads it: `undefined` fields are left out (an unknown or malformed field is refused). */
const plain = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

interface Pending {
  method: string;
  resolve(result: unknown): void;
  reject(error: SextantError): void;
  timer: ReturnType<typeof setTimeout>;
}

interface StreamState {
  deliver(update: WatchUpdate): void;
  fail(error: SextantError): void;
  end(): void;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
  return String(error);
}

function open(win: Window, host: Window, options: ConnectOptions): Promise<Sextant> {
  if (host === win || !host) {
    return Promise.reject(
      new SextantError("invalid", "This page is not inside a Sextant extension frame; open it from Sextant."),
    );
  }
  const doc = newDocumentId(win);
  const pending = new Map<RequestId, Pending>();
  const streams = new Map<RequestId, StreamState>();
  const contextListeners = new Set<(context: HostContext, previous: HostContext) => void>();
  const themeListeners = new Set<(context: HostContext) => void>();
  const cleanups: (() => void)[] = [];
  let nextId = 1;
  let current: HostContext | null = null;
  let closed = false;
  const logFailures = options.logFailures !== false;
  const themeOptions: ThemeOptions | null =
    options.theme === false ? null : typeof options.theme === "object" ? options.theme : {};

  const post = (message: FrameMessage) => {
    if (!closed) host.postMessage(message, "*");
  };
  post({ sextant: PROTOCOL_VERSION, doc, type: "ready" });

  const timeoutFor = (method: string, callOptions?: CallOptions) =>
    callOptions?.timeoutMs ??
    (CHANGES.has(method)
      ? (options.changeTimeoutMs ?? DEFAULT_CHANGE_TIMEOUT)
      : (options.timeoutMs ?? DEFAULT_TIMEOUT));

  /** Sends a call; `id` is given for a watch, whose updates are listened for before the call goes out. */
  const send = <R>(method: string, params: unknown, callOptions?: CallOptions, id: RequestId = nextId++): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      if (closed) {
        reject(new SextantError("other", `${method}: the connection to Sextant was closed`, method));
        return;
      }
      const ms = timeoutFor(method, callOptions);
      const timer = setTimeout(() => {
        pending.delete(id);
        const seconds = Math.round(ms / 100) / 10;
        reject(new SextantError("timeout", `${method}: no answer from Sextant in ${seconds} s`, method));
      }, ms);
      pending.set(id, { method, resolve: resolve as (r: unknown) => void, reject, timer });
      const message: FrameMessage = { sextant: PROTOCOL_VERSION, doc, id, method };
      if (params !== undefined) message.params = plain(params);
      post(message);
    }).catch((err: unknown) => {
      const error = err instanceof SextantError ? err : toSextantError(err, method);
      if (logFailures) console.warn(`[sextant] ${method} failed: ${error.code}: ${error.message}`, error);
      throw error;
    });

  const clusterOf = (clusterId: string | undefined, method: string): string => {
    const id = clusterId ?? current?.clusterId ?? null;
    if (!id) throw new SextantError("invalid", `${method}: no cluster is open; pass clusterId`, method);
    return id;
  };
  /** A call on a cluster: `clusterId` defaults to the context's. */
  const onCluster = <R>(method: string, params: { clusterId?: string }, callOptions?: CallOptions): Promise<R> => {
    try {
      return send<R>(method, { ...params, clusterId: clusterOf(params.clusterId, method) }, callOptions);
    } catch (err) {
      return Promise.reject(err);
    }
  };

  const reportError = (error: unknown) => {
    post({ sextant: PROTOCOL_VERSION, doc, type: "error", message: errorText(error) });
  };

  const measure = () => {
    const body = win.document.body;
    if (!body) return 0;
    const margin = parseFloat(win.getComputedStyle(body).marginBottom) || 0;
    return Math.max(body.getBoundingClientRect().bottom + margin, body.scrollHeight);
  };
  const resize = (height?: number) => {
    const value = Math.ceil(height ?? measure());
    if (Number.isFinite(value)) post({ sextant: PROTOCOL_VERSION, doc, type: "resize", height: Math.max(0, value) });
  };
  const autoResize = () => {
    const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    let last = -1;
    const update = () => {
      const height = Math.ceil(measure());
      if (height !== last) {
        last = height;
        resize(height);
      }
    };
    update();
    if (!Observer) return () => undefined;
    const observer = new Observer(() => update());
    observer.observe(win.document.documentElement);
    if (win.document.body) observer.observe(win.document.body);
    const stop = () => observer.disconnect();
    cleanups.push(stop);
    return stop;
  };

  const watch = (
    params: WatchParams,
    handlers?: WatchHandlers | ((update: WatchUpdate) => void),
    callOptions?: CallOptions,
  ): Watch => {
    const id = nextId++;
    const { onUpdate, onError } = typeof handlers === "function" ? { onUpdate: handlers, onError: undefined } : (handlers ?? {});
    const listeners = new Set<(update: WatchUpdate) => void>();
    if (onUpdate) listeners.add(onUpdate);
    // Iterators waiting: each has its own queue.
    const iterators = new Set<{ push(u: WatchUpdate): void; fail(e: SextantError): void; end(): void }>();
    let failure: SextantError | null = null;
    let ended = false;
    // Updates that came while nobody listened: the first listener or iterator gets them.
    const backlog: WatchUpdate[] = [];

    const finish = () => {
      if (ended) return;
      ended = true;
      streams.delete(id);
      for (const it of iterators) it.end();
      iterators.clear();
      listeners.clear();
    };
    streams.set(id, {
      deliver: (update) => {
        if (listeners.size === 0 && iterators.size === 0) {
          backlog.push(update);
          return;
        }
        for (const listener of [...listeners]) listener(update);
        for (const it of iterators) it.push(update);
      },
      fail: (error) => {
        failure = error;
        for (const it of iterators) it.fail(error);
        iterators.clear();
        finish();
      },
      end: finish,
    });

    let started: Promise<void>;
    try {
      const request = { ...params, clusterId: clusterOf(params.clusterId, "resources.watch") };
      started = send<unknown>("resources.watch", request, callOptions, id).then(() => undefined);
    } catch (err) {
      started = Promise.reject(err);
    }
    started.catch((err: SextantError) => {
      streams.get(id)?.fail(err);
      onError?.(err);
    });

    let unwatching: Promise<void> | null = null;
    const handle: Watch = {
      stream: id,
      started,
      get closed() {
        return ended;
      },
      onUpdate(listener) {
        listeners.add(listener);
        for (const update of backlog.splice(0)) listener(update);
        return () => listeners.delete(listener);
      },
      unwatch() {
        if (unwatching) return unwatching;
        const wasOpen = !ended && !failure;
        finish();
        unwatching = wasOpen && !closed
          ? send<unknown>("resources.unwatch", { stream: id }).then(
              () => undefined,
              () => undefined,
            )
          : Promise.resolve();
        return unwatching;
      },
      [Symbol.asyncIterator](): AsyncIterator<WatchUpdate> {
        const queue: WatchUpdate[] = backlog.splice(0);
        let waiting: { resolve(r: IteratorResult<WatchUpdate>): void; reject(e: unknown): void } | null = null;
        let done = ended;
        let error: SextantError | null = failure;
        const state = {
          push(update: WatchUpdate) {
            if (waiting) {
              waiting.resolve({ value: update, done: false });
              waiting = null;
            } else queue.push(update);
          },
          fail(e: SextantError) {
            error = e;
            if (waiting) {
              waiting.reject(e);
              waiting = null;
            }
          },
          end() {
            done = true;
            if (waiting) {
              waiting.resolve({ value: undefined, done: true });
              waiting = null;
            }
          },
        };
        if (!done) iterators.add(state);
        return {
          next() {
            const queued = queue.shift();
            if (queued) return Promise.resolve({ value: queued, done: false });
            if (error) return Promise.reject(error);
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => (waiting = { resolve, reject }));
          },
          return() {
            iterators.delete(state);
            done = true;
            // Leaving the loop stops the watch; the loop does not wait for the window's answer.
            void handle.unwatch();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    return handle;
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== host) return;
    const data: unknown = event.data;
    if (!isRecord(data) || data.sextant !== PROTOCOL_VERSION || data.doc !== doc) return;
    if (data.type === "context" && isRecord(data.context)) {
      receiveContext(data.context as unknown as HostContext);
      return;
    }
    if ("stream" in data && "event" in data && (typeof data.stream === "string" || typeof data.stream === "number")) {
      streams.get(data.stream)?.deliver(data.event as WatchUpdate);
      return;
    }
    const id = data.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const call = pending.get(id);
    if (!call) return;
    if ("error" in data) {
      pending.delete(id);
      clearTimeout(call.timer);
      call.reject(toSextantError(data.error, call.method));
    } else if ("result" in data) {
      pending.delete(id);
      clearTimeout(call.timer);
      call.resolve(data.result);
    }
  };
  win.addEventListener("message", onMessage);
  cleanups.push(() => win.removeEventListener("message", onMessage));

  if (options.reportErrors !== false) {
    const onError = (event: ErrorEvent) => reportError(event.message || event.error || "Script error");
    const onRejection = (event: PromiseRejectionEvent) => reportError(event.reason);
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);
    cleanups.push(() => {
      win.removeEventListener("error", onError);
      win.removeEventListener("unhandledrejection", onRejection);
    });
  }

  let connected: ((sextant: Sextant) => void) | null = null;
  const sextant: Sextant = {
    get context() {
      return current!;
    },
    onContextChange(listener) {
      contextListeners.add(listener);
      return () => contextListeners.delete(listener);
    },
    onThemeChange(listener) {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    refreshContext: (o) =>
      send<HostContext>("context.get", undefined, o).then((context) => {
        receiveContext(context);
        return context;
      }),
    clusters: { list: (o) => send("clusters.list", undefined, o) },
    kinds: (params = {}, o) => onCluster("kinds", params, o),
    resources: {
      list: (params, o) => onCluster("resources.list", params, o),
      get: (params, o) => onCluster("resources.get", params, o),
      watch,
      apply: (params, o) => onCluster("resources.apply", params, o),
      patch: (params, o) => onCluster("resources.patch", params, o),
      delete: (params, o) => onCluster<unknown>("resources.delete", params, o).then(() => undefined),
    },
    logs: { tail: (params, o) => onCluster("logs.tail", params, o) },
    secret: { value: (params, o) => onCluster("secret.value", params, o) },
    backend: {
      call: (method, params, o) => send("backend.call", params === undefined ? { method } : { method, params }, o),
    },
    storage: {
      get: (key, o) => send("storage.get", { key }, o),
      set: (key, value, o) => send<unknown>("storage.set", { key, value }, o).then(() => undefined),
      remove: (key, o) => send<unknown>("storage.remove", { key }, o).then(() => undefined),
    },
    ui: {
      openDetails: (ref, o) => send<unknown>("ui.openDetails", ref, o).then(() => undefined),
      navigate: (page, o) => send<unknown>("ui.navigate", { page }, o).then(() => undefined),
      notify: (text, o) => send<unknown>("ui.notify", { text }, o).then(() => undefined),
      close: (o) => send<unknown>("ui.close", undefined, o).then(() => undefined),
    },
    call: (method, params, o) => send(method, params, o),
    resize,
    autoResize,
    reportError,
    disconnect() {
      if (closed) return;
      for (const [id, call] of pending) {
        clearTimeout(call.timer);
        pending.delete(id);
        call.reject(new SextantError("other", `${call.method}: the connection to Sextant was closed`, call.method));
      }
      for (const stream of [...streams.values()]) stream.end();
      for (const cleanup of cleanups.splice(0)) cleanup();
      closed = true;
      if (connections.get(win) === connection) connections.delete(win);
    },
  };

  function receiveContext(context: HostContext) {
    const previous = current;
    current = context;
    if (themeOptions && (!previous || themeDiffers(previous, context))) applyTheme(context, themeOptions);
    if (!previous) {
      connected?.(sextant);
      return;
    }
    if (themeDiffers(previous, context)) for (const listener of [...themeListeners]) listener(context);
    for (const listener of [...contextListeners]) listener(context, previous);
  }

  const connection = new Promise<Sextant>((resolve, reject) => {
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const sayReadyAgain = () => {
      retry = setTimeout(() => {
        if (current || closed) return;
        post({ sextant: PROTOCOL_VERSION, doc, type: "ready" });
        attempt++;
        sayReadyAgain();
      }, READY_RETRIES[attempt] ?? 2000);
    };
    sayReadyAgain();
    const ms = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
    const timer = setTimeout(() => {
      if (retry) clearTimeout(retry);
      sextant.disconnect();
      reject(
        new SextantError(
          "timeout",
          `Sextant did not answer in ${Math.round(ms / 100) / 10} s; is this page open inside Sextant?`,
        ),
      );
    }, ms);
    connected = (value) => {
      clearTimeout(timer);
      if (retry) clearTimeout(retry);
      connected = null;
      if (options.autoResize ?? AUTO_HEIGHT_VIEWS.has(value.context.view)) autoResize();
      resolve(value);
    };
  });
  return connection;
}

function themeDiffers(a: HostContext, b: HostContext): boolean {
  if (a.theme !== b.theme || a.language !== b.language) return true;
  const ka = Object.keys(a.tokens);
  const kb = Object.keys(b.tokens);
  return ka.length !== kb.length || ka.some((k) => a.tokens[k] !== b.tokens[k]);
}
