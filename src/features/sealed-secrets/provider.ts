// The problems category "Sealed Secrets" (#240): while the problems store holds its source (the problems screen, the
// section counter or the notifications look at a cluster that serves SealedSecrets), the cluster's SealedSecrets are
// held (one shared watch, all namespaces, at most `MAX_SEALED_SECRETS`) and so is a metadata-only list of the Secrets
// in the namespaces whose SealedSecrets say Synced (at most `MAX_SECRET_NAMESPACES` namespaces and `MAX_SECRETS`
// objects; beyond either, a missing Secret is not judged and the source says it is truncated). Two problems:
//   - SyncFailed: Synced=False for the current generation, counted `SYNC_GRACE_MS` after the condition changed (the
//     controller retries with a back-off; a key restored a minute later passes quietly), with the controller's error;
//   - TargetMissing: Synced=True and current, but no Secret of that name in a namespace read in full, counted
//     `TARGET_GRACE_MS` after it was first seen (the controller recreates an owned Secret on its deletion).
// The watches are the resource map's shared ones (`acquireWatch`), so an open Sealed Secrets table shares the list;
// they are released with the source. Secret data never reaches the window: the list is metadata only. Agents get none
// of it (NEVER_FOR_AGENTS).
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { LONG_GRACE_MS, SHORT_GRACE_MS, type Problem } from "../problems/model";
import { registerProblemProvider, type ProvidedProblems } from "../problems/store";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import { SEALED_SECRET, SECRET, syncOf, targetName } from "./model";

export const MAX_SEALED_SECRETS = 5000;
export const MAX_SECRET_NAMESPACES = 20;
export const MAX_SECRETS = 5000;
export const SYNC_GRACE_MS = LONG_GRACE_MS;
export const TARGET_GRACE_MS = SHORT_GRACE_MS;
/** Changes of the shared watches are looked at once per this long. */
export const LOOK_DELAY_MS = 200;

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

const uidOf = (obj: KubeObject) => obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;

/** The namespaces whose Secrets are looked at: those of SealedSecrets that say they are synced. */
export function namespacesToCheck(sealed: Iterable<KubeObject>): string[] {
  const out = new Set<string>();
  for (const obj of sealed) {
    if (obj.metadata?.deletionTimestamp || !obj.metadata?.namespace) continue;
    if (syncOf(obj).state === "ready") out.add(obj.metadata.namespace);
  }
  return [...out].sort();
}

/** Whether the Secrets list has `namespace/name`: `false` only where it is read in full, else `undefined`. */
export function secretExists(secrets: WatchState | undefined, namespace: string, name: string): boolean | undefined {
  if (!secrets) return undefined;
  for (const s of secrets.items.values()) if (s.metadata?.namespace === namespace && s.metadata?.name === name) return true;
  if (secrets.status !== "ready" || isCapped(secrets) || (secrets.forbidden ?? []).includes(namespace)) return undefined;
  return false;
}

/** The problems of the SealedSecrets; `firstSeen` keeps when each was first seen. */
export function toProblems(
  sealed: Iterable<KubeObject>,
  exists: (namespace: string, name: string) => boolean | undefined,
  firstSeen: Map<string, number>,
  now: number,
  kind = SEALED_SECRET,
): Problem[] {
  const keys = new Set<string>();
  const out: Problem[] = [];
  for (const obj of sealed) {
    if (obj.metadata?.deletionTimestamp) continue;
    const uid = uidOf(obj);
    const namespace = obj.metadata?.namespace ?? "";
    const name = obj.metadata?.name ?? "";
    const sync = syncOf(obj);
    const add = (reason: string, start: number | undefined, grace: number, extra: Partial<Problem>) => {
      const key = `${uid}|${reason}`;
      keys.add(key);
      const first = firstSeen.get(key) ?? now;
      firstSeen.set(key, first);
      out.push({
        key,
        notifyKey: key,
        category: "sealedSecrets",
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
    if (sync.state === "failed") add("SyncFailed", time(sync.since), SYNC_GRACE_MS, { message: sync.message, since: sync.since });
    const target = targetName(obj);
    if (sync.state === "ready" && target && exists(namespace, target) === false)
      add("TargetMissing", undefined, TARGET_GRACE_MS, { messageKey: "messages.sealedSecretTargetMissing", messageParams: { name: target } });
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
}

const everywhere = (kind: WatchSpec["kind"]): WatchSpec => ({ kind, namespaces: null, labelSelector: null, fieldSelector: null });

/** Provides the category's problems of one cluster through `set`; returns the function that stops it. */
export function provideSealedSecrets(clusterId: ClusterId, set: (update: ProvidedProblems) => void): () => void {
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
    const served = kinds ? findKind(kinds, SEALED_SECRET)?.kindRef : undefined;
    if (!served) {
      hold([]);
      if (last?.[0] !== "none") set({ status: kinds ? "ready" : "loading", problems: [] });
      last = ["none"];
      return;
    }
    const sealedSpec = everywhere(served);
    const sealedKey = specKey(clusterId, sealedSpec);
    if (!held.has(sealedKey)) held.set(sealedKey, acquireWatch(clusterId, sealedSpec, MAX_SEALED_SECRETS));
    const sealed = watchState(clusterId, sealedSpec);
    const namespaces = sealed.status === "loading" ? [] : namespacesToCheck(sealed.items.values());
    const tooMany = namespaces.length > MAX_SECRET_NAMESPACES;
    const secretsSpec: WatchSpec | undefined =
      namespaces.length > 0 && !tooMany ? { kind: SECRET, namespaces, labelSelector: null, fieldSelector: null, metadataOnly: true } : undefined;
    hold([{ spec: sealedSpec, cap: MAX_SEALED_SECRETS }, ...(secretsSpec ? [{ spec: secretsSpec, cap: MAX_SECRETS }] : [])]);
    const secrets = secretsSpec ? watchState(clusterId, secretsSpec) : undefined;
    const inputs = [sealed, secrets];
    if (last && last.length === 2 && last[0] === inputs[0] && last[1] === inputs[1]) return;
    last = inputs;
    if (sealed.status === "loading" || secrets?.status === "loading") {
      set({ status: "loading", problems: [] });
      return;
    }
    if (sealed.status === "error") {
      set({ status: "error", error: sealed.error, problems: [] });
      return;
    }
    const exists = (ns: string, name: string) => secretExists(secrets, ns, name);
    set({
      status: "ready",
      problems: toProblems(sealed.items.values(), exists, firstSeen, Date.now(), served),
      truncated: isCapped(sealed) || tooMany || (secrets !== undefined && isCapped(secrets)),
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

registerProblemProvider("sealedSecrets", provideSealedSecrets);
