// The frame side of Sextant's extension protocol (Sextant's `src/extensions/protocol.ts`).
//
// `connect()` makes up the document id (`doc`, 128 random bits), says `ready` at once (and again until the window
// answers), and resolves with the first context sent to this document. Every message carries `doc`; messages from any
// window but the parent, without `sextant: 1` or for another document are ignored. Calls get ids of their own and
// answers are matched by id; a call without an answer in time fails with `timeout`. `resources.watch` updates arrive
// under the id of the watch call, so the client listens before it sends the call.
import { setIconSource } from "./icons";
import type {
  ApplyParams,
  CallOptions,
  ClusterId,
  ClusterSummary,
  DeleteParams,
  ExecParams,
  ExecResult,
  ForwardInfo,
  ForwardResult,
  ForwardStartParams,
  GetManyParams,
  GetManyResult,
  GetParams,
  JsonValue,
  KindsParams,
  KubeObject,
  ListParams,
  ListResult,
  LogsParams,
  Methods,
  MetricAnswer,
  MetricQueryParams,
  ObjectRef,
  OpenLogsParams,
  PatchManyParams,
  PatchManyResult,
  PatchParams,
  ServiceAnswer,
  ServiceRequestParams,
  ServiceSecretRef,
  SignInState,
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
  /** With `maxObjects`: how many objects match in all, each time it changes (since Sextant 0.30). */
  onCapped?: (total: number) => void;
}

