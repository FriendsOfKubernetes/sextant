// What the Strimzi section reads from kafka.strimzi.io objects: the kinds it knows, their readiness from the Ready /
// NotReady / Warning conditions Strimzi sets, a Kafka's listeners with their addresses and node pools, topics'
// partitions and replicas, users' authentication and their Secret's name (never its data). Pure functions, no React.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";
import { connectorsOf, failedTasks, FAILED, firstLine } from "./connectors";

const { arr, get, num, str } = status;

export const STRIMZI_GROUP = "kafka.strimzi.io";
// v1beta2 is what Strimzi has served for years; discovery gives the version the cluster serves (v1 in new releases).
const k = (kind: string): KindRef => ({
  group: STRIMZI_GROUP,
  version: "v1beta2",
  kind,
});

export const KAFKA = k("Kafka");
export const KAFKA_NODE_POOL = k("KafkaNodePool");
export const KAFKA_TOPIC = k("KafkaTopic");
export const KAFKA_USER = k("KafkaUser");
export const KAFKA_CONNECT = k("KafkaConnect");
export const KAFKA_MIRROR_MAKER_2 = k("KafkaMirrorMaker2");
export const KAFKA_CONNECTOR = k("KafkaConnector");

export interface StrimziKind {
  kind: KindRef;
  order: number;
  /** Key under `strimzi:sidebar`. */
  label: string;
}

