// Details of KServe objects (one section, `kserve`): an InferenceService's components, revisions, traffic, model
// status, what KServe made for it and the runtime it chooses (serviceView.tsx); runtimes, InferenceGraphs and
// TrainedModels (otherViews.tsx). Conditions and YAML are the panel's own sections. Read-only.
import type { DetailsSectionProps } from "../../layout/details/registry";
import { CLUSTER_SERVING_RUNTIME, INFERENCE_GRAPH, INFERENCE_SERVICE, isKind, kserveKind, SERVING_RUNTIME, TRAINED_MODEL } from "./model";
import { GraphView, RuntimeView, TrainedModelView } from "./otherViews";
import { ServiceView } from "./serviceView";

export function KServeSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, INFERENCE_SERVICE)) return <ServiceView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, SERVING_RUNTIME, CLUSTER_SERVING_RUNTIME)) return <RuntimeView obj={obj} />;
  if (isKind(kind, INFERENCE_GRAPH)) return <GraphView obj={obj} />;
  if (isKind(kind, TRAINED_MODEL)) return <TrainedModelView obj={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof kserveKind>[0]): boolean => kserveKind(kind) !== undefined;
