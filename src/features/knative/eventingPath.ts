// The event path of a Knative Eventing object (#234), as a tree for its details: sources → Broker → Triggers →
// subscribers, sources → Channel → Subscriptions → subscribers and replies, a Sequence's steps in order, a Parallel's
// branches. Read from the objects' specs (where events are sent) and statuses (where those resolved to), and from the
// lists of the hub's namespace the details watch (`pathNeeds`). Pure; a fan-out is cut at `MAX_FANOUT`.
import type { KindRef, KubeObject } from "../../api";
import {
  addressOf,
  BROKER,
  brokerOf,
  branchesOf,
  channelOf,
  CHANNEL_KINDS,
  groupOf,
  isChannelKind,
  isSourceKind,
  ownedByEventing,
  PARALLEL,
  pointsAt,
  replyOf,
  replyUriOf,
  SEQUENCE,
  sinkOf,
  sinkUriOf,
  stepsOf,
  subscriberOf,
  subscriberUriOf,
  SUBSCRIPTION,
  TRIGGER,
  triggerFilter,
  type Destination,
  type FilterTerm,
  type Target,
} from "./eventing";
import { sameKind } from "./model";

/** Items of one fan-out shown at most (the rest is counted). */
export const MAX_FANOUT = 50;
const MAX_STEPS = 30;

export type PathRole = "source" | "sink" | "subscriber" | "reply" | "step" | "branch" | "filter" | "hub" | "trigger" | "subscription";

export interface PathNode {
  role: PathRole;
  /** An object (link) — `kind` with its apiVersion — or a bare URI. */
  apiVersion?: string;
  kind?: string;
  name?: string;
  namespace?: string;
  uri?: string;
  /** The object when it is in hand (its state is shown). */
  obj?: KubeObject;
  current?: boolean;
  /** 1-based number of a step or branch. */
  index?: number;
  filter?: FilterTerm[];
  children: PathNode[];
  /** Children left out beyond `MAX_FANOUT`. */
  more?: number;
}

export interface EventPath {
  /** The sources that send to the hub (the root), when that is looked up. */
  from?: PathNode[];
  fromMore?: number;
  root: PathNode;
}

export interface PathLists {
  brokers?: readonly KubeObject[];
  triggers?: readonly KubeObject[];
  subscriptions?: readonly KubeObject[];
  sources?: readonly { kind: KindRef; items: readonly KubeObject[] }[];
}

const apiVersionOf = (kind: KindRef) => `${kind.group}/${kind.version}`;
const nsOf = (obj: KubeObject) => obj.metadata?.namespace ?? "";

function objectNode(role: PathRole, kind: KindRef, obj: KubeObject, extra: Partial<PathNode> = {}): PathNode {
  return { role, apiVersion: apiVersionOf(kind), kind: kind.kind, name: obj.metadata?.name, namespace: nsOf(obj), obj, children: [], ...extra };
}

function cut(nodes: PathNode[]): { nodes: PathNode[]; more?: number } {
  return nodes.length > MAX_FANOUT ? { nodes: nodes.slice(0, MAX_FANOUT), more: nodes.length - MAX_FANOUT } : { nodes };
}

/** A node for a Destination written in an object of `fromNamespace`; `resolved` is where it resolved to. */
export function destinationNode(role: PathRole, dest: Destination | undefined, fromNamespace: string, resolved?: string): PathNode | undefined {
  if (!dest && !resolved) return undefined;
  const ref = dest?.ref;
  if (ref) {
    return { role, apiVersion: ref.apiVersion, kind: ref.kind, name: ref.name, namespace: ref.namespace ?? fromNamespace, uri: resolved ?? dest.uri, children: [] };
  }
  return { role, uri: dest?.uri ?? resolved, children: [] };
}

/** Which lists of which namespace the path of `obj` needs. */
export interface PathNeeds {
  namespace: string;
  brokers: boolean;
  triggers: boolean;
  subscriptions: boolean;
  sources: boolean;
}

