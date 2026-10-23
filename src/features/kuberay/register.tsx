// Registers the KubeRay kinds in the sidebar section `kuberay` (shown only for kinds the cluster serves) and their
// details. Read-only: the kinds offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { clusterColumns, jobColumns, serviceColumns } from "./columns";
import { appliesTo, KubeRaySection } from "./details";
import { isKind, isProblem, RAY_CLUSTER, RAY_JOB, RAY_KINDS, RAY_SERVICE, type RayKind } from "./model";

const ICONS: Record<string, IconName> = {
  rayClusters: "rayCluster",
  rayJobs: "rayJob",
  rayServices: "rayService",
};

function columnsOf({ kind }: RayKind): ColumnDef[] {
  if (isKind(kind, RAY_CLUSTER)) return clusterColumns;
  if (isKind(kind, RAY_JOB)) return jobColumns;
  if (isKind(kind, RAY_SERVICE)) return serviceColumns;
  return [];
}

for (const def of RAY_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "kuberay", order: def.order, labelKey: `kuberay:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: true,
    problem: (obj) => isProblem(obj, def.kind),
  });
}

registerDetailsSection({ id: "kuberay", order: 20, appliesTo, Component: KubeRaySection });