/** An open `resources.watch`: updates by callback or `for await`; `unwatch()` (or leaving the loop) stops it. */
export interface Watch extends AsyncIterable<WatchUpdate> {
  /** The id of the watch call, which names its updates. */
  readonly stream: RequestId;
  /** Resolves when Sextant runs the watch; rejects with the reason it does not. */
  readonly started: Promise<void>;
  /** The watch ended (unwatched, failed to start, or the connection was closed). */
  readonly closed: boolean;
  /** With `maxObjects`: how many objects match in all when more do than are kept; else `null`. */
  readonly capped: number | null;
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
    /**
     * Up to 50 named objects in one call, read 4 at a time: each in its place as `{object}` or `{error}` (a missing one
     * is `notFound`). Refused as a whole when the extension may not read every one of them (since Sextant 0.29).
     */
    getMany<T = KubeObject>(params: GetManyParams, options?: CallOptions): Promise<GetManyResult<T>>;
    /** Watches objects: a snapshot first, then deltas (objects changed, uids deleted), batched by Sextant. */
    watch(
      params: WatchParams,
      handlers?: WatchHandlers | ((update: WatchUpdate) => void),
      options?: CallOptions,
    ): Watch;
    /** Applies YAML documents (server-side apply); the objects applied. */
    apply(params: ApplyParams, options?: CallOptions): Promise<ObjectRef[]>;
    /**
     * Creates the one object of `yaml`, never changing one that exists: a name already taken fails with `conflict`
     * (Modify on it; since Sextant 0.30). For a Velero Backup or Restore, a snapshot, anything that must be new.
     */
    create(params: ApplyParams, options?: CallOptions): Promise<ObjectRef>;
    patch<T = KubeObject>(params: PatchParams, options?: CallOptions): Promise<T>;
    /**
     * Several patches (at most 50) under one decision and one confirmation, sent in order; the first failure stops
     * the rest (since Sextant 0.30).
     */
    patchMany<T = KubeObject>(params: PatchManyParams, options?: CallOptions): Promise<PatchManyResult<T>>;
    delete(params: DeleteParams, options?: CallOptions): Promise<void>;
    /**
     * `oc rollout latest` of a DeploymentConfig or `oc start-build` of a BuildConfig (since Sextant 0.30): Sextant
     * builds the request from the name, asks as for any change (Modify), and answers the ReplicationController or
     * Build it made. Nothing else is posted to a subresource.
     */
    instantiate(params: DeleteParams, options?: CallOptions): Promise<ObjectRef>;
  };
  logs: { tail(params: LogsParams, options?: CallOptions): Promise<string> };
  /** One value of a Secret (needs the "Secret values" permission). */
  secret: { value(params: SecretParams, options?: CallOptions): Promise<string> };
  /** Runs one of the manifest's metric queries in the cluster's Prometheus-compatible source (ADR-0138). */
  metrics: { query(params: MetricQueryParams, options?: CallOptions): Promise<MetricAnswer> };
  /**
   * Runs a command of the manifest (`contributes.commands`) by id in `namespace`, with a value for each parameter.
   * The extension never sends words of its own; one that changes something asks the user first (since Sextant 0.29).
   */
  exec: { run(params: ExecParams, options?: CallOptions): Promise<ExecResult> };
  /**
   * Port forwards to a Pod or Service (sextantApi 4 with the `portForward` permission, since Sextant 0.30): listed on
   * Sextant's port-forward page as the extension's, never to a node shell or a pod on the node's network; at most 8 at
   * once; they end when the extension is disabled, removed or granted anything else.
   */
  /**
   * Requests to a Service of the manifest (`contributes.services`, sextantApi 4, since Sextant 0.30) through Sextant's
   * own port forward, with Read and Port forward on Services in the namespace. Sextant keeps a session token taken
   * with `capture` and adds it with `auth: "session"`; the extension never holds it.
   */
  service: {
    request<T = JsonValue>(params: ServiceRequestParams, options?: CallOptions): Promise<ServiceAnswer<T>>;
    /**
     * Drops the session token Sextant keeps for the service in `namespace` and its remembered sign-in (signing out);
     * with `saved: true` only the sign-in remembered in the keyring, keeping this run's session (since Sextant 0.30).
     */
    forget(params: { clusterId?: ClusterId; namespace: string; service: string; saved?: boolean }, options?: CallOptions): Promise<void>;
    /**
     * The Secrets of `namespace` the service's labelled `secrets` entries pick and that hold the key — names only, for
     * `{{secret:<name>/<key>}}` or `auth: "secret:<name>/<key>"` (since Sextant 0.30).
     */
    secrets(params: { clusterId?: ClusterId; namespace: string; service: string }, options?: CallOptions): Promise<ServiceSecretRef[]>;
    /** Whether the service's sign-in is saved for this cluster, typed for this run only, or none; never a value (since Sextant 0.30). */
    signInState(params: { clusterId?: ClusterId; namespace: string; service: string }, options?: CallOptions): Promise<SignInState>;
  };
  portForward: {
    start(params: ForwardStartParams, options?: CallOptions): Promise<ForwardResult>;
    /** The extension's own forwards still running (of one cluster when `clusterId` is given). */
    list(params?: { clusterId?: ClusterId }, options?: CallOptions): Promise<ForwardInfo[]>;
    stop(id: string, options?: CallOptions): Promise<void>;
  };
  /**
   * The extension's own backend (ADR-0131), when its manifest declares one: `handle(method, params)` of its
   * WebAssembly component, with the answer it returns. A call is limited to 10 s and 1 MB each way.
   */
  backend: {
    call<T = JsonValue>(method: string, params?: JsonValue, options?: CallOptions): Promise<T>;
  };
  /**
   * The extension's own data, kept by Sextant (at most 1 MB in all). With `session: true` (since Sextant 0.30) the
   * data of this run only: kept in memory, apart from the stored data, gone when Sextant quits (at most 1 MB too).
   */
  storage: {
    get<T extends JsonValue = JsonValue>(key: string, options?: CallOptions & { session?: boolean }): Promise<T | null>;
    set(key: string, value: JsonValue, options?: CallOptions & { session?: boolean }): Promise<void>;
    remove(key: string, options?: CallOptions & { session?: boolean }): Promise<void>;
  };
  ui: {
    /** Opens the details panel of an object (in the active cluster). */
    openDetails(ref: RefInput | ObjectRef, options?: CallOptions): Promise<void>;
    /**
     * Opens a page: one of the extension's own page ids, a Sextant page, or a table view (`kind:<group>/<Kind>`).
     * `closeDetails: true` closes the details panel too, as Sextant's own "Check a request…" (since Sextant 0.30).
     */
    navigate(page: string, options?: CallOptions & { closeDetails?: boolean }): Promise<void>;
    /** A short notice in Sextant's window (at most 500 characters). */
    notify(text: string, options?: CallOptions): Promise<void>;
    /**
     * Closes the action's window or the dock tab. With `failed` the action failed: Sextant shows its own failure dialog
     * with the action's title and this text (since Sextant 0.30).
     */
    close(options?: CallOptions & { failed?: string }): Promise<void>;
    /**
     * Opens Sextant's logs tab of a pod (one container), or the merged logs of the pods a label selector picks, when
     * the extension may read their logs (since Sextant 0.30).
     */
    openLogs(params: OpenLogsParams, options?: CallOptions): Promise<void>;
    /**
     * Asks the user to open an http(s) address in the browser; `true` when they did (since Sextant 0.30). Sextant shows
     * the whole address and asks every time; one question per extension at a time.
     */
    openUrl(url: string, options?: CallOptions): Promise<boolean>;
    /**
     * Asks the user to open the cluster Sextant has at an API server address (a Cluster API workload cluster's
     * `controlPlaneEndpoint`), with `node` that Node's details (since Sextant 0.30). Sextant lists the matching clusters
     * in its own dialog and connects the one picked; the extension learns only `opened`, or `found: 0` when Sextant has
     * none at that address (nothing is asked then).
     */
    openCluster(target: { host: string; port: number; node?: string }, options?: CallOptions): Promise<{ opened: boolean; found?: number }>;
    /**
     * Keeps a block of a details section open or closed in Sextant's own memory of details sections (since Sextant
     * 0.30): what `context.blocks` tells next time, per kind and as the user's setting says, with "Expand all" and
     * "Collapse all" of the panel. `id`: letters, digits, `-`, `_`, `.`.
     */
    setBlockOpen(id: string, open: boolean, options?: CallOptions): Promise<void>;
    /**
     * Keeps the width of a column of the extension's own table in Sextant's memory, as Sextant keeps its own tables'
     * (since Sextant 0.30): what `context.columnWidths[table][column]` tells next time; `null` gives the column its own
     * width back. `ui.table` with an `id` calls it when the user resizes a column. Ids: letters, digits, `-`, `_`, `.`.
     */
    setColumnWidth(table: string, column: string, width: number | null, options?: CallOptions): Promise<void>;
    /**
     * Details only (since Sextant 0.30): opens, scrolls to and focuses a section of the same details panel — one of
     * Sextant's by its id (`requestHealth`) or the extension's own by its manifest id; `notFound` when it is not shown.
     */
    revealSection(id: string, options?: CallOptions): Promise<void>;
    /**
     * Asks the user to sign in to a service of the manifest that declares `signIn`, in Sextant's own dialog (since
     * Sextant 0.30); `true` once they did. What they type goes to Sextant, never to the extension: use it in a request
     * body as `{{signIn:<field id>}}`. "Remember" keeps it for that cluster in the keyring.
     */
    signIn(params: { clusterId?: ClusterId; namespace: string; service: string }, options?: CallOptions): Promise<boolean>;
    /** A details section hides itself (title included) while it has nothing to show, and shows again (since 0.30). */
    setHidden(hidden: boolean, options?: CallOptions): Promise<void>;
    /**
     * One of Sextant's icons by name as SVG markup, `null` for a name Sextant does not have (since Sextant 0.30); what
     * `ui.button(…, {icon})` of the UI kit draws.
     */
    icon(name: string, options?: CallOptions): Promise<string | null>;
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
const CHANGES: ReadonlySet<string> = new Set([
  "resources.apply",
  "resources.create",
  "resources.patch",
  "resources.patchMany",
  "resources.delete",
  "resources.instantiate",
  "portForward.start",
  "ui.openLogs",
  "service.request",
]);
/** `ui.openUrl` waits for the user's answer to Sextant's own dialog, which has no time limit. */
const CONFIRM_TIMEOUT = 600_000;
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
    const { onUpdate, onError, onCapped } =
      typeof handlers === "function" ? { onUpdate: handlers, onError: undefined, onCapped: undefined } : (handlers ?? {});
    let capped: number | null = null;
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
        // `capped` (a watch with `maxObjects`) is not a WatchUpdate an extension switches over: it is told apart.
        const raw = update as unknown as { type: string; total?: number };
        if (raw.type === "capped") {
          capped = typeof raw.total === "number" && raw.total > (params.maxObjects ?? Infinity) ? raw.total : null;
          if (typeof raw.total === "number") onCapped?.(raw.total);
          return;
        }
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
      get capped() {
        return capped;
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
      getMany: (params, o) => onCluster("resources.getMany", params, o),
      watch,
      apply: (params, o) => onCluster("resources.apply", params, o),
      create: (params, o) => onCluster("resources.create", params, o),
      patch: (params, o) => onCluster("resources.patch", params, o),
      patchMany: (params, o) => onCluster("resources.patchMany", params, o),
      delete: (params, o) => onCluster<unknown>("resources.delete", params, o).then(() => undefined),
      instantiate: (params, o) => onCluster("resources.instantiate", params, o),
    },
    logs: { tail: (params, o) => onCluster("logs.tail", params, o) },
    secret: { value: (params, o) => onCluster("secret.value", params, o) },
    metrics: { query: (params, o) => onCluster("metrics.query", params, o) },
    exec: { run: (params, o) => onCluster("exec.run", params, o) },
    service: {
      request: (params, o) => onCluster("service.request", params, o),
      forget: (params, o) => onCluster<unknown>("service.forget", params, o).then(() => undefined),
      secrets: (params, o) => onCluster<{ secrets: ServiceSecretRef[] }>("service.secrets", params, o).then((r) => r.secrets),
      signInState: (params, o) => onCluster<{ state: SignInState }>("service.signInState", params, o).then((r) => r.state),
    },
    portForward: {
      start: (params, o) => onCluster("portForward.start", params, o),
      list: (params, o) =>
        send<{ forwards: ForwardInfo[] }>("portForward.list", params ?? {}, o).then((r) => r.forwards),
      stop: (id, o) => send<unknown>("portForward.stop", { id }, o).then(() => undefined),
    },
    backend: {
      call: (method, params, o) => send("backend.call", params === undefined ? { method } : { method, params }, o),
    },
    storage: {
      get: (key, o) => send("storage.get", o?.session === true ? { key, session: true } : { key }, o),
      set: (key, value, o) =>
        send<unknown>("storage.set", o?.session === true ? { key, value, session: true } : { key, value }, o).then(() => undefined),
      remove: (key, o) => send<unknown>("storage.remove", o?.session === true ? { key, session: true } : { key }, o).then(() => undefined),
    },
    ui: {
      openDetails: (ref, o) => send<unknown>("ui.openDetails", ref, o).then(() => undefined),
      navigate: (page, o) =>
        send<unknown>("ui.navigate", o?.closeDetails === true ? { page, closeDetails: true } : { page }, o).then(() => undefined),
      notify: (text, o) => send<unknown>("ui.notify", { text }, o).then(() => undefined),
      // The user answers these: no timeout of the default length.
      openLogs: (params, o) => send<unknown>("ui.openLogs", params, o).then(() => undefined),
      openUrl: (url, o) =>
        send<{ opened: boolean }>("ui.openUrl", { url }, { timeoutMs: CONFIRM_TIMEOUT, ...o }).then((r) => r.opened),
      openCluster: (target, o) =>
        send<{ opened: boolean; found?: number }>("ui.openCluster", target, { timeoutMs: CONFIRM_TIMEOUT, ...o }),
      setHidden: (hidden, o) => send<unknown>("ui.setHidden", { hidden }, o).then(() => undefined),
      setBlockOpen: (id, open, o) => send<unknown>("ui.setBlockOpen", { id, open }, o).then(() => undefined),
      setColumnWidth: (table, column, width, o) => send<unknown>("ui.setColumnWidth", { table, column, width }, o).then(() => undefined),
      revealSection: (id, o) => send<unknown>("ui.revealSection", { id }, o).then(() => undefined),
      icon: (name, o) => send<{ svg?: unknown } | null>("ui.icon", { name }, o).then((r) => (r && typeof r.svg === "string" ? r.svg : null)),
      signIn: (params, o) =>
        onCluster<{ signedIn: boolean }>("ui.signIn", params, { timeoutMs: CONFIRM_TIMEOUT, ...o }).then((r) => r.signedIn),
      close: (o) =>
        send<unknown>("ui.close", o?.failed !== undefined ? { failed: o.failed } : undefined, o).then(() => undefined),
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
      // The UI kit's buttons draw Sextant's icons through this connection (`ui.button(…, {icon})`).
      const source = (name: string) => value.ui.icon(name);
      setIconSource(source);
      cleanups.push(() => setIconSource(null));
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
