// The deletion behind the Delete action, for one object or a selection (ADR-0126). Pure planning plus one run.
//
// Each object is deleted with the ordinary `resource_delete` (`CHANGE_TIMEOUT` per request, never repeated — ADR-0055),
// one at a time in the order confirmed, Namespaces last (their deletion takes everything inside along). Every request
// carries the uid of the object the user saw as a precondition, so an object deleted and created again under the same
// name since the list was shown is kept: the API server answers `conflict` and the outcome says so. A refusal does not
// stop the run; "Stop" is honoured before the next object (the one being deleted is finished first). Sextant's own pods
// (node shells, debug copies) are deleted like any other pod, as a single Delete always did: the user's own sessions.
import { api, toApiError, type ApiError, type ClusterId, type KindRef, type KubeObject, type ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { managerOf } from "../hygiene/managed";
import { controllerOf, type Owner } from "../restart/model";

/** How many objects the confirmation names; the rest are counted in one sentence. */
export const MAX_LISTED = 50;

export interface DeleteItem {
  ref: ObjectRef;
  /** The uid the user saw; sent as the precondition when known. */
  uid?: string;
  /** Its controller (an owner reference with `controller: true`): it usually creates the object again. */
  controller?: Owner;
  /** A GitOps tool that puts it back on its next sync (Flux, Argo CD; `hygiene/managed.ts`). */
  gitops?: { tool: "flux" | "argocd"; name: string };
}

export type DeleteOutcomeId =
  /** Deleted. */
  | "deleted"
  /** Already gone when its turn came. */
  | "gone"
  /** Another object of the same name took its place since the list was shown: kept. */
  | "changed"
  /** No permission. */
  | "forbidden"
  /** Any other error (a timeout, a webhook, …). */
  | "failed"
  /** Not tried: the run was stopped. */
  | "stopped";

export interface DeleteOutcome {
  item: DeleteItem;
  id: DeleteOutcomeId;
  error?: ApiError;
}

const isNamespace = (kind: Pick<KindRef, "group" | "kind">) => kind.group === "" && kind.kind === "Namespace";

/**
 * The objects to delete, Namespaces last, otherwise in the order given. `objects` are the watched objects of `refs`
 * (same order) when the caller has them; without them nothing is known beyond the names.
 */
export function planDelete(refs: readonly ObjectRef[], objects?: readonly KubeObject[]): DeleteItem[] {
  const items = refs.map((ref, i): DeleteItem => {
    const obj = objects?.[i];
    const same = obj && obj.metadata?.name === ref.name && (obj.metadata?.namespace ?? undefined) === (ref.namespace ?? undefined);
    if (!same) return { ref };
    const item: DeleteItem = { ref };
    const uid = obj.metadata?.uid;
    if (uid) item.uid = uid;
    const controller = controllerOf(obj);
    if (controller) item.controller = controller;
    const manager = managerOf(obj);
    if (manager && (manager.tool === "flux" || manager.tool === "argocd")) item.gitops = { tool: manager.tool, name: manager.name };
    return item;
  });
  return [...items.filter((i) => !isNamespace(i.ref.kind)), ...items.filter((i) => isNamespace(i.ref.kind))];
}

export interface DeleteRunOptions {
  /** Called after each object. */
  onProgress?: (done: number, total: number) => void;
  /** Called before each object with its index. */
  onStart?: (index: number) => void;
  /** Checked before each object; `true` stops the run. */
  shouldStop?: () => boolean;
}

/** Deletes `items` one at a time; every item gets an outcome, in the same order. */
export async function deleteItems(clusterId: ClusterId, items: readonly DeleteItem[], options: DeleteRunOptions = {}): Promise<DeleteOutcome[]> {
  const outcomes: DeleteOutcome[] = [];
  for (const [index, item] of items.entries()) {
    if (options.shouldStop?.()) {
      outcomes.push({ item, id: "stopped" });
      continue;
    }
    options.onStart?.(index);
    outcomes.push(await deleteOne(clusterId, item));
    options.onProgress?.(outcomes.length, items.length);
  }
  closeDetailsOf(outcomes.filter((o) => o.id === "deleted" || o.id === "gone").map((o) => o.item.ref));
  return outcomes;
}

async function deleteOne(clusterId: ClusterId, item: DeleteItem): Promise<DeleteOutcome> {
  try {
    if (item.uid) await api.resources.delete(clusterId, item.ref, { uid: item.uid, resourceVersion: null });
    else await api.resources.delete(clusterId, item.ref);
    return { item, id: "deleted" };
  } catch (err) {
    const error = toApiError(err);
    if (error.code === "notFound") return { item, id: "gone" };
    // The uid precondition failed: the object of that name is not the one the user confirmed.
    if (error.code === "conflict" && item.uid) return { item, id: "changed", error };
    if (error.code === "forbidden") return { item, id: "forbidden", error };
    return { item, id: "failed", error };
  }
}

/** The details panel must not keep showing an object that is gone. */
function closeDetailsOf(deleted: readonly ObjectRef[]): void {
  const { details, closeDetails } = useAppStore.getState();
  if (!details) return;
  const same = (r: ObjectRef) =>
    r.name === details.name &&
    (r.namespace ?? null) === (details.namespace ?? null) &&
    r.kind.group === details.kind.group &&
    r.kind.kind === details.kind.kind;
  if (deleted.some(same)) closeDetails();
}
