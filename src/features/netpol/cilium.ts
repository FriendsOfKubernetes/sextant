// Cilium policies (cilium.io/v2: CiliumNetworkPolicy, CiliumClusterwideNetworkPolicy) in the engine's model — the L3/L4
// subset Sextant can evaluate without a running agent:
//
//  - `endpointSelector` selects pods (of the policy's namespace for a CiliumNetworkPolicy, of every namespace for a
//    clusterwide one); keys may carry the `k8s:`/`any:` source prefix; pods also carry
//    `io.kubernetes.pod.namespace`, `io.cilium.k8s.namespace.labels.<key>` and `io.cilium.k8s.policy.serviceaccount`;
//    a spec with `nodeSelector` is a host policy and selects no pod;
//  - a pod is isolated (default deny) for a direction when a selecting spec has rules of it (`ingress`/`ingressDeny`),
//    unless `enableDefaultDeny` turns that off; allow rules add up, deny rules win;
//  - a rule: its L3 peers (`fromEndpoints`, `fromCIDR`, `fromCIDRSet`, `fromEntities`) ORed, AND its `toPorts`; a rule
//    with neither matches nothing (`ingress: [{}]` denies all, unlike Kubernetes' `- {}`); `fromEndpoints` of a
//    namespaced policy is limited to its namespace unless the selector names a namespace label;
//  - CIDR rules select addresses outside the cluster, never pods; entities `all`, `world`, `cluster` are modelled.
//
// Not modelled (the answer becomes "unknown" where they could matter): L7 rules (`toPorts[].rules`), `serverNames`,
// listeners, TLS, `toFQDNs`, `toServices`, `fromRequires`/`toRequires`, groups, nodes, CIDR groups, `authentication`.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { labelSelector, matches } from "../resource-map/selectors";
import { portPhrase } from "./kubernetes";
import { ipBlockCheck } from "./kubernetes";
import {
  type Check,
  type Ctx,
  type Direction,
  type Flavor,
  type Labels,
  type Peer,
  type PeerReason,
  type PodInfo,
  type Policy,
  type PortSpec,
  type Rule,
  type RuleList,
  type Tri,
} from "./model";

const { arr, get, num, record, str } = status;

export const CILIUM_GROUP = "cilium.io";
export const NS_LABEL = "io.kubernetes.pod.namespace";
export const NS_LABELS_PREFIX = "io.cilium.k8s.namespace.labels.";
const SA_LABEL = "io.cilium.k8s.policy.serviceaccount";
const CLUSTER_LABEL = "io.cilium.k8s.policy.cluster";

/** `k8s:app` → `app`; other sources (`reserved:host`) keep their prefix: no pod label has one. */
function stripSource(key: string): string {
  if (key.startsWith("k8s:")) return key.slice(4);
  if (key.startsWith("any:")) return key.slice(4);
  return key;
}

interface CiliumSelector {
  /** The selector with the source prefixes stripped. */
  value: { matchLabels: Record<string, string>; matchExpressions: unknown[] };
  keys: string[];
  text: string;
}

function ciliumSelector(raw: unknown): CiliumSelector {
  const matchLabels: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(get(raw, "matchLabels")))) matchLabels[stripSource(k)] = String(v);
  const matchExpressions = arr(get(raw, "matchExpressions")).map((e) => ({
    key: stripSource(str(get(e, "key")) ?? ""),
    operator: str(get(e, "operator")) ?? "",
    values: arr(get(e, "values")).map(String),
  }));
  const keys = [...Object.keys(matchLabels), ...matchExpressions.map((e) => e.key)];
  const text = [
    ...Object.entries(record(get(raw, "matchLabels"))).map(([k, v]) => `${k}=${String(v)}`),
    ...matchExpressions.map((e) => `${e.key} ${e.operator}${e.values.length > 0 ? ` (${e.values.join(", ")})` : ""}`),
  ].join(", ");
  return { value: { matchLabels, matchExpressions }, keys, text };
}

const namesNamespace = (sel: CiliumSelector) => sel.keys.some((k) => k === NS_LABEL || k.startsWith(NS_LABELS_PREFIX));

/** A pod's identity labels as Cilium sees them; `null` namespace labels when they are not known. */
function identity(pod: PodInfo, ctx: Ctx): { labels: Labels; namespaceKnown: boolean } {
  const labels: Record<string, string> = { ...pod.labels, [NS_LABEL]: pod.namespace };
  if (pod.serviceAccount) labels[SA_LABEL] = pod.serviceAccount;
  const nsLabels = ctx.namespaceLabels(pod.namespace);
  for (const [k, v] of Object.entries(nsLabels ?? {})) labels[`${NS_LABELS_PREFIX}${k}`] = v;
  return { labels, namespaceKnown: nsLabels !== undefined };
}

