// Objects and cluster views for the diagnosis tests.
import type { CertificateInfo, KubeObject } from "../../api";
import type { World } from "../netpol/engine";
import { kubernetesPolicy } from "../netpol/kubernetes";
import type { CertificateState, ClusterView } from "./model";

export const NOW = Date.parse("2026-10-20T12:00:00Z");
export const NS = "shop";

let uid = 0;
const meta = (name: string, namespace: string | null, extra: Record<string, unknown> = {}) => ({
  name,
  ...(namespace === null ? {} : { namespace }),
  uid: `uid-${name}-${++uid}`,
  creationTimestamp: "2026-10-20T10:00:00Z",
  ...extra,
});

export interface PodOptions {
  ready?: boolean;
  ports?: { name?: string; containerPort: number; protocol?: string }[];
  waiting?: string;
  namespace?: string;
  terminating?: boolean;
  /** `null`: no IP yet. */
  ip?: string | null;
}

export function pod(name: string, labels: Record<string, string>, o: PodOptions = {}): KubeObject {
  const ready = o.ready ?? true;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: meta(name, o.namespace ?? NS, { labels, ...(o.terminating ? { deletionTimestamp: "2026-10-20T11:59:00Z" } : {}) }),
    spec: { containers: [{ name: "app", ports: o.ports ?? [{ name: "http", containerPort: 8080 }] }] },
    status: {
      phase: "Running",
      ...(o.ip === null ? {} : { podIP: o.ip ?? "10.0.0.1" }),
      conditions: [{ type: "Ready", status: ready ? "True" : "False", lastTransitionTime: "2026-10-20T11:00:00Z" }],
      containerStatuses: [
        o.waiting
          ? { name: "app", ready: false, restartCount: 4, state: { waiting: { reason: o.waiting } } }
          : { name: "app", ready, restartCount: 0, state: { running: {} } },
      ],
    },
  };
}

export function service(name: string, spec: Record<string, unknown>, extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: meta(name, NS),
    spec: { type: "ClusterIP", clusterIP: "10.96.0.10", ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }], ...spec },
    ...extra,
  };
}

/** An EndpointSlice of `svc` with one endpoint per pod (ready as given). */
export function slice(svc: string, endpoints: { pod: string; ready?: boolean; terminating?: boolean }[]): KubeObject {
  return {
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata: meta(`${svc}-abc`, NS, { labels: { "kubernetes.io/service-name": svc } }),
    endpoints: endpoints.map((e) => ({
      addresses: [`10.0.0.${e.pod.length}`],
      targetRef: { kind: "Pod", name: e.pod, uid: `pod-${e.pod}` },
      conditions: { ready: e.ready ?? true, serving: e.ready ?? true, terminating: e.terminating ?? false },
    })),
  };
}

export function networkPolicy(name: string, spec: Record<string, unknown>, namespace = NS): KubeObject {
  return { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: meta(name, namespace), spec };
}

export function ingressClass(name: string, controller: string, isDefault = false): KubeObject {
  const annotations = isDefault ? { "ingressclass.kubernetes.io/is-default-class": "true" } : {};
  return { apiVersion: "networking.k8s.io/v1", kind: "IngressClass", metadata: meta(name, null, { annotations }), spec: { controller } };
}

export function ingress(name: string, spec: Record<string, unknown>, addresses: string[] = ["203.0.113.5"]): KubeObject {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: meta(name, NS),
    spec,
    status: { loadBalancer: { ingress: addresses.map((ip) => ({ ip })) } },
  };
}

export function certificate(dnsNames: string[], o: { notAfter?: string; notBefore?: string; commonName?: string } = {}): CertificateInfo {
  return {
    subject: `CN=${o.commonName ?? dnsNames[0] ?? ""}`,
    commonName: o.commonName ?? dnsNames[0] ?? null,
    issuer: "CN=test",
    issuerCommonName: "test",
    serial: "01",
    dnsNames,
    ipAddresses: [],
    emails: [],
    uris: [],
    notBefore: o.notBefore ?? "2026-01-01T00:00:00Z",
    notAfter: o.notAfter ?? "2027-01-01T00:00:00Z",
    keyAlgorithm: "ECDSA",
    keySize: 256,
    signatureAlgorithm: "ecdsa-with-SHA256",
    isCa: false,
    selfSigned: false,
    fingerprintSha256: "AA",
  };
}

export interface ViewInput {
  services?: KubeObject[];
  pods?: KubeObject[];
  slices?: KubeObject[];
  policies?: KubeObject[];
  /** `null`: the policies cannot be read. */
  world?: null;
  classes?: KubeObject[] | null;
  controllerPods?: Record<string, KubeObject[]>;
  certificates?: Record<string, CertificateState>;
  gateways?: KubeObject[];
  grants?: KubeObject[];
  /** Namespaces whose lists cannot be read. */
  unreadable?: string[];
  namespaceLabels?: Record<string, Record<string, string>>;
}

export function view(input: ViewInput): ClusterView {
  const inNs = (list: KubeObject[] | undefined, ns: string) =>
    input.unreadable?.includes(ns) ? undefined : (list ?? []).filter((o) => o.metadata?.namespace === ns);
  const world: World = {
    policies: (input.policies ?? []).map(kubernetesPolicy),
    unreadable: [],
    namespaceLabels: (ns) => input.namespaceLabels?.[ns] ?? { "kubernetes.io/metadata.name": ns },
  };
  return {
    now: NOW,
    services: (ns) => inNs(input.services, ns),
    pods: (ns) => inNs(input.pods, ns),
    endpointSlices: (ns) => inNs(input.slices, ns),
    world: input.world === null ? undefined : world,
    ingressClasses: input.classes === undefined ? [] : input.classes,
    controllerPods: (c) => {
      const pods = input.controllerPods?.[c];
      return pods ? { selector: "app.kubernetes.io/name=ingress-nginx", pods } : c === "k8s.io/ingress-nginx" ? { selector: "app.kubernetes.io/name=ingress-nginx", pods: [] } : null;
    },
    certificates: (ns, name) => input.certificates?.[`${ns}/${name}`],
    gateways: (ns) => inNs(input.gateways, ns),
    grants: (ns) => inNs(input.grants, ns),
  };
}