export const STRIMZI_KINDS: StrimziKind[] = [
  { kind: KAFKA, order: 10, label: "kafkas" },
  { kind: KAFKA_NODE_POOL, order: 11, label: "nodePools" },
  { kind: KAFKA_TOPIC, order: 20, label: "topics" },
  { kind: KAFKA_USER, order: 21, label: "users" },
  { kind: KAFKA_CONNECT, order: 30, label: "connects" },
  { kind: KAFKA_MIRROR_MAKER_2, order: 31, label: "mirrorMakers" },
  { kind: KAFKA_CONNECTOR, order: 32, label: "connectors" },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

export const strimziKind = (kind: Pick<KindRef, "group" | "kind">): StrimziKind | undefined =>
  STRIMZI_KINDS.find((d) => isKind(kind, d.kind));

// ---------- Readiness ----------

export type StrimziState = "ready" | "notReady" | "pending";

export interface Readiness {
  state: StrimziState;
  reason?: string;
  message?: string;
  since?: string;
}

export interface Warning {
  reason?: string;
  message?: string;
}

/**
 * Strimzi's readiness: a `Ready` condition with status True is ready; a `NotReady` condition with status True (or
 * `Ready` False) is not ready, with its reason; without either (not reconciled yet) pending.
 */
export function readinessOf(obj: KubeObject): Readiness {
  const conditions = arr(get(obj, "status", "conditions"));
  const of = (type: string) => conditions.find((c) => get(c, "type") === type);
  const ready = of("Ready");
  const notReady = of("NotReady");
  const read = (c: unknown, state: StrimziState): Readiness => ({
    state,
    reason: str(get(c, "reason")),
    message: str(get(c, "message")),
    since: str(get(c, "lastTransitionTime")),
  });
  if (notReady && str(get(notReady, "status")) === "True") return read(notReady, "notReady");
  if (ready && str(get(ready, "status")) === "True") return read(ready, "ready");
  if (ready && str(get(ready, "status")) === "False") return read(ready, "notReady");
  return { state: "pending" };
}

/** `Warning` conditions (deprecated fields, unsupported settings): shown, never a problem. */
export function warningsOf(obj: KubeObject): Warning[] {
  return arr(get(obj, "status", "conditions"))
    .filter((c) => get(c, "type") === "Warning" && str(get(c, "status")) !== "False")
    .map((c) => ({
      reason: str(get(c, "reason")),
      message: str(get(c, "message")),
    }));
}

export const STATE_TONE: Record<StrimziState, Tone> = {
  ready: "success",
  notReady: "danger",
  pending: "warning",
};

// ---------- Kafka ----------

export interface Listener {
  name: string;
  type?: string;
  port?: number;
  tls?: boolean;
  bootstrapServers?: string;
  addresses: string[];
}

/** The listeners of a Kafka: as declared (`spec.kafka.listeners`) with the addresses Strimzi reports for each. */
export function listenersOf(kafka: KubeObject): Listener[] {
  const reported = arr(get(kafka, "status", "listeners"));
  const declared = arr(get(kafka, "spec", "kafka", "listeners"));
  const names = new Set<string>([
    ...declared.map((l) => str(get(l, "name")) ?? ""),
    ...reported.map((l) => str(get(l, "name")) ?? str(get(l, "type")) ?? ""),
  ]);
  names.delete("");
  return [...names].map((name) => {
    const spec = declared.find((l) => get(l, "name") === name);
    const st = reported.find((l) => (str(get(l, "name")) ?? str(get(l, "type"))) === name);
    return {
      name,
      type: str(get(spec, "type")),
      port: num(get(spec, "port")),
      tls: get(spec, "tls") === true ? true : get(spec, "tls") === false ? false : undefined,
      bootstrapServers: str(get(st, "bootstrapServers")),
      addresses: arr(get(st, "addresses")).map((a) => {
        const host = str(get(a, "host")) ?? "";
        const port = num(get(a, "port"));
        return port === undefined ? host : `${host}:${port}`;
      }),
    };
  });
}

/** The node pools a Kafka uses (`status.kafkaNodePools`). */
export const nodePoolsOf = (kafka: KubeObject): string[] =>
  arr(get(kafka, "status", "kafkaNodePools"))
    .map((p) => str(get(p, "name")))
    .filter((n): n is string => !!n);

/** The Kafka cluster an object belongs to: the `strimzi.io/cluster` label. */
export const clusterLabelOf = (obj: KubeObject): string | undefined => status.labelsOf(obj)["strimzi.io/cluster"];

// ---------- Topics and users ----------

export const topicNameOf = (topic: KubeObject): string | undefined =>
  str(get(topic, "status", "topicName")) ?? str(get(topic, "spec", "topicName")) ?? topic.metadata?.name;

/** The Secret Strimzi wrote for a user (`status.secret`): its name only, never its data. */
export const userSecretOf = (user: KubeObject): string | undefined => str(get(user, "status", "secret"));

// ---------- Problems ----------

/** Not ready counts after this long: a reconciliation or a rolling update passes through NotReady. */
export const NOT_READY_GRACE_MS = 5 * 60_000;

export function isProblem(obj: KubeObject): boolean {
  return readinessOf(obj).state === "notReady" || connectorFailures(obj).length > 0;
}

/**
 * Failed connectors and tasks (#235) from the Kafka Connect REST status Strimzi copies into a KafkaConnector or a
 * KafkaMirrorMaker2: one problem per reason, the message the first line of the first failure's trace. They count at
 * once (a FAILED state is final until a restart; Strimzi's own auto-restart shows in the details).
 */
export function connectorFailures(obj: KubeObject): Detected[] {
  const connectors = connectorsOf(obj);
  const many = connectors.length > 1;
  const named = (name: string | undefined, line: string | undefined) => (many && name && line ? `${name}: ${line}` : line);
  const r = readinessOf(obj);
  const since = r.state === "notReady" ? r.since : undefined;
  const found: Detected[] = [];
  const failed = connectors.find((c) => c.state === FAILED);
  if (failed) {
    const message = named(failed.name, firstLine(failed.trace));
    found.push({ reason: "ConnectorFailed", group: "connectorFailed", message, since, notify: true });
  }
  const task = connectors.map((c) => ({ c, t: failedTasks(c)[0] })).find((x) => x.t !== undefined);
  if (task) {
    const message = named(task.c.name, firstLine(task.t?.trace));
    found.push({ reason: "TaskFailed", group: "taskFailed", message, since, notify: true });
  }
  return found;
}

/**
 * The problems of a Strimzi object: failed connectors and tasks; otherwise not ready (after a grace). Warnings are not
 * problems.
 */
export function strimziProblems(obj: KubeObject): Detected[] {
  if (obj.metadata?.deletionTimestamp) return [];
  // Strimzi's NotReady of a failed connector or task only says "see connectorStatus": the failures say more.
  const failures = connectorFailures(obj);
  if (failures.length > 0) return failures;
  const r = readinessOf(obj);
  if (r.state !== "notReady") return [];
  return [
    {
      reason: r.reason || "NotReady",
      group: "notReady",
      message: r.message,
      since: r.since,
      graceMs: NOT_READY_GRACE_MS,
      notify: true,
    },
  ];
}
