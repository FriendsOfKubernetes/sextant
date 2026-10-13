// Registry of actions on resources (interfaces.md, «Действия над ресурсами регистрируются»).
//
// A feature registers its actions from its own index.ts:
//
//   registerAction("logs", {
//     labelKey: "logs:action",            // i18n key of the menu item / button
//     icon: "logs",                       // icon of the set (src/components/icons.tsx) before the label
//     appliesTo: (obj, kind) => kind.kind === "Pod",
//     run: ({ clusterId, objects, refs, openDialog }) => { … },
//   });
//
// The table's context menu and the details panel's ActionBar list, for a kind, the ids in its
// `ResourceDef.actions` (src/resources/registry.ts) that are registered and apply to every selected object
// (`getActionsFor`), and start them with `runAction`. An action that needs a dialog (scale, delete confirmation, …)
// opens it with `ctx.openDialog`; a rejected `run` is shown to the user as an error dialog.
import { useSyncExternalStore, type ReactNode } from "react";
import type { ClusterId, KindRef, KubeObject, ObjectRef } from "../../api";
import type { IconName } from "../../components/icons";
import type { ActionId } from "../../resources/registry";
import { refOf } from "../../resources/refs";

export type { ActionId };

export interface ActionContext {
  clusterId: ClusterId;
  kind: KindRef;
  /** The objects the action runs on: the clicked row, or every selected row (only for `multiple` actions). */
  objects: KubeObject[];
  /** `ObjectRef`s of `objects`, same order. */
  refs: ObjectRef[];
  /** Shows a modal rendered by `render`; call `close` to remove it. Returns `close`. */
  openDialog: (render: (close: () => void) => ReactNode) => () => void;
}

export interface ActionDef {
  /** i18n key of the label, e.g. "actions:delete". */
  labelKey: string;
  /** Icon of the set (`IconName`) shown before the label. */
  icon: IconName;
  /** Whether the action is offered for `obj` (called for every selected object). */
  appliesTo: (obj: KubeObject, kind: KindRef) => boolean;
  run: (ctx: ActionContext) => void | Promise<void>;
  /** Shown in red (delete, drain). */
  danger?: boolean;
  /** Offered when several rows are selected (e.g. delete). Default: single object only. */
  multiple?: boolean;
}

export interface RegisteredAction extends ActionDef {
  id: ActionId;
}

const actions = new Map<ActionId, RegisteredAction>();
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version++;
  for (const fn of listeners) fn();
}

/** Registers (or replaces) the implementation of an action. Returns a function that removes it. */
export function registerAction(id: ActionId, def: ActionDef): () => void {
  const entry = { ...def, id };
  actions.set(id, entry);
  changed();
  return () => {
    if (actions.get(id) === entry) {
      actions.delete(id);
      changed();
    }
  };
}

export function unregisterAction(id: ActionId): void {
  if (actions.delete(id)) changed();
}

export function getAction(id: ActionId): RegisteredAction | undefined {
  return actions.get(id);
}

/**
 * Actions to offer for `objects` of `kind`, in the order of `ids` (usually `ResourceDef.actions`): registered,
 * applying to every object, and — when there is more than one object — marked `multiple`.
 */
export function getActionsFor(objects: KubeObject[], kind: KindRef, ids: readonly ActionId[]): RegisteredAction[] {
  if (objects.length === 0) return [];
  const result: RegisteredAction[] = [];
  for (const id of ids) {
    const action = actions.get(id);
    if (!action) continue;
    if (objects.length > 1 && !action.multiple) continue;
    if (objects.every((obj) => safeApplies(action, obj, kind))) result.push(action);
  }
  return result;
}

function safeApplies(action: ActionDef, obj: KubeObject, kind: KindRef): boolean {
  try {
    return action.appliesTo(obj, kind);
  } catch {
    return false;
  }
}

/** Starts `action` on `objects`; a thrown error or rejected promise is shown in an error dialog. */
export async function runAction(
  action: ActionDef,
  clusterId: ClusterId,
  kind: KindRef,
  objects: KubeObject[],
): Promise<void> {
  const ctx: ActionContext = {
    clusterId,
    kind,
    objects,
    refs: objects.map((o) => refOf(o, kind)),
    openDialog: openActionDialog,
  };
  try {
    await action.run(ctx);
  } catch (err) {
    reportActionError(action, err);
  }
}

/** Re-renders when actions are (un)registered. */
export function useActionsVersion(): number {
  return useSyncExternalStore(subscribeActions, () => version, () => version);
}

function subscribeActions(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- Dialogs opened by actions (rendered by <ActionDialogHost /> in the main view) ----------

export interface ActionDialog {
  id: number;
  render: (close: () => void) => ReactNode;
  close: () => void;
}

/** A failed action, shown by the dialog host with the action's label and the error. */
export interface ActionFailure {
  id: number;
  labelKey: string;
  error: unknown;
  close: () => void;
}

let dialogs: ActionDialog[] = [];
let failures: ActionFailure[] = [];
let dialogCounter = 0;
const dialogListeners = new Set<() => void>();
let dialogSnapshot = { dialogs, failures };

function dialogsChanged(): void {
  dialogSnapshot = { dialogs, failures };
  for (const fn of dialogListeners) fn();
}

/** Shows a modal from anywhere (actions, features); returns the function that closes it. */
export function openActionDialog(render: (close: () => void) => ReactNode): () => void {
  const id = ++dialogCounter;
  const close = () => {
    dialogs = dialogs.filter((d) => d.id !== id);
    dialogsChanged();
  };
  dialogs = [...dialogs, { id, render, close }];
  dialogsChanged();
  return close;
}

function reportActionError(action: ActionDef, error: unknown): void {
  const id = ++dialogCounter;
  const close = () => {
    failures = failures.filter((f) => f.id !== id);
    dialogsChanged();
  };
  failures = [...failures, { id, labelKey: action.labelKey, error, close }];
  dialogsChanged();
}

/** Open action dialogs and failures, for the dialog host. */
export function useActionDialogs(): { dialogs: ActionDialog[]; failures: ActionFailure[] } {
  return useSyncExternalStore(
    (fn) => {
      dialogListeners.add(fn);
      return () => dialogListeners.delete(fn);
    },
    () => dialogSnapshot,
    () => dialogSnapshot,
  );
}

/** Forgets every action and dialog (tests). */
export function resetActions(): void {
  actions.clear();
  dialogs = [];
  failures = [];
  dialogsChanged();
  changed();
}
