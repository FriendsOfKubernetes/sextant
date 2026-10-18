// How objects relate: pure functions over watched objects, no React. An edge always points from the object that
// names or selects to the one named or selected (a Pod → its ConfigMap, a child → its owner, a Service → its pods),
// so "what uses this" is the incoming edges and "what this uses" the outgoing ones.
//
//   references(kind, obj)       // what the object itself names (owners, volumes, env, backends, TLS Secrets, …)
//   buildGraph(inputs, options) // every object of the inputs, the objects they name (placeholders when not
//                               // watched) and the pods label selectors pick (Service, PDB, NetworkPolicy)
//   neighbours(graph, key)      // one hop both ways, grouped by relation and direction
//
// Gateway API routes are read through the Gateway API model (`routeRules`, `parentRefs`, `listeners`), so a backend
// or a parent means the same here as in the section's own views.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import { kindFromApiVersion } from "../../resources/refs";
import { GATEWAY, GATEWAY_CLASS, gatewayClassName, isRouteKind, listeners, parentRefs, routeRules } from "../gateway-api/model";
import {
  CONFIG_MAP,
  CRON_JOB,
  DAEMON_SET,
  DEPLOYMENT,
  ENDPOINT_SLICE,
  HPA,
  INGRESS,
  INGRESS_CLASS,
  isClusterScoped,
  JOB,
  knownKind,
  NETWORK_POLICY,
  NODE,
  PDB,
  POD,
  PV,
  PVC,
  REPLICA_SET,
  same,
  SECRET,
  SERVICE,
  SERVICE_ACCOUNT,
  STATEFUL_SET,
  STORAGE_CLASS,
} from "./kinds";
import { indexPods, podSelectorOf, selectPods } from "./selectors";

const { arr, get, str } = status;

/** An object, watched or only referred to. `version` is known when the reference says it. */
export interface NodeRef {
  group: string;
  kind: string;
  version?: string;
  namespace: string | null;
  name: string;
}

/** Relations in the order the "Related" view lists them. */
export const RELATIONS = [
  "owner",
  "scales",
  "routesTo",
  "parent",
  "selects",
  "endpointsFor",
  "endpoint",
  "volume",
  "env",
  "serviceAccount",
  "pullSecret",
  "tls",
  "boundTo",
  "storageClass",
  "class",
  "parameters",
  "node",
] as const;
export type Relation = (typeof RELATIONS)[number];

/** What an object names, as found in it. */
export interface Reference {
  to: NodeRef;
  relation: Relation;
  /** The reference is marked `optional: true` (a missing target does not stop the pod). */
  optional?: boolean;
  /** Named in a workload's pod template, not by a running pod. */
  template?: boolean;
  /** The edge runs the other way: `to` names this object (a PersistentVolume's `claimRef`). */
  reverse?: boolean;
  /** `owner`: the owner's uid as the reference states it (the name alone may point at a newer object). */
  uid?: string;
}

export interface Edge {
  from: string;
  to: string;
  relation: Relation;
  optional?: boolean;
  template?: boolean;
  /** `owner`: the uid the owner reference names. */
  uid?: string;
}

export interface GraphNode {
  key: string;
  ref: NodeRef;
  /** The kind it was watched as (with the served version); absent for a placeholder. */
  kind?: KindRef;
  /** The object; absent when only referred to. */
  obj?: KubeObject;
  /** Referred to, but not there although its kind is fully listed where it would be. */
  missing?: boolean;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  out: Map<string, Edge[]>;
  in: Map<string, Edge[]>;
}

/** `group/kind/namespace/name`: the version does not matter for identity. */
export function keyOf(ref: Pick<NodeRef, "group" | "kind" | "namespace" | "name">): string {
  return `${ref.group}/${ref.kind}/${ref.namespace ?? ""}/${ref.name}`;
}

export function refOfObject(kind: KindRef, obj: KubeObject): NodeRef {
  return {
    group: kind.group,
    kind: kind.kind,
    version: kind.version,
    namespace: obj.metadata?.namespace ?? null,
    name: obj.metadata?.name ?? "",
  };
}

function to(kind: KindRef, namespace: string | null, name: string): NodeRef {
  return { group: kind.group, kind: kind.kind, version: kind.version, namespace: isClusterScoped(kind) ? null : namespace, name };
}

