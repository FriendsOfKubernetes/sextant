// Registers the Argo Rollouts kinds in the sidebar section `argoRollouts` (shown only for kinds the cluster serves),
// their columns, the details section and the Rollout actions. Argo CD's kinds share the group `argoproj.io` and keep
// their own section (src/features/argocd): only these five kinds are registered here.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ActionId, type ColumnDef } from "../../resources";
import { analysisRunColumns, experimentColumns, rolloutColumns, templateColumns } from "./columns";
import { RolloutsSection } from "./details";
import { ANALYSIS_RUN, analysisPhase, EXPERIMENT, isKind, isRolloutsKind, ROLLOUT, ROLLOUTS_KINDS, rolloutProblems } from "./model";

const ICONS: Record<string, IconName> = {
  rollouts: "argoRollout",
  analysisRuns: "argoAnalysisRun",
  analysisTemplates: "argoAnalysisTemplate",
  clusterAnalysisTemplates: "argoClusterAnalysisTemplate",
  experiments: "argoExperiment",
};

const ROLLOUT_ACTIONS: ActionId[] = ["rolloutPromote", "rolloutPromoteFull", "rolloutAbort", "rolloutRetry", "rolloutPause", "rolloutResume", "restart", "edit", "delete"];

function columnsOf(label: string, namespaced: boolean): ColumnDef[] {
  if (label === "rollouts") return rolloutColumns;
  if (label === "analysisRuns") return analysisRunColumns;
  if (label === "experiments") return experimentColumns;
  return templateColumns(namespaced);
}

for (const def of ROLLOUTS_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "argoRollouts", order: def.order, labelKey: `argorollouts:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: columnsOf(def.label, def.namespaced),
    actions: isKind(def.kind, ROLLOUT) ? ROLLOUT_ACTIONS : ["edit", "delete"],
    namespaced: def.namespaced,
    ...(isKind(def.kind, ROLLOUT) ? { problem: (obj) => rolloutProblems(obj).length > 0 } : {}),
    ...(isKind(def.kind, ANALYSIS_RUN, EXPERIMENT)
      ? { problem: (obj) => ["Failed", "Error"].includes(analysisPhase(obj) ?? "") }
      : {}),
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "argoRollouts", order: 20, appliesTo: isRolloutsKind, Component: RolloutsSection });
