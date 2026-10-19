// The service-mesh kinds Sextant knows (#155): Istio's networking and security APIs and Linkerd's service profiles and
// policy API. Each is registered at the version current releases serve; the cluster's own version comes from
// discovery (`resolve_kind`), so an older Istio serving only v1beta1 works the same.
import type { IconName } from "../../components";
import type { KindRef } from "../../api";

export const ISTIO_NETWORKING = "networking.istio.io";
export const ISTIO_SECURITY = "security.istio.io";
export const ISTIO_TELEMETRY = "telemetry.istio.io";
export const LINKERD = "linkerd.io";
export const LINKERD_POLICY = "policy.linkerd.io";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const VIRTUAL_SERVICE = k(ISTIO_NETWORKING, "v1", "VirtualService");
export const DESTINATION_RULE = k(ISTIO_NETWORKING, "v1", "DestinationRule");
export const ISTIO_GATEWAY = k(ISTIO_NETWORKING, "v1", "Gateway");
export const SERVICE_ENTRY = k(ISTIO_NETWORKING, "v1", "ServiceEntry");
export const SIDECAR = k(ISTIO_NETWORKING, "v1", "Sidecar");
export const WORKLOAD_ENTRY = k(ISTIO_NETWORKING, "v1", "WorkloadEntry");
export const PEER_AUTHENTICATION = k(ISTIO_SECURITY, "v1", "PeerAuthentication");
export const REQUEST_AUTHENTICATION = k(ISTIO_SECURITY, "v1", "RequestAuthentication");
export const AUTHORIZATION_POLICY = k(ISTIO_SECURITY, "v1", "AuthorizationPolicy");
export const TELEMETRY = k(ISTIO_TELEMETRY, "v1", "Telemetry");

export const SERVICE_PROFILE = k(LINKERD, "v1alpha2", "ServiceProfile");
export const LINKERD_SERVER = k(LINKERD_POLICY, "v1beta3", "Server");
export const SERVER_AUTHORIZATION = k(LINKERD_POLICY, "v1beta1", "ServerAuthorization");
export const LINKERD_AUTHORIZATION_POLICY = k(LINKERD_POLICY, "v1alpha1", "AuthorizationPolicy");
export const LINKERD_HTTP_ROUTE = k(LINKERD_POLICY, "v1beta3", "HTTPRoute");
export const MESH_TLS_AUTHENTICATION = k(LINKERD_POLICY, "v1alpha1", "MeshTLSAuthentication");
export const NETWORK_AUTHENTICATION = k(LINKERD_POLICY, "v1alpha1", "NetworkAuthentication");

export type MeshSection = "istio" | "linkerd";

export interface MeshKindDef {
  kind: KindRef;
  section: MeshSection;
  order: number;
  /** `mesh:sidebar.<label>`. */
  label: string;
  icon: IconName;
}

export const MESH_KINDS: readonly MeshKindDef[] = [
  { kind: VIRTUAL_SERVICE, section: "istio", order: 10, label: "virtualServices", icon: "meshRoute" },
  { kind: DESTINATION_RULE, section: "istio", order: 20, label: "destinationRules", icon: "meshDestination" },
  { kind: ISTIO_GATEWAY, section: "istio", order: 30, label: "gateways", icon: "gateway" },
  { kind: SERVICE_ENTRY, section: "istio", order: 40, label: "serviceEntries", icon: "meshServiceEntry" },
  { kind: SIDECAR, section: "istio", order: 50, label: "sidecars", icon: "config" },
  { kind: WORKLOAD_ENTRY, section: "istio", order: 60, label: "workloadEntries", icon: "endpoints" },
  { kind: PEER_AUTHENTICATION, section: "istio", order: 70, label: "peerAuthentications", icon: "meshMtls" },
  { kind: REQUEST_AUTHENTICATION, section: "istio", order: 80, label: "requestAuthentications", icon: "meshJwt" },
  { kind: AUTHORIZATION_POLICY, section: "istio", order: 90, label: "authorizationPolicies", icon: "meshAuthz" },
  { kind: TELEMETRY, section: "istio", order: 100, label: "telemetries", icon: "overview" },
  { kind: SERVICE_PROFILE, section: "linkerd", order: 10, label: "serviceProfiles", icon: "meshRoute" },
  { kind: LINKERD_SERVER, section: "linkerd", order: 20, label: "servers", icon: "service" },
  { kind: LINKERD_HTTP_ROUTE, section: "linkerd", order: 30, label: "httpRoutes", icon: "httpRoute" },
  { kind: LINKERD_AUTHORIZATION_POLICY, section: "linkerd", order: 40, label: "authorizationPolicies", icon: "meshAuthz" },
  { kind: SERVER_AUTHORIZATION, section: "linkerd", order: 50, label: "serverAuthorizations", icon: "meshAuthz" },
  { kind: MESH_TLS_AUTHENTICATION, section: "linkerd", order: 60, label: "meshTlsAuthentications", icon: "meshMtls" },
  { kind: NETWORK_AUTHENTICATION, section: "linkerd", order: 70, label: "networkAuthentications", icon: "networkPolicy" },
];

/** Same group and kind (any version). */
export const sameKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) =>
  a.group === b.group && a.kind === b.kind;

/** The mesh kind of `kind` (any version), if it is one. */
export function meshKind(kind: Pick<KindRef, "group" | "kind">): MeshKindDef | undefined {
  return MESH_KINDS.find((d) => sameKind(d.kind, kind));
}

/** `group/version` of a kind for a link (the registered version; the details resolve the served one). */
export function apiVersionOf(kind: Pick<KindRef, "group" | "kind">): string {
  if (kind.group === "") return "v1";
  return `${kind.group}/${meshKind(kind)?.kind.version ?? "v1"}`;
}
