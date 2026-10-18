// "What breaks if I delete it", in plain words: one line per consequence, counted from the graph's edges. Each line is
// an i18n key (`resourcemap:impact.<id>`, plural by `count`) with the values it names; nothing is glued from pieces.
// References marked `optional` do not count: a pod starts without an optional ConfigMap.
import { status } from "../../resources";
import {
  CONFIG_MAP,
  DAEMON_SET,
  DEPLOYMENT,
  JOB,
  NETWORK_POLICY,
  PDB,
  POD,
  PVC,
  REPLICA_SET,
  same,
  SECRET,
  SERVICE,
  SERVICE_ACCOUNT,
  STATEFUL_SET,
} from "./kinds";
import type { Edge, Graph, GraphNode, Relation } from "./relations";

const { arr, get, num } = status;

export type ImpactId =
  | "cascade"
  | "recreated"
  | "mountedBy"
  | "claimInUse"
  | "envFrom"
  | "templates"
  | "pullSecret"
  | "serviceAccount"
  | "routes"
  | "tls"
  | "parent"
  | "node"
  | "boundClaims"
  | "storageClass"
  | "scaledBy"
  | "class"
  | "trafficStops"
  | "budgetLost"
  | "policyLost";

export interface ImpactLine {
  id: ImpactId;
  count: number;
  /** The objects concerned (keys), for tests and tooltips. */
  keys: string[];
  /** `cascade`: the kinds that go with it (the view joins them with the language's list format). */
  kinds?: string[];
  /** `recreated`: the owner that creates it again. */
  owner?: { kind: string; name: string };
}

const isPod = (n: GraphNode | undefined) => n !== undefined && same(n.ref, POD);

const uidOf = (node: GraphNode | undefined) => node?.obj?.metadata?.uid;

/** The owner reference names this very owner object: same uid (a name alone may be an older, deleted owner). */
function ownsByUid(graph: Graph, edge: Edge): boolean {
  const uid = uidOf(graph.nodes.get(edge.to));
  return edge.relation === "owner" && uid !== undefined && edge.uid === uid;
}

/**
 * Whether the garbage collector deletes `key` once `gone` are deleted: every owner it names is gone — in `gone`, or
 * a listed object with another uid (the owner it named no longer exists). An owner that is not watched may exist
 * and keep it, so it counts as staying.
 */
function orphaned(graph: Graph, key: string, gone: ReadonlySet<string>): boolean {
  return (graph.out.get(key) ?? [])
    .filter((e) => e.relation === "owner")
    .every((e) => {
      if (gone.has(e.to) && ownsByUid(graph, e)) return true;
      const owner = graph.nodes.get(e.to);
      return owner?.obj !== undefined && uidOf(owner) !== undefined && e.uid !== uidOf(owner);
    });
}

/**
 * Every object deleted with `key` through owner references (children, their children, …): only references naming
 * it by uid, and only dependents with no other owner left — Kubernetes keeps a dependent while any owner exists.
 */
export function descendants(graph: Graph, key: string): string[] {
  const gone = new Set<string>([key]);
  const queue = [key];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.in.get(current) ?? []) {
      if (gone.has(edge.from) || !ownsByUid(graph, edge) || !orphaned(graph, edge.from, gone)) continue;
      gone.add(edge.from);
      queue.push(edge.from);
    }
  }
  gone.delete(key);
  return [...gone];
}

const conditionTrue = (node: GraphNode, type: string) =>
  arr(get(node.obj, "status", "conditions")).some((c) => get(c, "type") === type && get(c, "status") === "True");

/**
 * Whether `owner` creates `self` again after it is deleted: a ReplicaSet, StatefulSet or DaemonSet its pods; a Job
 * its pods while it has not finished; a Deployment only its current ReplicaSet (the one with replicas — old ones are
 * history). A CronJob never recreates a deleted Job: its next run is a new Job.
 */
function recreates(owner: GraphNode, self: GraphNode): boolean {
  if (!owner.obj) return false;
  if ([REPLICA_SET, STATEFUL_SET, DAEMON_SET].some((k) => same(k, owner.ref))) return true;
  if (same(owner.ref, JOB)) return !conditionTrue(owner, "Complete") && !conditionTrue(owner, "Failed");
  if (same(owner.ref, DEPLOYMENT)) return (num(get(self.obj, "spec", "replicas")) ?? 0) > 0;
  return false;
}

export function deletionImpact(graph: Graph, key: string): ImpactLine[] {
  const self = graph.nodes.get(key);
  if (!self) return [];
  const incoming = graph.in.get(key) ?? [];
  const outgoing = graph.out.get(key) ?? [];
  const lines: ImpactLine[] = [];
  const line = (id: ImpactId, keys: Iterable<string>, extra: Pick<ImpactLine, "kinds" | "owner"> = {}) => {
    const unique = [...new Set(keys)];
    if (unique.length > 0) lines.push({ id, count: unique.length, keys: unique, ...extra });
  };
  const from = (relation: Relation, filter: (e: Edge) => boolean = () => true) =>
    incoming.filter((e) => e.relation === relation && filter(e)).map((e) => e.from);
  const required = (e: Edge) => !e.optional;
  const byPod = (e: Edge) => !e.template && isPod(graph.nodes.get(e.from));

  const children = descendants(graph, key);
  if (children.length > 0) {
    const kinds = [...new Set(children.map((k) => graph.nodes.get(k)?.ref.kind ?? ""))].filter(Boolean).sort();
    line("cascade", children, { kinds });
  }
  for (const edge of outgoing) {
    if (!ownsByUid(graph, edge)) continue;
    const owner = graph.nodes.get(edge.to);
    if (owner && recreates(owner, self)) {
      line("recreated", [owner.key], { owner: { kind: owner.ref.kind, name: owner.ref.name } });
      break;
    }
  }

  const mounted = from("volume", (e) => required(e) && byPod(e));
  line(same(self.ref, PVC) ? "claimInUse" : "mountedBy", mounted);
  line("envFrom", from("env", (e) => required(e) && byPod(e)));
  if ([CONFIG_MAP, SECRET, PVC, SERVICE_ACCOUNT].some((k) => same(k, self.ref))) {
    const templates = incoming.filter(
      (e) => e.template && !e.optional && ["volume", "env", "pullSecret", "serviceAccount"].includes(e.relation),
    );
    line("templates", templates.map((e) => e.from));
  }
  line("pullSecret", from("pullSecret", byPod));
  line("serviceAccount", from("serviceAccount", byPod));
  line("routes", from("routesTo"));
  line("tls", from("tls"));
  line("parent", from("parent"));
  line("node", from("node"));
  line("boundClaims", from("boundTo"));
  line("storageClass", from("storageClass"));
  line("scaledBy", from("scales"));
  line("class", from("class"));

  const selected = outgoing.filter((e) => e.relation === "selects").map((e) => e.to);
  if (same(self.ref, SERVICE)) line("trafficStops", selected);
  else if (same(self.ref, PDB)) line("budgetLost", selected);
  else if (same(self.ref, NETWORK_POLICY)) line("policyLost", selected);
  return lines;
}