export function pathNeeds(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): PathNeeds | undefined {
  const ns = nsOf(obj);
  const none = { brokers: false, triggers: false, subscriptions: false, sources: false };
  if (sameKind(kind, BROKER)) return { namespace: ns, ...none, triggers: true, sources: true };
  if (sameKind(kind, TRIGGER)) {
    const broker = brokerOf(obj);
    return broker ? { namespace: broker.namespace, ...none, brokers: true, sources: true } : undefined;
  }
  if (isChannelKind(kind)) return { namespace: ns, ...none, subscriptions: true, sources: true };
  if (isSourceKind(kind)) {
    const ref = sinkOf(obj)?.ref;
    if (!ref) return undefined;
    const sinkNs = ref.namespace ?? ns;
    const sinkKind = { group: groupOf(ref.apiVersion), kind: ref.kind ?? "" };
    if (sameKind(sinkKind, BROKER)) return { namespace: sinkNs, ...none, brokers: true, triggers: true };
    if (CHANNEL_KINDS.some((c) => sameKind(c, sinkKind))) return { namespace: sinkNs, ...none, subscriptions: true };
  }
  return undefined;
}

// ---------- Fan-outs ----------

/** The sources (not ones another Eventing object made) that send to `target`. */
function sourcesTo(target: Target, lists: PathLists): { nodes: PathNode[]; more?: number } | undefined {
  if (!lists.sources) return undefined;
  const nodes = lists.sources.flatMap(({ kind, items }) =>
    items
      .filter((s) => !ownedByEventing(s) && pointsAt(sinkOf(s), nsOf(s), target))
      .map((s) => objectNode("source", kind, s, { uri: sinkUriOf(s) })),
  );
  return cut(nodes);
}

function subscriberNodes(obj: KubeObject): PathNode[] {
  const ns = nsOf(obj);
  return [
    destinationNode("subscriber", subscriberOf(obj), ns, subscriberUriOf(obj)),
    destinationNode("reply", replyOf(obj), ns, replyUriOf(obj)),
  ].filter((n): n is PathNode => Boolean(n));
}

function triggerNode(trigger: KubeObject, current: boolean): PathNode {
  return objectNode("trigger", TRIGGER, trigger, { current, filter: triggerFilter(trigger).terms, children: subscriberNodes(trigger) });
}

/** A Broker with the Triggers of `lists` that take its events (all of them, or only `only`). */
function brokerNode(name: string, namespace: string, lists: PathLists, current?: { obj: KubeObject; trigger?: KubeObject }): PathNode {
  const obj = current && !current.trigger ? current.obj : lists.brokers?.find((b) => b.metadata?.name === name && nsOf(b) === namespace);
  const node: PathNode = obj
    ? objectNode("hub", BROKER, obj, { current: Boolean(current && !current.trigger) })
    : { role: "hub", apiVersion: apiVersionOf(BROKER), kind: BROKER.kind, name, namespace, children: [] };
  if (current?.trigger) {
    node.children = [triggerNode(current.trigger, true)];
  } else if (lists.triggers) {
    const triggers = lists.triggers.filter((t) => {
      const b = brokerOf(t);
      return b?.name === name && b.namespace === namespace;
    });
    const { nodes, more } = cut(triggers.map((t) => triggerNode(t, false)));
    node.children = nodes;
    node.more = more;
  }
  return node;
}

/** A Channel (or channel implementation) with the Subscriptions of `lists` that subscribe to it. */
function channelNode(kind: Pick<KindRef, "group" | "kind">, name: string, namespace: string, lists: PathLists, node: PathNode): PathNode {
  if (!lists.subscriptions) return node;
  const subs = lists.subscriptions.filter((s) => {
    const c = channelOf(s);
    return c?.name === name && c.namespace === namespace && sameKind(c.kind, kind);
  });
  const { nodes, more } = cut(subs.map((s) => objectNode("subscription", SUBSCRIPTION, s, { children: subscriberNodes(s) })));
  return { ...node, children: nodes, more };
}