/** A reference by group and kind only: the version is the known one, if any. */
function toGroupKind(group: string, kind: string, namespace: string | null, name: string): NodeRef {
  const known = knownKind({ group, kind });
  return known ? to(known, namespace, name) : { group, kind, namespace, name };
}

// ---------- Pod specs (pods and workload templates) ----------

const CONTAINER_LISTS = ["initContainers", "containers", "ephemeralContainers"] as const;

/** Volume types with a `secretRef` to a Secret of the pod's namespace. */
const SECRET_REF_VOLUMES = ["cephfs", "rbd", "iscsi", "flexVolume", "scaleIO", "storageos", "cinder"] as const;

/** What a pod spec names: volumes, environment sources, image pull secrets, the service account, the node. */
export function podSpecReferences(spec: unknown, namespace: string | null, template: boolean): Reference[] {
  const refs: Reference[] = [];
  const add = (kind: KindRef, name: string | undefined, relation: Relation, optional = false) => {
    if (name) refs.push({ to: to(kind, namespace, name), relation, optional, template: template || undefined });
  };
  const optional = (v: unknown) => get(v, "optional") === true;
  for (const volume of arr(get(spec, "volumes"))) {
    const cm = get(volume, "configMap");
    if (cm) add(CONFIG_MAP, str(get(cm, "name")), "volume", optional(cm));
    const secret = get(volume, "secret");
    if (secret) add(SECRET, str(get(secret, "secretName")), "volume", optional(secret));
    add(PVC, str(get(volume, "persistentVolumeClaim", "claimName")), "volume");
    // Volume plugins that read their credentials from a Secret of the pod's namespace.
    for (const plugin of SECRET_REF_VOLUMES) add(SECRET, str(get(volume, plugin, "secretRef", "name")), "volume");
    add(SECRET, str(get(volume, "csi", "nodePublishSecretRef", "name")), "volume");
    add(SECRET, str(get(volume, "azureFile", "secretName")), "volume");
    for (const source of arr(get(volume, "projected", "sources"))) {
      const pcm = get(source, "configMap");
      if (pcm) add(CONFIG_MAP, str(get(pcm, "name")), "volume", optional(pcm));
      const ps = get(source, "secret");
      if (ps) add(SECRET, str(get(ps, "name")), "volume", optional(ps));
    }
  }
  for (const list of CONTAINER_LISTS) {
    for (const container of arr(get(spec, list))) {
      for (const from of arr(get(container, "envFrom"))) {
        const cm = get(from, "configMapRef");
        if (cm) add(CONFIG_MAP, str(get(cm, "name")), "env", optional(cm));
        const secret = get(from, "secretRef");
        if (secret) add(SECRET, str(get(secret, "name")), "env", optional(secret));
      }
      for (const env of arr(get(container, "env"))) {
        const cm = get(env, "valueFrom", "configMapKeyRef");
        if (cm) add(CONFIG_MAP, str(get(cm, "name")), "env", optional(cm));
        const secret = get(env, "valueFrom", "secretKeyRef");
        if (secret) add(SECRET, str(get(secret, "name")), "env", optional(secret));
      }
    }
  }
  for (const pull of arr(get(spec, "imagePullSecrets"))) add(SECRET, str(get(pull, "name")), "pullSecret");
  add(SERVICE_ACCOUNT, str(get(spec, "serviceAccountName")) ?? str(get(spec, "serviceAccount")), "serviceAccount");
  if (!template) add(NODE, str(get(spec, "nodeName")), "node");
  return refs;
}

/** The pod template of a workload: `spec.template.spec`, a CronJob's `spec.jobTemplate.spec.template.spec`. */
function templateSpec(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): unknown {
  if (same(kind, CRON_JOB)) return get(obj, "spec", "jobTemplate", "spec", "template", "spec");
  if ([DEPLOYMENT, STATEFUL_SET, DAEMON_SET, REPLICA_SET, JOB].some((w) => same(w, kind)))
    return get(obj, "spec", "template", "spec");
  return undefined;
}

// ---------- References of one object ----------

