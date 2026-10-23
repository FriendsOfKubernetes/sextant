// The problems category "NVIDIA GPU Operator" (#245, ADR-0116), on by default (a cluster has one ClusterPolicy, a few
// NVIDIADrivers, and the operand namespace's DaemonSets). Three problems:
//   - NotReady: a ClusterPolicy or NVIDIADriver whose `status.state` is notReady, counted `NOT_READY_GRACE_MS` after
//     its Ready condition changed (else after it was first seen), with the operator's Error/Ready message;
//   - ComponentNotReady: an enabled component's DaemonSet (or a DaemonSet an NVIDIADriver owns) with pods not ready or
//     not updated, counted `ROLLOUT_GRACE_MS` after its counts last moved — a rollout that progresses stays quiet;
//   - MigConfigFailed: a node whose `nvidia.com/mig.config.state` is failed (the MIG manager could not apply
//     `nvidia.com/mig.config`), counted `SHORT_GRACE_MS` after it was first seen.
// Held only where the cluster serves ClusterPolicies. The watches, all shared (`acquireWatch`): ClusterPolicies and
// NVIDIADrivers (cluster-scoped, few), the DaemonSets of the operand namespaces they report (at most
// `MAX_OPERAND_NAMESPACES` namespaces and `MAX_DAEMONSETS` objects), and the nodes labelled
// `nvidia.com/mig.config.state=failed` (a label selector on the API server). Agents get none of it (NEVER_FOR_AGENTS).
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { SHORT_GRACE_MS, type Problem } from "../problems/model";
import { registerProblemProvider, type ProvidedProblems } from "../problems/store";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import {
  CLUSTER_POLICY,
  componentsOf,
  conditionOf,
  DAEMONSET,
  failureOf,
  isRolledOut,
  LABEL_MIG_CONFIG,
  LABEL_MIG_STATE,
  NODE,
  NVIDIA_DRIVER,
  operandNamespaceOf,
  ownedDaemonSets,
  stateOf,
  type Rollout,
} from "./model";

export const MAX_OPERAND_NAMESPACES = 4;
export const MAX_POLICIES = 100;
export const MAX_DAEMONSETS = 1000;
export const MAX_FAILED_NODES = 2000;
export const NOT_READY_GRACE_MS = 10 * 60_000;
export const ROLLOUT_GRACE_MS = 10 * 60_000;
export const MIG_GRACE_MS = SHORT_GRACE_MS;
export const LOOK_DELAY_MS = 200;
export const MIG_FAILED_SELECTOR = `${LABEL_MIG_STATE}=failed`;

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

const uidOf = (obj: KubeObject) => obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
const deleting = (obj: KubeObject) => Boolean((obj.metadata as { deletionTimestamp?: string } | undefined)?.deletionTimestamp);
const labels = (obj: KubeObject) => (obj.metadata as { labels?: Record<string, string> } | undefined)?.labels ?? {};

/** The operand namespaces the ClusterPolicies and NVIDIADrivers report. */
export function operandNamespaces(objects: Iterable<KubeObject>): string[] {
  const out = new Set<string>();
  for (const obj of objects) {
    const ns = operandNamespaceOf(obj);
    if (ns) out.add(ns);
  }
  return [...out].sort();
}

/** The DaemonSets of a namespace read in full; else `undefined` (not judged). */
export function daemonSetsIn(state: WatchState | undefined, namespace: string): KubeObject[] | undefined {
  if (!state || state.status !== "ready" || isCapped(state) || (state.forbidden ?? []).includes(namespace)) return undefined;
  return [...state.items.values()].filter((d) => d.metadata?.namespace === namespace);
}

export interface Inputs {
  policies: Iterable<KubeObject>;
  drivers: Iterable<KubeObject>;
  daemonSetsOf: (namespace: string) => KubeObject[] | undefined;
  failedNodes: Iterable<KubeObject>;
}

