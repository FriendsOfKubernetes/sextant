// The watches of the "Cleanup" page and the live result of the rules. Bounded: only the namespaces in view (at most
// `MAX_CLEANUP_NAMESPACES`, excluded ones not at all), PersistentVolumes, Namespaces and ClusterIssuers cluster-wide,
// only kinds the cluster serves, nothing before discovery, and everything is let go when the page closes. The lists are
// the resource map's shared watches (`resource-map/watches.ts`), so the map and the "Related" tab of a namespace in view
// reuse them instead of listing it again. ConfigMaps and Secrets (and the kinds read only for them) are watched only
// while their rule is on. Each namespace checked is also sampled once per page open (and on "Check again"):
// every served namespaced kind, metadata only, a few names each (`cleanup_sample`).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError, ClusterId, KindRef, KubeObject, NamedObject, WatchSpec, WatchState } from "../../api";
import { api, defaultAppSettings, useSettings } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { REFERENCE_GRANT } from "../gateway-api/model";
import { CONFIG_MAP, knownKind, SECRET, SERVICE_ACCOUNT } from "../resource-map/kinds";
import { useSharedWatches } from "../resource-map/watches";
import {
  BUILT_IN_GROUPS,
  CLEANUP_CLUSTER_KINDS,
  CLEANUP_NAMESPACE_KINDS,
  CLUSTER_BUILT_IN_REFERRERS,
  HARMLESS_GROUPS,
  METADATA_ONLY,
  NOT_SAMPLED,
  SCANNED_CLUSTER_KINDS,
  SCANNED_KINDS,
} from "./kinds";
import {
  findCleanup,
  SYSTEM_NAMESPACES,
  type CleanupAges,
  type Candidate,
  type CleanupResult,
  type ClusterState,
  type KindList,
  type NamespaceSample,
} from "./rules";

/** Namespaces of the filter the page checks at once. */
export const MAX_CLEANUP_NAMESPACES = 5;
/** How often ages are looked at again while the page is open. */
const TICK_MS = 60_000;

export const DEFAULT_AGES: CleanupAges = { configs: 7, services: 7, pods: 7, jobs: 7, claims: 30, volumes: 30, namespaces: 30 };
/** Bounds of a number of days in the settings. */
export const MIN_DAYS = 0;
export const MAX_DAYS = 3650;

export function clampDays(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(value))) : MIN_DAYS;
}

export interface CleanupRules {
  configMaps: boolean;
  secrets: boolean;
}

export interface CleanupSettingsView {
  /** `false` until the settings are read: nothing is judged before (the excluded namespaces are not known yet). */
  loaded: boolean;
  excluded: string[];
  ages: CleanupAges;
  rules: CleanupRules;
}

/** The page's settings with their defaults (an older settings file has none; an unreadable one gives the defaults). */
export function useCleanupSettings(): CleanupSettingsView {
  const { settings, error } = useSettings();
  const cleanup = settings?.cleanup ?? (error ? defaultAppSettings().cleanup : undefined);
  const loaded = cleanup !== undefined;
  return useMemo(() => {
    const ages = { ...DEFAULT_AGES };
    for (const key of Object.keys(DEFAULT_AGES) as (keyof CleanupAges)[]) {
      const value = cleanup?.minAgeDays?.[key];
      if (typeof value === "number") ages[key] = clampDays(value);
    }
    return {
      loaded,
      excluded: cleanup?.excludedNamespaces ?? defaultAppSettings().cleanup.excludedNamespaces,
      ages,
      rules: { configMaps: cleanup?.checkConfigMaps === true, secrets: cleanup?.checkSecrets === true },
    };
  }, [cleanup, loaded]);
}

const sameKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) => a.group === b.group && a.kind === b.kind;

interface Planned {
  kind: KindRef;
  namespace: string | null;
  /**
   * The served kind to watch; `null` not served; `undefined` unknown (discovery failed for a kind not built in);
   * `false` not watched because no rule on needs it.
   */
  served: KindRef | null | undefined | false;
}

/** Kinds read only for the ConfigMap and Secret rules. */
const FOR_CONFIGS: readonly KindRef[] = [SERVICE_ACCOUNT, REFERENCE_GRANT, ...SCANNED_KINDS, ...SCANNED_CLUSTER_KINDS];

function needed(kind: KindRef, rules: CleanupRules): boolean {
  if (sameKind(kind, CONFIG_MAP)) return rules.configMaps;
  if (sameKind(kind, SECRET)) return rules.secrets;
  if (FOR_CONFIGS.some((k) => sameKind(k, kind))) return rules.configMaps || rules.secrets;
  return true;
}

