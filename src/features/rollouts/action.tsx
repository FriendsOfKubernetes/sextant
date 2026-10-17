// "Roll back…" on a Deployment, StatefulSet or DaemonSet: the rollback dialog with the revision before the newest
// chosen, as `kubectl rollout undo` does.
import type { ActionDef, ActionId } from "../actions/registry";
import { registerAction } from "../actions/registry";
import { extendActions } from "../../resources/registry";
import { workloadKind } from "./model";
import { RollbackDialog } from "./RollbackDialog";

export const rolloutUndoAction: ActionDef = {
  labelKey: "rollouts:rollback.action",
  icon: "rollback",
  appliesTo: (_obj, kind) => workloadKind(kind) !== null,
  run: ({ clusterId, kind, objects, refs, openDialog }) => {
    const workload = objects[0];
    const objectRef = refs[0];
    const rollout = workloadKind(kind);
    if (!workload || !objectRef || !rollout) return;
    openDialog((close) => (
      <RollbackDialog clusterId={clusterId} objectRef={objectRef} workload={workload} kind={rollout} close={close} />
    ));
  },
};

/** Registers the action under `id` and offers it on the three kinds. Returns a function that removes it again. */
export function registerRolloutUndo(id: ActionId): () => void {
  const removers = [
    registerAction(id, rolloutUndoAction),
    ...(["Deployment", "StatefulSet", "DaemonSet"] as const).map((kind) => extendActions({ group: "apps", kind }, [id])),
  ];
  return () => removers.forEach((remove) => remove());
}
