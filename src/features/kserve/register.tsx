// Registers the KServe kinds in the sidebar section `kserve` (shown only for kinds the cluster serves) and their
// details. Read-only: the kinds offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { clusterServingRuntimeColumns, graphColumns, serviceColumns, servingRuntimeColumns, trainedModelColumns } from "./columns";
import { appliesTo, KServeSection } from "./details";
import {
  CLUSTER_SERVING_RUNTIME,
  INFERENCE_GRAPH,
  INFERENCE_SERVICE,
  isKind,
  isProblem,
  KSERVE_KINDS,
  SERVING_RUNTIME,
  TRAINED_MODEL,
  type KServeKind,
} from "./model";

const ICONS: Record<string, IconName> = {
  inferenceServices: "inferenceService",
  servingRuntimes: "servingRuntime",
  clusterServingRuntimes: "clusterServingRuntime",
  inferenceGraphs: "inferenceGraph",
  trainedModels: "trainedModel",
};

function columnsOf({ kind }: KServeKind): ColumnDef[] {
  if (isKind(kind, INFERENCE_SERVICE)) return serviceColumns;
  if (isKind(kind, SERVING_RUNTIME)) return servingRuntimeColumns;
  if (isKind(kind, CLUSTER_SERVING_RUNTIME)) return clusterServingRuntimeColumns;
  if (isKind(kind, INFERENCE_GRAPH)) return graphColumns;
  if (isKind(kind, TRAINED_MODEL)) return trainedModelColumns;
  return [];
}

for (const def of KSERVE_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "kserve", order: def.order, labelKey: `kserve:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
    ...(isKind(def.kind, INFERENCE_SERVICE) ? { problem: (obj: Parameters<typeof isProblem>[0]) => isProblem(obj, def.kind) } : {}),
  });
}

registerDetailsSection({ id: "kserve", order: 20, appliesTo, Component: KServeSection });