/**
 * What to watch. While discovery has not come, nothing. When it failed, the kinds the resource map knows are watched
 * by their usual version and the others count as unknown (a custom kind might exist), never as not served.
 */
export function cleanupPlan(
  kinds: ReturnType<typeof useClusterKinds>,
  namespaces: readonly string[],
  rules: CleanupRules,
): Planned[] | undefined {
  if (!kinds.kinds && !kinds.error) return undefined;
  const resolve = (kind: KindRef): KindRef | null | undefined | false => {
    if (!needed(kind, rules)) return false;
    if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
    return knownKind(kind) ?? (kind.group === "" ? kind : undefined);
  };
  return [
    ...namespaces.flatMap((namespace) => CLEANUP_NAMESPACE_KINDS.map((kind) => ({ kind, namespace, served: resolve(kind) }))),
    ...CLEANUP_CLUSTER_KINDS.map((kind) => ({ kind, namespace: null, served: resolve(kind) })),
  ];
}

export interface WatchFailure {
  kind: string;
  error?: ApiError;
  /** Namespaces the list may not read. */
  forbidden?: string[];
}

export interface CleanupData {
  result: CleanupResult;
  /** A list has not come yet (or discovery, a sample or the cluster check has not). */
  loading: boolean;
  failures: WatchFailure[];
  /** The namespaces checked (in view, within the cap, not excluded). */
  checked: string[];
  /** Namespaces in view that are excluded. */
  skipped: string[];
  rules: CleanupRules;
  /** Samples the namespaces and checks the cluster again ("Check again"). */
  resample: () => void;
  /** Checked namespaces whose sample failed: their ConfigMaps, Secrets, claims, Services and themselves are not offered. */
  sampleFailed: string[];
  /** The cluster check failed: nothing that needs it is offered. */
  clusterFailed: boolean;
  /**
   * Before a deletion: samples `namespaces` and checks the cluster again, fresh from the API server, so `evaluate`
   * judges on what is there now rather than on what was there when the page opened.
   */
  recheck: (namespaces: readonly string[]) => Promise<void>;
  /** The candidates by key, judged now on the live lists and the latest samples and cluster check. */
  evaluate: () => ReadonlyMap<string, Candidate>;
}

const EMPTY: CleanupResult = { candidates: [], managed: [], kept: [], unchecked: [], blocked: [], unavailableGroups: [], clusterUnread: [] };

/** Names asked for per kind: enough to see past what Kubernetes creates in every namespace. */
const SAMPLE_LIMIT = 5;
/** Kinds one sample may ask for (the backend's own cap). */
const MAX_SAMPLED_KINDS = 300;
/** ConfigMaps and Secrets one cluster check may look for (the backend's own cap). */
const MAX_TARGETS = 20_000;

/** The served namespaced kinds that can be listed, Events left out. */
export function sampledKinds(kinds: ReturnType<typeof useClusterKinds>): KindRef[] | undefined {
  if (!kinds.kinds) return undefined;
  return kinds.kinds
    .filter((k) => k.namespaced && (k.verbs.length === 0 || k.verbs.includes("list")))
    .map((k) => k.kindRef)
    .filter((k) => !NOT_SAMPLED.some((n) => sameKind(n, k)));
}

/**
 * The served cluster-scoped kinds whose objects may name a ConfigMap or Secret: every custom kind (scan reports
 * aside) and the built-in kinds that carry such references.
 */
export function clusterScannedKinds(kinds: ReturnType<typeof useClusterKinds>): KindRef[] | undefined {
  if (!kinds.kinds) return undefined;
  return kinds.kinds
    .filter((k) => !k.namespaced && (k.verbs.length === 0 || k.verbs.includes("list")))
    .map((k) => k.kindRef)
    .filter(
      (k) =>
        CLUSTER_BUILT_IN_REFERRERS.some((b) => sameKind(b, k)) || (!BUILT_IN_GROUPS.has(k.group) && !HARMLESS_GROUPS.has(k.group)),
    );
}

/** Keeps the previous array while every element is the same object, so memos keyed on it hold. */
function useStable<T>(values: readonly T[]): readonly T[] {
  const ref = useRef<readonly T[]>(values);
  const prev = ref.current;
  if (prev.length !== values.length || prev.some((v, i) => v !== values[i])) ref.current = values;
  return ref.current;
}

function listState(state: WatchState | undefined): KindList["state"] {
  return state?.status === "ready" ? "ready" : "unknown";
}

