// The manifest's declarative parts against the model they replace — the reading of Sextant's former built-in Strimzi
// view, ported unchanged into ./model.ts. The problem rules, "Only problems" and columns are judged by Sextant's own
// window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run time so the type check stays inside the
// extension), on the built-in view's fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import kafkaJson from "../fixtures/kafka.json";
import connectorJson from "../fixtures/kafkaconnector.json";
import mirrorJson from "../fixtures/kafkamirrormaker2.json";
import topicJson from "../fixtures/kafkatopic.json";
import userJson from "../fixtures/kafkauser.json";
import en from "./locales/en.json";
import {
  autoRestartGrace,
  clusterLabelOf,
  connectorStatusOf,
  ESCALATING_RESTARTS,
  firstLine,
  isProblem,
  kindOf,
  listenersOf,
  nextRestartMinutes,
  readinessOf,
  RECONCILIATION_MS,
  STATE_TONE,
  stateTone,
  strimziProblems,
  taskCounts,
  type Detected,
} from "./model";

const kafka = kafkaJson as unknown as KubeObject;
const topic = topicJson as unknown as KubeObject;
const user = userJson as unknown as KubeObject;
const connector = connectorJson as unknown as KubeObject;
const mirror = mirrorJson as unknown as KubeObject;

const copy = <T>(value: T): T => structuredClone(value);
type Json = Record<string, unknown>;
const status = (obj: KubeObject) => obj.status as Json;
const spec = (obj: KubeObject) => obj.spec as Json;

const nodePool: KubeObject = {
  apiVersion: "kafka.strimzi.io/v1beta2",
  kind: "KafkaNodePool",
  metadata: { name: "broker", namespace: "kafka", uid: "pool-broker", labels: { "strimzi.io/cluster": "my-cluster" } },
  spec: { replicas: 3, roles: ["broker", "controller"], storage: { type: "jbod" } },
  status: { replicas: 3, nodeIds: [0, 1, 2], roles: ["broker"] },
};
const connect: KubeObject = {
  apiVersion: "kafka.strimzi.io/v1beta2",
  kind: "KafkaConnect",
  metadata: { name: "my-connect-cluster", namespace: "kafka", uid: "connect-1" },
  spec: { replicas: 2, bootstrapServers: "my-cluster-kafka-bootstrap:9093" },
  status: {
    replicas: 1,
    conditions: [{ type: "NotReady", status: "True", reason: "TimeoutException", message: "Exceeded timeout", lastTransitionTime: "2026-10-10T08:00:00Z" }],
  },
};

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface RuleDetected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  until?: number;
  notify: boolean;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): RuleDetected[];
}
interface WindowColumn {
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
interface Format {
  formatList(items: readonly string[]): string;
}
let engine: Engine;
let columns: Columns;
let format: Format;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  format = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/format.ts"))) as Format;
});

const NOW = Date.parse("2026-10-10T09:00:00Z");
const holdsNow = (condition: unknown, obj: KubeObject, now = NOW) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && (v.activeFrom === undefined || v.activeFrom <= now) && (v.until === undefined || v.until > now);
};

const c = manifest.contributes;
const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

/** What the manifest's rules find in an object of its kind. */
function ruleProblems(obj: KubeObject): RuleDetected[] {
  return c.problems
    .filter((r) => sameKind(r.kind, kindOf(obj)))
    .flatMap((r) => engine.detectRule({ notify: true, toldThroughOwner: false, graceMinutes: 0, ...r }, obj));
}

const GROUPS: Record<string, string> = { notReady: "not-ready", connectorFailed: "connector-failed", taskFailed: "task-failed" };

/** The built-in problems as the rules must give them: the message the first line of a failure's trace. */
const builtIn = (obj: KubeObject) =>
  strimziProblems(obj).map((d: Detected) => ({
    reason: d.reason,
    group: GROUPS[d.group],
    message: d.message,
    since: d.since,
    graceMs: d.graceMs,
    activeFrom: d.activeFrom,
  }));
/** The rules' problems, a failure's message cut to its first line (the rules show the whole trace). */
const fromRules = (obj: KubeObject) =>
  ruleProblems(obj).map((d) => {
    expect(d.until).toBeUndefined();
    expect(d.notify).toBe(true);
    const failure = d.group !== "not-ready";
    return {
      reason: d.reason,
      group: d.group,
      message: failure ? firstLine(d.message) : d.message,
      since: d.since,
      graceMs: d.graceMs,
      activeFrom: d.activeFrom,
    };
  });

const notReady = (obj: KubeObject, reason = "TimeoutException", message = "Exceeded timeout") => {
  const o = copy(obj);
  status(o).conditions = [{ type: "NotReady", status: "True", reason, message, lastTransitionTime: "2026-10-10T08:30:00Z" }];
  return o;
};