function selectorMatch(sel: CiliumSelector, pod: PodInfo, ctx: Ctx): Tri {
  if (sel.keys.includes(CLUSTER_LABEL)) return "maybe";
  // A pod known only by labels has no known service account.
  if (pod.name === null && sel.keys.includes(SA_LABEL)) return "maybe";
  const { labels, namespaceKnown } = identity(pod, ctx);
  if (!namespaceKnown && sel.keys.some((k) => k.startsWith(NS_LABELS_PREFIX))) return "maybe";
  return matches(labelSelector(sel.value), labels) ? "yes" : "no";
}

function endpointsPeer(raw: unknown, index: number, policyNamespace: string | null): Peer {
  const sel = ciliumSelector(raw);
  const limited = policyNamespace !== null && !namesNamespace(sel);
  return {
    index,
    text: limited
      ? { key: "peer.ciliumEndpointsHere", params: { selector: sel.text || "{}", namespace: policyNamespace } }
      : { key: "peer.ciliumEndpoints", params: { selector: sel.text || "{}" } },
    match(ep, ctx): Check<PeerReason> {
      if (ep.type === "external") {
        // `reserved:world` and the like are identities of outside addresses.
        return sel.keys.some((k) => k.includes(":"))
          ? { result: "maybe", reason: { type: "unmodelled", feature: "reserved" } }
          : { result: "no", reason: { type: "notPod" } };
      }
      if (limited && ep.pod.namespace !== policyNamespace) {
        return { result: "no", reason: { type: "namespace", expected: policyNamespace, actual: ep.pod.namespace } };
      }
      const result = selectorMatch(sel, ep.pod, ctx);
      if (result === "no") return { result, reason: { type: "podSelector", selector: sel.text, labels: ep.pod.labels } };
      return { result, reason: result === "yes" ? { type: "match" } : { type: "unmodelled", feature: "selector" } };
    },
  };
}

function cidrPeer(cidr: string, except: string[], index: number): Peer {
  return {
    index,
    text: except.length > 0 ? { key: "peer.ipBlockExcept", params: { cidr, except: except.join(", ") } } : { key: "peer.ipBlock", params: { cidr } },
    match(ep) {
      if (ep.type === "pod") return { result: "no", reason: { type: "cidrNotPods" } };
      return ipBlockCheck(ep, cidr, except);
    },
  };
}

const ENTITIES_OF_PODS = new Set(["all", "cluster"]);
const ENTITIES_OF_OUTSIDE = new Set(["all", "world", "world-ipv4", "world-ipv6"]);
/** Entities an outside address might be (a node's or the API server's address). */
const ENTITIES_MAYBE_OUTSIDE = new Set(["host", "remote-node", "kube-apiserver"]);

function entityPeer(entity: string, index: number): Peer {
  return {
    index,
    text: { key: "peer.entity", params: { entity } },
    match(ep) {
      if (ep.type === "pod") {
        return ENTITIES_OF_PODS.has(entity) ? { result: "yes", reason: { type: "match" } } : { result: "no", reason: { type: "entity", entity } };
      }
      if (ENTITIES_OF_OUTSIDE.has(entity)) return { result: "yes", reason: { type: "match" } };
      return ENTITIES_MAYBE_OUTSIDE.has(entity)
        ? { result: "maybe", reason: { type: "entity", entity } }
        : { result: "no", reason: { type: "entity", entity } };
    },
  };
}

function unmodelledPeer(feature: string, index: number): Peer {
  return {
    index,
    text: { key: "peer.unmodelled", params: { feature } },
    match: () => ({ result: "maybe", reason: { type: "unmodelled", feature } }),
  };
}

const L7_FIELDS = ["rules", "serverNames", "listener", "originatingTLS", "terminatingTLS"] as const;

function ciliumPorts(rule: unknown): PortSpec[] | null {
  const toPorts = arr(get(rule, "toPorts"));
  const icmps = arr(get(rule, "icmps"));
  if (toPorts.length === 0 && icmps.length === 0) return null;
  const specs: PortSpec[] = [];
  for (const entry of toPorts) {
    const l7 = L7_FIELDS.find((f) => {
      const v = get(entry, f);
      return v !== undefined && v !== null && !(typeof v === "object" && Object.keys(v as object).length === 0);
    });
    const ports = arr(get(entry, "ports"));
    const list = ports.length > 0 ? ports : [{}];
    for (const p of list) {
      const protocolText = (str(get(p, "protocol")) ?? "ANY").toUpperCase();
      const protocol = protocolText === "TCP" || protocolText === "UDP" || protocolText === "SCTP" || protocolText === "ANY" ? protocolText : "OTHER";
      const raw = get(p, "port");
      const text = typeof raw === "number" ? String(raw) : (str(raw) ?? "");
      const port = text === "" || text === "0" ? null : /^\d+$/.test(text) ? Number(text) : text;
      const endPort = typeof port === "number" ? (num(get(p, "endPort")) ?? null) : null;
      specs.push({
        index: specs.length,
        protocol,
        port,
        endPort,
        text: portPhrase(protocolText === "ANY" ? "any" : protocolText, port, endPort),
        ...(l7 ? { unmodelled: l7 } : {}),
      });
    }
  }
  for (const icmp of icmps) {
    specs.push({ index: specs.length, protocol: "OTHER", port: null, endPort: null, text: { key: "port.icmp", params: { type: String(get(icmp, "fields", 0, "type") ?? "") } } });
  }
  return specs;
}

