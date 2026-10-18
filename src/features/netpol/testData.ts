// Builders of pods, Services, namespaces and policies for the engine's tests (Vitest only; never imported by
// application code).
import type { KubeObject } from "../../api";
import type { World } from "./engine";
import { kubernetesPolicy } from "./kubernetes";
import { namespaceLabels, podInfo, type Endpoint, type Labels, type PodInfo, type Policy } from "./model";

let uid = 0;

export function pod(
  namespace: string,
  name: string,
  labels: Labels = {},
  extra: { ip?: string; ips?: string[]; hostNetwork?: boolean; node?: string; ports?: { name?: string; containerPort: number; protocol?: string }[]; phase?: string } = {},
): KubeObject {
  const ips = extra.ips ?? (extra.ip ? [extra.ip] : []);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, labels: { ...labels }, uid: `pod-${++uid}` },
    spec: {
      nodeName: extra.node ?? "node-1",
      hostNetwork: extra.hostNetwork ?? false,
      containers: [{ name: "main", ports: extra.ports ?? [] }],
    },
    status: { phase: extra.phase ?? "Running", podIP: ips[0], podIPs: ips.map((ip) => ({ ip })) },
  } as KubeObject;
}

export const podEp = (obj: KubeObject): Endpoint => ({ type: "pod", pod: podInfo(obj) });
export const info = (obj: KubeObject): PodInfo => podInfo(obj);
export const external = (ip: string): Endpoint => ({ type: "external", ip });

export function namespace(name: string, labels: Labels = {}): KubeObject {
  return { apiVersion: "v1", kind: "Namespace", metadata: { name, labels: { ...labels }, uid: `ns-${name}` } } as KubeObject;
}

export function netpol(ns: string, name: string, spec: Record<string, unknown>): KubeObject {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: ns, uid: `np-${ns}-${name}` },
    spec,
  } as KubeObject;
}

export function service(
  ns: string,
  name: string,
  selector: Labels | null,
  ports: { name?: string; port: number; targetPort?: number | string; protocol?: string; nodePort?: number }[],
  type = "ClusterIP",
): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: ns, uid: `svc-${ns}-${name}` },
    spec: { type, ...(selector ? { selector } : {}), ports },
  } as KubeObject;
}

/** A world of Kubernetes NetworkPolicies (and any already normalised policies) with these namespaces. */
export function world(
  policies: (KubeObject | Policy)[],
  namespaces: KubeObject[] | null = [],
  extra: Partial<World> = {},
): World {
  const labels = namespaces ? new Map(namespaces.map((n) => [n.metadata?.name ?? "", namespaceLabels(n)])) : null;
  return {
    policies: policies.map((p) => ("ref" in p ? (p as Policy) : kubernetesPolicy(p as KubeObject))),
    namespaceLabels: (ns) => (labels ? (labels.get(ns) ?? { "kubernetes.io/metadata.name": ns }) : undefined),
    unreadable: [],
    ...extra,
  };
}