/** Every object the tests judge, by name: the fixtures and their variants. */
function variants(): [string, KubeObject][] {
  const deleting = notReady(kafka);
  deleting.metadata.deletionTimestamp = "2026-10-10T08:40:00Z";
  const pending = copy(kafka);
  delete status(pending).conditions;
  const failedConnector = copy(connector);
  status(failedConnector).connectorStatus = {
    name: "my-source-connector",
    connector: { state: "FAILED", worker_id: "w", trace: 'org.apache.kafka.common.config.ConfigException: Missing required configuration "file"\n\tat x' },
    tasks: [],
  };
  const healthy = copy(connector);
  status(healthy).connectorStatus = { name: "c", connector: { state: "RUNNING" }, tasks: [{ id: 0, state: "RUNNING" }] };
  status(healthy).conditions = [{ type: "Ready", status: "True" }];
  const connectorNotReady = notReady(healthy, "ConnectRestException", "Connect cluster unreachable");
  const mirrorFailed = copy(mirror);
  const mc = status(mirrorFailed).connectors as Json[];
  mc[0] = { ...mc[0], connector: { state: "FAILED", trace: "java.lang.IllegalStateException: boom\n\tat y" } };
  status(mirrorFailed).conditions = [{ type: "NotReady", status: "True", reason: "Throwable", message: "Connector failed", lastTransitionTime: "2026-10-10T08:20:00Z" }];
  const mirrorSingle = copy(mirrorFailed);
  status(mirrorSingle).connectors = [mc[0]];
  const mirrorSixth = copy(mirror);
  status(mirrorSixth).connectors = [0, 1, 2, 3, 4, 5].map((i) => ({
    name: `c${i}`,
    connector: { state: i === 5 ? "FAILED" : "RUNNING", trace: i === 5 ? "E: sixth" : undefined },
    tasks: [{ id: 0, state: i === 4 ? "FAILED" : "RUNNING", trace: "T: fifth" }],
  }));
  const mirrorReady = copy(mirror);
  ((status(mirrorReady).connectors as Json[])[1]!.tasks as Json[])[0]!.state = "RUNNING";
  return [
    ["kafka", kafka],
    ["kafka not ready", notReady(kafka)],
    ["kafka deleting", deleting],
    ["kafka pending", pending],
    ["node pool", nodePool],
    ["node pool not ready", notReady(nodePool)],
    ["topic", topic],
    ["user", user],
    ["connect", connect],
    ["connector with a failed task, restarts exhausted", connector],
    ["failed connector", failedConnector],
    ["healthy connector", healthy],
    ["connector not ready", connectorNotReady],
    ["mirror maker with a failed task", mirror],
    ["mirror maker with a failed connector", mirrorFailed],
    ["mirror maker with one failed connector", mirrorSingle],
    ["mirror maker with a sixth connector failed", mirrorSixth],
    ["mirror maker ready", mirrorReady],
  ];
}

