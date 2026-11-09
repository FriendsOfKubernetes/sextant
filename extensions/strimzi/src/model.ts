// What the extension reads from kafka.strimzi.io objects, ported unchanged from Sextant's former built-in Strimzi
// view (ADR-0100, #235): the kinds, their readiness from the Ready / NotReady / Warning conditions Strimzi sets, a
// Kafka's listeners with their addresses and node pools, topics' names, users' Secret by name (never its data), and
// the Kafka Connect connectors Strimzi copies into a KafkaConnector or a KafkaMirrorMaker2 with their auto-restarts.
// Pure functions, no DOM. The table columns and problem rules are the manifest's; `strimziProblems` and the readings
// here are what the tests compare them with.
//
// What Strimzi writes (read from strimzi-kafka-operator, `api/.../connector/KafkaConnectorStatus.java`,
// `AutoRestartStatus.java`, `mirrormaker2/KafkaMirrorMaker2Status.java` and `cluster-operator/.../assembly/
// AbstractConnectOperator.java`, `KafkaConnectAssemblyOperator.java`, `KafkaMirrorMaker2AssemblyOperator.java`):
// - a KafkaConnector's `status.connectorStatus` and each of a KafkaMirrorMaker2's `status.connectors[]` is the Kafka
//   Connect REST API's `GET /connectors/<name>/status` answer as is:
//   `{name, type, connector: {state, worker_id, trace?}, tasks: [{id, state, worker_id, trace?}]}`, the states being
//   RUNNING, PAUSED, STOPPED, FAILED, UNASSIGNED and RESTARTING;
// - the auto-restart state is `status.autoRestart` (KafkaConnector) or `status.autoRestartStatuses[]` (MirrorMaker 2):
//   `{count, connectorName, lastRestartTimestamp}`; Strimzi restarts after 0, 2, 6, 12, 20, 30, 42 and 56 minutes, then
//   hourly, until `spec.autoRestart.maxRestarts`, and drops the status once the connector has been stable long enough;
// - a KafkaConnector whose connector or any task is FAILED gets `NotReady` ("Connector has failed, …" / "The following
//   tasks have failed: …"); a KafkaMirrorMaker2 only when a connector is FAILED — its failed tasks leave it Ready.
// So a failed connector or task is read here from the REST answer, never inferred from the condition.
import type { KubeObject } from "@sextant/extension-sdk";

export type Tone = "success" | "warning" | "danger" | "muted" | "neutral";

export function get(value: unknown, ...path: (string | number)[]): unknown {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
}
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

export const STRIMZI_GROUP = "kafka.strimzi.io";

export interface KindName {
  group: string;
  kind: string;
}
const k = (kind: string): KindName => ({ group: STRIMZI_GROUP, kind });
export const KAFKA = k("Kafka");
export const KAFKA_NODE_POOL = k("KafkaNodePool");
export const KAFKA_TOPIC = k("KafkaTopic");
export const KAFKA_USER = k("KafkaUser");
export const KAFKA_CONNECT = k("KafkaConnect");
export const KAFKA_MIRROR_MAKER_2 = k("KafkaMirrorMaker2");
export const KAFKA_CONNECTOR = k("KafkaConnector");
export const SECRET: KindName = { group: "", kind: "Secret" };

/** The kinds of the section, in its order. */
export const STRIMZI_KINDS: readonly KindName[] = [
  KAFKA,
  KAFKA_NODE_POOL,
  KAFKA_TOPIC,
  KAFKA_USER,
  KAFKA_CONNECT,
  KAFKA_MIRROR_MAKER_2,
  KAFKA_CONNECTOR,
];

export const isKind = (a: KindName, b: KindName): boolean => a.group === b.group && a.kind === b.kind;

/** The kind of an object, from its `apiVersion` and `kind`. */
export function kindOf(obj: KubeObject): KindName {
  const api = obj.apiVersion ?? "";
  const slash = api.indexOf("/");
  return { group: slash < 0 ? "" : api.slice(0, slash), kind: obj.kind ?? "" };
}

/** The version of an object's `apiVersion` (Strimzi serves v1beta2 and, in new releases, v1). */
export function versionOf(obj: KubeObject): string {
  const api = obj.apiVersion ?? "";
  return api.slice(api.indexOf("/") + 1) || "v1beta2";
}

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
    .map((c) => ({ reason: str(get(c, "reason")), message: str(get(c, "message")) }));
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
export const clusterLabelOf = (obj: KubeObject): string | undefined => str(record(obj.metadata?.labels)["strimzi.io/cluster"]);

/** Replicas Strimzi reports, else those asked for. */
export const replicasOf = (obj: KubeObject): number | undefined => num(get(obj, "status", "replicas")) ?? num(get(obj, "spec", "replicas"));