function ownerReferences(obj: KubeObject): Reference[] {
  const namespace = obj.metadata?.namespace ?? null;
  return arr(obj.metadata?.ownerReferences).flatMap((o): Reference[] => {
    const apiVersion = str(get(o, "apiVersion"));
    const kind = str(get(o, "kind"));
    const name = str(get(o, "name"));
    if (!apiVersion || !kind || !name) return [];
    const ref = kindFromApiVersion(apiVersion, kind);
    return [{ to: to(ref, namespace, name), relation: "owner", uid: str(get(o, "uid")) }];
  });
}

function hasController(obj: KubeObject): boolean {
  return arr(obj.metadata?.ownerReferences).some((o) => get(o, "controller") === true);
}

function ingressReferences(obj: KubeObject): Reference[] {
  const ns = obj.metadata?.namespace ?? null;
  const spec = get(obj, "spec");
  const refs: Reference[] = [];
  const backend = (b: unknown) => {
    const service = str(get(b, "service", "name"));
    if (service) refs.push({ to: to(SERVICE, ns, service), relation: "routesTo" });
    const resource = get(b, "resource");
    const kind = str(get(resource, "kind"));
    const name = str(get(resource, "name"));
    if (kind && name) refs.push({ to: toGroupKind(str(get(resource, "apiGroup")) ?? "", kind, ns, name), relation: "routesTo" });
  };
  backend(get(spec, "defaultBackend"));
  for (const rule of arr(get(spec, "rules"))) for (const p of arr(get(rule, "http", "paths"))) backend(get(p, "backend"));
  for (const tls of arr(get(spec, "tls"))) {
    const secret = str(get(tls, "secretName"));
    if (secret) refs.push({ to: to(SECRET, ns, secret), relation: "tls" });
  }
  const className = str(get(spec, "ingressClassName"));
  if (className) refs.push({ to: to(INGRESS_CLASS, null, className), relation: "class" });
  return refs;
}

function gatewayReferences(obj: KubeObject): Reference[] {
  const refs: Reference[] = [];
  const className = gatewayClassName(obj);
  if (className) refs.push({ to: to(GATEWAY_CLASS, null, className), relation: "class" });
  for (const listener of listeners(obj)) {
    for (const cert of listener.certificateRefs) {
      refs.push({ to: toGroupKind(cert.group, cert.kind, cert.namespace, cert.name), relation: "tls" });
    }
  }
  // Implementation-specific settings of the Gateway's infrastructure (a ConfigMap, a custom resource).
  const params = get(obj, "spec", "infrastructure", "parametersRef");
  const paramsKind = str(get(params, "kind"));
  const paramsName = str(get(params, "name"));
  if (paramsKind && paramsName) {
    refs.push({ to: toGroupKind(str(get(params, "group")) ?? "", paramsKind, obj.metadata?.namespace ?? null, paramsName), relation: "parameters" });
  }
  return refs;
}

