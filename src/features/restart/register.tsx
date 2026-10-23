// The action "Restart" (#255, ADR-0112): Deployments, StatefulSets and DaemonSets (rollout restart), Argo Rollouts
// (`spec.restartAt`), ReplicaSets (their Deployment or Rollout; their pods one at a time when they have no owner) and
// pods with a controller (deleted and recreated) — one object or several selected rows. Which kinds list it is
// `ResourceDef.actions`; `canRestart` decides per object.
import { registerAction } from "../actions/registry";
import { canRestart, planRestart } from "./model";
import { RestartDialog } from "./RestartDialog";

registerAction("restart", {
  labelKey: "actions:restart.label",
  icon: "restart",
  multiple: true,
  appliesTo: canRestart,
  run: ({ clusterId, kind, objects, openDialog }) => {
    const steps = planRestart(objects, kind);
    if (steps.length === 0) return;
    openDialog((close) => <RestartDialog clusterId={clusterId} steps={steps} close={close} />);
  },
});
