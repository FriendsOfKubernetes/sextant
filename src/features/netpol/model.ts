// The objects the connectivity engine reasons over, read from the cluster's objects: pods (labels, IPs, container
// ports, hostNetwork), Services (selector, ports and target ports) and the policy model every policy flavour is
// normalised to (`Policy`, `Rule`, `Peer`, `PortSpec`). Pure; the engine is `engine.ts`.
//
// Three-valued answers (`Tri`): "maybe" is what the objects cannot decide — an unreadable namespace, a pod IP inside an
// `ipBlock` (implementation-defined), a Cilium or Calico feature Sextant does not model.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { labelSelector, mapSelector, type Labels, type Selector } from "../resource-map/selectors";

const { arr, get, labelsOf, num, record, str } = status;

export type Tri = "yes" | "no" | "maybe";
export type Direction = "ingress" | "egress";
export type Verdict = "allowed" | "denied" | "unknown";
export type Protocol = "TCP" | "UDP" | "SCTP";
export const PROTOCOLS: readonly Protocol[] = ["TCP", "UDP", "SCTP"];
export const DIRECTIONS: readonly Direction[] = ["egress", "ingress"];
/** The order views list the directions in. */
export const SHOWN_DIRECTIONS: readonly Direction[] = ["ingress", "egress"];

export function and(...values: Tri[]): Tri {
  if (values.includes("no")) return "no";
  return values.includes("maybe") ? "maybe" : "yes";
}

export function or(...values: Tri[]): Tri {
  if (values.includes("yes")) return "yes";
  return values.includes("maybe") ? "maybe" : "no";
}

export const tri = (value: boolean): Tri => (value ? "yes" : "no");

export type { Labels, Selector };

// ---------- Pods, Services, namespaces ----------

export interface ContainerPort {
  name: string | null;
  port: number;
  protocol: Protocol;
}

export interface PodInfo {
  namespace: string;
  /** `null`: a pod that may not exist — the source "namespace and labels". */
  name: string | null;
  labels: Labels;
  ips: string[];
  hostNetwork: boolean;
  nodeName: string | null;
  serviceAccount: string | null;
  ports: ContainerPort[];
}

/** One side of a connection: a pod (real or described by labels) or an address outside the cluster. */
export type Endpoint = { type: "pod"; pod: PodInfo } | { type: "external"; ip: string };

export function protocolOf(value: unknown, fallback: Protocol = "TCP"): Protocol {
  const p = str(value)?.toUpperCase();
  return p === "UDP" || p === "SCTP" || p === "TCP" ? p : fallback;
}

export function podInfo(obj: KubeObject): PodInfo {
  const ips = arr(get(obj, "status", "podIPs"))
    .map((p) => str(get(p, "ip")))
    .filter((ip): ip is string => Boolean(ip));
  const single = str(get(obj, "status", "podIP"));
  if (single && !ips.includes(single)) ips.unshift(single);
  const containers = [...arr(get(obj, "spec", "containers")), ...arr(get(obj, "spec", "initContainers"))];
  const ports = containers.flatMap((c) =>
    arr(get(c, "ports")).flatMap((p): ContainerPort[] => {
      const port = num(get(p, "containerPort"));
      return port === undefined ? [] : [{ name: str(get(p, "name")) ?? null, port, protocol: protocolOf(get(p, "protocol")) }];
    }),
  );
  return {
    namespace: obj.metadata?.namespace ?? "",
    name: obj.metadata?.name ?? "",
    labels: labelsOf(obj),
    ips,
    hostNetwork: get(obj, "spec", "hostNetwork") === true,
    nodeName: str(get(obj, "spec", "nodeName")) ?? null,
    serviceAccount: str(get(obj, "spec", "serviceAccountName")) ?? str(get(obj, "spec", "serviceAccount")) ?? "default",
    ports,
  };
}

/** A pod known only by its namespace and labels (no IP, no ports). */
export function describedPod(namespace: string, labels: Labels): PodInfo {
  return { namespace, name: null, labels, ips: [], hostNetwork: false, nodeName: null, serviceAccount: null, ports: [] };
}

/** Whether a pod has finished (its IP is gone and it takes no traffic). */
export function isFinished(obj: KubeObject): boolean {
  const phase = str(get(obj, "status", "phase"));
  return phase === "Succeeded" || phase === "Failed";
}

export interface ServicePort {
  name: string | null;
  port: number;
  protocol: Protocol;
  /** The pod port: a number, or a container port's name. */
  targetPort: number | string;
  nodePort: number | null;
}