function routeReferences(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Reference[] {
  const refs: Reference[] = [];
  for (const rule of routeRules(obj, kind)) {
    for (const b of [...rule.backends, ...rule.mirrors]) {
      refs.push({ to: toGroupKind(b.group, b.kind, b.namespace, b.name), relation: "routesTo" });
    }
  }
  for (const p of parentRefs(obj)) refs.push({ to: toGroupKind(p.group, p.kind, p.namespace, p.name), relation: "parent" });
  return refs;
}

const SERVICE_NAME_LABEL = "kubernetes.io/service-name";

function endpointSliceReferences(obj: KubeObject, owners: readonly Reference[]): Reference[] {
  const ns = obj.metadata?.namespace ?? null;
  const refs: Reference[] = [];
  const service = status.labelsOf(obj)[SERVICE_NAME_LABEL];
  // The Service usually owns the slice too: the owner edge already says it.
  const owned = owners.some((o) => same(o.to, SERVICE) && o.to.name === service);
  if (service && !owned) refs.push({ to: to(SERVICE, ns, service), relation: "endpointsFor" });
  for (const endpoint of arr(get(obj, "endpoints"))) {
    const target = get(endpoint, "targetRef");
    const name = str(get(target, "name"));
    if (str(get(target, "kind")) === "Pod" && name) {
      refs.push({ to: to(POD, str(get(target, "namespace")) ?? ns, name), relation: "endpoint" });
    }
  }
  return refs;
}

const STORAGE_CLASS_ANNOTATION = "volume.beta.kubernetes.io/storage-class";

function storageClassOf(obj: KubeObject): string | undefined {
  return str(get(obj, "spec", "storageClassName")) ?? str(get(obj, "metadata", "annotations", STORAGE_CLASS_ANNOTATION));
}

/** What `obj` (of `kind`) names itself. Selector matches are not here: they need the pods (`buildGraph`). */
export function references(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Reference[] {
  const ns = obj.metadata?.namespace ?? null;
  const owners = ownerReferences(obj);
  const refs: Reference[] = [...owners];
  if (same(kind, POD)) refs.push(...podSpecReferences(get(obj, "spec"), ns, false));
  else {
    const template = templateSpec(kind, obj);
    // Only a workload nobody controls: a Deployment's ReplicaSets and a CronJob's Jobs repeat their owner's template.
    if (template && !hasController(obj)) refs.push(...podSpecReferences(template, ns, true));
  }
  if (same(kind, INGRESS)) refs.push(...ingressReferences(obj));
  else if (same(kind, GATEWAY)) refs.push(...gatewayReferences(obj));
  else if (isRouteKind(kind)) refs.push(...routeReferences(kind, obj));
  else if (same(kind, ENDPOINT_SLICE)) refs.push(...endpointSliceReferences(obj, owners));
  else if (same(kind, HPA)) {
    const target = get(obj, "spec", "scaleTargetRef");
    const targetKind = str(get(target, "kind"));
    const name = str(get(target, "name"));
    if (targetKind && name) {
      const apiVersion = str(get(target, "apiVersion"));
      const ref = apiVersion ? kindFromApiVersion(apiVersion, targetKind) : (knownKind({ group: "apps", kind: targetKind }) ?? kindFromApiVersion("apps/v1", targetKind));
      refs.push({ to: to(ref, ns, name), relation: "scales" });
    }
  } else if (same(kind, PVC)) {
    const volume = str(get(obj, "spec", "volumeName"));
    if (volume) refs.push({ to: to(PV, null, volume), relation: "boundTo" });
    const sc = storageClassOf(obj);
    if (sc) refs.push({ to: to(STORAGE_CLASS, null, sc), relation: "storageClass" });
  } else if (same(kind, PV)) {
    const claim = get(obj, "spec", "claimRef");
    const claimName = str(get(claim, "name"));
    if (claimName) refs.push({ to: to(PVC, str(get(claim, "namespace")) ?? null, claimName), relation: "boundTo", reverse: true });
    const sc = storageClassOf(obj);
    if (sc) refs.push({ to: to(STORAGE_CLASS, null, sc), relation: "storageClass" });
  } else if (same(kind, SERVICE_ACCOUNT)) {
    for (const pull of arr(get(obj, "imagePullSecrets"))) {
      const name = str(get(pull, "name"));
      if (name) refs.push({ to: to(SECRET, ns, name), relation: "pullSecret" });
    }
  }
  return refs;
}

// ---------- The graph ----------

export interface GraphInput {
  /** The kind the objects were watched as. */
  kind: KindRef;
  items: Iterable<KubeObject>;
}

export interface GraphOptions {
  /**
   * Whether every object of this kind in this namespace is listed (a ready watch): a reference to one that is not
   * there is then `missing`, not merely unwatched.
   */
  complete?: (ref: Pick<NodeRef, "group" | "kind" | "namespace">) => boolean;
}

/** References per object: watch updates keep unchanged objects, so they are read once. */
const cache = new WeakMap<KubeObject, { kind: string; refs: Reference[] }>();

function cachedReferences(kind: KindRef, obj: KubeObject): Reference[] {
  const id = `${kind.group}/${kind.kind}`;
  const hit = cache.get(obj);
  if (hit && hit.kind === id) return hit.refs;
  const refs = references(kind, obj);
  cache.set(obj, { kind: id, refs });
  return refs;
}

/** Kinds whose label selector picks pods, with the relation it draws. */
const SELECTING: readonly KindRef[] = [SERVICE, PDB, NETWORK_POLICY];

export function buildGraph(inputs: readonly GraphInput[], options: GraphOptions = {}): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, Edge>();
  const objects: { kind: KindRef; obj: KubeObject; key: string }[] = [];
  for (const { kind, items } of inputs) {
    for (const obj of items) {
      const ref = refOfObject(kind, obj);
      const key = keyOf(ref);
      // The first input wins: the opened object comes before the lists that may hold it too.
      if (nodes.has(key)) continue;
      nodes.set(key, { key, ref, kind, obj });
      objects.push({ kind, obj, key });
    }
  }
  const nodeFor = (ref: NodeRef): string => {
    const key = keyOf(ref);
    if (!nodes.has(key)) nodes.set(key, { key, ref });
    return key;
  };
  const addEdge = (from: string, toKey: string, relation: Relation, optional?: boolean, template?: boolean, uid?: string) => {
    if (from === toKey) return;
    const id = `${from}|${toKey}|${relation}`;
    const existing = edges.get(id);
    if (existing) {
      // Required wins over optional, a running pod's reference over a template's.
      existing.optional = existing.optional && optional ? true : undefined;
      existing.template = existing.template && template ? true : undefined;
      return;
    }
    edges.set(id, { from, to: toKey, relation, optional: optional || undefined, template: template || undefined, ...(uid ? { uid } : {}) });
  };

  for (const { kind, obj, key } of objects) {
    for (const r of cachedReferences(kind, obj)) {
      const other = nodeFor(r.to);
      if (r.reverse) addEdge(other, key, r.relation, r.optional, r.template);
      else addEdge(key, other, r.relation, r.optional, r.template, r.uid);
    }
  }

  const pods = objects.filter((o) => same(o.kind, POD));
  if (pods.length > 0) {
    const podKey = new Map(pods.map((p) => [p.obj, p.key]));
    const index = indexPods(pods.map((p) => p.obj));
    for (const { kind, obj, key } of objects) {
      if (!SELECTING.some((s) => same(s, kind))) continue;
      const selector = podSelectorOf(kind, obj);
      if (!selector) continue;
      for (const pod of selectPods(index, obj.metadata?.namespace ?? "", selector)) {
        addEdge(key, podKey.get(pod)!, "selects");
      }
    }
  }

  const out = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const edge of edges.values()) {
    (out.get(edge.from) ?? out.set(edge.from, []).get(edge.from)!).push(edge);
    (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to)!).push(edge);
  }
  if (options.complete) {
    for (const node of nodes.values()) {
      if (!node.obj && options.complete(node.ref)) node.missing = true;
    }
  }
  return { nodes, out, in: incoming };
}

