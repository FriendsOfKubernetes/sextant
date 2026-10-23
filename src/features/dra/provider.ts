// The problems category "Dynamic Resource Allocation" (#244, ADR-0116), on by default: a pod the scheduler has not
// placed because a ResourceClaim it uses has no devices yet — the claim made from its template does not exist, the
// claim it names is missing, or a claim is not allocated — counted `WAIT_GRACE_MS` after its PodScheduled condition
// changed (else after it was created). The scheduler's own message is the problem's text.
//
// Held only where the cluster serves ResourceClaims, and bounded: one shared watch of the cluster's Pending pods
// (`status.phase=Pending` on the API server, at most `MAX_PENDING_PODS`), and the ResourceClaims of only the
// namespaces where such a pod waits (at most `MAX_CLAIM_NAMESPACES` namespaces and `MAX_CLAIMS` objects). Where the
// claims are not read in full, a pod counts only when the scheduler's message names a DRA reason. The watches are the
// resource map's shared ones (`acquireWatch`); they are released with the source. Agents get none of it
// (NEVER_FOR_AGENTS).
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { isUnscheduled, schedulingCondition } from "../autoscaling/scheduling";
import { LONG_GRACE_MS, type Problem } from "../problems/model";
import { registerProblemProvider, type ProvidedProblems } from "../problems/store";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import { draReasonsIn, isAllocated, POD, podClaimsOf, RESOURCE_CLAIM, usesClaims } from "./model";

export const MAX_PENDING_PODS = 2000;
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

/** A pod waiting for its node that uses claims. */
export const waitsWithClaims = (pod: KubeObject): boolean => !deleting(pod) && usesClaims(pod) && isUnscheduled(pod);

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
  const out: string[] = [];
  for (const c of podClaimsOf(pod)) {
    if (c.notNeeded) continue;
    if (c.notCreated || !c.claimName) {
      out.push(c.name);
      continue;
    }
    if (!claims) return undefined;
    const claim = claims.get(c.claimName);
    if (!claim || !isAllocated(claim)) out.push(c.claimName);
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
    const missing = unallocatedClaims(pod, claimsOf(namespace));
    // Claims not read in full: only the scheduler's own DRA reason says the pod waits for devices.
    const waits = missing === undefined ? draReasonsIn(scheduling.message).length > 0 : missing.length > 0;
    if (!waits) continue;
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
    if (!served) {
      hold([]);
      if (last?.[0] !== "none") set({ status: kinds ? "ready" : "loading", problems: [] });
      last = ["none"];
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
    hold([{ spec: podSpec, cap: MAX_PENDING_PODS }, ...(claimSpec ? [{ spec: claimSpec, cap: MAX_CLAIMS }] : [])]);
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