export interface ServiceInfo {
  namespace: string;
  name: string;
  type: string;
  /** Selects nothing for a Service without a selector (its endpoints are managed by hand) or an ExternalName one. */
  selector: Selector;
  hasSelector: boolean;
  ports: ServicePort[];
  externalTrafficPolicy: string | null;
}

export function serviceInfo(obj: KubeObject): ServiceInfo {
  const type = str(get(obj, "spec", "type")) ?? "ClusterIP";
  const selector = type === "ExternalName" ? mapSelector(undefined) : mapSelector(get(obj, "spec", "selector"));
  const ports = arr(get(obj, "spec", "ports")).flatMap((p): ServicePort[] => {
    const port = num(get(p, "port"));
    if (port === undefined) return [];
    const target = get(p, "targetPort");
    return [
      {
        name: str(get(p, "name")) ?? null,
        port,
        protocol: protocolOf(get(p, "protocol")),
        targetPort: typeof target === "number" || (typeof target === "string" && target !== "") ? target : port,
        nodePort: num(get(p, "nodePort")) ?? null,
      },
    ];
  });
  return {
    namespace: obj.metadata?.namespace ?? "",
    name: obj.metadata?.name ?? "",
    type,
    selector,
    hasSelector: selector.type !== "nothing",
    ports,
    externalTrafficPolicy: str(get(obj, "spec", "externalTrafficPolicy")) ?? null,
  };
}

/** The pod port a Service port reaches on `pod`: a named target port is looked up in its containers. */
export function resolveTargetPort(port: ServicePort, pod: PodInfo): number | null {
  if (typeof port.targetPort === "number") return port.targetPort;
  if (/^\d+$/.test(port.targetPort)) return Number(port.targetPort);
  return pod.ports.find((p) => p.name === port.targetPort && p.protocol === port.protocol)?.port ?? null;
}

/** A port typed by the user: a number, or the name of one of `pod`'s container ports (for `protocol`). */
export function resolvePodPort(text: string, protocol: Protocol, pod: PodInfo | null): number | null {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n >= 1 && n <= 65535 ? n : null;
  }
  if (!pod || trimmed === "") return null;
  return pod.ports.find((p) => p.name === trimmed && p.protocol === protocol)?.port ?? null;
}

/** `app=web, tier=api` → labels; `null` when a part is not `key=value`. An empty text is no labels. */
export function parseLabels(text: string): Labels | null {
  const labels: Record<string, string> = {};
  for (const part of text.split(",")) {
    const item = part.trim();
    if (item === "") continue;
    const eq = item.indexOf("=");
    if (eq <= 0) return null;
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim().replace(/^=/, "");
    if (!/^[A-Za-z0-9]([A-Za-z0-9_./-]*[A-Za-z0-9])?$/.test(key) || /[\s,]/.test(value)) return null;
    labels[key] = value;
  }
  return labels;
}

/** Labels of a Namespace (with `kubernetes.io/metadata.name`, which the API server sets on every namespace). */
export function namespaceLabels(obj: KubeObject): Labels {
  const name = obj.metadata?.name ?? "";
  return { ...labelsOf(obj), "kubernetes.io/metadata.name": name };
}

/** `app=web, tier in (a, b), !legacy` — a LabelSelector in kubectl's syntax; "" for an empty one. */
export function selectorText(value: unknown): string {
  const labels = Object.entries(record(get(value, "matchLabels"))).map(([k, v]) => `${k}=${String(v)}`);
  const expressions = arr(get(value, "matchExpressions")).map((e) => {
    const key = str(get(e, "key")) ?? "";
    const values = arr(get(e, "values")).map(String).join(", ");
    switch (str(get(e, "operator"))) {
      case "In":
        return `${key} in (${values})`;
      case "NotIn":
        return `${key} notin (${values})`;
      case "Exists":
        return key;
      case "DoesNotExist":
        return `!${key}`;
      default:
        return `${key} ${str(get(e, "operator")) ?? ""} (${values})`;
    }
  });
  return [...labels, ...expressions].join(", ");
}

export { labelSelector };

// ---------- The policy model ----------

export type Flavor = "kubernetes" | "cilium" | "ciliumClusterwide" | "calico" | "calicoGlobal";

export interface PolicyRef {
  flavor: Flavor;
  apiVersion: string;
  kind: string;
  namespace: string | null;
  name: string;
  /** Cilium: the index in `specs` (a policy with several specs is one policy per spec). */
  part: number | null;
}

export const policyKey = (ref: PolicyRef) => `${ref.flavor}/${ref.namespace ?? ""}/${ref.name}/${ref.part ?? ""}`;

