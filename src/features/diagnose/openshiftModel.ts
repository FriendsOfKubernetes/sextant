// What the traffic diagnosis of an OpenShift Route (`openshift.ts`, #267, ADR-0120) reads from it, field by field, as
// OpenShift's own types name them (route/v1/types.go of github.com/openshift/api): its backends with their shares, the
// target port, its TLS termination, and what each router says of it. A Route's inline certificate fields are never
// read as values: only whether they are set. Every free text from the cluster goes through `cleanText`. Pure
// functions, no React. The OpenShift views themselves are Sextant's own extension `extensions/openshift` since 0.30
// (ADR-0162 amendment); the diagnosis stays Sextant's own, for the window and agents' `diagnose_service`.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import { cleanText } from "../../resources/uri";

const { arr, get, num, str } = status;

export const ROUTE_GROUP = "route.openshift.io";

export const ROUTE: KindRef = { group: ROUTE_GROUP, version: "v1", kind: "Route" };

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  since?: string;
}

function conditionsIn(value: unknown): Condition[] {
  return arr(value).map((c) => ({
    type: str(get(c, "type")) ?? "",
    status: str(get(c, "status")) ?? "Unknown",
    reason: str(get(c, "reason")) || undefined,
    message: cleanText(str(get(c, "message"))) || undefined,
    since: str(get(c, "lastTransitionTime")) || undefined,
  }));
}

export interface RouteTls {
  termination?: string;
  /** `Allow`, `None` (the default: plain HTTP is refused) or `Redirect`. */
  insecure?: string;
  /** Whether the inline PEM fields are set; their values are never read. */
  certificate: boolean;
  key: boolean;
  caCertificate: boolean;
  destinationCACertificate: boolean;
  /** A Secret of the Route's namespace holding the certificate (`externalCertificate`, OpenShift 4.16+). */
  externalCertificate?: string;
}

export function routeTls(obj: KubeObject): RouteTls | undefined {
  const tls = get(obj, "spec", "tls");
  if (!tls || typeof tls !== "object") return undefined;
  const set = (field: string) => Boolean(str(get(tls, field)));
  return {
    termination: str(get(tls, "termination")) || undefined,
    insecure: str(get(tls, "insecureEdgeTerminationPolicy")) || undefined,
    certificate: set("certificate"),
    key: set("key"),
    caCertificate: set("caCertificate"),
    destinationCACertificate: set("destinationCACertificate"),
    externalCertificate: str(get(tls, "externalCertificate", "name")) || undefined,
  };
}

export interface RouteBackend {
  kind: string;
  name: string;
  /** 0–256; 100 when not set (`+kubebuilder:default=100`, route/v1/types.go). */
  weight: number;
  /** The share of the requests, in percent (0 when every weight is 0: the router answers 503). */
  percent: number;
  /** `spec.to` (else an alternate backend). */
  primary: boolean;
}

/** `spec.to` and `spec.alternateBackends`, with each share as the router weighs them. */
export function routeBackends(obj: KubeObject): RouteBackend[] {
  const one = (value: unknown, primary: boolean) => {
    const name = str(get(value, "name"));
    if (!name) return [];
    return [{ kind: str(get(value, "kind")) || "Service", name, weight: num(get(value, "weight")) ?? 100, percent: 0, primary }];
  };
  const list: RouteBackend[] = [...one(get(obj, "spec", "to"), true), ...arr(get(obj, "spec", "alternateBackends")).flatMap((b) => one(b, false))];
  const total = list.reduce((sum, b) => sum + b.weight, 0);
  return list.map((b) => ({ ...b, percent: total > 0 ? (b.weight / total) * 100 : 0 }));
}

/**
 * `spec.port.targetPort`: a number is an endpoint (pod) port, a name an endpoint port name — which is the Service
 * port's name (`endpointsForAlias` in pkg/router/template/template_helper.go of github.com/openshift/router matches
 * `PortName` or `Port` against it). Without it the router sends to every endpoint of the Service.
 */
export function routeTargetPort(obj: KubeObject): number | string | undefined {
  const value = get(obj, "spec", "port", "targetPort");
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return /^\d+$/.test(value) ? Number(value) : value;
  return undefined;
}

export interface RouterAdmission {
  routerName: string;
  host?: string;
  /** `True`, `False` or `Unknown` (no Admitted condition yet). */
  admitted: string;
  reason?: string;
  message?: string;
  since?: string;
  canonicalHostname?: string;
}

/** What each router says of the Route (`status.ingress[]`, its `Admitted` condition). */
export function routeAdmissions(obj: KubeObject): RouterAdmission[] {
  return arr(get(obj, "status", "ingress")).map((i) => {
    const admitted = conditionsIn(get(i, "conditions")).find((c) => c.type === "Admitted");
    return {
      routerName: str(get(i, "routerName")) || "",
      host: str(get(i, "host")) || undefined,
      admitted: admitted?.status ?? "Unknown",
      reason: admitted?.reason,
      message: admitted?.message,
      since: admitted?.since,
      canonicalHostname: str(get(i, "routerCanonicalHostname")) || undefined,
    };
  });
}

export type RouteState = "admitted" | "rejected" | "pending";

/** Admitted by at least one router; else rejected by one; else no router has answered yet. */
export function routeState(obj: KubeObject): RouteState {
  const all = routeAdmissions(obj);
  if (all.some((a) => a.admitted === "True")) return "admitted";
  if (all.some((a) => a.admitted === "False")) return "rejected";
  return "pending";
}

/** The host: `spec.host`, else the one a router generated (a Route with `spec.subdomain` or none). */
export const routeHost = (obj: KubeObject): string | undefined =>
  str(get(obj, "spec", "host")) || routeAdmissions(obj).find((a) => a.host)?.host;

/** `https://host/path` (or `http://` without TLS): where the Route answers; the Route's own fields only. */
export function routeUrl(obj: KubeObject): string | undefined {
  const host = routeHost(obj);
  if (!host) return undefined;
  const wildcard = str(get(obj, "spec", "wildcardPolicy")) === "Subdomain";
  return `${routeTls(obj) ? "https" : "http"}://${wildcard ? `*.${host.replace(/^[^.]*\./, "")}` : host}${str(get(obj, "spec", "path")) ?? ""}`;
}