describe("the problem rules", () => {
  it.each(variants())("find what the built-in view found: %s", (_, obj) => {
    expect(fromRules(obj)).toEqual(builtIn(obj));
  });

  it("say what the built-in view said of the fixtures", () => {
    expect(fromRules(topic)).toEqual([
      expect.objectContaining({ reason: "KafkaError", group: "not-ready", graceMs: 5 * 60_000, since: "2026-10-10T08:00:00Z" }),
    ]);
    expect(fromRules(connector)).toEqual([
      expect.objectContaining({ reason: "TaskFailed", message: "org.apache.kafka.connect.errors.ConnectException: java.nio.file.NoSuchFileException: /opt/kafka/LICENSE" }),
    ]);
    expect(fromRules(mirror)).toEqual([
      expect.objectContaining({
        reason: "TaskFailed",
        message: "cluster-a->cluster-b.MirrorSourceConnector: org.apache.kafka.common.errors.TopicAuthorizationException: Not authorized to access topics: [orders]",
        since: undefined,
      }),
    ]);
    // A not-ready condition without a reason: the rule's title, where the built-in view said "NotReady".
    const noReason = copy(topic);
    status(noReason).conditions = [{ type: "Ready", status: "False", lastTransitionTime: "2026-10-10T08:00:00Z" }];
    expect(strimziProblems(noReason)[0]!.reason).toBe("NotReady");
    expect(ruleProblems(noReason)[0]!.reason).toBe("KafkaTopic not ready");
  });

  it("wait for Strimzi's automatic restarts as the built-in view did", () => {
    const last = "2026-10-10T08:12:00Z";
    for (const failure of ["task", "connector"]) {
      const base = copy(connector);
      if (failure === "connector") {
        status(base).connectorStatus = { name: "c", connector: { state: "FAILED", trace: "E: x" }, tasks: [] };
      }
      for (const maxRestarts of [undefined, 0, 3, 20]) {
        spec(base).autoRestart = maxRestarts === undefined ? { enabled: true } : { enabled: true, maxRestarts };
        // No restart yet: one reconciliation's grace.
        const first = copy(base);
        delete status(first).autoRestart;
        expect(fromRules(first), `${failure} ${maxRestarts} first`).toEqual(builtIn(first));
        for (let count = 0; count <= 12; count++) {
          const o = copy(base);
          status(o).autoRestart = { count, connectorName: "c", lastRestartTimestamp: last };
          expect(fromRules(o), `${failure} ${maxRestarts} ${count}`).toEqual(builtIn(o));
        }
      }
      // Auto-restart off: at once.
      const off = copy(base);
      spec(off).autoRestart = { enabled: false };
      status(off).autoRestart = { count: 1, lastRestartTimestamp: last };
      expect(fromRules(off)).toEqual(builtIn(off));
      expect(autoRestartGrace(off)).toBeUndefined();
    }
    // The windows: n² + n minutes after the n-th restart, at most 60, plus one reconciliation.
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(nextRestartMinutes)).toEqual([0, 2, 6, 12, 20, 30, 42, 56, 60]);
    const o = copy(connector);
    spec(o).autoRestart = { enabled: true };
    status(o).autoRestart = { count: ESCALATING_RESTARTS - 1, lastRestartTimestamp: last };
    expect(fromRules(o)[0]!.activeFrom).toBe(Date.parse(last) + 42 * 60_000 + RECONCILIATION_MS);
  });

  it("name at most six MirrorMaker 2 connectors: a later failed one is told by Strimzi's NotReady", () => {
    const seventh = copy(mirror);
    status(seventh).connectors = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ name: `c${i}`, connector: { state: i === 6 ? "FAILED" : "RUNNING" }, tasks: [] }));
    status(seventh).conditions = [{ type: "NotReady", status: "True", reason: "Throwable", message: "c6 failed", lastTransitionTime: "2026-10-10T08:00:00Z" }];
    expect(builtIn(seventh)).toEqual([expect.objectContaining({ reason: "ConnectorFailed" })]);
    expect(fromRules(seventh)).toEqual([expect.objectContaining({ reason: "Throwable", group: "not-ready", message: "c6 failed" })]);
  });

  it("keep within the limits of a manifest", () => {
    const count = (cond: { of?: unknown }): number =>
      1 + (Array.isArray(cond.of) ? cond.of.reduce((n: number, inner) => n + count(inner as { of?: unknown }), 0) : cond.of ? count(cond.of as { of?: unknown }) : 0);
    expect(c.problems.length).toBeLessThanOrEqual(30);
    for (const rule of c.problems) expect(count(rule.when), rule.id).toBeLessThanOrEqual(30);
  });
});

describe("Only problems", () => {
  it.each(variants())("is the built-in view's: %s", (_, obj) => {
    const entry = c.kinds.find((k) => sameKind(k, kindOf(obj)))!;
    expect(holdsNow(entry.problemWhen, obj)).toBe(isProblem(obj));
  });
});

// ---------- Columns ----------

