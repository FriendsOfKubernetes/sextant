// Details of OpenShift objects (one section, `openshift`): a Route's admission, TLS and backends (routeView.tsx), a
// DeploymentConfig's rollouts and triggers (dcView.tsx), a BuildConfig's builds and a Build's pod and logs
// (buildViews.tsx), an ImageStream's tags and a Project's annotations (otherViews.tsx). Conditions and YAML are the
// panel's own sections. Read-only; the two actions are the panel's (actions.tsx).
import type { DetailsSectionProps } from "../../layout/details/registry";
import { BuildConfigView, BuildView } from "./buildViews";
import { DcView } from "./dcView";
import { BUILD, BUILD_CONFIG, DEPLOYMENT_CONFIG, IMAGE_STREAM, isKind, openshiftKind, PROJECT, ROUTE } from "./model";
import { ImageStreamView, ProjectView } from "./otherViews";
import { RouteView } from "./routeView";

export function OpenShiftSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, ROUTE)) return <RouteView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, DEPLOYMENT_CONFIG)) return <DcView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, BUILD_CONFIG)) return <BuildConfigView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, BUILD)) return <BuildView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, IMAGE_STREAM)) return <ImageStreamView obj={obj} />;
  if (isKind(kind, PROJECT)) return <ProjectView obj={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof openshiftKind>[0]): boolean => openshiftKind(kind) !== undefined;
