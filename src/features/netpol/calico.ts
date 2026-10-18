// Calico policies (projectcalico.org/v3 through the Calico API server, or crd.projectcalico.org/v1: NetworkPolicy,
// GlobalNetworkPolicy) in the engine's model — the L3/L4 subset of the default tier:
//
//  - policies are "ordered": sorted by `order` (none = last), then by name; Kubernetes NetworkPolicies take part as
//    order 1000. The first rule whose match is certain decides (Allow / Deny); Log goes on; a pod selected by a policy
//    of the direction that no rule decides is denied (end of tier); a pod no policy selects is allowed;
//  - `selector` (Calico's expression language, `calicoSelector.ts`) selects pods of the policy's namespace (of every
//    namespace for a GlobalNetworkPolicy, narrowed by its `namespaceSelector`); pods also carry
//    `projectcalico.org/namespace`, `projectcalico.org/orchestrator`, `projectcalico.org/serviceaccount` and
//    `pcns.<namespace label>`, namespaces `projectcalico.org/name`;
//  - `types` left out: Ingress, plus Egress when there are egress rules (Egress alone when there are only those);
//  - a rule's `source`/`destination`: `selector`, `notSelector`, `namespaceSelector`, `nets`, `notNets`, destination
//    `ports` and the rule's `protocol`; a `selector` without `namespaceSelector` in a namespaced policy means its
//    namespace. Calico matches pod IPs against `nets`.
//
// Not modelled ("unknown" where they could matter): tiers other than `default`, Pass, `serviceAccountSelector`,
// `serviceAccounts`, `services`, `http`, `notProtocol`, `ipVersion`, `notPorts`, source ports, network sets (a selector
// may match an outside address through one). Host-endpoint policies (`doNotTrack`, `preDNAT`) select no pod.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { cidrContains, parseCidr, parseIp } from "./cidr";
import { evalCalico, parseCalicoSelector, type Expr } from "./calicoSelector";
import { portPhrase } from "./kubernetes";
import {
  and,
  type Check,
  type Ctx,
  type Direction,
  type Endpoint,
  type Flavor,
  type Labels,
  type Peer,
  type PeerReason,
  type PodInfo,
  type Policy,
  type PortSpec,
  type Rule,
  type Tri,
} from "./model";

const { arr, get, num, str } = status;

export const CALICO_GROUPS = ["projectcalico.org", "crd.projectcalico.org"] as const;

function keysOf(expr: Expr): string[] {
  switch (expr.type) {
    case "all":
    case "global":
      return [];
    case "not":
      return keysOf(expr.expr);
    case "and":
    case "or":
      return [...keysOf(expr.left), ...keysOf(expr.right)];
    default:
      return [expr.key];
  }
}

/** A pod's labels as Calico's selectors see them; `known` false when its namespace's labels are not known. */
export function calicoPodLabels(pod: PodInfo, ctx: Ctx): { labels: Labels; known: boolean } {
  const labels: Record<string, string> = {
    ...pod.labels,
    "projectcalico.org/namespace": pod.namespace,
    "projectcalico.org/orchestrator": "k8s",
  };
  if (pod.serviceAccount) labels["projectcalico.org/serviceaccount"] = pod.serviceAccount;
  const ns = ctx.namespaceLabels(pod.namespace);
  for (const [k, v] of Object.entries(ns ?? {})) labels[`pcns.${k}`] = v;
  labels["pcns.projectcalico.org/name"] = pod.namespace;
  return { labels, known: ns !== undefined };
}

function evalOnPod(expr: Expr, pod: PodInfo, ctx: Ctx): Tri {
  const { labels, known } = calicoPodLabels(pod, ctx);
  if (!known && keysOf(expr).some((k) => k.startsWith("pcns.") && k !== "pcns.projectcalico.org/name")) return "maybe";
  if (pod.name === null && keysOf(expr).includes("projectcalico.org/serviceaccount")) return "maybe";
  return evalCalico(expr, labels);
}

function evalOnNamespace(expr: Expr, namespace: string, ctx: Ctx): Tri {
  const labels = ctx.namespaceLabels(namespace);
  const own = { "projectcalico.org/name": namespace };
  if (!labels) {
    const onlyName = keysOf(expr).every((k) => k === "projectcalico.org/name" || k === "kubernetes.io/metadata.name");
    return onlyName ? evalCalico(expr, { ...own, "kubernetes.io/metadata.name": namespace }) : "maybe";
  }
  return evalCalico(expr, { ...labels, ...own });
}

const not = (t: Tri): Tri => (t === "yes" ? "no" : t === "no" ? "yes" : "maybe");

/** Whether any of the pod's IPs (or the outside address) is inside one of `nets`; "maybe" without a known IP. */
function inNets(ep: Endpoint, nets: string[]): Tri {
  const ips = ep.type === "external" ? [ep.ip] : ep.pod.ips;
  if (ips.length === 0) return "maybe";
  const blocks = nets.map(parseCidr).filter((c) => c !== null);
  return ips.some((ip) => {
    const a = parseIp(ip);
    return a !== null && blocks.some((b) => cidrContains(b, a));
  })
    ? "yes"
    : "no";
}

