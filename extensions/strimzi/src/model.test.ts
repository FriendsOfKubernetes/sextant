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
  value(obj: KubeObject): unknown;
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

/** The built-in problems as the rules must give them. */
const builtIn = (obj: KubeObject) =>
  strimziProblems(obj).map((d: Detected) => ({
    reason: d.reason,
    group: GROUPS[d.group],
    message: d.message,
    since: d.since,
    graceMs: d.graceMs,
    activeFrom: d.activeFrom,
  }));
/** The rules' problems; an empty message is the built-in view's none. */
const fromRules = (obj: KubeObject) =>
  ruleProblems(obj).map((d) => {
    expect(d.until).toBeUndefined();
    expect(d.notify).toBe(true);
    return {
      reason: d.reason,
      group: d.group,
      message: d.message === "" ? undefined : d.message,
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
// Ready False rather than NotReady: a failure counts from it, as the built-in readiness read it.
const READY_FALSE = [{ type: "Ready", status: "False", reason: "Throwable", message: "failed", lastTransitionTime: "2026-10-10T08:25:00Z" }];

/** A MirrorMaker 2 with `n` connectors, the connectors `failedAt` FAILED and a task of each of `tasksFailedAt` FAILED. */
function mirrorWith(n: number, failedAt: number[], tasksFailedAt: number[], conditions: unknown[] = [{ type: "Ready", status: "True" }]) {
  const o = copy(mirror);
  status(o).connectors = Array.from({ length: n }, (_, i) => ({
    name: `c${i}`,
    connector: failedAt.includes(i) ? { state: "FAILED", trace: `E${i}: connector ${i}\n\tat x` } : { state: "RUNNING" },
    tasks: [
      { id: 0, state: "RUNNING" },
      tasksFailedAt.includes(i) ? { id: 1, state: "FAILED", trace: `T${i}: task of ${i}\n\tat y` } : { id: 1, state: "RUNNING" },
    ],
  }));
  status(o).conditions = conditions;
  return o;
}

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
  const connectorReadyFalse = copy(failedConnector);
  status(connectorReadyFalse).conditions = READY_FALSE;
  const topicReadyFalse = copy(topic);
  status(topicReadyFalse).conditions = READY_FALSE;
  const noReason = copy(topic);
  status(noReason).conditions = [{ type: "Ready", status: "False", lastTransitionTime: "2026-10-10T08:00:00Z" }];
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
  const mirrorNoTrace = mirrorWith(3, [1], []);
  delete ((status(mirrorNoTrace).connectors as Json[])[1]!.connector as Json).trace;
  const mirrorNoName = mirrorWith(3, [1], []);
  delete (status(mirrorNoName).connectors as Json[])[1]!.name;
  const mirrorEmptyName = mirrorWith(3, [1], []);
  (status(mirrorEmptyName).connectors as Json[])[1]!.name = "";
  const mirrorTaskNoTrace = mirrorWith(3, [], [2]);
  delete (((status(mirrorTaskNoTrace).connectors as Json[])[2]!.tasks as Json[])[1] as Json).trace;
  const mirrorTaskBlankTrace = mirrorWith(3, [], [2]);
  (((status(mirrorTaskBlankTrace).connectors as Json[])[2]!.tasks as Json[])[1] as Json).trace = "  \n\t \n";
  const mirrorBlankTrace = mirrorWith(3, [1], []);
  ((status(mirrorBlankTrace).connectors as Json[])[1]!.connector as Json).trace = " \n  ";
  const mirrorTaskNoName = mirrorWith(3, [], [2]);
  delete (status(mirrorTaskNoName).connectors as Json[])[2]!.name;
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
    ["topic Ready False", topicReadyFalse],
    ["topic not ready without a reason", noReason],
    ["user", user],
    ["connect", connect],
    ["connector with a failed task, restarts exhausted", connector],
    ["failed connector", failedConnector],
    ["failed connector, Ready False", connectorReadyFalse],
    ["healthy connector", healthy],
    ["connector not ready", connectorNotReady],
    ["mirror maker with a failed task", mirror],
    ["mirror maker with a failed connector", mirrorFailed],
    ["mirror maker with one failed connector", mirrorSingle],
    ["mirror maker with a sixth connector failed", mirrorSixth],
    ["mirror maker with a connector failed without a trace", mirrorNoTrace],
    ["mirror maker with a connector failed without a name", mirrorNoName],
    ["mirror maker with a connector failed with an empty name", mirrorEmptyName],
    ["mirror maker with the tenth and twelfth connectors failed, Ready False", mirrorWith(12, [9, 11], [], READY_FALSE)],
    ["mirror maker with the thirtieth connector failed", mirrorWith(30, [29], [])],
    ...[0, 1, 2, 7, 12, 19].map((i): [string, KubeObject] => [`mirror maker with failed tasks of connectors ${i + 1} and 20`, mirrorWith(20, [], [i, 19])]),
    ["mirror maker with a failed task without a trace", mirrorTaskNoTrace],
    ["mirror maker with a failed task whose trace is blank", mirrorTaskBlankTrace],
    ["mirror maker with a failed connector whose trace is blank", mirrorBlankTrace],
    ["mirror maker with a failed task of a connector without a name", mirrorTaskNoName],
    ["mirror maker with one connector and a failed task", mirrorWith(1, [], [0])],
    ["mirror maker with failed connectors and tasks, Ready False", mirrorWith(9, [4, 6], [3, 8], READY_FALSE)],
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
    // The first line of the failed task's stack trace.
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
    // A not-ready condition without a reason: "NotReady", as the built-in view said (`reasonOr`).
    const noReason = copy(topic);
    status(noReason).conditions = [{ type: "Ready", status: "False", lastTransitionTime: "2026-10-10T08:00:00Z" }];
    expect(ruleProblems(noReason)[0]!.reason).toBe("NotReady");
    // A failure counts from Ready False too.
    const readyFalse = copy(connector);
    status(readyFalse).conditions = READY_FALSE;
    spec(readyFalse).autoRestart = { enabled: false };
    expect(fromRules(readyFalse)[0]!.since).toBe("2026-10-10T08:25:00Z");
  });

  it("take a failure's first line that is not blank, trimmed and cut at 300 characters, as the built-in view", () => {
    const o = copy(connector);
    const task = ((status(o).connectorStatus as Json).tasks as Json[])[1]!;
    task.trace = "\n  E: after a blank line  \n\tat y";
    expect(fromRules(o)).toEqual(builtIn(o));
    expect(fromRules(o)[0]!.message).toBe("E: after a blank line");
    task.trace = `${"x".repeat(400)}\n\tat y`;
    expect(builtIn(o)[0]!.message).toBe(`${"x".repeat(300)}…`);
    expect(fromRules(o)).toEqual(builtIn(o));
  });

  it("wait for Strimzi's automatic restarts as the built-in view did", () => {
    const last = "2026-10-10T08:12:00Z";
    for (const failure of ["task", "connector"]) {
      const base = copy(connector);
      if (failure === "connector") {
        status(base).connectorStatus = { name: "c", connector: { state: "FAILED", trace: "E: x" }, tasks: [] };
      }
      for (const maxRestarts of [undefined, 0, 1, 3, 8, 9, 20]) {
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
        // A status without a count (Strimzi always writes one): the built-in view read 0 restarts and waited one
        // reconciliation after its time; the rules wait one reconciliation as before the first restart.
        const uncounted = copy(base);
        status(uncounted).autoRestart = { connectorName: "c", lastRestartTimestamp: last };
        const told = builtIn(uncounted);
        expect(fromRules(uncounted), `${failure} ${maxRestarts} uncounted`).toEqual(
          told.map((d) => (d.activeFrom === undefined ? d : { ...d, activeFrom: undefined, graceMs: RECONCILIATION_MS })),
        );
        // A restart time that is no time: the built-in view waited one reconciliation; the rules tell it at once.
        const unreadable = copy(base);
        status(unreadable).autoRestart = { count: 1, connectorName: "c", lastRestartTimestamp: "soon" };
        expect(fromRules(unreadable), `${failure} ${maxRestarts} unreadable`).toEqual(
          builtIn(unreadable).map((d) => (d.graceMs === RECONCILIATION_MS ? { ...d, graceMs: undefined } : d)),
        );
        status(unreadable).autoRestart = { connectorName: "c", lastRestartTimestamp: "soon" };
        expect(fromRules(unreadable), `${failure} ${maxRestarts} unreadable, uncounted`).toEqual(builtIn(unreadable));
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
    // One rule per failure waits for every restart window.
    expect(c.problems.filter((r) => r.id.endsWith("-restarting")).map((r) => r.id)).toEqual(["connector-failed-restarting", "task-failed-restarting"]);
  });

  it("name the first connector of a MirrorMaker 2 with a failed task or a failed connector, wherever it is", () => {
    const later = mirrorWith(40, [], [33, 35]);
    expect(fromRules(later)).toEqual([expect.objectContaining({ reason: "TaskFailed", message: "c33: T33: task of 33" })]);
    expect(fromRules(later)).toEqual(builtIn(later));
    const connectorLater = mirrorWith(30, [27, 28], []);
    expect(fromRules(connectorLater)).toEqual(builtIn(connectorLater));
    expect(fromRules(connectorLater)[0]!.message).toBe("c27: E27: connector 27");
    // One rule for one connector, one for several.
    expect(c.problems.filter((r) => r.id.startsWith("mirror-")).map((r) => r.id)).toEqual([
      "mirror-maker-not-ready",
      "mirror-connector-failed",
      "mirror-connector-failed-named",
      "mirror-task-failed",
      "mirror-task-failed-named",
    ]);
  });

  it("keep within the limits of a manifest", () => {
    type Cond = { of?: Cond | Cond[] };
    const inner = (cond: Cond): Cond[] => (Array.isArray(cond.of) ? cond.of : cond.of ? [cond.of] : []);
    const count = (cond: Cond): number => 1 + inner(cond).reduce((n, i) => n + count(i), 0);
    const depth = (cond: Cond): number => 1 + Math.max(0, ...inner(cond).map(depth));
    const widest = (cond: Cond): number => Math.max(inner(cond).length, ...inner(cond).map(widest));
    expect(c.problems.length).toBeLessThanOrEqual(30);
    for (const rule of c.problems) {
      expect(count(rule.when as Cond), rule.id).toBeLessThanOrEqual(40);
      expect(depth(rule.when as Cond), rule.id).toBeLessThanOrEqual(6);
      expect(widest(rule.when as Cond), rule.id).toBeLessThanOrEqual(10);
    }
    for (const kind of c.kinds) expect(count(kind.problemWhen as Cond), kind.kind).toBeLessThanOrEqual(40);
  });
});

describe("the problem watches", () => {
  it("cap topics and users at 5000 as the built-in view did, the other kinds at a source's most", () => {
    for (const kind of c.kinds) {
      const caps = new Set(c.problems.filter((r) => r.kind.kind === kind.kind).map((r) => JSON.stringify(r.source)));
      const cap = ["KafkaTopic", "KafkaUser"].includes(kind.kind) ? 5000 : 20000;
      expect([...caps], kind.kind).toEqual([JSON.stringify({ maxObjects: cap })]);
    }
  });
});

describe("the details section", () => {
  it("has no heading of its own, as the built-in section had none; its title stays its accessible name", () => {
    expect(c.detailsSections).toEqual([expect.objectContaining({ id: "strimzi", title: "Strimzi", heading: false })]);
  });
});

describe("Only problems", () => {
  const more: [string, KubeObject][] = [
    ["mirror maker with a failed task of its 20th connector", mirrorWith(20, [], [19])],
    ["mirror maker with its 20th connector failed", mirrorWith(20, [19], [])],
  ];
  it.each([...variants(), ...more])("is the built-in view's: %s", (_, obj) => {
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
const sortValue = (id: string, obj: KubeObject) => windowColumn(id).value(obj);
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
/** How Sextant's tables order cell values (`compareCellValues`): numbers numerically, text naturally. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compare = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b)));

const prefixes: Record<string, string> = {
  Kafka: "kafka",
  KafkaNodePool: "node-pool",
  KafkaTopic: "topic",
  KafkaUser: "user",
  KafkaConnect: "connect",
  KafkaMirrorMaker2: "mirror-maker",
  KafkaConnector: "connector",
};

/** The built-in columns' widths. */
const WIDTHS: Record<string, string> = {
  status: "100px",
  reason: "minmax(120px, 1fr)",
  cluster: "minmax(110px, 1fr)",
  replicas: "80px",
  version: "80px",
  listeners: "minmax(120px, 1.5fr)",
  roles: "minmax(110px, 1fr)",
  partitions: "90px",
  state: "110px",
  tasks: "80px",
  class: "minmax(120px, 1fr)",
  restarts: "90px",
  authentication: "130px",
  authorization: "110px",
};

describe("the columns", () => {
  it("are the built-in ones, in its order and widths", () => {
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
    for (const col of c.columns) {
      const name = col.id.slice(prefixes[col.kind.kind]!.length + 1);
      expect(col.width, col.id).toBe(WIDTHS[name]);
    }
  });

  it.each(variants())("read readiness as the built-in view: %s", (_, obj) => {
    const prefix = prefixes[kindOf(obj).kind]!;
    const r = readinessOf(obj);
    if (prefix !== "node-pool") {
      expect(cell(`${prefix}-status`, obj)).toBe(en[`state.${r.state}`]);
      expect(toneOf(`${prefix}-status`, obj)).toBe(STATE_TONE[r.state]);
      expect(hover(`${prefix}-status`, obj)).toBe(r.message);
    }
    if (["kafka", "topic", "connect", "mirror-maker", "connector"].includes(prefix)) {
      expect(cell(`${prefix}-reason`, obj)).toBe(r.reason);
    }
    if (["node-pool", "topic", "user", "connector"].includes(prefix)) {
      expect(cell(`${prefix}-cluster`, obj)).toBe(clusterLabelOf(obj));
    }
  });

  it("sort readiness by the state, whatever the language, as the built-in column", () => {
    const of = (state: string) => variants().find(([, o]) => kindOf(o).kind === "Kafka" && readinessOf(o).state === state)![1];
    const states = ["ready", "pending", "notReady"];
    const byWindow = [...states].sort((a, b) => compare(sortValue("kafka-status", of(a)), sortValue("kafka-status", of(b))));
    expect(byWindow).toEqual([...states].sort((a, b) => collator.compare(a, b)));
  });

  it("show a Kafka's version and every listener", () => {
    expect(cell("kafka-version", kafka)).toBe("4.0.0");
    const names = (o: KubeObject) => format.formatList(listenersOf(o).map((l) => l.name));
    expect(cell("kafka-listeners", kafka)).toBe(names(kafka));
    const many = copy(kafka);
    (spec(many).kafka as Json).listeners = ["a", "b", "c", "d", "e", "f", "g"].map((name) => ({ name, port: 9092, type: "internal" }));
    delete status(many).listeners;
    expect(cell("kafka-listeners", many)).toBe(names(many));
    const one = copy(kafka);
    (spec(one).kafka as Json).listeners = [{ name: "plain" }];
    status(one).listeners = [{ name: "plain" }];
    expect(cell("kafka-listeners", one)).toBe("plain");
    // Without declared listeners, the reported ones.
    const reported = copy(kafka);
    delete (spec(reported).kafka as Json).listeners;
    expect(cell("kafka-listeners", reported)).toBe(names(reported));
    // A listener only in the status (being removed) is named after the declared ones, each once.
    const removing = copy(kafka);
    (status(removing).listeners as Json[]).push({ name: "old" });
    expect(names(removing)).toBe(format.formatList(["plain", "tls", "external", "old"]));
    expect(cell("kafka-listeners", removing)).toBe(names(removing));
    // A status listener of the old shape, its name only as `type`: the built-in column named it by its type.
    const legacy = copy(kafka);
    status(legacy).listeners = [{ type: "plain" }, { type: "legacy" }];
    expect(names(legacy)).toBe(format.formatList(["plain", "tls", "external", "legacy"]));
    expect(cell("kafka-listeners", legacy)).toBe(names(kafka));
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

  it("show a connector's state in the built-in tones", () => {
    const state = connectorStatusOf(connector)!.state!;
    expect(cell("connector-state", connector)).toBe(state);
    for (const s of ["RUNNING", "FAILED", "UNASSIGNED", "RESTARTING", "PAUSED", "STOPPED", "SOMETHING_NEW"]) {
      const o = copy(connector);
      ((status(o).connectorStatus as Json).connector as Json).state = s;
      expect(toneOf("connector-state", o), s).toBe(stateTone(s));
    }
    const none = copy(connector);
    delete status(none).connectorStatus;
    expect(cell("connector-state", none)).toBeUndefined();
  });

  it("show a connector's tasks as the built-in column: running of all in its tone, blank without tasks", () => {
    const withTasks = (states: string[] | undefined) => {
      const o = copy(connector);
      if (states === undefined) delete status(o).connectorStatus;
      else (status(o).connectorStatus as Json).tasks = states.map((state, id) => ({ id, state }));
      return o;
    };
    const builtInTone = (o: KubeObject) => {
      const n = taskCounts(connectorStatusOf(o));
      return n.failed > 0 ? "danger" : n.running === n.total ? "success" : "warning";
    };
    for (const states of [["RUNNING", "FAILED"], ["RUNNING", "RUNNING"], ["RUNNING", "UNASSIGNED"], ["PAUSED"], ["FAILED", "FAILED", "RUNNING"]]) {
      const o = withTasks(states);
      const n = taskCounts(connectorStatusOf(o));
      expect(cell("connector-tasks", o), states.join()).toBe(`${n.running}/${n.total}`);
      expect(toneOf("connector-tasks", o), states.join()).toBe(builtInTone(o));
    }
    expect(cell("connector-tasks", connector)).toBe("1/2");
    // Without tasks: blank, valued 0 as the built-in column's running tasks.
    for (const states of [[], undefined]) {
      const o = withTasks(states);
      expect(cell("connector-tasks", o) ?? "").toBe("");
      expect(toneOf("connector-tasks", o)).toBeUndefined();
      expect(sortValue("connector-tasks", o)).toBe(0);
    }
    // Sorted by the running tasks, as the built-in column's value; without tasks with the ones running none.
    const objects = [["RUNNING", "RUNNING", "RUNNING"], ["FAILED"], [], Array(10).fill("RUNNING"), undefined, ["RUNNING", "FAILED"]].map(withTasks);
    const running = (o: KubeObject) => taskCounts(connectorStatusOf(o)).running;
    const byWindow = [...objects].sort((a, b) => compare(sortValue("connector-tasks", a), sortValue("connector-tasks", b)));
    expect(byWindow.map(running)).toEqual(objects.map(running).sort((a, b) => a - b));
  });

  it("show a connector's class by its last part, the whole on hover, and its restarts", () => {
    expect(cell("connector-class", connector)).toBe("FileStreamSourceConnector");
    expect(sortValue("connector-class", connector)).toBe("FileStreamSourceConnector");
    expect(hover("connector-class", connector)).toBe("org.apache.kafka.connect.file.FileStreamSourceConnector");
    const plain = copy(connector);
    spec(plain).class = "FileStreamSource";
    expect(cell("connector-class", plain)).toBe("FileStreamSource");
    expect(cell("connector-restarts", connector)).toBe("3");
    const noCount = copy(connector);
    status(noCount).autoRestart = { connectorName: "c" };
    expect(cell("connector-restarts", noCount)).toBe("0");
    delete status(noCount).autoRestart;
    expect(cell("connector-restarts", noCount)).toBeUndefined();
  });
});
