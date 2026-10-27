// Charts from metrics-server (#280, ADR-0125). metrics-server knows only the current CPU and memory, so a chart without
// a Prometheus-compatible source is drawn from the values the window polls anyway (`usePodUsage`, `useNodeUsage`),
// sampled while the chart is shown into a small ring per target. Bounded:
//   - a ring keeps the last `HISTORY_MS` (the hour a Prometheus chart shows), at most `MAX_SAMPLES` samples, and takes
//     a sample at most every `MIN_SAMPLE_GAP_MS` (one poll answer is one sample however many charts show it);
//   - at most `MAX_TARGETS_PER_CLUSTER` rings per cluster and `MAX_TARGETS` overall; a new target pushes out the ring
//     nobody has shown for the longest, and one that would only fit by pushing out a shown ring gets none (its chart
//     says so);
//   - a ring nobody shows is kept `KEEP_MS`, so reopening the details shows the recent past, then dropped;
//   - every ring of a cluster goes when its connection comes or goes (another connection may reach another cluster).
// Nothing is persisted; the samples are the window's own clock and the polled values, never a request of their own.
import { useCallback, useSyncExternalStore } from "react";
import type { ChartTarget, ClusterId, NodeUsage, PodUsage, Usage } from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import { podNamePattern } from "../rightsizing/podNames";
import { CHART_RANGE_SECS, podKey, POLL_INTERVAL_MS } from "./hooks";

/** A ring keeps the samples of the last hour, like a Prometheus chart. */
export const HISTORY_MS = CHART_RANGE_SECS * 1000;
/** Samples per ring: an hour at the poll interval (120), with room for a quicker answer now and then. */
export const MAX_SAMPLES = Math.ceil(HISTORY_MS / POLL_INTERVAL_MS) + 30;
/** Two samples closer than this are one (a remount or a changed namespace filter asks again at once). */
export const MIN_SAMPLE_GAP_MS = 5_000;
/** Rings per cluster. */
export const MAX_TARGETS_PER_CLUSTER = 30;
/** Rings over all clusters. */
export const MAX_TARGETS = 100;
/** How long a ring nobody shows is kept. */
export const KEEP_MS = 10 * 60_000;

/** A chart's points, `(unix seconds, value)` as `Series.points`. */
export type Points = [number, number][];

export interface HistorySeries {
  cpu: Points;
  memory: Points;
}

interface Ring {
  clusterId: ClusterId;
  times: number[];
  cpu: number[];
  memory: number[];
  refs: number;
  /** When it was last shown (released, or acquired). */
  seen: number;
  /** The poll answer of the last sample: the same answer seen by another chart is not a new sample. */
  source: unknown;
  expiry: ReturnType<typeof setTimeout> | null;
  /** The points as last handed out (a new object only after a change, for `useSyncExternalStore`). */
  series: HistorySeries;
}

const EMPTY: HistorySeries = Object.freeze({ cpu: [], memory: [] }) as HistorySeries;
const rings = new Map<string, Ring>();
const listeners = new Set<() => void>();
let clock: () => number = () => Date.now();
let unfollow: (() => void) | undefined;
const connected = new Map<ClusterId, boolean>();
const epochs = new Map<ClusterId, number>();

const ringKey = (clusterId: ClusterId, target: string) => `${clusterId}\u0000${target}`;

function changed(): void {
  for (const fn of [...listeners]) fn();
}

function drop(key: string): void {
  const ring = rings.get(key);
  if (!ring) return;
  if (ring.expiry) clearTimeout(ring.expiry);
  rings.delete(key);
}

/**
 * Makes room for one more ring of `clusterId` by dropping idle rings, those seen longest ago first: the cluster's own
 * until it is under its cap, then any until all of them are. False, dropping nothing, when only shown rings stand in
 * the way (another cluster's idle ring is never pushed out for a ring the cluster's own cap would refuse anyway).
 */