/** An i18n key under `netpol:` with its values: how the UI says what a selector, peer or port is. */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
}

export interface Ctx {
  /** The labels of a namespace; `undefined` when they are not known (Namespaces not readable). */
  namespaceLabels(namespace: string): Labels | undefined;
}

export interface Check<R> {
  result: Tri;
  reason: R;
}

/** Why a peer matched or not (or could not be told). */
export type PeerReason =
  | { type: "match" }
  /** A podSelector-only peer selects pods of the policy's own namespace. */
  | { type: "namespace"; expected: string; actual: string }
  /** `labels` null: the namespace's labels are not known. */
  | { type: "namespaceSelector"; namespace: string; selector: string; labels: Labels | null }
  | { type: "podSelector"; selector: string; labels: Labels }
  /** A selector peer never matches an address outside the cluster. */
  | { type: "notPod" }
  | { type: "ipBlock"; cidr: string }
  | { type: "ipBlockExcept"; cidr: string; except: string }
  /** The pod's IP is inside the block: whether an `ipBlock` applies to pod IPs depends on the CNI. */
  | { type: "ipBlockPod"; cidr: string }
  /** The pod's IP is not known (a pod described by labels, or one not running yet). */
  | { type: "ipUnknown" }
  /** Cilium CIDR rules do not select pods managed by Cilium. */
  | { type: "cidrNotPods" }
  | { type: "entity"; entity: string }
  /** A Calico selector can match a (Global)NetworkSet holding an outside address. */
  | { type: "networkSet" }
  | { type: "unmodelled"; feature: string };

export type PortReason =
  | { type: "match" }
  | { type: "protocol"; expected: string }
  | { type: "port"; expected: string }
  /** A named port of the destination pod with this protocol does not exist. */
  | { type: "namedUnresolved"; name: string }
  | { type: "namedOther"; name: string; resolved: number }
  /** A named port cannot be resolved for an address outside the cluster. */
  | { type: "namedExternal"; name: string }
  | { type: "unmodelled"; feature: string };

export interface Peer {
  index: number;
  text: Phrase;
  match(ep: Endpoint, ctx: Ctx): Check<PeerReason>;
}

export interface PortSpec {
  index: number;
  /** "ANY": every protocol (Cilium); "OTHER": a protocol other than TCP/UDP/SCTP (ICMP, …), never matched. */
  protocol: Protocol | "ANY" | "OTHER";
  /** A number, a container port's name, or `null` for every port. */
  port: number | string | null;
  endPort: number | null;
  text: Phrase;
  unmodelled?: string;
}

export type RuleList = "ingress" | "egress" | "ingressDeny" | "egressDeny";

export interface Rule {
  /** Position in its list (`list`), from 0. */
  index: number;
  list: RuleList;
  action: "allow" | "deny" | "log" | "pass";
  /** `null`: every peer. */
  peers: Peer[] | null;
  /** `null`: every port. */
  ports: PortSpec[] | null;
  /** Calico: what the rule asks of the selected pod itself (the destination of an ingress rule, the source of egress). */
  local?: Peer;
  /** Features the engine does not model: the rule matches at best "maybe". */
  unmodelled: string[];
  /** A rule that matches nothing at all (Cilium's `{}`). */
  empty?: boolean;
}

export interface Policy {
  ref: PolicyRef;
  /** "union": allows add up, deny rules win (Kubernetes, Cilium); "ordered": first matching rule decides (Calico). */
  semantics: "union" | "ordered";
  /** Calico's `order` (Kubernetes NetworkPolicies count as 1000 among Calico policies); `null` = last. */
  order: number | null;
  /** The name Calico sorts policies of the same order by. */
  sortName: string;
  selects(pod: PodInfo, ctx: Ctx): Check<string | null>;
  /**
   * Whether it selects every pod of `namespace` whatever the pod's own labels (an empty pod selector, or one naming only
   * the namespace): what makes it a namespace-wide default (`coverage.ts`). Left out: "no".
   */
  everyPodIn?(namespace: string, ctx: Ctx): Tri;
  /** Which pods it selects, in words. */
  selectorText: Phrase;
  /** Whether a pod it selects is isolated (default deny) for the direction. */
  isolates: Record<Direction, boolean>;
  /** Whether its rules of the direction take part (Cilium rules count even without default deny). */
  applies: Record<Direction, boolean>;
  /** `policyTypes` was left out and defaulted (Kubernetes) or `types` (Calico). */
  defaultedTypes: boolean;
  rules: Record<Direction, Rule[]>;
  /** Features of the whole policy the engine does not model (a Calico tier, …). */
  unmodelled: string[];
}
