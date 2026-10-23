// The problems category "Vertical Pod Autoscaler" (#242), on by default (ADR-0111: a cluster holds few VPAs, and
// HPAs are listed only where a VPA changes running pods). While the problems store holds its source (the problems
// screen, the section counter or the notifications look at a cluster that serves VPAs), the cluster's VPAs are held
// (one shared watch, all namespaces, at most `MAX_VPAS`) and so are the HPAs of the namespaces whose VPAs change
// running pods (at most `MAX_HPA_NAMESPACES` namespaces and `MAX_HPAS` objects; beyond either the conflicts are not
// judged and the source says it is truncated). Three problems:
//   - ConfigUnsupported: the recommender cannot use the VPA (its target cannot be read, or is not the topmost
//     controller), with the recommender's message, counted `SHORT_GRACE_MS` after the condition changed;
//   - NoPodsMatched: no pod matches the VPA (and it is not ConfigUnsupported, which also says so), counted
//     `NO_PODS_GRACE_MS` after the condition changed — a rollout or a scale from zero passes quietly;
//   - HpaConflict: the VPA changes running pods and an HPA scales the same target on a resource the VPA controls
//     (conflicts.ts, judged from the two objects alone), counted `SHORT_GRACE_MS` after it was first seen.
// The watches are the resource map's shared ones (`acquireWatch`), so an open VPA or HPA table shares the list; they
// are released with the source. Agents get none of it (NEVER_FOR_AGENTS).
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { SHORT_GRACE_MS, type Problem } from "../problems/model";
import { registerProblemProvider, type ProvidedProblems } from "../problems/store";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import { conflictsOf } from "./conflicts";
import { HPA, statusOf, UPDATING_MODES, updateModeOf, VPA } from "./model";

export const MAX_VPAS = 5000;
export const MAX_HPA_NAMESPACES = 40;
export const MAX_HPAS = 5000;
export const UNSUPPORTED_GRACE_MS = SHORT_GRACE_MS;
export const NO_PODS_GRACE_MS = 10 * 60_000;
export const CONFLICT_GRACE_MS = SHORT_GRACE_MS;
/** Changes of the shared watches are looked at once per this long. */
export const LOOK_DELAY_MS = 200;

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

const uidOf = (obj: KubeObject) => obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;

/** The namespaces whose HPAs are looked at: those of VPAs that change running pods. */
export function namespacesToCheck(vpas: Iterable<KubeObject>): string[] {
  const out = new Set<string>();
  for (const vpa of vpas) {
    if (vpa.metadata?.deletionTimestamp || !vpa.metadata?.namespace) continue;
    if (UPDATING_MODES.has(updateModeOf(vpa))) out.add(vpa.metadata.namespace);
  }
  return [...out].sort();
}

/** The HPAs of a namespace read in full, else `undefined` (not judged). */
export function hpasIn(hpas: WatchState | undefined, namespace: string): KubeObject[] | undefined {
  if (!hpas || hpas.status !== "ready" || isCapped(hpas) || (hpas.forbidden ?? []).includes(namespace)) return undefined;
  return [...hpas.items.values()].filter((h) => h.metadata?.namespace === namespace);
}

/** The problems of the VPAs; `firstSeen` keeps when each was first seen. */
export function toProblems(
  vpas: Iterable<KubeObject>,
  hpasOf: (namespace: string) => KubeObject[] | undefined,
  firstSeen: Map<string, number>,
  now: number,
  kind = VPA,
): Problem[] {
  const keys = new Set<string>();
  const out: Problem[] = [];
  for (const vpa of vpas) {
    if (vpa.metadata?.deletionTimestamp) continue;
    const uid = uidOf(vpa);
    const namespace = vpa.metadata?.namespace ?? "";
    const name = vpa.metadata?.name ?? "";
    const add = (reason: string, start: number | undefined, grace: number, extra: Partial<Problem>) => {
      const key = `${uid}|${reason}`;
      keys.add(key);
      const first = firstSeen.get(key) ?? now;
      firstSeen.set(key, first);
      out.push({
        key,
        notifyKey: key,
        category: "vpa",
        uid,
        object: { kind, namespace, name },
        reason,
        group: reason,
        notify: true,
        firstSeen: first,
        activeAt: (start ?? first) + grace,
        ...extra,
      });
    };
    const s = statusOf(vpa);
    if (s.reason === "configUnsupported") add("ConfigUnsupported", time(s.since), UNSUPPORTED_GRACE_MS, { message: s.message, since: s.since });
    if (s.reason === "noPodsMatched") add("NoPodsMatched", time(s.since), NO_PODS_GRACE_MS, { messageKey: "messages.vpaNoPodsMatched", since: s.since });
    const hpas = UPDATING_MODES.has(updateModeOf(vpa)) ? hpasOf(namespace) : undefined;
    for (const c of hpas ? conflictsOf(vpa, hpas) : []) {
      const key = `HpaConflict:${c.hpa}`;
      add(key, undefined, CONFLICT_GRACE_MS, {
        reason: "HpaConflict",
        group: "HpaConflict",
        messageKey: "messages.vpaHpaConflict",
        messageParams: { hpa: c.hpa, mode: updateModeOf(vpa) },
        messageLists: { resources: c.resources },
      });
    }
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
}

const everywhere = (kind: WatchSpec["kind"]): WatchSpec => ({ kind, namespaces: null, labelSelector: null, fieldSelector: null });

/** Provides the category's problems of one cluster through `set`; returns the function that stops it. */
export function provideVpa(clusterId: ClusterId, set: (update: ProvidedProblems) => void): () => void {
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
    const served = kinds ? findKind(kinds, VPA)?.kindRef : undefined;
    if (!served) {
      hold([]);
      if (last?.[0] !== "none") set({ status: kinds ? "ready" : "loading", problems: [] });
      last = ["none"];
      return;
    }
    const vpaSpec = everywhere(served);
    const vpaKey = specKey(clusterId, vpaSpec);
    if (!held.has(vpaKey)) held.set(vpaKey, acquireWatch(clusterId, vpaSpec, MAX_VPAS));
    const vpas = watchState(clusterId, vpaSpec);
    const namespaces = vpas.status === "loading" ? [] : namespacesToCheck(vpas.items.values());
    const tooMany = namespaces.length > MAX_HPA_NAMESPACES;
    const hpaKind = findKind(kinds!, HPA)?.kindRef;
    const hpaSpec: WatchSpec | undefined =
      hpaKind && namespaces.length > 0 && !tooMany ? { kind: hpaKind, namespaces, labelSelector: null, fieldSelector: null } : undefined;
    hold([{ spec: vpaSpec, cap: MAX_VPAS }, ...(hpaSpec ? [{ spec: hpaSpec, cap: MAX_HPAS }] : [])]);
    const hpas = hpaSpec ? watchState(clusterId, hpaSpec) : undefined;
    const inputs = [vpas, hpas];
    if (last && last.length === 2 && last[0] === inputs[0] && last[1] === inputs[1]) return;
    last = inputs;
    if (vpas.status === "loading" || hpas?.status === "loading") {
      set({ status: "loading", problems: [] });
      return;
    }
    if (vpas.status === "error") {
      set({ status: "error", error: vpas.error, problems: [] });
      return;
    }
    set({
      status: "ready",
      problems: toProblems(vpas.items.values(), (ns) => hpasIn(hpas, ns), firstSeen, Date.now(), served),
      truncated: isCapped(vpas) || tooMany || (hpas !== undefined && isCapped(hpas)),
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

registerProblemProvider("vpa", provideVpa);