async function takeSample(clusterId: ClusterId, ns: string, kinds: KindRef[]): Promise<NamespaceSample> {
  if (kinds.length > MAX_SAMPLED_KINDS) return { state: "failed" };
  try {
    return { state: "ready", kinds: await api.cleanup.sample(clusterId, ns, kinds, SAMPLE_LIMIT) };
  } catch {
    return { state: "failed" };
  }
}

const targetKey = (kind: string, namespace: string, name: string) => `${kind}/${namespace}/${name}`;

async function checkCluster(clusterId: ClusterId, kinds: KindRef[], targets: NamedObject[]): Promise<ClusterState> {
  if (kinds.length > MAX_SAMPLED_KINDS || targets.length > MAX_TARGETS) return { state: "failed" };
  try {
    const check = await api.cleanup.clusterCheck(clusterId, kinds, targets);
    return {
      state: "ready",
      unavailableGroups: check.unavailableGroups,
      referenced: new Set(check.referenced.map((t) => targetKey(t.kind, t.namespace, t.name))),
      scanned: new Set(targets.map((t) => targetKey(t.kind, t.namespace, t.name))),
      unread: [...new Set(check.unread.map((u) => u.kind.kind))].sort(),
    };
  } catch {
    return { state: "failed" };
  }
}

/** The ConfigMaps and Secrets of the lists, as the cluster check looks for them. */
function targetsOf(lists: readonly KindList[], rules: CleanupRules): NamedObject[] {
  const out: NamedObject[] = [];
  for (const list of lists) {
    const kind = sameKind(list.kind, CONFIG_MAP) && rules.configMaps ? "ConfigMap" : sameKind(list.kind, SECRET) && rules.secrets ? "Secret" : null;
    if (!kind) continue;
    for (const obj of list.items) {
      const namespace = obj.metadata?.namespace;
      const name = obj.metadata?.name;
      if (namespace && name) out.push({ kind, namespace, name });
    }
  }
  return out;
}

