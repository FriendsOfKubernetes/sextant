// The bulk deletion of the "Cleanup" page: one object at a time through the ordinary `resource_delete` (the same
// command as the Delete action: `CHANGE_TIMEOUT` per request, never repeated — ADR-0055). Right before each deletion
// the object is looked up in the live result again: it must still be a candidate, with the uid and resourceVersion
// the user confirmed, and the deletion carries both as preconditions, so the API server keeps an object that was
// replaced or changed in the meantime. A refusal does not stop the run: every object gets its own outcome.
//
// The run starts `SETTLE_MS` after the confirmation: a watch delivers a change within about 350 ms (a 250 ms batch and
// the shared watches' 100 ms flush), so a referrer created before the click (a new Pod mounting a ConfigMap) is in
// the live result when the first object is checked. A re-list per object would only narrow a race with referrers
// created during the run, which no check before a DELETE can close.
//
// What the page sampled when it opened may be stale: before the first deletion every affected namespace is sampled
// again and the cluster checked again (`recheck`), and a namespace once more right before the Namespace object itself
// is deleted; the live result is then judged on those fresh answers, so a custom resource created after the page
// opened keeps its namespace's objects.
import { api, toApiError, type ApiError, type ClusterId } from "../../api";
import { useAppStore } from "../../app/store";
import type { Candidate } from "./rules";

export type OutcomeId =
  /** Deleted. */
  | "deleted"
  /** Already gone when its turn came. */
  | "gone"
  /** No longer a candidate (now named by something, managed, or no longer listed in full). */
  | "notCandidate"
  /** Its uid or resourceVersion differ from the ones confirmed (here or on the server). */
  | "changed"
  /** The deletion failed (no permission, a timeout, …). */
  | "failed"
  /** Not tried: the run was stopped. */
  | "stopped";

export interface Outcome {
  candidate: Candidate;
  id: OutcomeId;
  error?: ApiError;
}

/** How long the run waits after the confirmation before the first deletion. */
export const SETTLE_MS = 1000;

export interface RunOptions {
  /** Wait before the first deletion (default `SETTLE_MS`). */
  settleMs?: number;
  /** The live candidates by key, read right before each deletion. */
  current: () => ReadonlyMap<string, Candidate>;
  /** Samples the namespaces and checks the cluster again, fresh; `current` judges on the answers afterwards. */
  recheck?: (namespaces: string[]) => Promise<void>;
  /** Called after each object. */
  onProgress?: (done: number, total: number) => void;
  /** Checked before each object; `true` stops the run. */
  shouldStop?: () => boolean;
}

/** The namespace an object lives in, or the namespace a Namespace candidate is. */
const namespaceOf = (c: Candidate): string => c.namespace ?? (c.rule === "namespace" ? c.name : "");

/** Namespaces go last: their deletion takes everything inside along. */
export function deletionOrder(items: readonly Candidate[]): Candidate[] {
  return [...items].sort((a, b) => Number(a.rule === "namespace") - Number(b.rule === "namespace"));
}

export async function deleteCandidates(clusterId: ClusterId, items: readonly Candidate[], options: RunOptions): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const ordered = deletionOrder(items);
  await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? SETTLE_MS));
  const recheck = async (namespaces: string[]) => {
    try {
      await options.recheck?.(namespaces);
    } catch {
      // A recheck that fails leaves samples that offer nothing: every object is then kept.
    }
  };
  await recheck([...new Set(ordered.map(namespaceOf).filter(Boolean))]);
  for (const candidate of ordered) {
    if (options.shouldStop?.()) {
      outcomes.push({ candidate, id: "stopped" });
      continue;
    }
    if (candidate.rule === "namespace") await recheck([candidate.name]);
    outcomes.push(await deleteOne(clusterId, candidate, options.current()));
    options.onProgress?.(outcomes.length, ordered.length);
  }
  closeDetailsOf(outcomes.filter((o) => o.id === "deleted" || o.id === "gone").map((o) => o.candidate));
  return outcomes;
}

async function deleteOne(clusterId: ClusterId, confirmed: Candidate, current: ReadonlyMap<string, Candidate>): Promise<Outcome> {
  const now = current.get(confirmed.key);
  if (!now) return { candidate: confirmed, id: "notCandidate" };
  if (now.uid !== confirmed.uid || now.resourceVersion !== confirmed.resourceVersion) return { candidate: confirmed, id: "changed" };
  try {
    await api.resources.delete(
      clusterId,
      { kind: now.kind, namespace: now.namespace, name: now.name },
      { uid: now.uid, resourceVersion: now.resourceVersion || null },
    );
    return { candidate: confirmed, id: "deleted" };
  } catch (err) {
    const error = toApiError(err);
    if (error.code === "notFound") return { candidate: confirmed, id: "gone" };
    if (error.code === "conflict") return { candidate: confirmed, id: "changed", error };
    return { candidate: confirmed, id: "failed", error };
  }
}

/** The details panel must not keep showing an object that is gone. */
function closeDetailsOf(gone: readonly Candidate[]): void {
  const { details, closeDetails } = useAppStore.getState();
  if (!details) return;
  const same = (c: Candidate) =>
    c.name === details.name &&
    c.namespace === (details.namespace ?? null) &&
    c.kind.group === details.kind.group &&
    c.kind.kind === details.kind.kind;
  if (gone.some(same)) closeDetails();
}