export type Direction = "out" | "in";

export interface NeighbourGroup {
  relation: Relation;
  direction: Direction;
  /** The other end of each edge, by kind and name. */
  items: { edge: Edge; node: GraphNode }[];
}

const byKindAndName = (a: GraphNode, b: GraphNode) =>
  a.ref.kind.localeCompare(b.ref.kind) ||
  (a.ref.namespace ?? "").localeCompare(b.ref.namespace ?? "") ||
  a.ref.name.localeCompare(b.ref.name, undefined, { numeric: true });

/** One hop both ways from `key`, grouped by relation (in `RELATIONS` order) and direction (out first). */
export function neighbours(graph: Graph, key: string): NeighbourGroup[] {
  const groups = new Map<string, NeighbourGroup>();
  const put = (edge: Edge, direction: Direction) => {
    const other = graph.nodes.get(direction === "out" ? edge.to : edge.from);
    if (!other) return;
    const id = `${edge.relation}|${direction}`;
    const group = groups.get(id) ?? groups.set(id, { relation: edge.relation, direction, items: [] }).get(id)!;
    group.items.push({ edge, node: other });
  };
  for (const edge of graph.out.get(key) ?? []) put(edge, "out");
  for (const edge of graph.in.get(key) ?? []) put(edge, "in");
  const order = (g: NeighbourGroup) => RELATIONS.indexOf(g.relation) * 2 + (g.direction === "out" ? 0 : 1);
  return [...groups.values()]
    .sort((a, b) => order(a) - order(b))
    .map((g) => ({ ...g, items: g.items.sort((a, b) => byKindAndName(a.node, b.node)) }));
}
