// The problems category "Dynamic Resource Allocation" (#244, ADR-0116), on by default: a pod the scheduler has not
// placed because a ResourceClaim it uses has no devices yet, counted `WAIT_GRACE_MS` after its PodScheduled condition
// changed (else after it was created). The scheduler's own message is the problem's text. A pod counts when the claim
// made from its template does not exist yet or the claim it names is missing; a claim that exists but is not
// allocated counts only with a DRA reason in the scheduler's message (`draReasonsIn`) — the scheduler allocates
// claims while it places the pod, so an unallocated claim of a pod that waits for CPU, a taint or an affinity is not
// the reason it waits. A pod held by a scheduling gate (`SchedulingGated`) is not judged at all.
//
// Held only where the cluster serves ResourceClaims and has at least one DeviceClass (resource.k8s.io/v1 is served by
// default from Kubernetes 1.34, but a cluster without a DRA driver has no class; one metadata-only DeviceClass watch
// capped at `MAX_DEVICE_CLASSES` tells), and bounded: one shared watch of the cluster's Pending pods
// (`status.phase=Pending` on the API server, at most `MAX_PENDING_PODS`), and the ResourceClaims of only the
// namespaces where such a pod waits (at most `MAX_CLAIM_NAMESPACES` namespaces and `MAX_CLAIMS` objects). Where the
// claims are not read in full, a pod counts only when the scheduler's message names a DRA reason. A DeviceClass list
// that cannot be read does not stop it (nothing tells then). The watches are the resource map's shared ones
// (`acquireWatch`); they are released with the source. Agents get none of it (NEVER_FOR_AGENTS).
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { isUnscheduled, schedulingCondition } from "../autoscaling/scheduling";
import { LONG_GRACE_MS, type Problem } from "../problems/model";
import { registerProblemProvider, type ProvidedProblems } from "../problems/store";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import { DEVICE_CLASS, draReasonsIn, isAllocated, POD, podClaimsOf, RESOURCE_CLAIM, usesClaims } from "./model";

export const MAX_PENDING_PODS = 2000;
/** The DeviceClass watch only tells whether there is one. */
export const MAX_DEVICE_CLASSES = 5;
export const MAX_CLAIM_NAMESPACES = 40;
export const MAX_CLAIMS = 5000;
export const WAIT_GRACE_MS = LONG_GRACE_MS;
/** Changes of the shared watches are looked at once per this long. */
export const LOOK_DELAY_MS = 200;
export const PENDING_SELECTOR = "status.phase=Pending";

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

const uidOf = (obj: KubeObject) => obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
const deleting = (obj: KubeObject) => Boolean((obj.metadata as { deletionTimestamp?: string } | undefined)?.deletionTimestamp);

/** A pod waiting for its node that uses claims (a pod held by a scheduling gate waits for no node yet). */
export const waitsWithClaims = (pod: KubeObject): boolean =>
  !deleting(pod) && usesClaims(pod) && isUnscheduled(pod) && schedulingCondition(pod).reason !== "SchedulingGated";

/** The namespaces whose claims are looked at: those of pods waiting with claims. */
export function namespacesToCheck(pods: Iterable<KubeObject>): string[] {
  const out = new Set<string>();
  for (const pod of pods) if (pod.metadata?.namespace && waitsWithClaims(pod)) out.add(pod.metadata.namespace);
  return [...out].sort();
}

/** The claims of a namespace read in full, by name; else `undefined` (not known). */
export function claimsIn(claims: WatchState | undefined, namespace: string): Map<string, KubeObject> | undefined {
  if (!claims || claims.status !== "ready" || isCapped(claims) || (claims.forbidden ?? []).includes(namespace)) return undefined;
  const out = new Map<string, KubeObject>();
  for (const c of claims.items.values()) if (c.metadata?.namespace === namespace && c.metadata.name) out.set(c.metadata.name, c);
  return out;
}

/**
 * The claims a waiting pod has no devices for: names of claims not allocated or missing, and the pod's own claim
 * names whose claim was not made yet; `undefined` when the claims of its namespace are not known.
 */
export function unallocatedClaims(pod: KubeObject, claims: Map<string, KubeObject> | undefined): string[] | undefined {
  return claimGaps(pod, claims)?.map((g) => g.name);
}

/** A claim a waiting pod has no devices for: `absent` when it does not exist (yet), else it is not allocated. */
export interface ClaimGap {
  name: string;
  absent: boolean;
}

/** The claims a waiting pod has no devices for, in the pod's order; `undefined` when its namespace's claims are not known. */
export function claimGaps(pod: KubeObject, claims: Map<string, KubeObject> | undefined): ClaimGap[] | undefined {
  const out: ClaimGap[] = [];
  for (const c of podClaimsOf(pod)) {
    if (c.notNeeded) continue;
    if (c.notCreated || !c.claimName) {
      out.push({ name: c.name, absent: true });
      continue;
    }
    if (!claims) return undefined;
    const claim = claims.get(c.claimName);
    if (!claim) out.push({ name: c.claimName, absent: true });
    else if (!isAllocated(claim)) out.push({ name: c.claimName, absent: false });
  }
  return out;
}

