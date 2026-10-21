// Kubernetes NetworkPolicy (networking.k8s.io/v1) in the engine's model, following the API's semantics:
//
//  - `spec.podSelector` selects pods of the policy's namespace (empty: all of them; hostNetwork pods are not subject);
//  - `policyTypes` left out defaults to Ingress, plus Egress when `spec.egress` has rules (the API server's defaulting);
//    rules of a direction not in `policyTypes` are ignored;
//  - rules are ORed; a rule's `from`/`to` peers are ORed, its `ports` are ORed, and peers AND ports must both match;
//    `from`/`to` missing or empty = every peer, `ports` missing or empty = every port, so `- {}` allows everything
//    while a missing `ingress` (or `ingress: []`) under policyType Ingress allows nothing;
//  - a peer with `podSelector` AND `namespaceSelector` selects those pods in those namespaces (one peer = AND; two
//    peers = OR); a `podSelector` alone means the policy's namespace; `namespaceSelector: {}` means every namespace;
//  - `ipBlock` (with `except`) is meant for addresses outside the cluster; whether it applies to pod IPs is
//    implementation-defined, so a pod IP inside a block is "maybe";
//  - a port's protocol defaults to TCP; a named port is resolved against the destination pod's container ports (it
//    never matches an address outside the cluster); `endPort` makes a range.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { EVERYTHING, matches, podSelectorOf } from "../resource-map/selectors";
import { cidrContains, parseCidr, parseIp } from "./cidr";
import {
  labelSelector,
  selectorText,
  tri,
  type Check,
  type Ctx,
  type Direction,
  type Endpoint,
  type Peer,
  type PeerReason,
  type Phrase,
  type Policy,
  type PortSpec,
  type Rule,
} from "./model";

const { arr, get, num, str } = status;

const NETWORK_POLICY = { group: "networking.k8s.io", kind: "NetworkPolicy" };

/** `policyTypes` as written, or as the API server defaults it. */
export function policyTypesOf(obj: KubeObject): { types: Record<Direction, boolean>; defaulted: boolean } {
  const written = arr(get(obj, "spec", "policyTypes")).map(String);
  if (written.length > 0) {
    return { types: { ingress: written.includes("Ingress"), egress: written.includes("Egress") }, defaulted: false };
  }
  return { types: { ingress: true, egress: arr(get(obj, "spec", "egress")).length > 0 }, defaulted: true };
}

/** An address against an ip block: inside and not excepted. */
export function ipBlockCheck(ep: Endpoint, cidr: string, except: readonly string[]): Check<PeerReason> {
  const block = parseCidr(cidr);
  if (!block) return { result: "no", reason: { type: "ipBlock", cidr } };
  const inside = (ip: string): { result: boolean; except?: string } => {
    const address = parseIp(ip);
    if (!address || !cidrContains(block, address)) return { result: false };
    const hit = except.find((e) => {
      const c = parseCidr(e);
      return c ? cidrContains(c, address) : false;
    });
    return hit ? { result: false, except: hit } : { result: true };
  };
  if (ep.type === "external") {
    const r = inside(ep.ip);
    if (r.result) return { result: "yes", reason: { type: "match" } };
    return r.except
      ? { result: "no", reason: { type: "ipBlockExcept", cidr, except: r.except } }
      : { result: "no", reason: { type: "ipBlock", cidr } };
  }
  if (ep.pod.ips.length === 0) return { result: "maybe", reason: { type: "ipUnknown" } };
  const results = ep.pod.ips.map(inside);
  if (results.some((r) => r.result)) return { result: "maybe", reason: { type: "ipBlockPod", cidr } };
  const excepted = results.find((r) => r.except);
  return excepted?.except
    ? { result: "no", reason: { type: "ipBlockExcept", cidr, except: excepted.except } }
    : { result: "no", reason: { type: "ipBlock", cidr } };
}

