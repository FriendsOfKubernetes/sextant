// Rollout history (#134): a "History" tab on Deployments, StatefulSets and DaemonSets — where the rollout stands
// (updated/ready/available, paused, stuck with the reason), the revisions from the ReplicaSets / ControllerRevisions
// the workload controls, two revisions' pod templates side by side, and "Roll back to revision N" (the patch
// `kubectl rollout undo --to-revision` makes, through `resource_patch`, after a confirmation that shows the change).
// The agents' counterpart is the MCP tool `rollout_undo` (crates/sextant-core/src/resources/rollouts.rs).
import { registerDetailsSection } from "../../layout/details/registry";
import { registerRolloutUndo } from "./action";
import { HistoryTab } from "./HistoryTab";
import { workloadKind } from "./model";
import "./rollouts.css";

registerDetailsSection({
  id: "rolloutHistory",
  order: 40,
  placement: "tab",
  labelKey: "rollouts:tab",
  appliesTo: (kind) => workloadKind(kind) !== null,
  Component: HistoryTab,
});

registerRolloutUndo("rolloutUndo");

export { registerRolloutUndo, rolloutUndoAction } from "./action";
export { RollbackDialog, type RollbackDialogProps } from "./RollbackDialog";