interface Entity {
  selector?: Expr | null;
  notSelector?: Expr | null;
  namespaceSelector?: Expr | null;
  nets: string[];
  notNets: string[];
  unmodelled: string[];
  text: string;
  constrained: boolean;
}

function entityOf(raw: unknown, withPorts: "traffic" | "unmodelled"): Entity {
  const parse = (field: string) => {
    const v = str(get(raw, field));
    return v === undefined ? undefined : parseCalicoSelector(v);
  };
  const nets = [...arr(get(raw, "nets")), ...(str(get(raw, "net")) ? [get(raw, "net")] : [])].map(String);
  const notNets = [...arr(get(raw, "notNets")), ...(str(get(raw, "notNet")) ? [get(raw, "notNet")] : [])].map(String);
  const unmodelled = ["serviceAccounts", "services", "notPorts"].filter((f) => get(raw, f) !== undefined && get(raw, f) !== null);
  if (withPorts === "unmodelled" && arr(get(raw, "ports")).length > 0) unmodelled.push("source ports");
  const entity: Entity = {
    selector: parse("selector"),
    notSelector: parse("notSelector"),
    namespaceSelector: parse("namespaceSelector"),
    nets,
    notNets,
    unmodelled,
    text: ["selector", "notSelector", "namespaceSelector"]
      .flatMap((f) => (str(get(raw, f)) !== undefined ? [`${f}: ${str(get(raw, f))}`] : []))
      .concat(nets.length > 0 ? [`nets: ${nets.join(", ")}`] : [], notNets.length > 0 ? [`notNets: ${notNets.join(", ")}`] : [])
      .join("; "),
    constrained: false,
  };
  for (const f of ["selector", "notSelector", "namespaceSelector"] as const) {
    if (entity[f] === null) entity.unmodelled.push(f);
  }
  entity.constrained =
    entity.selector !== undefined ||
    entity.notSelector !== undefined ||
    entity.namespaceSelector !== undefined ||
    nets.length > 0 ||
    notNets.length > 0 ||
    unmodelled.length > 0;
  return entity;
}

function entityMatch(e: Entity, ep: Endpoint, ctx: Ctx, policyNamespace: string | null): Check<PeerReason> {
  if (e.unmodelled.length > 0) return { result: "maybe", reason: { type: "unmodelled", feature: e.unmodelled.join(", ") } };
  const parts: { result: Tri; reason: PeerReason }[] = [];
  if (ep.type === "external") {
    if (e.selector || e.notSelector || e.namespaceSelector) parts.push({ result: "maybe", reason: { type: "networkSet" } });
  } else {
    const pod = ep.pod;
    if (e.namespaceSelector) {
      const r = evalOnNamespace(e.namespaceSelector, pod.namespace, ctx);
      parts.push({ result: r, reason: { type: "namespaceSelector", namespace: pod.namespace, selector: "", labels: ctx.namespaceLabels(pod.namespace) ?? null } });
    } else if (e.selector && policyNamespace !== null) {
      parts.push(
        pod.namespace === policyNamespace
          ? { result: "yes", reason: { type: "match" } }
          : { result: "no", reason: { type: "namespace", expected: policyNamespace, actual: pod.namespace } },
      );
    }
    if (e.selector) parts.push({ result: evalOnPod(e.selector, pod, ctx), reason: { type: "podSelector", selector: "", labels: pod.labels } });
    if (e.notSelector) parts.push({ result: not(evalOnPod(e.notSelector, pod, ctx)), reason: { type: "podSelector", selector: "", labels: pod.labels } });
  }
  if (e.nets.length > 0) {
    const r = inNets(ep, e.nets);
    parts.push({ result: r, reason: r === "maybe" ? { type: "ipUnknown" } : { type: "ipBlock", cidr: e.nets.join(", ") } });
  }
  if (e.notNets.length > 0) {
    const r = not(inNets(ep, e.notNets));
    parts.push({ result: r, reason: r === "maybe" ? { type: "ipUnknown" } : { type: "ipBlock", cidr: e.notNets.join(", ") } });
  }
  const failed = parts.find((p) => p.result === "no") ?? parts.find((p) => p.result === "maybe");
  return failed ? { result: and(...parts.map((p) => p.result)), reason: failed.reason } : { result: "yes", reason: { type: "match" } };
}

type ProtocolSpec = PortSpec["protocol"] | null;

function protocolOf(raw: unknown): ProtocolSpec {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).toUpperCase();
  if (text === "TCP" || text === "6") return "TCP";
  if (text === "UDP" || text === "17") return "UDP";
  if (text === "SCTP" || text === "132") return "SCTP";
  return "OTHER";
}

function calicoPorts(protocol: ProtocolSpec, destination: unknown): PortSpec[] | null {
  const list = arr(get(destination, "ports"));
  const proto = protocol ?? "ANY";
  const label = proto === "ANY" ? "any" : proto === "OTHER" ? String(protocol) : proto;
  if (list.length === 0) return protocol === null ? null : [{ index: 0, protocol: proto, port: null, endPort: null, text: portPhrase(label, null, null) }];
  return list.map((p, index): PortSpec => {
    const text = String(p);
    const range = /^(\d+):(\d+)$/.exec(text);
    const port = range ? Number(range[1]) : /^\d+$/.test(text) ? Number(text) : text;
    const endPort = range ? Number(range[2]) : null;
    return { index, protocol: proto, port, endPort, text: portPhrase(label, port, endPort) };
  });
}

