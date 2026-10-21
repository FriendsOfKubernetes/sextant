// Route kinds of other projects (Traefik's IngressRoute, Contour's HTTPProxy, …) the traffic diagnosis follows: each
// project registers its kinds here from its own feature module, so the engine and the hooks stay generic. A
// registered kind gets the "Diagnose" action (the project calls `extendActions` for it) and the "Diagnosis" tab.
//
// The hook (`hooks.ts`) reads for a registered kind, beside what every diagnosis reads (Services, EndpointSlices,
// pods and policies of the path's namespaces): the lists `lists` names, each one (kind, namespace) as a shared watch,
// only for kinds the cluster serves, and the TLS Secrets `secrets` names through `tls_certificate_info`. The engine
// sees those lists through `ClusterView.objects`. An AI agent's view has no `objects` (agents get nothing new).
import type { KindRef, KubeObject } from "../../api";
import type { Chain, ClusterView } from "./model";

export interface ListRef {
  kind: KindRef;
  namespace: string;
}

export interface SecretRef {
  namespace: string;
  name: string;
}

export interface RouteDiagnoser {
  /** The kinds it diagnoses (by group and kind; any version). */
  appliesTo(kind: Pick<KindRef, "group" | "kind">): boolean;
  /** The namespaces of the path's Services after the object's own (the hook keeps at most `MAX_NAMESPACES`). */
  namespaces(obj: KubeObject | null, own: string): string[];
  /** The project's own lists the diagnosis reads (middlewares, weighted services, …). */
  lists(obj: KubeObject | null, own: string): ListRef[];
  /** TLS Secrets whose certificates the diagnosis reads. */
  secrets(obj: KubeObject | null, own: string): SecretRef[];
  diagnose(obj: KubeObject, kind: KindRef, view: ClusterView): Chain;
}

const DIAGNOSERS: RouteDiagnoser[] = [];

export function registerRouteDiagnoser(diagnoser: RouteDiagnoser): void {
  DIAGNOSERS.push(diagnoser);
}

export function routeDiagnoserOf(kind: Pick<KindRef, "group" | "kind">): RouteDiagnoser | undefined {
  return DIAGNOSERS.find((d) => d.appliesTo(kind));
}
