// The access check of each connected cluster (#285, ADR-0124), run once per connection and again on "Check again":
//
// 1. One SelfSubjectAccessReview: may the user list Namespaces (cluster-wide)? If yes — or the review fails — nothing
//    changes: "All namespaces" is one cluster-wide watch as always.
// 2. If not, the cluster is "restricted": candidates are gathered — the kubeconfig context's namespace, the
//    ServiceAccount's namespace from a SelfSubjectReview (`rbac_whoami`; skipped where not served), the user's
//    OpenShift projects where `project.openshift.io/v1` is served (listing projects returns only the projects the user
//    may see: `github.com/openshift/api`, `project/v1/types.go`, "Listing or watching projects will return only
//    projects the user has the reader role on"), plus the known namespaces of the settings (`known.ts`).
// 3. Each candidate is asked "may I list pods in it?" (batches of `MAX_QUERIES`): accessible, no access or unknown.
// 4. Which kinds can be read: every served cluster-scoped kind (Sextant's own first) by one batch of access reviews,
//    namespaced kinds by a rules review of each accessible namespace (at most `MAX_RULES_REVIEWS`).
//
// While restricted, "All namespaces" means the accessible known and found namespaces (`restrictedScope`), and the
// namespace-wide views (`useSelectedNamespaces`), the problems store and the palette watch those. A name typed or
// added later is checked when it appears in the settings. Only the user's own permissions are asked, and only by the
// window (no MCP tool, no extension method); answers live in memory for the connection and are never saved.
import { useSyncExternalStore } from "react";
import {
  api,
  getSettingsSnapshot,
  loadSettings,
  openStream,
  subscribeSettings,
  toApiError,
  type AccessAnswer,
  type ApiError,
  type ClusterId,
  type KubeObject,
  type ResourceKind,
  type RulesReview,
  type WatchUpdate,
} from "../../api";
import { getResourceDefs } from "../../resources";
import { useClustersStore } from "../clusters/clustersStore";
import {
  batches,
  candidatesOf,
  kindAnswerOf,
  kindKeyOf,
  kindQuery,
  LIST_NAMESPACES,
  MAX_QUERIES,
  MAX_RULES_REVIEWS,
  namespaceAccessOf,
  namespaceQuery,
  scopeOf,
  type FoundBy,
  type KindFacts,
  type NamespaceAccess,
} from "./access";
import { isNamespaceName, knownOf } from "./known";

/** Views wait this long for the first answer (step 1) before they watch as if Namespaces could be listed. */
export const CHECK_WAIT_MS = 3000;
/** Tables wait at most this long (from the connect) for the kinds' answers before they list as usual. */
export const KINDS_WAIT_MS = 6000;
/** OpenShift projects taken as candidates at most. */
export const MAX_PROJECTS = 200;
/** How long the project list may take. */
export const PROJECTS_TIMEOUT_MS = 15_000;
/** Rules reviews sent at the same time. */
const PARALLEL_REVIEWS = 4;

const PROJECT_KIND = { group: "project.openshift.io", version: "v1", kind: "Project" } as const;

export interface AccessState extends KindFacts {
  /** "idle": not connected (or not checked yet); "checking": the check runs; "ready": it is done. */
  status: "idle" | "checking" | "ready";
  /** The first answer came (or failed, or `CHECK_WAIT_MS` passed): views stop waiting. */
  settled: boolean;
  /** The kinds' answers came (or failed, or `KINDS_WAIT_MS` passed): tables stop waiting for "No access". */
  kindsSettled: boolean;
  /** May the user list Namespaces: `false` = restricted, `null` = cannot tell (the review failed or is pending). */
  listNamespaces: boolean | null;
  /** The user name the API server knows (SelfSubjectReview), when asked. */
  username: string | null;
  /** Candidate namespaces found by the check (not saved) and where. */
  found: ReadonlyMap<string, readonly FoundBy[]>;
  /** Marks of the candidates asked about. */
  namespaces: ReadonlyMap<string, NamespaceAccess>;
  /** The first review failed (shown in the filter and the settings). */
  error: ApiError | null;
  /** When the check finished (ms). */
  checkedAt: number | null;
}

