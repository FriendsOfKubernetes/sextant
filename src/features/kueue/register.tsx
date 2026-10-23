// Registers the Kueue kinds in the sidebar section `kueue` (shown only for kinds the cluster serves), their details,
// and the "Queue" section of the jobs Kueue queues. Read-only: the kinds offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import {
  admissionCheckColumns,
  clusterQueueColumns,
  cohortColumns,
  localQueueColumns,
  priorityClassColumns,
  resourceFlavorColumns,
  workloadColumns,
} from "./columns";
import { appliesTo, KueueSection } from "./details";
import { isProblem, KUEUE_KINDS, type KueueKind } from "./model";
import { appliesToJob, QueueSection } from "./queueSection";

const ICONS: Record<string, IconName> = {
  clusterQueues: "kueueClusterQueue",
  localQueues: "kueueLocalQueue",
  workloads: "kueueWorkload",
  resourceFlavors: "kueueResourceFlavor",
  cohorts: "kueueCohort",
  admissionChecks: "kueueAdmissionCheck",
  priorityClasses: "kueuePriorityClass",
};

const COLUMNS: Record<string, ColumnDef[]> = {
  clusterQueues: clusterQueueColumns,
  localQueues: localQueueColumns,
  workloads: workloadColumns,
  resourceFlavors: resourceFlavorColumns,
  cohorts: cohortColumns,
  admissionChecks: admissionCheckColumns,
  priorityClasses: priorityClassColumns,
};

const PROBLEM_LABELS = new Set(["clusterQueues", "localQueues", "workloads"]);

for (const def of KUEUE_KINDS as KueueKind[]) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "kueue", order: def.order, labelKey: `kueue:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: COLUMNS[def.label] ?? [],
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
    ...(PROBLEM_LABELS.has(def.label) ? { problem: (obj) => isProblem(obj, def.kind) } : {}),
  });
}

registerDetailsSection({ id: "kueue", order: 20, appliesTo, Component: KueueSection });

registerDetailsSection({ id: "kueueQueue", order: 25, appliesTo: appliesToJob, Component: QueueSection });
