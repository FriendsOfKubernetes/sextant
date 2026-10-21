// Which kinds can be diagnosed, and the diagnosis of one object.
import type { KindRef, KubeObject } from "../../api";
import { GRPC_ROUTE, HTTP_ROUTE, isKind } from "../gateway-api/model";
import { diagnoseIngress } from "./ingress";
import type { Chain, ClusterView } from "./model";
import { INGRESS, SERVICE } from "./objects";
import { diagnoseRoute } from "./route";
import { routeDiagnoserOf } from "./routeKinds";
import { diagnoseService } from "./service";

/** `registered`: a route kind of another project (`routeKinds.ts`). */
export type DiagnosedKind = "service" | "ingress" | "route" | "registered";

export function diagnosedKind(kind: Pick<KindRef, "group" | "kind">): DiagnosedKind | undefined {
  if (isKind(kind, SERVICE)) return "service";
  if (isKind(kind, INGRESS)) return "ingress";
  if (isKind(kind, HTTP_ROUTE, GRPC_ROUTE)) return "route";
  if (routeDiagnoserOf(kind)) return "registered";
  return undefined;
}

export const isDiagnosable = (kind: Pick<KindRef, "group" | "kind">) => diagnosedKind(kind) !== undefined;

export function diagnose(kind: KindRef, obj: KubeObject, view: ClusterView): Chain {
  switch (diagnosedKind(kind)) {
    case "ingress":
      return diagnoseIngress(obj, view);
    case "route":
      return diagnoseRoute(obj, kind, view);
    case "registered":
      return routeDiagnoserOf(kind)!.diagnose(obj, kind, view);
    default:
      return diagnoseService(obj, view, { source: { type: "outside" } });
  }
}
