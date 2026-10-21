// The problems category "Reflector" (#241), opt-in (`OPT_IN_CATEGORIES`: it needs a cluster-wide metadata list of
// every Secret and ConfigMap, a cost a cluster pays only when asked): while the problems store holds its source, the
// store lists them (metadata only, names, annotations and resourceVersions — never a value, store.ts) and each mirror
// becomes a problem of its own when
//   - its source does not exist (after `MISSING_GRACE_MS`: Reflector deletes an automatic mirror whose source is gone,
//     and a source applied after its mirror comes moments later),
//   - it is stale — its `reflected-version` is not the source's resourceVersion — for `STALE_GRACE_MS` (Reflector
//     normally copies a change within seconds), or
//   - the source no longer permits its namespace and it is out of date (Reflector will not update it again).
// A mirror whose source cannot be read, or whose permission cannot be told, is never one. Agents get none of it
// (NEVER_FOR_AGENTS).
import type { KubeObject } from "../../api";
import type { Problem } from "../problems/model";
import { registerProblemProvider } from "../problems/store";
import { judgeMirror } from "./judge";
import { kindRefOf, reflectionOf, type ReflectedKind } from "./model";
import { acquireReflector, getReflector, subscribeReflector, type Lookup } from "./store";

export const STALE_GRACE_MS = 10 * 60_000;
export const MISSING_GRACE_MS = 2 * 60_000;

const KINDS: readonly ReflectedKind[] = ["Secret", "ConfigMap"];

export function toProblems(lookup: Lookup, firstSeen: Map<string, number>, now: number): Problem[] {
  const keys = new Set<string>();
  const out: Problem[] = [];
  const add = (kind: ReflectedKind, obj: KubeObject, reason: string, messageKey: string, source: string, graceMs: number) => {
    const uid = obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
    const key = `${uid}|${reason}`;
    keys.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    out.push({
      key,
      notifyKey: key,
      category: "reflector",
      uid,
      object: { kind: kindRefOf(kind), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" },
      reason,
      group: "notReady",
      messageKey,
      messageParams: { source },
      notify: true,
      firstSeen: first,
      activeAt: first + graceMs,
    });
  };
  for (const kind of KINDS) {
    for (const obj of lookup.annotated(kind)) {
      const ref = reflectionOf(obj).reflects;
      if (!ref) continue;
      const source = ref.namespace ? lookup.get(kind, ref.namespace, ref.name) : null;
      const j = judgeMirror(obj, source, lookup.labels);
      if (!j) continue;
      const name = `${ref.namespace}/${ref.name}`;
      if (j.state === "sourceMissing") add(kind, obj, "SourceMissing", "messages.reflectorSourceMissing", name, MISSING_GRACE_MS);
      else if (j.state === "stale") add(kind, obj, "Stale", "messages.reflectorStale", name, STALE_GRACE_MS);
      else if (j.state === "notAllowed" && !j.versionMatches) add(kind, obj, "NotAllowed", "messages.reflectorNotAllowed", name, STALE_GRACE_MS);
    }
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
}

registerProblemProvider("reflector", (clusterId, set) => {
  const firstSeen = new Map<string, number>();
  const release = acquireReflector(clusterId, { all: true });
  let last: unknown;
  const look = () => {
    const state = getReflector(clusterId);
    if (state === last) return;
    last = state;
    if (state.loading) set({ status: "loading", problems: [] });
    else set({ status: "ready", problems: toProblems(state.lookup, firstSeen, Date.now()), truncated: state.truncated });
  };
  const unsubscribe = subscribeReflector(look);
  look();
  return () => {
    unsubscribe();
    release();
  };
});
