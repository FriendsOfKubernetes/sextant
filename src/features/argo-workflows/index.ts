// Argo Workflows (#213): the sidebar section "Argo Workflows" — Workflows, CronWorkflows, WorkflowTemplates and
// ClusterWorkflowTemplates — shown only for the kinds the cluster serves. A Workflow shows its phase, progress,
// duration and the step that failed with its message; its details hold the node tree (bounded, collapsed by default)
// with each pod node linked to its pod and its logs; a CronWorkflow shows its schedule, last run and active Workflows.
// Workflows that failed within a day feed the problems screen (category `workflows`) from one metadata-only watch of
// failed Workflows (./provider.ts). Read-only (ADR-0097).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useWorkflowProblemCount } from "./problems";
import "./provider";
import "./register";

registerSectionBadge("argoWorkflows", useWorkflowProblemCount, { tone: "danger", labelKey: "argoworkflows:badge" });

export * from "./model";
