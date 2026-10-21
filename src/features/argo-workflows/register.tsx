// Registers the Argo Workflows kinds in the sidebar section `argoWorkflows` (shown only for kinds the cluster serves),
// their columns and the details section. Workflows also offer Suspend, Resume, Stop and Terminate (./actions.tsx); the
// other kinds offer the generic Edit and Delete only. Argo CD's and
// Argo Rollouts' kinds share the group `argoproj.io` and keep their own sections.
import type { IconName } from "../../components";
import type { ActionId } from "../../resources";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { cronWorkflowColumns, templateColumns, workflowColumns } from "./columns";
import { WorkflowsSection } from "./details";
import { isFailedPhase, isKind, isWorkflowsKind, WORKFLOW, workflowPhase, WORKFLOWS_KINDS } from "./model";

const ICONS: Record<string, IconName> = {
  workflows: "argoWorkflow",
  cronWorkflows: "argoCronWorkflow",
  workflowTemplates: "argoWorkflowTemplate",
  clusterWorkflowTemplates: "argoClusterWorkflowTemplate",
};

const WORKFLOW_ACTIONS: ActionId[] = ["workflowSuspend", "workflowResume", "workflowStop", "workflowTerminate", "edit", "delete"];

function columnsOf(label: string, namespaced: boolean): ColumnDef[] {
  if (label === "workflows") return workflowColumns;
  if (label === "cronWorkflows") return cronWorkflowColumns;
  return templateColumns(namespaced);
}

for (const def of WORKFLOWS_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "argoWorkflows", order: def.order, labelKey: `argoworkflows:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: columnsOf(def.label, def.namespaced),
    actions: isKind(def.kind, WORKFLOW) ? WORKFLOW_ACTIONS : ["edit", "delete"],
    namespaced: def.namespaced,
    ...(isKind(def.kind, WORKFLOW) ? { problem: (obj) => isFailedPhase(workflowPhase(obj)) } : {}),
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "argoWorkflows", order: 20, appliesTo: isWorkflowsKind, Component: WorkflowsSection });