/** The problems of the waiting pods; `firstSeen` keeps when each was first seen. */
export function toProblems(
  pods: Iterable<KubeObject>,
  claimsOf: (namespace: string) => Map<string, KubeObject> | undefined,
  firstSeen: Map<string, number>,
  now: number,
): Problem[] {
  const keys = new Set<string>();
  const out: Problem[] = [];
  for (const pod of pods) {
    if (!waitsWithClaims(pod)) continue;
    const namespace = pod.metadata?.namespace ?? "";
    const scheduling = schedulingCondition(pod);
    const gaps = claimGaps(pod, claimsOf(namespace));
    const draReason = draReasonsIn(scheduling.message).length > 0;
    // Claims not read in full: only the scheduler's own DRA reason says the pod waits for devices. Read: a claim not
    // there (yet) does; an unallocated one only with the scheduler's DRA reason.
    const waits = gaps === undefined ? draReason : gaps.some((g) => g.absent) || (draReason && gaps.length > 0);
    if (!waits) continue;
    const missing = gaps?.map((g) => g.name);
    const uid = uidOf(pod);
    const key = `${uid}|DraWaiting`;
    keys.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    const since = scheduling.since ?? (pod.metadata as { creationTimestamp?: string } | undefined)?.creationTimestamp;
    const owner = ((pod.metadata as { ownerReferences?: { uid?: string; controller?: boolean }[] } | undefined)?.ownerReferences ?? []).find((o) => o.controller)?.uid;
    out.push({
      key,
      notifyKey: `${owner ?? uid}|DraWaiting`,
      category: "dra",
      uid,
      object: { kind: POD, namespace, name: pod.metadata?.name ?? "" },
      reason: "DraWaiting",
      group: "DraWaiting",
      notify: true,
      firstSeen: first,
      activeAt: (time(since) ?? first) + WAIT_GRACE_MS,
      ...(since ? { since } : {}),
      ...(scheduling.message ? { message: scheduling.message } : {}),
      messageKey: missing && missing.length > 0 ? "messages.draWaitingClaims" : "messages.draWaiting",
      ...(missing && missing.length > 0 ? { messageLists: { claims: missing } } : {}),
    });
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
}

/** Provides the category's problems of one cluster through `set`; returns the function that stops it. */
export function provideDra(clusterId: ClusterId, set: (update: ProvidedProblems) => void): () => void {
  const firstSeen = new Map<string, number>();
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
    const served = kinds ? findKind(kinds, RESOURCE_CLAIM)?.kindRef : undefined;
    const classKind = kinds ? findKind(kinds, DEVICE_CLASS)?.kindRef : undefined;
    if (!served || !classKind) {
      hold([]);
      if (last?.[0] !== "none") set({ status: kinds ? "ready" : "loading", problems: [] });
      last = ["none"];
      return;
    }
    const classSpec: WatchSpec = { kind: classKind, namespaces: null, labelSelector: null, fieldSelector: null, metadataOnly: true };
    const classKey = specKey(clusterId, classSpec);
    if (!held.has(classKey)) held.set(classKey, acquireWatch(clusterId, classSpec, MAX_DEVICE_CLASSES));
    const classes = watchState(clusterId, classSpec);
    if (classes.status === "loading" || (classes.status === "ready" && classes.items.size === 0)) {
      // No DeviceClass (yet): no DRA driver, nothing can wait for devices; only the class watch is kept.
      hold([{ spec: classSpec, cap: MAX_DEVICE_CLASSES }]);
      const state = classes.status === "loading" ? "classesLoading" : "noClasses";
      if (last?.[0] !== state) set({ status: classes.status === "loading" ? "loading" : "ready", problems: [] });
      last = [state];
      for (const key of [...firstSeen.keys()]) firstSeen.delete(key);
      return;
    }
    const podSpec: WatchSpec = { kind: POD, namespaces: null, labelSelector: null, fieldSelector: PENDING_SELECTOR };
    const podKey = specKey(clusterId, podSpec);
    if (!held.has(podKey)) held.set(podKey, acquireWatch(clusterId, podSpec, MAX_PENDING_PODS));
    const pods = watchState(clusterId, podSpec);
    const namespaces = pods.status === "loading" ? [] : namespacesToCheck(pods.items.values());
    const tooMany = namespaces.length > MAX_CLAIM_NAMESPACES;
    const claimSpec: WatchSpec | undefined =
      namespaces.length > 0 && !tooMany ? { kind: served, namespaces, labelSelector: null, fieldSelector: null } : undefined;
    hold([{ spec: classSpec, cap: MAX_DEVICE_CLASSES }, { spec: podSpec, cap: MAX_PENDING_PODS }, ...(claimSpec ? [{ spec: claimSpec, cap: MAX_CLAIMS }] : [])]);
    const claims = claimSpec ? watchState(clusterId, claimSpec) : undefined;
    const inputs = [pods, claims];
    if (last && last.length === 2 && last[0] === inputs[0] && last[1] === inputs[1]) return;
    last = inputs;
    if (pods.status === "loading" || claims?.status === "loading") {
      set({ status: "loading", problems: [] });
      return;
    }
    if (pods.status === "error") {
      set({ status: "error", error: pods.error, problems: [] });
      return;
    }
    set({
      status: "ready",
      problems: toProblems(pods.items.values(), (ns) => claimsIn(claims, ns), firstSeen, Date.now()),
      truncated: isCapped(pods) || tooMany || (claims !== undefined && isCapped(claims)),
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

registerProblemProvider("dra", provideDra);
