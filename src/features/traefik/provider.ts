// The problems category "Traefik" (#232), opt-in (`OPT_IN_CATEGORIES`: it lists every Traefik object of the cluster
// and the Services they name, a cost a cluster pays only when asked): while the problems store holds its source (the
// problems screen, the section counter or the notifications look at a cluster that serves IngressRoutes and the
// category is on), the Traefik objects are held (store.ts) and each object with a broken reference — a Middleware,
// Service, TraefikService or TLSOption that does not exist — or a route Traefik skips by its shape becomes a problem
// of that object. No Secret is listed for it (a Secret reference is judged only in the open details), and a missing
// TLS Secret of a route is no problem anyway: Traefik builds the router and serves another certificate. A reference
// that cannot be judged (another namespace, another provider, a list not read, a target only in the old group) is
// never one. Agents get none of it (NEVER_FOR_AGENTS).
import type { Problem } from "../problems/model";
import { registerProblemProvider } from "../problems/store";
import { breaks, refText } from "./resolve";
import { acquireTraefik, getTraefik, subscribeTraefik, type TraefikFinding } from "./store";

/** A reference applied in the wrong order is fixed by the next apply: it counts after this long. */
export const TRAEFIK_GRACE_MS = 2 * 60_000;

export function toProblems(findings: readonly TraefikFinding[], firstSeen: Map<string, number>, now: number): Problem[] {
  const keys = new Set<string>();
  const out: Problem[] = [];
  const add = (f: TraefikFinding, reason: string, messageKey: string, lists: Record<string, string[]>) => {
    const key = `${f.uid}|${reason}`;
    keys.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    out.push({
      key,
      notifyKey: key,
      category: "traefik",
      uid: f.uid,
      object: f.ref,
      reason,
      group: "notReady",
      messageKey,
      messageLists: lists,
      notify: true,
      firstSeen: first,
      activeAt: first + TRAEFIK_GRACE_MS,
    });
  };
  for (const f of findings) {
    const from = f.ref.namespace ?? "";
    const broken = [...new Set(f.judgement.checks.filter(breaks).map((c) => refText(c.ref, from)))];
    if (broken.length > 0) add(f, "MissingReference", "messages.traefikMissingReference", { refs: broken });
    const skipped = [...new Set(f.judgement.issues.map((i) => String(i.route + 1)))];
    if (skipped.length > 0) add(f, "SkippedRoute", "messages.traefikSkippedRoute", { routes: skipped });
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
}

registerProblemProvider("traefik", (clusterId, set) => {
  const firstSeen = new Map<string, number>();
  const release = acquireTraefik(clusterId);
  let last: unknown;
  const look = () => {
    const state = getTraefik(clusterId);
    if (state === last) return;
    last = state;
    if (state.loading) set({ status: "loading", problems: [] });
    else set({ status: "ready", problems: toProblems(state.findings, firstSeen, Date.now()), truncated: state.truncated });
  };
  const unsubscribe = subscribeTraefik(look);
  look();
  return () => {
    unsubscribe();
    release();
  };
});