const UNMODELLED_L3 = {
  from: ["fromGroups", "fromNodes"],
  to: ["toGroups", "toNodes", "toServices", "toFQDNs"],
} as const;

function ciliumRule(raw: unknown, index: number, list: RuleList, policyNamespace: string | null): Rule {
  const side = list.startsWith("ingress") ? "from" : "to";
  const peers: Peer[] = [];
  const add = (make: (i: number) => Peer) => peers.push(make(peers.length));
  for (const sel of arr(get(raw, `${side}Endpoints`))) add((i) => endpointsPeer(sel, i, policyNamespace));
  for (const cidr of arr(get(raw, `${side}CIDR`))) add((i) => cidrPeer(String(cidr), [], i));
  for (const set of arr(get(raw, `${side}CIDRSet`))) {
    const cidr = str(get(set, "cidr"));
    if (cidr) add((i) => cidrPeer(cidr, arr(get(set, "except")).map(String), i));
    else add((i) => unmodelledPeer("cidrGroupRef", i));
  }
  for (const entity of arr(get(raw, `${side}Entities`))) add((i) => entityPeer(String(entity), i));
  for (const field of UNMODELLED_L3[side]) if (arr(get(raw, field)).length > 0) add((i) => unmodelledPeer(field, i));
  const ports = ciliumPorts(raw);
  const unmodelled = [`${side}Requires`, "authentication"].filter((f) => {
    const v = get(raw, f);
    return v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
  });
  return {
    index,
    list,
    action: list.endsWith("Deny") ? "deny" : "allow",
    peers: peers.length > 0 ? peers : null,
    ports,
    unmodelled,
    ...(peers.length === 0 && ports === null && unmodelled.length === 0 ? { empty: true } : {}),
  };
}

/** A Cilium policy (one engine policy per spec of `specs`); host policies (`nodeSelector`) select no pod. */
export function ciliumPolicies(obj: KubeObject, clusterwide: boolean): Policy[] {
  const namespace = clusterwide ? null : (obj.metadata?.namespace ?? "");
  const name = obj.metadata?.name ?? "";
  const single = get(obj, "spec");
  const specs: { spec: unknown; part: number | null }[] = [
    ...(single && typeof single === "object" ? [{ spec: single, part: null }] : []),
    ...arr(get(obj, "specs")).map((spec, i) => ({ spec, part: i })),
  ];
  const flavor: Flavor = clusterwide ? "ciliumClusterwide" : "cilium";
  return specs.flatMap(({ spec, part }): Policy[] => {
    if (get(spec, "nodeSelector") !== undefined) return [];
    const raw = get(spec, "endpointSelector");
    if (raw === undefined || raw === null) return [];
    const sel = ciliumSelector(raw);
    const lists = (d: Direction) => ({ allow: arr(get(spec, d)), deny: arr(get(spec, `${d}Deny`)) });
    const defaultDeny = (d: Direction) => get(spec, "enableDefaultDeny", d) !== false;
    const has = (d: Direction) => lists(d).allow.length > 0 || lists(d).deny.length > 0;
    const rules = (d: Direction): Rule[] => [
      ...lists(d).allow.map((r, i) => ciliumRule(r, i, d, namespace)),
      ...lists(d).deny.map((r, i) => ciliumRule(r, i, `${d}Deny`, namespace)),
    ];
    return [
      {
        ref: { flavor, apiVersion: obj.apiVersion ?? `${CILIUM_GROUP}/v2`, kind: obj.kind ?? "", namespace, name, part },
        semantics: "union",
        order: null,
        sortName: name,
        selects(pod, ctx) {
          if (namespace !== null && pod.namespace !== namespace) return { result: "no", reason: null };
          return { result: selectorMatch(sel, pod, ctx), reason: null };
        },
        selectorText: namespace !== null
          ? { key: "selects.ciliumHere", params: { selector: sel.text || "{}", namespace } }
          : { key: "selects.ciliumEverywhere", params: { selector: sel.text || "{}" } },
        isolates: { ingress: has("ingress") && defaultDeny("ingress"), egress: has("egress") && defaultDeny("egress") },
        applies: { ingress: has("ingress"), egress: has("egress") },
        defaultedTypes: false,
        rules: { ingress: rules("ingress"), egress: rules("egress") },
        unmodelled: [],
      },
    ];
  });
}