/** Whether a namespace's labels match a selector (`maybe` when the labels are not known). */
export function namespaceCheck(
  ctx: Ctx,
  namespace: string,
  selectorValue: unknown,
): Check<PeerReason> {
  const selector = labelSelector(selectorValue);
  if (selector.type === "everything") return { result: "yes", reason: { type: "match" } };
  const labels = ctx.namespaceLabels(namespace);
  const text = selectorText(selectorValue);
  if (!labels) {
    // The API server sets `kubernetes.io/metadata.name` on every namespace: a selector on it alone is still decidable.
    const own = { "kubernetes.io/metadata.name": namespace };
    const onlyName =
      selector.type === "terms" &&
      selector.matchLabels.every(([k]) => k === "kubernetes.io/metadata.name") &&
      selector.expressions.every((e) => e.key === "kubernetes.io/metadata.name");
    if (onlyName) {
      return matches(selector, own)
        ? { result: "yes", reason: { type: "match" } }
        : { result: "no", reason: { type: "namespaceSelector", namespace, selector: text, labels: own } };
    }
    return { result: "maybe", reason: { type: "namespaceSelector", namespace, selector: text, labels: null } };
  }
  return matches(selector, labels)
    ? { result: "yes", reason: { type: "match" } }
    : { result: "no", reason: { type: "namespaceSelector", namespace, selector: text, labels } };
}

function peerPhrase(value: unknown, policyNamespace: string): Phrase {
  const ipBlock = get(value, "ipBlock");
  if (ipBlock !== undefined) {
    const cidr = str(get(ipBlock, "cidr")) ?? "";
    const except = arr(get(ipBlock, "except")).map(String);
    return except.length > 0
      ? { key: "peer.ipBlockExcept", params: { cidr, except: except.join(", ") } }
      : { key: "peer.ipBlock", params: { cidr } };
  }
  const pods = get(value, "podSelector");
  const nss = get(value, "namespaceSelector");
  const podText = pods === undefined || pods === null ? "" : selectorText(pods);
  const nsText = nss === undefined || nss === null ? null : selectorText(nss);
  if (nsText === null) {
    return podText
      ? { key: "peer.podsHere", params: { selector: podText, namespace: policyNamespace } }
      : { key: "peer.allPodsHere", params: { namespace: policyNamespace } };
  }
  if (nsText === "") return podText ? { key: "peer.podsEverywhere", params: { selector: podText } } : { key: "peer.everyPod" };
  return podText
    ? { key: "peer.podsInNamespaces", params: { selector: podText, namespaces: nsText } }
    : { key: "peer.allPodsInNamespaces", params: { namespaces: nsText } };
}

function k8sPeer(value: unknown, index: number, policyNamespace: string): Peer {
  const text = peerPhrase(value, policyNamespace);
  const ipBlock = get(value, "ipBlock");
  if (ipBlock !== undefined && ipBlock !== null) {
    const cidr = str(get(ipBlock, "cidr")) ?? "";
    const except = arr(get(ipBlock, "except")).map(String);
    return { index, text, match: (ep) => ipBlockCheck(ep, cidr, except) };
  }
  const podValue = get(value, "podSelector");
  const nsValue = get(value, "namespaceSelector");
  const hasPods = podValue !== undefined && podValue !== null;
  const hasNs = nsValue !== undefined && nsValue !== null;
  const pods = hasPods ? labelSelector(podValue) : EVERYTHING;
  return {
    index,
    text,
    match(ep, ctx) {
      if (!hasPods && !hasNs) return { result: "no", reason: { type: "unmodelled", feature: "emptyPeer" } };
      if (ep.type === "external") return { result: "no", reason: { type: "notPod" } };
      const pod = ep.pod;
      const ns: Check<PeerReason> = hasNs
        ? namespaceCheck(ctx, pod.namespace, nsValue)
        : pod.namespace === policyNamespace
          ? { result: "yes", reason: { type: "match" } }
          : { result: "no", reason: { type: "namespace", expected: policyNamespace, actual: pod.namespace } };
      if (ns.result === "no") return ns;
      const podMatch: Check<PeerReason> = matches(pods, pod.labels)
        ? { result: "yes", reason: { type: "match" } }
        : { result: "no", reason: { type: "podSelector", selector: selectorText(podValue), labels: pod.labels } };
      if (podMatch.result === "no") return podMatch;
      return ns;
    },
  };
}

