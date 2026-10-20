// Small readings of objects the diagnosis needs: pod readiness, Service ports, EndpointSlice endpoints, load balancer
// addresses. Pure.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { ServicePort } from "../netpol/model";
import type { LinkRef } from "./model";

const { arr, get, record, str } = status;

export const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
export const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
export const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
export const ENDPOINT_SLICE: KindRef = { group: "discovery.k8s.io", version: "v1", kind: "EndpointSlice" };
export const INGRESS: KindRef = { group: "networking.k8s.io", version: "v1", kind: "Ingress" };
export const INGRESS_CLASS: KindRef = { group: "networking.k8s.io", version: "v1", kind: "IngressClass" };

export const nameOf = (obj: KubeObject) => obj.metadata?.name ?? "";
export const namespaceOf = (obj: KubeObject) => obj.metadata?.namespace ?? "";

export function linkOf(kind: KindRef, obj: KubeObject): LinkRef {
  return { kind, namespace: obj.metadata?.namespace ?? null, name: nameOf(obj) };
}

export function isReady(pod: KubeObject): boolean {
  return arr(get(pod, "status", "conditions")).some((c) => get(c, "type") === "Ready" && get(c, "status") === "True");
}

export const isTerminating = (obj: KubeObject) => Boolean(obj.metadata?.deletionTimestamp);

/** "http 80/TCP" or "80/TCP": how a Service port is named in a sentence. */
export function portLabel(port: Pick<ServicePort, "name" | "port" | "protocol">): string {
  return port.name ? `${port.name} ${port.port}/${port.protocol}` : `${port.port}/${port.protocol}`;
}

/** The Service port a reference names: a number is `port`, a string its `name` (or a number written as text). */
export function findServicePort(ports: readonly ServicePort[], ref: number | string): ServicePort | undefined {
  if (typeof ref === "number") return ports.find((p) => p.port === ref);
  if (/^\d+$/.test(ref)) return ports.find((p) => p.port === Number(ref));
  return ports.find((p) => p.name === ref);
}

/** `ip` or `hostname` of each `status.loadBalancer.ingress` entry (Services and Ingresses). */
export function loadBalancerAddresses(obj: KubeObject): string[] {
  return arr(get(obj, "status", "loadBalancer", "ingress"))
    .map((i) => str(get(i, "ip")) ?? str(get(i, "hostname")))
    .filter((a): a is string => Boolean(a));
}

export interface SliceEndpoints {
  /** EndpointSlices labelled with the Service's name. */
  slices: number;
  /** Endpoints by target pod (or address), each once. */
  total: number;
  ready: number;
  /** Terminating endpoints that still serve. */
  terminatingServing: number;
}

/** What the EndpointSlices of a Service list (`kubernetes.io/service-name`); an endpoint counts once. */
export function sliceEndpoints(slices: readonly KubeObject[], service: { namespace: string; name: string }): SliceEndpoints {
  const seen = new Map<string, { ready: boolean; terminatingServing: boolean }>();
  let count = 0;
  for (const slice of slices) {
    if (slice.metadata?.namespace !== service.namespace) continue;
    if (record(slice.metadata?.labels)["kubernetes.io/service-name"] !== service.name) continue;
    count++;
    for (const e of arr(get(slice, "endpoints"))) {
      const key = str(get(e, "targetRef", "uid")) ?? arr(get(e, "addresses")).map(String).join(",");
      // `ready` absent means ready; `serving` absent means as `ready`; `terminating` absent means false.
      const ready = get(e, "conditions", "ready") !== false;
      const serving = get(e, "conditions", "serving") ?? ready;
      const terminating = get(e, "conditions", "terminating") === true;
      const before = seen.get(key);
      seen.set(key, {
        ready: (before?.ready ?? false) || ready,
        terminatingServing: (before?.terminatingServing ?? false) || (terminating && serving === true),
      });
    }
  }
  const values = [...seen.values()];
  return {
    slices: count,
    total: values.length,
    ready: values.filter((v) => v.ready).length,
    terminatingServing: values.filter((v) => v.terminatingServing).length,
  };
}

/** Minutes since the object was created, `undefined` when it does not say. */
export function minutesSince(obj: KubeObject, now: number): number | undefined {
  const created = Date.parse(str(obj.metadata?.creationTimestamp) ?? "");
  return Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 60_000)) : undefined;
}

/** An RFC 1123 subdomain (what DNS names in Kubernetes are), lowercase, up to 253 characters. */
export function isDnsName(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value
    .replace(/\.$/, "")
    .split(".")
    .every((label) => label.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(label));
}

export const isIpAddress = (value: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || (value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value));