type Column = (typeof c.columns)[number];
const columnOf = (id: string) => c.columns.find((col) => col.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.strimzi:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
interface Drawn {
  props?: { title?: string; tone?: string; value?: string; children?: Drawn };
}
const drawn = (id: string, obj: KubeObject) => windowColumn(id).render(obj, { now: NOW }) as Drawn | null;
const hover = (id: string, obj: KubeObject) => drawn(id, obj)?.props?.title;
/** The tone a cell is drawn in (Sextant's `StatusText`), inside its hover span if any. */
const toneOf = (id: string, obj: KubeObject) => {
  const d = drawn(id, obj);
  return (d?.props?.title !== undefined ? d.props.children : d)?.props?.tone;
};
const TONES: Record<string, string> = { success: "success", danger: "danger", warning: "warning", muted: "neutral", neutral: "neutral" };

const prefixes: Record<string, string> = {
  Kafka: "kafka",
  KafkaNodePool: "node-pool",
  KafkaTopic: "topic",
  KafkaUser: "user",
  KafkaConnect: "connect",
  KafkaMirrorMaker2: "mirror-maker",
  KafkaConnector: "connector",
};

describe("the columns", () => {
  it("are the built-in ones, in its order", () => {
    const order = (kind: string) => {
      const own = c.columns.filter((col) => col.kind.kind === kind);
      const out = ["name", "namespace"];
      for (;;) {
        const next = own.find((col) => col.afterColumn === out[out.length - 1]);
        if (!next) break;
        out.push(next.id);
      }
      expect(out.length - 2, kind).toBe(own.length);
      return out.slice(2).map((id) => id.slice(prefixes[kind]!.length + 1));
    };
    expect(order("Kafka")).toEqual(["status", "version", "listeners", "reason"]);
    expect(order("KafkaNodePool")).toEqual(["cluster", "roles", "replicas"]);
    expect(order("KafkaTopic")).toEqual(["cluster", "status", "partitions", "replicas", "reason"]);
    expect(order("KafkaUser")).toEqual(["cluster", "status", "authentication", "authorization"]);
    expect(order("KafkaConnect")).toEqual(["status", "replicas", "reason"]);
    expect(order("KafkaMirrorMaker2")).toEqual(["status", "replicas", "reason"]);
    expect(order("KafkaConnector")).toEqual(["cluster", "status", "state", "tasks", "class", "restarts", "reason"]);
  });

  it.each(variants())("read readiness as the built-in view: %s", (_, obj) => {
    const prefix = prefixes[kindOf(obj).kind]!;
    const r = readinessOf(obj);
    if (prefix !== "node-pool") {
      expect(cell(`${prefix}-status`, obj)).toBe(en[`state.${r.state}`]);
      expect(toneOf(`${prefix}-status`, obj)).toBe(TONES[STATE_TONE[r.state]]);
      expect(hover(`${prefix}-status`, obj)).toBe(r.message);
    }
    if (["kafka", "topic", "connect", "mirror-maker", "connector"].includes(prefix)) {
      expect(cell(`${prefix}-reason`, obj)).toBe(r.reason);
    }
    if (["node-pool", "topic", "user", "connector"].includes(prefix)) {
      expect(cell(`${prefix}-cluster`, obj)).toBe(clusterLabelOf(obj));
    }
  });

  it("show a Kafka's version and listeners", () => {
    expect(cell("kafka-version", kafka)).toBe("4.0.0");
    expect(cell("kafka-listeners", kafka)).toBe(listenersOf(kafka).map((l) => l.name).join(", "));
    const many = copy(kafka);
    (spec(many).kafka as Json).listeners = ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({ name, port: 9092, type: "internal" }));
    // Five names at most: a manifest text has at most five values.
    expect(cell("kafka-listeners", many)).toBe("a, b, c, d, e, …");
    const one = copy(kafka);
    (spec(one).kafka as Json).listeners = [{ name: "plain" }];
    expect(cell("kafka-listeners", one)).toBe("plain");
    const none = copy(kafka);
    (spec(none).kafka as Json).listeners = [];
    expect(cell("kafka-listeners", none)).toBeUndefined();
    const older = copy(kafka);
    status(older).kafkaVersion = undefined;
    expect(cell("kafka-version", older)).toBe("4.0.0");
  });

  it("show node pools, topics and users as the built-in view", () => {
    // Joined as Sextant's tables join a list (`formatList`), as the built-in column did.
    expect(cell("node-pool-roles", nodePool)).toBe(format.formatList(["broker", "controller"]));
    expect(cell("node-pool-replicas", nodePool)).toBe("3");
    expect(cell("topic-partitions", topic)).toBe("10");
    expect(cell("topic-replicas", topic)).toBe("3");
    expect(cell("user-authentication", user)).toBe("tls");
    expect(cell("user-authorization", user)).toBe("simple");
    expect(cell("connect-replicas", connect)).toBe("1");
    expect(cell("mirror-maker-replicas", mirror)).toBe("1");
  });

  it("show a connector's state, tasks, class and restarts", () => {
    const state = connectorStatusOf(connector)!.state!;
    expect(cell("connector-state", connector)).toBe(state);
    for (const s of ["RUNNING", "FAILED", "UNASSIGNED", "RESTARTING", "PAUSED", "STOPPED"]) {
      const o = copy(connector);
      ((status(o).connectorStatus as Json).connector as Json).state = s;
      expect(toneOf("connector-state", o), s).toBe(TONES[stateTone(s)]);
    }
    const counts = taskCounts(connectorStatusOf(connector));
    expect(cell("connector-tasks", connector)).toBe(`${counts.running}/${counts.total}`);
    const none = copy(connector);
    delete status(none).connectorStatus;
    expect(cell("connector-tasks", none)).toBeUndefined();
    expect(cell("connector-state", none)).toBeUndefined();
    // The whole class, the built-in column's simple name being its last part.
    expect(cell("connector-class", connector)).toBe("org.apache.kafka.connect.file.FileStreamSourceConnector");
    expect(hover("connector-class", connector)).toBe("org.apache.kafka.connect.file.FileStreamSourceConnector");
    expect(cell("connector-restarts", connector)).toBe("3");
    const noCount = copy(connector);
    status(noCount).autoRestart = { connectorName: "c" };
    expect(cell("connector-restarts", noCount)).toBe("0");
    delete status(noCount).autoRestart;
    expect(cell("connector-restarts", noCount)).toBeUndefined();
  });
});