/** When each problem was first seen, and the rollout counts it was seen with (a move restarts the clock). */
export type Seen = Map<string, { first: number; stamp: string }>;

const stampOf = (r: Rollout) => `${r.ready}/${r.updated}/${r.desired}`;

/** The category's problems; `seen` keeps when each was first seen. */
export function toProblems(input: Inputs, seen: Seen, now: number): Problem[] {
  const keys = new Set<string>();
  const out: Problem[] = [];
  const add = (obj: KubeObject, kind: typeof CLUSTER_POLICY, reason: string, group: string, start: number | undefined, grace: number, extra: Partial<Problem>, stamp = "") => {
    const uid = uidOf(obj);
    const key = `${uid}|${reason}`;
    keys.add(key);
    const before = seen.get(key);
    const first = before && before.stamp === stamp ? before.first : now;
    seen.set(key, { first, stamp });
    out.push({
      key,
      notifyKey: key,
      category: "gpuOperator",
      uid,
      object: { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" },
      reason: group,
      group,
      notify: true,
      firstSeen: first,
      activeAt: (start ?? first) + grace,
      ...extra,
    });
  };
  const judge = (obj: KubeObject, kind: typeof CLUSTER_POLICY, rollouts: (ds: KubeObject[]) => Rollout[]) => {
    if (deleting(obj)) return;
    const state = stateOf(obj);
    if (state === "ignored" || state === "disabled") return;
    if (state === "notReady") {
      const ready = conditionOf(obj, "Ready");
      const failure = failureOf(obj);
      add(obj, kind, "NotReady", "NotReady", ready?.status === "False" ? time(ready.since) : undefined, NOT_READY_GRACE_MS, {
        ...(failure?.message ? { message: failure.message } : { messageKey: "messages.gpuOperatorNotReady" }),
        ...(ready?.since ? { since: ready.since } : {}),
      });
    }
    const namespace = operandNamespaceOf(obj);
    const daemonSets = namespace ? input.daemonSetsOf(namespace) : undefined;
    if (!daemonSets) return;
    for (const rollout of rollouts(daemonSets)) {
      if (isRolledOut(rollout)) continue;
      add(
        obj,
        kind,
        `ComponentNotReady:${rollout.name}`,
        "ComponentNotReady",
        undefined,
        ROLLOUT_GRACE_MS,
        {
          messageKey: "messages.gpuComponentNotReady",
          messageParams: { daemonSet: rollout.name, ready: rollout.ready, updated: rollout.updated, desired: rollout.desired },
        },
        stampOf(rollout),
      );
    }
  };
  for (const policy of input.policies) {
    judge(policy, CLUSTER_POLICY, (ds) =>
      componentsOf(policy, ds)
        .filter((row) => row.enabled && row.state !== "managedByDriver")
        .flatMap((row) => row.daemonSets),
    );
  }
  for (const driver of input.drivers) {
    judge(driver, NVIDIA_DRIVER, (ds) => ownedDaemonSets(driver, ds));
  }
  for (const node of input.failedNodes) {
    if (labels(node)[LABEL_MIG_STATE] !== "failed") continue;
    add(node, NODE, "MigConfigFailed", "MigConfigFailed", undefined, MIG_GRACE_MS, {
      messageKey: "messages.gpuMigConfigFailed",
      messageParams: { config: labels(node)[LABEL_MIG_CONFIG] ?? "" },
    });
  }
  for (const key of [...seen.keys()]) if (!keys.has(key)) seen.delete(key);
  return out;
}

const everywhere = (kind: WatchSpec["kind"]): WatchSpec => ({ kind, namespaces: null, labelSelector: null, fieldSelector: null });

/** Provides the category's problems of one cluster through `set`; returns the function that stops it. */
export function provideGpuOperator(clusterId: ClusterId, set: (update: ProvidedProblems) => void): () => void {
  const seen: Seen = new Map();
  const held = new Map<string, () => void>();
  let epoch = epochOf(clusterId);
  let last: unknown[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hold = (wanted: { spec: WatchSpec; cap: number }[]) => {
    const keys = new Set(wanted.map((w) => specKey(clusterId, w.spec)));
    for (const [key, release] of [...held]) {
      if (keys.has(key)) continue;
      release();
      held.delete(key);
    }
    for (const { spec, cap } of wanted) {
      const key = specKey(clusterId, spec);
      if (!held.has(key)) held.set(key, acquireWatch(clusterId, spec, cap));
    }
  };

  const look = () => {
    if (epochOf(clusterId) !== epoch) {
      hold([]);
      epoch = epochOf(clusterId);
      last = undefined;
    }
    const kinds = knownClusterKinds(clusterId);
    const policyKind = kinds ? findKind(kinds, CLUSTER_POLICY)?.kindRef : undefined;
    if (!policyKind) {
      hold([]);
      if (last?.[0] !== "none") set({ status: kinds ? "ready" : "loading", problems: [] });
      last = ["none"];
      return;
    }
    const driverKind = findKind(kinds!, NVIDIA_DRIVER)?.kindRef;
    const policySpec = everywhere(policyKind);
    const driverSpec = driverKind ? everywhere(driverKind) : undefined;
    const nodeSpec: WatchSpec = { kind: NODE, namespaces: null, labelSelector: MIG_FAILED_SELECTOR, fieldSelector: null };
    const base = [
      { spec: policySpec, cap: MAX_POLICIES },
      ...(driverSpec ? [{ spec: driverSpec, cap: MAX_POLICIES }] : []),
      { spec: nodeSpec, cap: MAX_FAILED_NODES },
    ];
    for (const { spec, cap } of base) {
      const key = specKey(clusterId, spec);
      if (!held.has(key)) held.set(key, acquireWatch(clusterId, spec, cap));
    }
    const policies = watchState(clusterId, policySpec);
    const drivers = driverSpec ? watchState(clusterId, driverSpec) : undefined;
    const nodes = watchState(clusterId, nodeSpec);
    const namespaces = operandNamespaces([...policies.items.values(), ...(drivers?.items.values() ?? [])]);
    const tooMany = namespaces.length > MAX_OPERAND_NAMESPACES;
    const dsSpec: WatchSpec | undefined =
      namespaces.length > 0 && !tooMany ? { kind: DAEMONSET, namespaces, labelSelector: null, fieldSelector: null } : undefined;
    hold([...base, ...(dsSpec ? [{ spec: dsSpec, cap: MAX_DAEMONSETS }] : [])]);
    const daemonSets = dsSpec ? watchState(clusterId, dsSpec) : undefined;
    const inputs = [policies, drivers, nodes, daemonSets];
    if (last && last.length === inputs.length && inputs.every((x, i) => last![i] === x)) return;
    last = inputs;
    if ([policies, drivers, nodes, daemonSets].some((s) => s?.status === "loading")) {
      set({ status: "loading", problems: [] });
      return;
    }
    if (policies.status === "error") {
      set({ status: "error", error: policies.error, problems: [] });
      return;
    }
    set({
      status: "ready",
      problems: toProblems(
        {
          policies: policies.items.values(),
          drivers: drivers?.status === "ready" ? drivers.items.values() : [],
          daemonSetsOf: (ns) => daemonSetsIn(daemonSets, ns),
          failedNodes: nodes.status === "ready" ? nodes.items.values() : [],
        },
        seen,
        Date.now(),
      ),
      truncated: tooMany || (daemonSets !== undefined && isCapped(daemonSets)) || isCapped(nodes),
    });
  };

  const unsubscribe = subscribeSharedWatches(() => {
    timer ??= setTimeout(() => {
      timer = undefined;
      look();
    }, LOOK_DELAY_MS);
  });
  look();
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    hold([]);
  };
}

registerProblemProvider("gpuOperator", provideGpuOperator);
