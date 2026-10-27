// What the selection bar of a resource table offers (ADR-0126). Pure: no React and no requests.
//
// The bar lists the kind's actions (`ResourceDef.actions`, the same ids and the same `appliesTo` as the row menu)
// that run on several objects (`multiple`). An action that applies to every selected object is offered as it is; one
// that applies to some of them only is offered too, marked with how many, and its click first says which objects it
// leaves out and why (`notApplicableReason`) — a mixed selection is explained, never silently filtered. An action that
// applies to none of them is not shown. Danger actions (Delete) come last.
import type { KindRef, KubeObject } from "../../api";
import type { ActionId } from "../../resources/registry";
import { getAction, type RegisteredAction } from "../actions/registry";

export interface BarAction {
  action: RegisteredAction;
  /** The selected objects it applies to, in the selection's order. */
  applying: KubeObject[];
  /** The selected objects it does not apply to. */
  left: KubeObject[];
}

function applies(action: RegisteredAction, obj: KubeObject, kind: KindRef): boolean {
  try {
    return action.appliesTo(obj, kind);
  } catch {
    return false;
  }
}

/** The actions of the bar for `objects` of `kind`, in the order of `ids`, danger ones last. */
export function selectionActions(objects: readonly KubeObject[], kind: KindRef, ids: readonly ActionId[]): BarAction[] {
  if (objects.length === 0) return [];
  const result: BarAction[] = [];
  for (const id of new Set(ids)) {
    const action = getAction(id);
    if (!action?.multiple) continue;
    const applying: KubeObject[] = [];
    const left: KubeObject[] = [];
    for (const obj of objects) (applies(action, obj, kind) ? applying : left).push(obj);
    if (applying.length > 0) result.push({ action, applying, left });
  }
  return [...result.filter((a) => !a.action.danger), ...result.filter((a) => a.action.danger)];
}

/** Why `action` does not apply to `obj`, as the action words it, or `undefined` when it does not say. */
export function reasonOf(action: RegisteredAction, obj: KubeObject, kind: KindRef): string | undefined {
  try {
    return action.notApplicableReason?.(obj, kind) || undefined;
  } catch {
    return undefined;
  }
}