/** A Kafka's version: the one running, else the one asked for. */
export const kafkaVersionOf = (obj: KubeObject): string | undefined =>
  str(get(obj, "status", "kafkaVersion")) ?? str(get(obj, "spec", "kafka", "version"));

// ---------- Topics and users ----------

export const topicNameOf = (topic: KubeObject): string | undefined =>
  str(get(topic, "status", "topicName")) ?? str(get(topic, "spec", "topicName")) ?? topic.metadata?.name;

/** The Secret Strimzi wrote for a user (`status.secret`): its name only, never its data. */
export const userSecretOf = (user: KubeObject): string | undefined => str(get(user, "status", "secret"));

// ---------- Connectors (#235) ----------

export interface TaskStatus {
  id: string;
  state?: string;
  workerId?: string;
  trace?: string;
}

export interface ConnectorStatus {
  name?: string;
  /** `source` or `sink`. */
  type?: string;
  state?: string;
  workerId?: string;
  trace?: string;
  tasks: TaskStatus[];
}

export interface AutoRestart {
  count: number;
  connectorName?: string;
  lastRestart?: string;
}

export const FAILED = "FAILED";

/** Longest trace the details render; a Java stack trace of a nested cause can run to tens of kilobytes. */
export const MAX_TRACE_CHARS = 20_000;
/** Longest first line of a trace taken as a problem message. */
export const MAX_LINE_CHARS = 300;

const text = (v: unknown): string | undefined => (typeof v === "number" ? String(v) : str(v));

/** One REST status answer; undefined when it is not an object. */
export function readConnectorStatus(raw: unknown): ConnectorStatus | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return {
    name: str(get(raw, "name")),
    type: str(get(raw, "type")),
    state: str(get(raw, "connector", "state")),
    workerId: str(get(raw, "connector", "worker_id")),
    trace: str(get(raw, "connector", "trace")),
    tasks: arr(get(raw, "tasks")).map((t, i) => ({
      id: text(get(t, "id")) ?? String(i),
      state: str(get(t, "state")),
      workerId: str(get(t, "worker_id")),
      trace: str(get(t, "trace")),
    })),
  };
}

/** A KafkaConnector's connector (`status.connectorStatus`). */
export const connectorStatusOf = (obj: KubeObject): ConnectorStatus | undefined =>
  readConnectorStatus(get(obj, "status", "connectorStatus"));

/** A KafkaMirrorMaker2's connectors (`status.connectors`). */
export const mirrorConnectorsOf = (obj: KubeObject): ConnectorStatus[] =>
  arr(get(obj, "status", "connectors"))
    .map(readConnectorStatus)
    .filter((c): c is ConnectorStatus => c !== undefined);

/** Every connector an object reports: a KafkaConnector's one and a KafkaMirrorMaker2's list. */
export const connectorsOf = (obj: KubeObject): ConnectorStatus[] => {
  const one = connectorStatusOf(obj);
  return [...(one ? [one] : []), ...mirrorConnectorsOf(obj)];
};

function readAutoRestart(raw: unknown): AutoRestart | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return {
    count: num(get(raw, "count")) ?? 0,
    connectorName: str(get(raw, "connectorName")),
    lastRestart: str(get(raw, "lastRestartTimestamp")),
  };
}

/** The auto-restart states: a KafkaConnector's `status.autoRestart`, a MirrorMaker 2's `status.autoRestartStatuses`. */
export const autoRestartsOf = (obj: KubeObject): AutoRestart[] =>
  [readAutoRestart(get(obj, "status", "autoRestart")), ...arr(get(obj, "status", "autoRestartStatuses")).map(readAutoRestart)].filter(
    (a): a is AutoRestart => a !== undefined,
  );

/** A KafkaConnector's `spec.autoRestart`: whether Strimzi restarts it and how many times at most (none: no limit). */
export function autoRestartSpecOf(obj: KubeObject): { enabled: boolean; maxRestarts?: number } {
  return {
    enabled: get(obj, "spec", "autoRestart", "enabled") === true,
    maxRestarts: num(get(obj, "spec", "autoRestart", "maxRestarts")),
  };
}

/**
 * Strimzi's wait before the next automatic restart after `count` restarts, in minutes: n² + n, at most 60
 * (`AbstractConnectOperator.nextAutoRestartBackOffIntervalInMinutes`).
 */
export const nextRestartMinutes = (count: number): number => Math.min(count * count + count, 60);

/** The default full reconciliation interval: the slack after a restart window. */
export const RECONCILIATION_MS = 120_000;