const IDLE: AccessState = Object.freeze({
  status: "idle",
  settled: false,
  kindsSettled: false,
  listNamespaces: null,
  username: null,
  found: new Map(),
  namespaces: new Map(),
  clusterKinds: new Map(),
  rules: new Map(),
  error: null,
  checkedAt: null,
}) as AccessState;

const states = new Map<ClusterId, AccessState>();
/** The run each cluster's answers belong to; an answer of an older run is dropped. */
const runs = new Map<ClusterId, number>();
const scopes = new Map<ClusterId, string[] | null>();
const listeners = new Set<() => void>();
const scopeListeners = new Set<(clusterId: ClusterId) => void>();
const connected = new Map<ClusterId, boolean>();
const waits = new Map<ClusterId, ReturnType<typeof setTimeout>>();
/** Names typed or added while restricted whose answer is pending (asked once; not in the scope until answered). */
const asking = new Map<ClusterId, Set<string>>();
let unfollow: (() => void) | null = null;
let version = 0;

function changed(scopeOnly = false): void {
  // The scope first: a listener that starts watches once the check settled (the problems store) reads the new one.
  let scopeChanged = false;
  for (const id of new Set([...states.keys(), ...scopes.keys()])) {
    if (updateScope(id)) scopeChanged = true;
  }
  if (scopeOnly && !scopeChanged) return;
  version++;
  for (const fn of [...listeners]) fn();
}

/**
 * Recomputes the cluster's restricted scope and tells the scope listeners when it moved (as a set: `scopeOf` is
 * sorted and has no repeats). Only a settled check has a scope: until then the candidates' answers are still coming,
 * and every move would restart each watch of "All namespaces".
 */
function updateScope(clusterId: ClusterId): boolean {
  const state = states.get(clusterId);
  const next =
    state?.listNamespaces === false && state.settled
      ? scopeOf(knownOf(getSettingsSnapshot(), clusterId), state.found, state.namespaces)
      : [];
  const value = next.length > 0 ? next : null;
  const before = scopes.get(clusterId) ?? null;
  if ((before === null ? "" : before.join(",")) === (value === null ? "" : value.join(","))) return false;
  scopes.set(clusterId, value);
  for (const fn of [...scopeListeners]) fn(clusterId);
  return true;
}

function set(clusterId: ClusterId, run: number, patch: Partial<AccessState>): boolean {
  if (runs.get(clusterId) !== run) return false;
  states.set(clusterId, { ...(states.get(clusterId) ?? IDLE), ...patch });
  changed();
  return true;
}

/** The cluster's access check as known now. */
export function getAccess(clusterId: ClusterId): AccessState {
  return states.get(clusterId) ?? IDLE;
}

/**
 * The namespaces "All namespaces" stands for, read outside React: `null` (one cluster-wide watch) unless the user
 * may not list Namespaces and some known or found namespace is not refused; the same array until it changes.
 */
export function restrictedScope(clusterId: ClusterId): string[] | null {
  follow();
  return scopes.get(clusterId) ?? null;
}

