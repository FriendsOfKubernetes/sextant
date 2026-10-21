// Kafka Connect connectors as Strimzi reports them (#235). Pure functions, no React.
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
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, str } = status;

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
  [
    readAutoRestart(get(obj, "status", "autoRestart")),
    ...arr(get(obj, "status", "autoRestartStatuses")).map(readAutoRestart),
  ].filter((a): a is AutoRestart => a !== undefined);

/** A KafkaConnector's `spec.autoRestart`: whether Strimzi restarts it and how many times at most (none: no limit). */
export function autoRestartSpecOf(obj: KubeObject): {
  enabled: boolean;
  maxRestarts?: number;
} {
  return {
    enabled: get(obj, "spec", "autoRestart", "enabled") === true,
    maxRestarts: num(get(obj, "spec", "autoRestart", "maxRestarts")),
  };
}

/**
 * Strimzi's wait before the next automatic restart after `count` restarts, in minutes: n² + n, at most 60
 * (`AbstractConnectOperator.nextAutoRestartBackOffIntervalInMinutes`: restarts after 0, 2, 6, 12, 20, 30, 42 and 56
 * minutes, then hourly). `shouldAutoRestart` restarts when that many minutes passed since `lastRestartTimestamp`.
 */
export const nextRestartMinutes = (count: number): number => Math.min(count * count + count, 60);

/**
 * A due restart happens at the operator's next reconciliation of the connector: the default full reconciliation
 * interval (`STRIMZI_FULL_RECONCILIATION_INTERVAL_MS`, 120 s) is the slack after a restart window.
 */
export const RECONCILIATION_MS = 120_000;

/**
 * Restarts after which the wait stops growing (every 60 minutes from then on). Without `maxRestarts` Strimzi never
 * stops restarting, so a failure counts once these are spent (about three hours): longer would never tell.
 */
export const ESCALATING_RESTARTS = 7;

/**
 * Whether Strimzi's auto-restart can still act on a failed KafkaConnector, and from when its failure counts if not
 * fixed by then: `activeFrom`, the next restart window plus one reconciliation (after a restart); `graceMs`, one
 * reconciliation (no restart yet: Strimzi restarts at once). `undefined`: no restart is coming — auto-restart is off,
 * `maxRestarts` is reached (`count < maxRestarts` in `shouldAutoRestart`), or the object is a KafkaMirrorMaker2, whose
 * auto-restart is set per mirror connector and not matched here.
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

export function taskCounts(c: ConnectorStatus | undefined): {
  running: number;
  failed: number;
  total: number;
} {
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