export function portPhrase(protocol: string, port: number | string | null, endPort: number | null): Phrase {
  if (port === null) return { key: "port.anyOf", params: { protocol } };
  if (typeof port === "string") return { key: "port.named", params: { protocol, name: port } };
  if (endPort !== null && endPort !== port) return { key: "port.range", params: { protocol, from: port, to: endPort } };
  return { key: "port.single", params: { protocol, port } };
}

function k8sPort(value: unknown, index: number): PortSpec {
  const protocolText = (str(get(value, "protocol")) ?? "TCP").toUpperCase();
  const protocol = protocolText === "TCP" || protocolText === "UDP" || protocolText === "SCTP" ? protocolText : "OTHER";
  const raw = get(value, "port");
  const port =
    typeof raw === "number" ? raw : typeof raw === "string" && raw !== "" ? (/^\d+$/.test(raw) ? Number(raw) : raw) : null;
  const endPort = typeof port === "number" ? (num(get(value, "endPort")) ?? null) : null;
  return { index, protocol, port, endPort, text: portPhrase(protocolText, port, endPort) };
}

/** `from`/`to` or `ports`: missing or empty = every peer / every port. */
function listOrAll<T>(value: unknown, map: (v: unknown, i: number) => T): T[] | null {
  const list = arr(value);
  return list.length === 0 ? null : list.map(map);
}

function k8sRules(obj: KubeObject, direction: Direction, namespace: string): Rule[] {
  return arr(get(obj, "spec", direction)).map((rule, index) => ({
    index,
    list: direction,
    action: "allow",
    peers: listOrAll(get(rule, direction === "ingress" ? "from" : "to"), (p, i) => k8sPeer(p, i, namespace)),
    ports: listOrAll(get(rule, "ports"), k8sPort),
    unmodelled: [],
  }));
}

export function kubernetesPolicy(obj: KubeObject): Policy {
  const namespace = obj.metadata?.namespace ?? "";
  const name = obj.metadata?.name ?? "";
  const selector = podSelectorOf(NETWORK_POLICY, obj) ?? EVERYTHING;
  const podSelectorValue = get(obj, "spec", "podSelector");
  const { types, defaulted } = policyTypesOf(obj);
  const text = selectorText(podSelectorValue);
  return {
    ref: { flavor: "kubernetes", apiVersion: obj.apiVersion ?? "networking.k8s.io/v1", kind: "NetworkPolicy", namespace, name, part: null },
    semantics: "union",
    order: 1000,
    sortName: `knp.default.${name}`,
    selects(pod) {
      if (pod.namespace !== namespace) return { result: "no", reason: null };
      return { result: tri(matches(selector, pod.labels)), reason: null };
    },
    everyPodIn: (ns) => tri(ns === namespace && selector.type === "everything"),
    selectorText: text ? { key: "selects.pods", params: { selector: text, namespace } } : { key: "selects.allPods", params: { namespace } },
    isolates: types,
    applies: types,
    defaultedTypes: defaulted,
    rules: {
      ingress: types.ingress ? k8sRules(obj, "ingress", namespace) : [],
      egress: types.egress ? k8sRules(obj, "egress", namespace) : [],
    },
    unmodelled: [],
  };
}

/** Rules written for a direction the policy's types leave out (ignored by Kubernetes). */
export function ignoredRules(obj: KubeObject): Direction[] {
  const { types } = policyTypesOf(obj);
  return (["ingress", "egress"] as const).filter((d) => !types[d] && arr(get(obj, "spec", d)).length > 0);
}