/** Restarts after which the wait stops growing; without `maxRestarts` a failure counts once these are spent. */
export const ESCALATING_RESTARTS = 7;

/**
 * Whether Strimzi's auto-restart can still act on a failed KafkaConnector, and from when its failure counts if not
 * fixed by then: `activeFrom`, the next restart window plus one reconciliation (after a restart); `graceMs`, one
 * reconciliation (no restart yet). `undefined`: no restart is coming.
 */
export function autoRestartGrace(obj: KubeObject): { activeFrom?: number; graceMs?: number } | undefined {
  if (!connectorStatusOf(obj)) return undefined;
  const spec = autoRestartSpecOf(obj);
  if (!spec.enabled) return undefined;
  const status = readAutoRestart(get(obj, "status", "autoRestart"));
  const count = status?.count ?? 0;
  if (count >= (spec.maxRestarts ?? ESCALATING_RESTARTS)) return undefined;
  const last = status?.lastRestart ? Date.parse(status.lastRestart) : Number.NaN;
  if (Number.isNaN(last)) return { graceMs: RECONCILIATION_MS };
  return { activeFrom: last + nextRestartMinutes(count) * 60_000 + RECONCILIATION_MS };
}

/** The state a KafkaConnector asks for: `spec.state`, else the deprecated `spec.pause`. */
export const desiredStateOf = (obj: KubeObject): string | undefined =>
  str(get(obj, "spec", "state")) ?? (get(obj, "spec", "pause") === true ? "paused" : undefined);

export const failedTasks = (c: ConnectorStatus): TaskStatus[] => c.tasks.filter((t) => t.state === FAILED);

export function taskCounts(c: ConnectorStatus | undefined): { running: number; failed: number; total: number } {
  const tasks = c?.tasks ?? [];
  return {
    running: tasks.filter((t) => t.state === "RUNNING").length,
    failed: tasks.filter((t) => t.state === FAILED).length,
    total: tasks.length,
  };
}

/** The first non-empty line of a trace (the exception and its message), clipped. */
export function firstLine(trace: string | undefined): string | undefined {
  const line = trace
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

export function stateTone(state: string | undefined): Tone {
  switch (state) {
    case "RUNNING":
      return "success";
    case FAILED:
      return "danger";
    case "PAUSED":
    case "STOPPED":
      return "muted";
    default:
      return "warning";
  }
}

// ---------- Problems ----------

/** A problem as the built-in view found it (Sextant's `Detected`). */
export interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  notify: boolean;
}

/** Not ready counts after this long: a reconciliation or a rolling update passes through NotReady. */
export const NOT_READY_GRACE_MS = 5 * 60_000;

/** "Only problems" of the built-in tables. */
export function isProblem(obj: KubeObject): boolean {
  return readinessOf(obj).state === "notReady" || connectorFailures(obj).length > 0;
}

/**
 * Failed connectors and tasks from the Kafka Connect REST status Strimzi copies into a KafkaConnector or a
 * KafkaMirrorMaker2: one problem per reason, the message the first line of the first failure's trace, counting at
 * once unless Strimzi's auto-restart of a KafkaConnector can still act.
 */
export function connectorFailures(obj: KubeObject): Detected[] {
  const connectors = connectorsOf(obj);
  const many = connectors.length > 1;
  const named = (name: string | undefined, line: string | undefined) => (many && name && line ? `${name}: ${line}` : line);
  const r = readinessOf(obj);
  const since = r.state === "notReady" ? r.since : undefined;
  const grace = autoRestartGrace(obj);
  const found: Detected[] = [];
  const failed = connectors.find((c) => c.state === FAILED);
  if (failed) {
    const message = named(failed.name, firstLine(failed.trace));
    found.push({ reason: "ConnectorFailed", group: "connectorFailed", message, since, notify: true, ...grace });
  }
  const task = connectors.map((c) => ({ c, t: failedTasks(c)[0] })).find((x) => x.t !== undefined);
  if (task) {
    const message = named(task.c.name, firstLine(task.t?.trace));
    found.push({ reason: "TaskFailed", group: "taskFailed", message, since, notify: true, ...grace });
  }
  return found;
}

/** The problems of a Strimzi object: failed connectors and tasks; otherwise not ready (after a grace). */
export function strimziProblems(obj: KubeObject): Detected[] {
  if (obj.metadata?.deletionTimestamp) return [];
  const failures = connectorFailures(obj);
  if (failures.length > 0) return failures;
  const r = readinessOf(obj);
  if (r.state !== "notReady") return [];
  return [{ reason: r.reason || "NotReady", group: "notReady", message: r.message, since: r.since, graceMs: NOT_READY_GRACE_MS, notify: true }];
}
