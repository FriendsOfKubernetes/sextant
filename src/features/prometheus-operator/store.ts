// What the ServiceMonitors and PodMonitors of a cluster select and whether a Prometheus picks them up, shared by the
// problems provider (provider.ts) and the section counter: one watch per kind the cluster serves (ServiceMonitors,
// PodMonitors, Prometheuses, PrometheusAgents — few, small objects) in all namespaces; metadata-only lists of the
// Services and Pods in the namespaces the monitors look in (at most `MAX_TARGET_NAMESPACES` per kind; beyond it, and
// for a monitor of every namespace, nothing is judged); and the Namespaces' labels only when a Prometheus selects
// namespaces by labels. The watches are the shared ones of the resource map (`acquireWatch`), released `LINGER_MS`
// after the last user and taken anew when the cluster reconnects. Kinds the cluster does not serve are never watched.
import { useEffect, useSyncExternalStore } from "react";
import type { ClusterId, KindRef, KubeObject, ObjectRef, WatchSpec, WatchState } from "../../api";
import { findKind, status, useClusterKinds } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import { matches, type Labels } from "../resource-map/selectors";
import {
  monitorSelector,
  needsNamespaceLabels,
  pickedUpBy,
  POD_MONITOR,
  PROMETHEUS,
  PROMETHEUS_AGENT,
  SERVICE_MONITOR,
  targetNamespaces,
} from "./model";

export const LINGER_MS = 5000;
export const MAX_TARGET_NAMESPACES = 40;

const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const NAMESPACE: KindRef = { group: "", version: "v1", kind: "Namespace" };

/** The kinds watched, in a fixed order. */
const WATCHED = [SERVICE_MONITOR, POD_MONITOR, PROMETHEUS, PROMETHEUS_AGENT];

export interface MonitorFinding {
  uid: string;
  ref: ObjectRef;
  /** The namespaces it looks in (`null`: every namespace). */
  namespaces: string[] | null;
  /** How many Services (Pods) it selects; `undefined` when not judged. */
  selected?: number;
  /** The Prometheus objects that pick it up (`namespace/name`); `undefined` when not judged or there is none. */
  pickedBy?: string[];
}

export interface MonitoringState {
  loading: boolean;
  findings: MonitorFinding[];
}

interface Entry {
  clusterId: ClusterId;
  refs: number;
  linger?: ReturnType<typeof setTimeout>;
  held: Map<string, { spec: WatchSpec; release: () => void }>;
  epoch: number;
  served?: (KindRef | null)[];
  targets: (WatchSpec | undefined)[];
  namespacesSpec?: WatchSpec;
  state?: MonitoringState;
}

const entries = new Map<ClusterId, Entry>();
const listeners = new Set<() => void>();
let unsubscribeShared: (() => void) | undefined;

const everywhere = (kind: KindRef, metadataOnly = false): WatchSpec => ({
  kind,
  namespaces: null,
  labelSelector: null,
  fieldSelector: null,
  ...(metadataOnly ? { metadataOnly: true } : {}),
});

function notify(): void {
  for (const fn of [...listeners]) fn();
}

function onShared(): void {
  for (const entry of entries.values()) {
    entry.state = undefined;
    sync(entry);
  }
  notify();
}

function items(entry: Entry, kind: KindRef | null | undefined): KubeObject[] {
  if (!kind) return [];
  return [...watchState(entry.clusterId, everywhere(kind)).items.values()];
}

/** The metadata-only list of `kind` in the namespaces `monitors` look in, if they are few enough. */
function targetsSpec(kind: KindRef, monitors: KubeObject[]): WatchSpec | undefined {
  const namespaces = new Set<string>();
  for (const m of monitors) {
    const t = targetNamespaces(m);
    if (t.type === "list") for (const n of t.names) namespaces.add(n);
  }
  if (namespaces.size === 0 || namespaces.size > MAX_TARGET_NAMESPACES) return undefined;
  return {
    kind,
    namespaces: [...namespaces].sort(),
    labelSelector: null,
    fieldSelector: null,
    metadataOnly: true,
  };
}