function makeRoom(clusterId: ClusterId): boolean {
  const idle = [...rings].filter(([, ring]) => ring.refs === 0).sort((a, b) => a[1].seen - b[1].seen);
  const victims = new Set<string>();
  let ofCluster = 0;
  for (const ring of rings.values()) if (ring.clusterId === clusterId) ofCluster++;
  for (const [key, ring] of idle) {
    if (ofCluster < MAX_TARGETS_PER_CLUSTER) break;
    if (ring.clusterId !== clusterId) continue;
    victims.add(key);
    ofCluster--;
  }
  if (ofCluster >= MAX_TARGETS_PER_CLUSTER) return false;
  let size = rings.size - victims.size;
  for (const [key] of idle) {
    if (size < MAX_TARGETS) break;
    if (victims.has(key)) continue;
    victims.add(key);
    size--;
  }
  if (size >= MAX_TARGETS) return false;
  for (const key of victims) drop(key);
  return true;
}

/** Drops every ring of the cluster whose connection came or went. */
function followConnections(): void {
  if (unfollow) return;
  const look = (states: ReturnType<typeof useClustersStore.getState>["states"]) => {
    for (const id of new Set([...Object.keys(states), ...connected.keys()])) {
      const now = states[id]?.state === "connected";
      const was = connected.get(id);
      connected.set(id, now);
      if (was !== undefined && was !== now) dropClusterHistory(id);
    }
  };
  look(useClustersStore.getState().states);
  unfollow = useClustersStore.subscribe((s, prev) => {
    if (s.states !== prev.states) look(s.states);
  });
}

/**
 * Holds the ring of `target` (any stable text, e.g. the chart target as JSON) while a chart shows it; returns the
 * release. Without room (every ring of the caps is shown) nothing is held and `hasHistory` stays false.
 */
export function acquireHistory(clusterId: ClusterId, target: string): () => void {
  followConnections();
  const key = ringKey(clusterId, target);
  let ring = rings.get(key);
  if (!ring) {
    if (!makeRoom(clusterId)) return () => undefined;
    ring = { clusterId, times: [], cpu: [], memory: [], refs: 0, seen: clock(), source: undefined, expiry: null, series: EMPTY };
    rings.set(key, ring);
  }
  if (ring.expiry) clearTimeout(ring.expiry);
  ring.expiry = null;
  ring.refs += 1;
  ring.seen = clock();
  const held = ring;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    held.seen = clock();
    if (held.refs > 0 || rings.get(key) !== held) return;
    held.expiry = setTimeout(() => {
      if (held.refs === 0 && rings.get(key) === held) {
        drop(key);
        changed();
      }
    }, KEEP_MS);
  };
}

/** Whether `target` has a ring (it is held, or kept after its last view). */
export function hasHistory(clusterId: ClusterId, target: string): boolean {
  return rings.has(ringKey(clusterId, target));
}

/**
 * Adds a sample to the ring of `target`, if it has one: `usage` as of now, from the poll answer `source` (the same
 * answer twice, or a sample within `MIN_SAMPLE_GAP_MS` of the last one, adds nothing). Samples older than an hour go.
 */
export function recordSample(clusterId: ClusterId, target: string, source: unknown, usage: Usage | undefined): void {
  const ring = rings.get(ringKey(clusterId, target));
  if (!ring || usage === undefined || source === ring.source) return;
  const now = clock();
  const last = ring.times[ring.times.length - 1];
  ring.source = source;
  if (last !== undefined && now - last < MIN_SAMPLE_GAP_MS) return;
  ring.times.push(now);
  ring.cpu.push(usage.cpuMillicores);
  ring.memory.push(usage.memoryBytes);
  let cut = 0;
  while (cut < ring.times.length && now - ring.times[cut]! > HISTORY_MS) cut++;
  cut = Math.max(cut, ring.times.length - MAX_SAMPLES);
  if (cut > 0) {
    ring.times.splice(0, cut);
    ring.cpu.splice(0, cut);
    ring.memory.splice(0, cut);
  }
  const at = ring.times.map((t) => Math.floor(t / 1000));
  ring.series = {
    cpu: at.map((t, i) => [t, ring.cpu[i]!]),
    memory: at.map((t, i) => [t, ring.memory[i]!]),
  };
  changed();
}

