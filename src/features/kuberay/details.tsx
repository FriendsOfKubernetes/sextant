// Details of KubeRay objects (one section, `kuberay`): a RayCluster's head and workers (clusterView.tsx), a RayJob's
// statuses, entrypoint and submitter, a RayService's applications and clusters (jobServiceViews.tsx). Conditions and
// YAML are the panel's own sections. Read-only.
import type { DetailsSectionProps } from "../../layout/details/registry";
import { ClusterView } from "./clusterView";
import { JobView, ServiceView } from "./jobServiceViews";
import { isKind, RAY_CLUSTER, RAY_JOB, RAY_SERVICE, rayKind } from "./model";

export function KubeRaySection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, RAY_CLUSTER)) return <ClusterView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, RAY_JOB)) return <JobView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, RAY_SERVICE)) return <ServiceView obj={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof rayKind>[0]): boolean => rayKind(kind) !== undefined;