/** Takes the watches the entry needs now and lets go of the others. */
function sync(entry: Entry): void {
  if (entry.refs === 0 && !entry.linger) return;
  if (entry.epoch !== epochOf(entry.clusterId)) {
    for (const h of entry.held.values()) h.release();
    entry.held.clear();
    entry.epoch = epochOf(entry.clusterId);
  }
  const kinds = knownClusterKinds(entry.clusterId);
  entry.served = kinds ? WATCHED.map((kind) => findKind(kinds, kind)?.kindRef ?? null) : undefined;
  const wanted = new Map<string, WatchSpec>();
  const want = (spec: WatchSpec | undefined) => spec && wanted.set(specKey(entry.clusterId, spec), spec);
  for (const kind of entry.served ?? []) if (kind) want(everywhere(kind));
  const [sm, pm, prom, agent] = entry.served ?? [];
  entry.targets = [sm ? targetsSpec(SERVICE, items(entry, sm)) : undefined, pm ? targetsSpec(POD, items(entry, pm)) : undefined];
  entry.targets.forEach(want);
  const proms = [...items(entry, prom), ...items(entry, agent)];
  entry.namespacesSpec = needsNamespaceLabels(proms) ? everywhere(NAMESPACE, true) : undefined;
  want(entry.namespacesSpec);
  for (const [key, h] of [...entry.held]) {
    if (wanted.has(key)) continue;
    h.release();
    entry.held.delete(key);
  }
  for (const [key, spec] of wanted) {
    if (!entry.held.has(key))
      entry.held.set(key, {
        spec,
        release: acquireWatch(entry.clusterId, spec),
      });
  }
}

/** Labels of the listed objects by namespace, for the namespaces a list fully covers. */
function labelsByNamespace(state: WatchState | undefined, spec: WatchSpec | undefined): Map<string, Labels[]> | undefined {
  if (!state || !spec || state.status !== "ready") return undefined;
  const out = new Map<string, Labels[]>();
  for (const ns of spec.namespaces ?? []) if (!state.forbidden?.includes(ns)) out.set(ns, []);
  for (const obj of state.items.values()) out.get(obj.metadata?.namespace ?? "")?.push(status.labelsOf(obj));
  return out;
}

function build(entry: Entry): MonitoringState {
  const served = entry.served;
  const watched = (served ?? []).map((kind) => (kind ? watchState(entry.clusterId, everywhere(kind)) : undefined));
  const targetStates = entry.targets.map((spec) => (spec ? watchState(entry.clusterId, spec) : undefined));
  const nsState = entry.namespacesSpec ? watchState(entry.clusterId, entry.namespacesSpec) : undefined;
  const loading = !served || [...watched, ...targetStates, nsState].some((s) => s?.status === "loading");
  if (loading) return { loading: true, findings: [] };
  const proms = [...items(entry, served[2]), ...items(entry, served[3])];
  const nsLabels = new Map<string, Labels>();
  if (nsState?.status === "ready")
    for (const ns of nsState.items.values()) nsLabels.set(ns.metadata?.name ?? "", status.labelsOf(ns));
  const namespaceLabels = (name: string) => (nsState?.status === "ready" ? nsLabels.get(name) : undefined);
  const findings: MonitorFinding[] = [];
  [served[0], served[1]].forEach((kind, i) => {
    if (!kind) return;
    const targets = labelsByNamespace(targetStates[i], entry.targets[i]);
    for (const monitor of items(entry, kind)) {
      const where = targetNamespaces(monitor);
      let selected: number | undefined;
      if (where.type === "list" && targets && where.names.every((n) => targets.has(n))) {
        const selector = monitorSelector(monitor);
        selected = where.names.reduce((n, ns) => n + targets.get(ns)!.filter((labels) => matches(selector, labels)).length, 0);
      }
      const picked = proms.length > 0 ? pickedUpBy(proms, kind, monitor, namespaceLabels) : undefined;
      findings.push({
        uid: monitor.metadata?.uid ?? `${monitor.metadata?.namespace}/${monitor.metadata?.name}`,
        ref: {
          kind,
          namespace: monitor.metadata?.namespace ?? null,
          name: monitor.metadata?.name ?? "",
        },
        namespaces: where.type === "any" ? null : where.names,
        selected,
        pickedBy:
          picked && (picked.by.length > 0 || !picked.unknown)
            ? picked.by.map((p) => `${p.metadata?.namespace ?? ""}/${p.metadata?.name ?? ""}`)
            : undefined,
      });
    }
  });
  return { loading: false, findings };
}