/** Where a source sends: its sink, followed through a Broker or a Channel when the lists of its namespace are in. */
function sinkNode(source: KubeObject, lists: PathLists): PathNode | undefined {
  const dest = sinkOf(source);
  const node = destinationNode("sink", dest, nsOf(source), sinkUriOf(source));
  const ref = dest?.ref;
  if (!node || !ref?.name) return node;
  const kind = { group: groupOf(ref.apiVersion), kind: ref.kind ?? "" };
  if (sameKind(kind, BROKER)) return { ...brokerNode(ref.name, node.namespace ?? "", lists), role: "sink", uri: node.uri };
  if (CHANNEL_KINDS.some((c) => sameKind(c, kind))) return channelNode(kind, ref.name, node.namespace ?? "", lists, node);
  return node;
}

// ---------- The path ----------

function withFrom(root: PathNode, from: ReturnType<typeof sourcesTo>): EventPath {
  return from ? { root, from: from.nodes, fromMore: from.more } : { root };
}

/** The event path of `obj` (a kind of the Eventing section); `undefined` for a kind without one. */
export function eventPath(kind: KindRef, obj: KubeObject, lists: PathLists): EventPath | undefined {
  const ns = nsOf(obj);
  const name = obj.metadata?.name ?? "";
  if (sameKind(kind, BROKER)) {
    const root = brokerNode(name, ns, lists, { obj });
    return withFrom(root, sourcesTo({ kind: BROKER, name, namespace: ns, url: addressOf(obj) }, lists));
  }
  if (sameKind(kind, TRIGGER)) {
    const broker = brokerOf(obj);
    if (!broker) return { root: triggerNode(obj, true) };
    const root = brokerNode(broker.name, broker.namespace, lists, { obj, trigger: obj });
    const brokerObj = lists.brokers?.find((b) => b.metadata?.name === broker.name && nsOf(b) === broker.namespace);
    return withFrom(root, sourcesTo({ kind: BROKER, name: broker.name, namespace: broker.namespace, url: brokerObj && addressOf(brokerObj) }, lists));
  }
  if (isChannelKind(kind)) {
    const root = channelNode(kind, name, ns, lists, objectNode("hub", kind, obj, { current: true }));
    return withFrom(root, sourcesTo({ kind, name, namespace: ns, url: addressOf(obj) }, lists));
  }
  if (sameKind(kind, SUBSCRIPTION)) {
    const sub = objectNode("subscription", SUBSCRIPTION, obj, { current: true, children: subscriberNodes(obj) });
    const channel = channelOf(obj);
    if (!channel) return { root: sub };
    return { root: { role: "hub", apiVersion: channel.apiVersion, kind: channel.kind.kind, name: channel.name, namespace: channel.namespace, children: [sub] } };
  }
  if (isSourceKind(kind)) {
    const sink = sinkNode(obj, lists);
    return { root: objectNode("source", kind, obj, { current: true, children: sink ? [sink] : [] }) };
  }
  if (sameKind(kind, SEQUENCE)) {
    // Each step's reply goes to the next step; the last one's to `spec.reply`.
    const steps = stepsOf(obj).slice(0, MAX_STEPS);
    const chain = [
      ...steps.map((dest) => destinationNode("step", dest, ns) ?? { role: "step" as const, children: [] }).map((n, i) => ({ ...n, index: i + 1 })),
      ...[destinationNode("reply", replyOf(obj), ns)].filter((n): n is PathNode => Boolean(n)),
    ];
    let child: PathNode | undefined;
    for (const node of chain.reverse()) child = { ...node, children: child ? [child] : [] };
    const root = objectNode("hub", SEQUENCE, obj, { current: true, children: child ? [child] : [] });
    return { root };
  }
  if (sameKind(kind, PARALLEL)) {
    const branches = branchesOf(obj).slice(0, MAX_FANOUT).map((b, i): PathNode => {
      const subscriber = destinationNode("subscriber", b.subscriber, ns);
      const reply = destinationNode("reply", b.reply ?? replyOf(obj), ns);
      const filter = destinationNode("filter", b.filter, ns);
      const after = [subscriber && { ...subscriber, children: reply ? [reply] : [] }].filter((n): n is PathNode => Boolean(n));
      return { role: "branch", index: i + 1, children: filter ? [{ ...filter, children: after }] : after };
    });
    return { root: objectNode("hub", PARALLEL, obj, { current: true, children: branches }) };
  }
  return undefined;
}