/** The points of `target`'s ring (empty without one). */
export function historySeries(clusterId: ClusterId, target: string): HistorySeries {
  return rings.get(ringKey(clusterId, target))?.series ?? EMPTY;
}

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders with the points of `target`'s ring. */
export function useHistorySeries(clusterId: ClusterId, target: string): HistorySeries {
  const snapshot = useCallback(() => historySeries(clusterId, target), [clusterId, target]);
  return useSyncExternalStore(subscribeHistory, snapshot, snapshot);
}

/**
 * Drops every ring of `clusterId` and moves its epoch on: a chart still shown (a Reconnect keeps the details mounted)
 * holds a ring that is gone, so it acquires again when the epoch moves (`useHistoryEpoch`).
 */
export function dropClusterHistory(clusterId: ClusterId): void {
  for (const [key, ring] of [...rings]) {
    if (ring.clusterId === clusterId) drop(key);
  }
  epochs.set(clusterId, historyEpochOf(clusterId) + 1);
  changed();
}

/** How many times the rings of `clusterId` were dropped: a holder depends on it and acquires again when it moves. */
export function historyEpochOf(clusterId: ClusterId): number {
  return epochs.get(clusterId) ?? 0;
}

/** Re-renders with `historyEpochOf(clusterId)`. */
export function useHistoryEpoch(clusterId: ClusterId): number {
  const snapshot = useCallback(() => historyEpochOf(clusterId), [clusterId]);
  return useSyncExternalStore(subscribeHistory, snapshot, snapshot);
}

/** Rings held (tests): all of them and those of `clusterId`. */
export function historyStats(clusterId?: ClusterId): { rings: number; ofCluster: number } {
  let ofCluster = 0;
  for (const ring of rings.values()) if (ring.clusterId === clusterId) ofCluster++;
  return { rings: rings.size, ofCluster };
}

/** Forgets every ring and the connections seen (tests); `now` replaces the clock. */
export function resetHistory(now?: () => number): void {
  for (const key of [...rings.keys()]) drop(key);
  connected.clear();
  epochs.clear();
  unfollow?.();
  unfollow = undefined;
  clock = now ?? (() => Date.now());
  changed();
}

/**
 * The usage a chart of `target` shows, from the polled values: a pod's own, a workload's pods' sum (picked by the names
 * its controller gives them, as the Prometheus charts do), a node's. `undefined` when the answer does not have it (a
 * pod not reported yet) and for the cluster (its overview charts stay Prometheus' only).
 */
export function targetUsage(
  target: ChartTarget,
  pods: ReadonlyMap<string, PodUsage> | null,
  nodes: ReadonlyMap<string, NodeUsage> | null,
): Usage | undefined {
  switch (target.type) {
    case "pod":
      return pods?.get(podKey(target.namespace, target.name))?.usage;
    case "node":
      return nodes?.get(target.name)?.usage;
    case "workload": {
      if (!pods || !WORKLOAD_KINDS.has(target.kind)) return undefined;
      const pattern = podNamePattern(target.kind as ChartWorkloadKind, target.name);
      return sumUsage([...pods.values()].filter((p) => p.namespace === target.namespace && pattern.test(p.name)));
    }
    case "cluster":
      // Every node's usage summed, as the Prometheus cluster charts sum every node.
      return nodes && nodes.size > 0 ? sumUsage([...nodes.values()]) : undefined;
  }
}

type ChartWorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";
const WORKLOAD_KINDS = new Set<string>(["Deployment", "StatefulSet", "DaemonSet"]);

function sumUsage(list: readonly { usage: Usage }[]): Usage {
  let cpuMillicores = 0;
  let memoryBytes = 0;
  for (const { usage } of list) {
    cpuMillicores += usage.cpuMillicores;
    memoryBytes += usage.memoryBytes;
  }
  return { cpuMillicores, memoryBytes };
}