/** Holds the cluster's monitors and what they select; returns the function that lets go of them. */
export function acquireMonitoring(clusterId: ClusterId): () => void {
  unsubscribeShared ??= subscribeSharedWatches(onShared);
  let entry = entries.get(clusterId);
  if (!entry) {
    entry = {
      clusterId,
      refs: 0,
      held: new Map(),
      epoch: epochOf(clusterId),
      targets: [],
    };
    entries.set(clusterId, entry);
  }
  const held = entry;
  if (held.linger) {
    clearTimeout(held.linger);
    held.linger = undefined;
  }
  held.refs++;
  sync(held);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs--;
    if (held.refs > 0) return;
    held.linger = setTimeout(() => {
      held.linger = undefined;
      if (held.refs > 0 || entries.get(clusterId) !== held) return;
      for (const h of held.held.values()) h.release();
      entries.delete(clusterId);
      notify();
    }, LINGER_MS);
  };
}

/** Looks again at what the cluster serves (discovery came or changed). */
export function refreshMonitoring(clusterId: ClusterId): void {
  const entry = entries.get(clusterId);
  if (!entry) return;
  entry.state = undefined;
  sync(entry);
  notify();
}

const EMPTY: MonitoringState = { loading: true, findings: [] };

export function getMonitoring(clusterId: ClusterId): MonitoringState {
  const entry = entries.get(clusterId);
  if (!entry) return EMPTY;
  entry.state ??= build(entry);
  return entry.state;
}

export function subscribeMonitoring(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a monitor selects nothing in a cluster whose monitors are held (the "Only problems" filter). */
export function selectsNothing(obj: KubeObject): boolean {
  const uid = obj.metadata?.uid;
  if (!uid) return false;
  for (const entry of entries.values()) if (entry.state?.findings.some((f) => f.uid === uid && f.selected === 0)) return true;
  return false;
}

/** The cluster's monitoring findings, held while mounted (`enabled` false holds nothing). */
export function useMonitoring(clusterId: ClusterId, enabled = true): MonitoringState {
  const { kinds } = useClusterKinds(clusterId);
  useEffect(() => {
    if (!enabled) return;
    return acquireMonitoring(clusterId);
  }, [clusterId, enabled]);
  useEffect(() => {
    if (enabled) refreshMonitoring(clusterId);
  }, [clusterId, enabled, kinds]);
  const state = useSyncExternalStore(subscribeMonitoring, () => getMonitoring(clusterId));
  return enabled ? state : EMPTY;
}

/** Forgets everything (tests). */
export function resetMonitoringStore(): void {
  for (const entry of entries.values()) {
    if (entry.linger) clearTimeout(entry.linger);
    for (const h of entry.held.values()) h.release();
  }
  entries.clear();
  unsubscribeShared?.();
  unsubscribeShared = undefined;
}

/** Whether `kind` is one the store judges. */
export const judgedKind = (kind: Pick<KindRef, "group" | "kind">): boolean =>
  [SERVICE_MONITOR, POD_MONITOR].some((k) => k.group === kind.group && k.kind === kind.kind);