/** The rules over the live lists of `namespaces` (the first `MAX_CLEANUP_NAMESPACES` of the filter). */
export function useCleanup(clusterId: ClusterId, inView: readonly string[]): CleanupData {
  const { loaded, excluded, ages, rules } = useCleanupSettings();
  const excludedSet = useMemo(() => new Set([...SYSTEM_NAMESPACES, ...excluded]), [excluded]);
  const limited = inView.slice(0, MAX_CLEANUP_NAMESPACES);
  const checkedKey = limited.filter((ns) => !excludedSet.has(ns)).join("\u0000");
  // `checkedKey` stands for the namespaces by value.
  const checked = useMemo(() => (checkedKey ? checkedKey.split("\u0000") : []), [checkedKey]);
  const skipped = limited.filter((ns) => excludedSet.has(ns));

  const kinds = useClusterKinds(clusterId);
  const plan = useMemo(() => (loaded ? cleanupPlan(kinds, checked, rules) : undefined), [loaded, kinds, checked, rules]);
  const watched = (plan ?? []).filter((p): p is Planned & { served: KindRef } => Boolean(p.served));
  const toSample = useMemo(() => sampledKinds(kinds), [kinds]);
  const toScan = useMemo(() => (rules.configMaps || rules.secrets ? clusterScannedKinds(kinds) : []), [kinds, rules]);
  const specs: WatchSpec[] = watched.map((p) => ({
    kind: p.served,
    namespaces: p.namespace === null ? null : [p.namespace],
    labelSelector: null,
    fieldSelector: null,
    ...(METADATA_ONLY.some((k) => sameKind(k, p.kind)) ? { metadataOnly: true } : {}),
  }));
  const states = useSharedWatches(clusterId, specs);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const stateKey = states.map((s) => `${s.status}:${(s.forbidden ?? []).join(",")}`).join("|");
  const itemMaps = useStable(states.map((s) => s.items));
  const lists = useMemo<KindList[]>(() => {
    if (!plan) return [];
    let i = 0;
    return plan.map((p): KindList => {
      if (p.served === false) return { kind: p.kind, namespace: p.namespace, state: "skipped", items: [] };
      if (p.served === null) return { kind: p.kind, namespace: p.namespace, state: "notServed", items: [] };
      if (p.served === undefined) return { kind: p.kind, namespace: p.namespace, state: "unknown", items: [] };
      const state = states[i++];
      const items: KubeObject[] = state ? [...state.items.values()] : [];
      return { kind: p.served, namespace: p.namespace, state: listState(state), forbidden: state?.forbidden ?? undefined, items };
    });
    // `itemMaps` and `stateKey` stand for `states` by value.
  }, [plan, stateKey, itemMaps]);

  // Samples and the cluster check: kept in state for rendering and in refs for `recheck`/`evaluate`, which must see
  // a fresh answer at once, before React renders again.
  const [samples, setSamplesState] = useState<ReadonlyMap<string, NamespaceSample>>(new Map());
  const [cluster, setClusterState] = useState<ClusterState>(undefined);
  const samplesRef = useRef(samples);
  const clusterRef = useRef(cluster);
  const setSamples = (next: ReadonlyMap<string, NamespaceSample>) => {
    samplesRef.current = next;
    setSamplesState(next);
  };
  const setCluster = (next: ClusterState) => {
    clusterRef.current = next;
    setClusterState(next);
  };
  const [round, setRound] = useState(0);
  const listsRef = useRef(lists);
  listsRef.current = lists;
  // The ConfigMap and Secret lists the cluster check looks for are in: it runs once they are, with their names then.
  const isConfigKind = (kind: KindRef) => (sameKind(kind, CONFIG_MAP) && rules.configMaps) || (sameKind(kind, SECRET) && rules.secrets);
  const configListsReady = watched.every((p, i) => !isConfigKind(p.kind) || states[i]?.status !== "loading");
  const kindsKey = JSON.stringify([toSample ?? null, toScan ?? null]);
  useEffect(() => {
    setSamples(new Map());
    setCluster(undefined);
    if (!loaded || !toSample || !toScan || !plan || !configListsReady) return;
    let cancelled = false;
    void (async () => {
      const next = await checkCluster(clusterId, toScan, targetsOf(listsRef.current, rules));
      if (cancelled) return;
      setCluster(next);
      for (const ns of checked) {
        const sample = await takeSample(clusterId, ns, toSample);
        if (cancelled) return;
        setSamples(new Map(samplesRef.current).set(ns, sample));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `checkedKey` and `kindsKey` stand for `checked`, `toSample` and `toScan` by value; `plan` matters only once it
    // is there.
  }, [clusterId, checkedKey, kindsKey, round, loaded, Boolean(plan), configListsReady, rules]);
  const resample = useCallback(() => setRound((r) => r + 1), []);

  const input = (from: { lists: KindList[]; samples: ReadonlyMap<string, NamespaceSample>; cluster: ClusterState }) => ({
    lists: from.lists,
    namespaces: checked,
    excluded: excludedSet,
    ages,
    rules,
    samples: from.samples,
    cluster: from.cluster,
    now: Date.now(),
  });
  const result = useMemo(
    () => (plan ? findCleanup({ ...input({ lists, samples, cluster }), now }) : EMPTY),
    [plan, lists, checked, excludedSet, ages, rules, samples, cluster, now],
  );

  const recheck = async (namespaces: readonly string[]) => {
    if (!toSample || !toScan) return;
    setCluster(await checkCluster(clusterId, toScan, targetsOf(listsRef.current, rules)));
    for (const ns of new Set(namespaces)) {
      const sample = await takeSample(clusterId, ns, toSample);
      setSamples(new Map(samplesRef.current).set(ns, sample));
    }
  };
  const cache = useRef<{ key: unknown[]; value: ReadonlyMap<string, Candidate> } | null>(null);
  const evaluate = (): ReadonlyMap<string, Candidate> => {
    if (!plan) return new Map();
    const key = [listsRef.current, samplesRef.current, clusterRef.current];
    if (cache.current && cache.current.key.every((k, i) => k === key[i])) return cache.current.value;
    const fresh = findCleanup(input({ lists: listsRef.current, samples: samplesRef.current, cluster: clusterRef.current }));
    const value = new Map(fresh.candidates.map((c) => [c.key, c]));
    cache.current = { key, value };
    return value;
  };

  const failures: WatchFailure[] = [];
  const seen = new Set<string>();
  states.forEach((state, index) => {
    const kind = watched[index]?.kind.kind ?? "";
    if (state.status === "error" && !seen.has(kind)) {
      seen.add(kind);
      failures.push({ kind, error: state.error ?? undefined });
    } else if ((state.forbidden?.length ?? 0) > 0 && !seen.has(kind)) {
      seen.add(kind);
      failures.push({ kind, forbidden: [...state.forbidden!] });
    }
  });

  return {
    result,
    loading: !plan || states.some((s) => s.status === "loading") || cluster === undefined || checked.some((ns) => !samples.has(ns)),
    failures,
    checked,
    skipped,
    rules,
    resample,
    sampleFailed: checked.filter((ns) => samples.get(ns)?.state === "failed"),
    clusterFailed: cluster?.state === "failed",
    recheck,
    evaluate,
  };
}