/** Calls `fn(clusterId)` whenever a cluster's `restrictedScope` changes; returns the unsubscribe. */
export function subscribeScope(fn: (clusterId: ClusterId) => void): () => void {
  follow();
  scopeListeners.add(fn);
  return () => scopeListeners.delete(fn);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getVersion = () => version;

/** The cluster's access check, kept up to date (starts following connections). */
export function useAccess(clusterId: ClusterId): AccessState {
  follow();
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return getAccess(clusterId);
}

/** Calls `fn` whenever any cluster's access check changes; returns the unsubscribe. */
export function subscribeAccess(fn: () => void): () => void {
  follow();
  return subscribe(fn);
}

/** `restrictedScope` in React. */
export function useRestrictedScope(clusterId: ClusterId | null): string[] | null {
  follow();
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return clusterId ? (scopes.get(clusterId) ?? null) : null;
}

/** Starts following connections and the settings (once): a connect runs the check, a disconnect forgets it. */
function follow(): void {
  if (unfollow) return;
  const look = (all: ReturnType<typeof useClustersStore.getState>["states"]) => {
    for (const id of new Set([...Object.keys(all), ...connected.keys()])) {
      const now = all[id]?.state === "connected";
      const was = connected.get(id) ?? false;
      connected.set(id, now);
      if (now && !was) void runCheck(id);
      // A Reconnect (connected → connecting → connected) keeps the last answer on screen until the new check's
      // answers come (`runCheck` starts from it), so views do not wait again; any other end forgets it.
      else if (!now && was && all[id]?.state === "connecting") hold(id);
      else if (!now && states.has(id) && all[id]?.state !== "connecting") forget(id);
    }
  };
  const offClusters = useClustersStore.subscribe((s, prev) => {
    if (s.states !== prev.states) look(s.states);
  });
  // A known namespace added anywhere (the filter, the settings, a saved view) is asked about while restricted.
  const offSettings = subscribeSettings(() => {
    for (const [id, state] of states) {
      if (state.listNamespaces !== false) continue;
      const pending = asking.get(id);
      const unchecked = knownOf(getSettingsSnapshot(), id).filter((ns) => !state.namespaces.has(ns) && !pending?.has(ns));
      if (unchecked.length > 0) void checkNamespaces(id, unchecked);
    }
    // A layout-only write does not change access; notify React only if the namespace scope moved.
    changed(true);
  });
  unfollow = () => {
    offClusters();
    offSettings();
  };
  // Not inside the render that asked first: the check's first change notifies other components.
  queueMicrotask(() => {
    if (unfollow) look(useClustersStore.getState().states);
  });
}

/** Stops the cluster's run: answers still on their way are dropped. */
function stopRun(clusterId: ClusterId): void {
  runs.set(clusterId, (runs.get(clusterId) ?? 0) + 1);
  const wait = waits.get(clusterId);
  if (wait) clearTimeout(wait);
  waits.delete(clusterId);
  asking.delete(clusterId);
}

function forget(clusterId: ClusterId): void {
  stopRun(clusterId);
  states.delete(clusterId);
  changed();
}

/** The connection is being made again: the run stops, its last answers stay until the new run replaces them. */
function hold(clusterId: ClusterId): void {
  stopRun(clusterId);
  const state = states.get(clusterId);
  if (state?.status === "checking") states.set(clusterId, { ...state, status: "idle" });
  changed();
}

/** Runs the whole check again ("Check again" in the filter or the settings); nothing when not connected. */
export function refreshAccess(clusterId: ClusterId): Promise<void> {
  follow();
  if (!connected.get(clusterId)) return Promise.resolve();
  return runCheck(clusterId);
}

async function runCheck(clusterId: ClusterId): Promise<void> {
  const run = (runs.get(clusterId) ?? 0) + 1;
  runs.set(clusterId, run);
  const before = states.get(clusterId);
  // A new run keeps what is known on screen until its answers come (a refresh does not flicker).
  states.set(clusterId, {
    ...(before ?? IDLE),
    status: "checking",
    settled: before?.settled ?? false,
    kindsSettled: before?.kindsSettled ?? false,
    error: null,
  });
  changed();
  const old = waits.get(clusterId);
  if (old) clearTimeout(old);
  const started = Date.now();
  const tick = () => {
    const state = getAccess(clusterId);
    if (!state.settled && Date.now() - started >= CHECK_WAIT_MS) set(clusterId, run, { settled: true });
    if (!state.kindsSettled && Date.now() - started >= KINDS_WAIT_MS) set(clusterId, run, { kindsSettled: true });
    const next = getAccess(clusterId);
    if (runs.get(clusterId) === run && !next.kindsSettled) {
      waits.set(clusterId, setTimeout(tick, (next.settled ? KINDS_WAIT_MS : CHECK_WAIT_MS) - (Date.now() - started)));
    } else waits.delete(clusterId);
  };
  waits.set(clusterId, setTimeout(tick, CHECK_WAIT_MS));

  let answer: AccessAnswer | undefined;
  try {
    [answer] = await api.rbac.canI(clusterId, [LIST_NAMESPACES]);
  } catch (err) {
    set(clusterId, run, {
      status: "ready",
      settled: true,
      kindsSettled: true,
      listNamespaces: null,
      error: toApiError(err),
      checkedAt: Date.now(),
    });
    return;
  }
  const may = kindAnswerOf(answer);
  if (may !== false) {
    set(clusterId, run, {
      status: "ready",
      settled: true,
      kindsSettled: true,
      listNamespaces: may,
      found: new Map(),
      namespaces: new Map(),
      clusterKinds: new Map(),
      rules: new Map(),
      checkedAt: Date.now(),
    });
    return;
  }
  // Views keep waiting (at most `CHECK_WAIT_MS` in all) until the candidates are known, so they start with them.
  if (!set(clusterId, run, { listNamespaces: false })) return;

  // Candidates the client knows, gathered side by side; a failed source adds nothing.
  const contextNamespace = useClustersStore.getState().clusters.find((c) => c.id === clusterId)?.namespace ?? null;
  const [me, kinds] = await Promise.all([
    api.rbac.whoami(clusterId).catch(() => null),
    api.clusters.kinds(clusterId).catch(() => [] as ResourceKind[]),
    // The known namespaces are in the settings.
    loadSettings().catch(() => null),
  ]);
  const projects = kinds.some((k) => k.kindRef.group === PROJECT_KIND.group && k.kindRef.kind === PROJECT_KIND.kind)
    ? await listProjects(clusterId)
    : [];
  const found = new Map<string, FoundBy[]>();
  const add = (ns: string | null | undefined, by: FoundBy) => {
    if (!ns || !isNamespaceName(ns)) return;
    found.set(ns, [...(found.get(ns) ?? []), by]);
  };
  add(contextNamespace, "context");
  add(me?.serviceAccountNamespace, "serviceAccount");
  for (const ns of projects) add(ns, "project");
  if (!set(clusterId, run, { found, username: me?.username || null })) return;

  // Views (and the restricted scope) settle once the candidates are answered, so they start with the final scope
  // instead of moving with every batch (or after `CHECK_WAIT_MS`, with the answers so far).
  const candidates = candidatesOf(knownOf(getSettingsSnapshot(), clusterId), found);
  await askNamespaces(clusterId, run, candidates);
  if (!set(clusterId, run, { settled: true })) return;
  await askKinds(clusterId, run, kinds);
  set(clusterId, run, { status: "ready", kindsSettled: true, checkedAt: Date.now() });
}

/** The user's projects (names only, metadata-only list, at most `MAX_PROJECTS`); `[]` when they cannot be listed. */
function listProjects(clusterId: ClusterId): Promise<string[]> {
  return new Promise((resolve) => {
    let done = false;
    let stop: () => void = () => undefined;
    const finish = (names: string[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      resolve(names);
    };
    const timer = setTimeout(() => finish([]), PROJECTS_TIMEOUT_MS);
    stop = openStream<WatchUpdate>({
      start: (id, channel) =>
        api.resources.watchStart(
          clusterId,
          { kind: PROJECT_KIND, namespaces: null, labelSelector: null, fieldSelector: null, metadataOnly: true },
          id,
          channel,
          { progressive: false, maxObjects: MAX_PROJECTS },
        ),
      stop: api.resources.watchStop,
      onEvent: (update) => {
        if (update.type === "snapshot") {
          const names = (update.items as KubeObject[]).map((o) => o.metadata?.name).filter((n): n is string => !!n);
          finish(names.slice(0, MAX_PROJECTS));
        } else if (update.type === "error") finish([]);
      },
      onStartError: () => finish([]),
    });
    if (done) stop();
  });
}

/** Asks "may I list pods in it?" for each name (batched); a failed batch leaves its names unknown. */
async function askNamespaces(clusterId: ClusterId, run: number, names: readonly string[]): Promise<void> {
  for (const batch of batches(names)) {
    let answers: AccessAnswer[] | null = null;
    try {
      answers = await api.rbac.canI(clusterId, batch.map(namespaceQuery));
    } catch {
      answers = null;
    }
    if (runs.get(clusterId) !== run) return;
    const marks = new Map(getAccess(clusterId).namespaces);
    batch.forEach((ns, i) => marks.set(ns, namespaceAccessOf(answers?.[i])));
    set(clusterId, run, { namespaces: marks });
  }
}

/** Cluster-scoped kinds by access reviews, namespaced kinds by the rules reviews of accessible namespaces. */
async function askKinds(clusterId: ClusterId, run: number, kinds: readonly ResourceKind[]): Promise<void> {
  const own = new Set(getResourceDefs().filter((d) => d.sidebar).map((d) => kindKeyOf(d.kind)));
  const clusterScoped = kinds
    .filter((k) => !k.namespaced && k.verbs.includes("list"))
    .sort(
      (a, b) =>
        Number(own.has(kindKeyOf(b.kindRef))) - Number(own.has(kindKeyOf(a.kindRef))) ||
        kindKeyOf(a.kindRef).localeCompare(kindKeyOf(b.kindRef)),
    )
    .slice(0, MAX_QUERIES);
  if (clusterScoped.length > 0) {
    let answers: AccessAnswer[] | null = null;
    try {
      answers = await api.rbac.canI(clusterId, clusterScoped.map(kindQuery));
    } catch {
      answers = null;
    }
    const clusterKinds = new Map<string, boolean | null>();
    clusterScoped.forEach((k, i) => clusterKinds.set(kindKeyOf(k.kindRef), kindAnswerOf(answers?.[i])));
    if (!set(clusterId, run, { clusterKinds })) return;
  }
  await reviewRules(clusterId, run, accessibleNamespaces(clusterId), true);
}

function accessibleNamespaces(clusterId: ClusterId): string[] {
  return [...getAccess(clusterId).namespaces].filter(([, mark]) => mark === "accessible").map(([ns]) => ns);
}

/**
 * Rules reviews of `names`, at most `MAX_RULES_REVIEWS` kept: `fresh` (a whole check) replaces the reviews once all
 * have come (what is shown does not flicker); otherwise only names not reviewed yet are added.
 */
async function reviewRules(clusterId: ClusterId, run: number, names: readonly string[], fresh = false): Promise<void> {
  const reviewed = fresh ? new Map<string, RulesReview | null>() : getAccess(clusterId).rules;
  const todo = names.filter((ns) => !reviewed.has(ns)).slice(0, Math.max(0, MAX_RULES_REVIEWS - reviewed.size));
  const got = new Map<string, RulesReview | null>();
  for (let i = 0; i < todo.length; i += PARALLEL_REVIEWS) {
    const part = todo.slice(i, i + PARALLEL_REVIEWS);
    const reviews = await Promise.all(
      part.map((ns) => api.rbac.rulesReview(clusterId, ns).catch((): RulesReview | null => null)),
    );
    if (runs.get(clusterId) !== run) return;
    part.forEach((ns, j) => got.set(ns, reviews[j] ?? null));
  }
  if (got.size === 0 && !fresh) return;
  set(clusterId, run, { rules: new Map([...(fresh ? [] : getAccess(clusterId).rules), ...got]) });
}

/**
 * Asks about names typed or added while restricted (not asked yet), then reviews the rules of the accessible ones.
 * Nothing while the cluster may list Namespaces or is not connected.
 */
export async function checkNamespaces(clusterId: ClusterId, names: readonly string[]): Promise<void> {
  const state = getAccess(clusterId);
  const run = runs.get(clusterId);
  if (state.listNamespaces !== false || run === undefined) return;
  const pending = asking.get(clusterId) ?? new Set<string>();
  const todo = [...new Set(names)].filter((ns) => isNamespaceName(ns) && !state.namespaces.has(ns) && !pending.has(ns));
  if (todo.length === 0) return;
  // Pending, so a second change of the settings does not ask again; without a mark until answered, so the name joins
  // the scope only when it may be read (never joins and leaves again).
  for (const ns of todo) pending.add(ns);
  asking.set(clusterId, pending);
  await askNamespaces(clusterId, run, todo);
  if (runs.get(clusterId) !== run) return;
  for (const ns of todo) pending.delete(ns);
  await reviewRules(clusterId, run, todo.filter((ns) => getAccess(clusterId).namespaces.get(ns) === "accessible"));
}

/** Forgets every check and stops following (tests). */
export function resetAccess(): void {
  unfollow?.();
  unfollow = null;
  for (const wait of waits.values()) clearTimeout(wait);
  waits.clear();
  asking.clear();
  for (const id of states.keys()) runs.set(id, (runs.get(id) ?? 0) + 1);
  states.clear();
  scopes.clear();
  connected.clear();
  version++;
  for (const fn of [...listeners]) fn();
}