const ACTIONS = { allow: "allow", deny: "deny", log: "log", pass: "pass" } as const;

function calicoRule(raw: unknown, index: number, direction: Direction, policyNamespace: string | null): Rule {
  const action = ACTIONS[(str(get(raw, "action")) ?? "").toLowerCase() as keyof typeof ACTIONS];
  const protocol = protocolOf(get(raw, "protocol"));
  const source = get(raw, "source");
  const destination = get(raw, "destination");
  const peerRaw = direction === "ingress" ? source : destination;
  const localRaw = direction === "ingress" ? destination : source;
  const peer = entityOf(peerRaw, direction === "ingress" ? "unmodelled" : "traffic");
  const local = entityOf(localRaw, direction === "ingress" ? "traffic" : "unmodelled");
  const unmodelled = ["notProtocol", "ipVersion", "http"].filter((f) => get(raw, f) !== undefined && get(raw, f) !== null);
  if (!action) unmodelled.push(`action ${str(get(raw, "action")) ?? ""}`);
  const peerDef: Peer = {
    index: 0,
    text: { key: "peer.calico", params: { match: peer.text || "*" } },
    match: (ep, ctx) => entityMatch(peer, ep, ctx, policyNamespace),
  };
  const localDef: Peer = {
    index: 0,
    text: { key: "peer.calico", params: { match: local.text || "*" } },
    match: (ep, ctx) => entityMatch(local, ep, ctx, policyNamespace),
  };
  return {
    index,
    list: direction,
    action: action ?? "allow",
    peers: peer.constrained ? [peerDef] : null,
    ports: calicoPorts(protocol, destination),
    ...(local.constrained ? { local: localDef } : {}),
    unmodelled,
  };
}

/** A Calico policy; `null` for one that selects no pod (host-endpoint only) or mirrors a Kubernetes NetworkPolicy. */
export function calicoPolicy(obj: KubeObject, global: boolean): Policy | null {
  const name = obj.metadata?.name ?? "";
  // The Calico API server lists Kubernetes NetworkPolicies converted (`knp.default.<name>`): they are evaluated as
  // NetworkPolicies already.
  if (name.startsWith("knp.default.") || name.startsWith("ossg.")) return null;
  const spec = get(obj, "spec");
  if (get(spec, "doNotTrack") === true || get(spec, "preDNAT") === true) return null;
  const namespace = global ? null : (obj.metadata?.namespace ?? "");
  const unmodelled: string[] = [];
  const tier = str(get(spec, "tier"));
  if (tier && tier !== "default") unmodelled.push(`tier ${tier}`);
  if (str(get(spec, "serviceAccountSelector"))) unmodelled.push("serviceAccountSelector");
  const selectorText = str(get(spec, "selector")) ?? "";
  const selector = parseCalicoSelector(selectorText);
  const nsSelectorText = global ? str(get(spec, "namespaceSelector")) : undefined;
  const nsSelector = nsSelectorText !== undefined ? parseCalicoSelector(nsSelectorText) : undefined;
  const ingress = arr(get(spec, "ingress"));
  const egress = arr(get(spec, "egress"));
  const written = arr(get(spec, "types")).map(String);
  const types: Record<Direction, boolean> =
    written.length > 0
      ? { ingress: written.includes("Ingress"), egress: written.includes("Egress") }
      : { ingress: ingress.length > 0 || egress.length === 0, egress: egress.length > 0 };
  const flavor: Flavor = global ? "calicoGlobal" : "calico";
  return {
    ref: { flavor, apiVersion: obj.apiVersion ?? "projectcalico.org/v3", kind: obj.kind ?? "", namespace, name, part: null },
    semantics: "ordered",
    order: num(get(spec, "order")) ?? null,
    sortName: name,
    selects(pod, ctx) {
      if (namespace !== null && pod.namespace !== namespace) return { result: "no", reason: null };
      if (!selector) return { result: "maybe", reason: "selector" };
      if (nsSelector === null) return { result: "maybe", reason: "namespaceSelector" };
      const r = evalOnPod(selector, pod, ctx);
      return { result: nsSelector ? and(r, evalOnNamespace(nsSelector, pod.namespace, ctx)) : r, reason: null };
    },
    selectorText: namespace !== null
      ? { key: "selects.calicoHere", params: { selector: selectorText || "all()", namespace } }
      : { key: "selects.calicoEverywhere", params: { selector: selectorText || "all()" } },
    isolates: types,
    applies: types,
    defaultedTypes: written.length === 0,
    rules: {
      ingress: types.ingress ? ingress.map((r, i) => calicoRule(r, i, "ingress", namespace)) : [],
      egress: types.egress ? egress.map((r, i) => calicoRule(r, i, "egress", namespace)) : [],
    },
    unmodelled,
  };
}
