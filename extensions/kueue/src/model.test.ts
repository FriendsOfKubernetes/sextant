// The model and the manifest's declarative parts. The manifest's problem rules (which also make the kinds' "Only
// problems") and the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and
// columns.tsx, loaded at run time so the type check stays inside the extension) and compared with the model they
// replace — the reading of Sextant's former built-in view (ADR-0114), ported unchanged — on its fixtures and variants
// of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import objectsJson from "../fixtures/objects.json";
import en from "./locales/en.json";
import {
  CLUSTER_QUEUE,
  evictionCount,
  isProblem,
  KUEUE_GROUP,
  LOCAL_QUEUE,
  ownerOf,
  PENDING_GRACE_MS,
  prebuiltWorkloadOf,
  QUEUE_GRACE_MS,
  QUEUE_TONE,
  QUEUED_KINDS,
  queueProblems,
  queueState,
  quotaRows,
  WORKLOAD,
  WORKLOAD_TONE,
  workloadInfo,
  workloadProblems,
  type Found,
} from "./model";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const find = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const cq = () => find("ClusterQueue", "cluster-queue");
const gpuQueue = () => find("ClusterQueue", "gpu-queue");
const pending = () => find("Workload", "job-sample-job-7f3a1");
const evicted = () => find("Workload", "jobset-trainer-1b2c3");
const st = (o: KubeObject) => o.status as Record<string, unknown>;
const spec = (o: KubeObject) => o.spec as Record<string, unknown>;
type Cond = { type: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string };
const conditions = (o: KubeObject) => (st(o).conditions ?? []) as Cond[];
const conditionOf = (o: KubeObject, type: string) => conditions(o).find((c) => c.type === type);
const at = (iso: string) => Date.parse(iso);

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  until?: number;
  notify: boolean;
  stamp?: string;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
  filter?: { value(obj: KubeObject, ctx: { now: number }): unknown };
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  // Sextant's own texts, so lists join as in the window (`common:list.separator`).
  const { startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await startI18n("en");
});

type Rule = (typeof manifest.contributes.problems)[number];
const RULES = manifest.contributes.problems as Rule[];
const rulesOf = (kind: string) => RULES.filter((r) => r.kind.kind === kind);

/** The window's start of a problem: `activeFrom`, else the grace after `since`; a problem without either counts at once. */
const windowStart = (d: Detected) => d.activeFrom ?? (d.graceMs && d.since ? at(d.since) + d.graceMs : -Infinity);
const builtInStart = (d: Found) => (d.graceMs && d.since ? at(d.since) + d.graceMs : -Infinity);
const live = (start: number, until: number | undefined, now: number) => start <= now && (until === undefined || until > now);

/** What the manifest's rules count for `obj` of `kind` at `now`. */
function windowFound(kind: string, obj: KubeObject, now: number) {
  return rulesOf(kind)
    .flatMap((rule) => engine.detectRule(rule, obj).map((d) => ({ d, category: (rule as { category?: string }).category })))
    .filter(({ d }) => live(windowStart(d), d.until, now))
    .map(({ d, category }) => ({ reason: d.reason, group: d.group, message: d.message, since: d.since, until: d.until, start: windowStart(d), category }));
}

/** The English text of the built-in evictions message (`messages.kueueEvictions`). */
const evictionsMessage = (count: number) => `Evictions so far: ${count}`;
/** The built-in detections' groups, by the manifest's names (a detection without one notified by its reason). */
const GROUP: Record<string, string> = { Deactivated: "deactivated", EvictedRepeatedly: "evicted" };

function builtInFound(kind: string, obj: KubeObject, now: number) {
  const found = kind === "Workload" ? workloadProblems(obj, now) : queueProblems({ group: KUEUE_GROUP, kind }, obj);
  return found
    .filter((d) => live(builtInStart(d), d.until, now))
    .map((d) => ({
      reason: d.reason,
      group: d.group ?? GROUP[d.reason]!,
      // Sextant shows the cluster's message, else the one it writes.
      message: d.message || (d.messageKey ? evictionsMessage(d.messageParams!.count!) : ""),
      since: d.since,
      until: d.until,
      start: builtInStart(d),
      // The built-in categories `kueueWorkloads` and `kueue`, the extension's own `workloads` and `queues`.
      category: kind === "Workload" ? "workloads" : "queues",
    }));
}

const TIMES = ["2026-10-20T09:00:30Z", "2026-10-20T09:04:00Z", "2026-10-20T09:31:00Z", "2026-10-20T10:01:00Z", "2026-10-20T10:03:00Z", "2026-10-20T10:39:00Z", "2026-10-20T10:41:00Z", "2030-01-01T00:00:00Z"].map(at);

function expectSame(kind: string, obj: KubeObject, label: string): void {
  for (const now of TIMES) {
    expect(windowFound(kind, obj, now), `${label} at ${new Date(now).toISOString()}`).toEqual(builtInFound(kind, obj, now));
    // "Only problems" comes from the same rules: the graces are in their conditions, so a problem counts once due.
    expect(windowFound(kind, obj, now).length > 0, `${label} Only problems`).toBe(isProblem(obj, { group: KUEUE_GROUP, kind }, now));
  }
}

// ---------- Variants of the fixtures ----------

const withCondition = (o: KubeObject, c: Cond) => {
  st(o).conditions = [...conditions(o).filter((x) => x.type !== c.type), c];
  return o;
};
const reserved = (reason: string, message = "couldn't assign flavors", time = "2026-10-20T09:00:01Z"): Cond => ({ type: "QuotaReserved", status: "False", reason, message, lastTransitionTime: time });

function queueVariants(): [string, string, KubeObject][] {
  const active = (patch: Partial<Cond>, base = gpuQueue()) => withCondition(base, { ...conditionOf(base, "Active")!, ...patch });
  const deleting = gpuQueue();
  deleting.metadata.deletionTimestamp = "2026-10-20T10:01:00Z";
  const noTime = active({ lastTransitionTime: undefined });
  delete conditionOf(noTime, "Active")!.lastTransitionTime;
  const noActive = gpuQueue();
  st(noActive).conditions = [];
  const lq = () => find("LocalQueue", "team-queue");
  const lqOfInactive = active({ reason: "ClusterQueueIsInactive" }, lq());
  const lqDeleting = lq();
  lqDeleting.metadata.deletionTimestamp = "2026-10-20T10:01:00Z";
  const lqNoTime = lq();
  delete conditionOf(lqNoTime, "Active")!.lastTransitionTime;
  return [
    ["ClusterQueue", "active", cq()],
    ["ClusterQueue", "inactive", gpuQueue()],
    ["ClusterQueue", "stopped", active({ reason: "Stopped", message: "Can't admit new workloads: is stopped." })],
    ["ClusterQueue", "terminating", active({ reason: "Terminating" })],
    ["ClusterQueue", "unknown status", active({ status: "Unknown" })],
    ["ClusterQueue", "no reason", active({ reason: "" })],
    ["ClusterQueue", "deleting", deleting],
    ["ClusterQueue", "no time", noTime],
    ["ClusterQueue", "no Active", noActive],
    ["LocalQueue", "active", find("LocalQueue", "user-queue")],
    ["LocalQueue", "missing ClusterQueue", lq()],
    ["LocalQueue", "of an inactive ClusterQueue", lqOfInactive],
    ["LocalQueue", "deleting", lqDeleting],
    ["LocalQueue", "no time", lqNoTime],
  ];
}

function workloadVariants(): [string, KubeObject][] {
  const out: [string, KubeObject][] = [
    ["pending", pending()],
    ["evicted and admitted again", evicted()],
  ];
  const add = (label: string, make: (o: KubeObject) => void, base = pending) => {
    const o = base();
    make(o);
    out.push([label, o]);
  };
  for (const reason of ["Pending", "WaitingForQuota", "NoMatchingFlavor", "ExceedsMaxQuota", "TopologyPlacementFailed", "WaitingForPreemptedWorkloads", "WaitingForPodsReady", "Waiting", "Inadmissible", "Misconfigured", "DRAResourcesUnresolved", "Suspended", "Other"])
    add(`QuotaReserved ${reason}`, (o) => withCondition(o, reserved(reason)));
  for (const message of ["ClusterQueue cluster-queue is inactive", "LocalQueue user-queue is stopped", "is stopped", "the queue this stopped", "Workload namespace doesn't match ClusterQueue selector"])
    add(`Inadmissible: ${message}`, (o) => withCondition(o, reserved("Inadmissible", message)));
  add("pending without a time", (o) => withCondition(o, { ...reserved("Pending"), lastTransitionTime: undefined }));
  add("inadmissible without a time", (o) => withCondition(o, { ...reserved("Inadmissible"), lastTransitionTime: undefined }));
  add("pending without a message", (o) => withCondition(o, { ...reserved("Pending"), message: undefined }));
  add("pending, no QuotaReserved", (o) => (st(o).conditions = []));
  add("reserved, checks pending", (o) =>
    (st(o).conditions = [
      { type: "QuotaReserved", status: "True", reason: "QuotaReserved", message: "Quota reserved in ClusterQueue cluster-queue", lastTransitionTime: "2026-10-20T09:10:00Z" },
      { type: "Admitted", status: "False", reason: "NoChecks", message: "The workload has not all checks ready", lastTransitionTime: "2026-10-20T09:10:00Z" },
    ]));
  add("evicted, waiting again", (o) => {
    withCondition(o, { type: "Evicted", status: "True", reason: "Preempted", message: "Preempted to accommodate a workload", lastTransitionTime: "2026-10-20T09:30:00Z" });
    withCondition(o, reserved("Pending"));
  });
  add("finished", (o) => (st(o).conditions = [{ type: "Finished", status: "True", reason: "Succeeded", message: "Job finished successfully" }]));
  add("failed", (o) => (st(o).conditions = [{ type: "Finished", status: "True", reason: "Failed", message: "Job failed" }]));
  add("deleting", (o) => (o.metadata.deletionTimestamp = "2026-10-20T09:00:00Z"));
  const deactivated = (evictedCond?: Cond, extra?: (o: KubeObject) => void) => () => {
    const o = pending();
    spec(o).active = false;
    st(o).conditions = evictedCond ? [evictedCond] : [];
    extra?.(o);
    return o;
  };
  const ev = (reason: string): Cond => ({ type: "Evicted", status: "True", reason, message: "The workload is deactivated", lastTransitionTime: "2026-10-20T09:20:00Z" });
  out.push(["deactivated by the user", deactivated()()]);
  for (const reason of ["DeactivatedDueToRequeuingLimitExceeded", "DeactivatedDueToMaximumExecutionTimeExceeded", "DeactivatedDueToAdmissionCheck", "DeactivatedDueToUser", "InactiveWorkload", "Deactivated"])
    out.push([`deactivated, Evicted ${reason}`, deactivated(ev(reason))()]);
  out.push([
    "deactivated, DeactivationTarget",
    deactivated(undefined, (o) => withCondition(o, { type: "DeactivationTarget", status: "True", reason: "MaximumExecutionTimeExceeded", message: "exceeded" }))(),
  ]);
  const counted = (reason: string, cause: string, evictedReason?: string) =>
    deactivated(evictedReason ? ev(evictedReason) : undefined, (o) => (st(o).schedulingStats = { evictions: [{ reason, underlyingCause: cause, count: 1 }] }))();
  out.push(["older Kueue, cause in the counts", counted("Deactivated", "RequeuingLimitExceeded", "InactiveWorkload")]);
  out.push(["older Kueue, cause in the counts, no Evicted", counted("InactiveWorkload", "AdmissionCheck")]);
  out.push(["older Kueue, no cause", counted("Deactivated", "", "InactiveWorkload")]);
  out.push(["cause in the counts, Evicted names its own", counted("Deactivated", "RequeuingLimitExceeded", "DeactivatedDueToUser")]);
  // A cause in any text, as the built-in matched it.
  out.push([`deactivated, Evicted DeactivatedDueToAdmissionCheckRejected`, deactivated(ev("DeactivatedDueToAdmissionCheckRejected"))()]);
  out.push(["older Kueue, a cause in a longer text", counted("Deactivated", "AdmissionCheckRejected", "InactiveWorkload")]);
  const countsOf = (entries: { reason: string; underlyingCause?: string; count?: number }[]) =>
    deactivated(ev("InactiveWorkload"), (o) => (st(o).schedulingStats = { evictions: entries }))();
  const others = Array.from({ length: 6 }, (_, i) => ({ reason: "Preempted", underlyingCause: `Cause${i}`, count: 1 }));
  out.push(["older Kueue, the cause sixth", countsOf([...others.slice(0, 5), { reason: "InactiveWorkload", underlyingCause: "MaximumExecutionTimeExceeded", count: 1 }])]);
  out.push(["older Kueue, the cause seventh", countsOf([...others, { reason: "Deactivated", underlyingCause: "RequeuingLimitExceeded", count: 1 }])]);
  out.push(["deactivated and finished", deactivated(ev("DeactivatedDueToRequeuingLimitExceeded"), (o) => withCondition(o, { type: "Finished", status: "True", reason: "Failed" }))()]);
  // Evictions.
  const evictions = (counts: number[], base = evicted) => () => {
    const o = base();
    (st(o).schedulingStats as { evictions: unknown[] }).evictions = counts.map((count, i) => ({ reason: `R${i}`, underlyingCause: "", count }));
    return o;
  };
  for (const counts of [[2], [1, 1], [2, 1], [1, 2], [1, 1, 1], [1, 1, 1, 1], [5], [0, 3], [0, 0, 2]]) out.push([`evictions ${counts.join("+")}`, evictions(counts)()]);
  add("evictions without counts", (o) => ((st(o).schedulingStats as { evictions: unknown[] }).evictions = [{ reason: "Preempted" }, { reason: "PodsReadyTimeout" }]), evicted);
  add("an empty list of evictions, requeued 3 times", (o) => ((st(o).schedulingStats as { evictions: unknown[] }).evictions = []), evicted);
  add("requeued 3 times, no counts", (o) => {
    st(o).requeueState = { count: 3 };
    withCondition(o, { type: "Evicted", status: "True", reason: "PodsReadyTimeout", message: "Exceeded the PodsReady timeout", lastTransitionTime: "2026-10-20T09:00:00Z" });
  });
  add("requeued twice", (o) => (st(o).requeueState = { count: 2 }));
  add("evicted now, 3 times", (o) => withCondition(o, { type: "Evicted", status: "True", reason: "PodsReadyTimeout", message: "Exceeded", lastTransitionTime: "2026-10-20T09:40:00Z" }), evicted);
  add("evicted 3 times, Evicted without a time", (o) => delete conditionOf(o, "Evicted")!.lastTransitionTime, evicted);
  add("evicted 3 times, no Evicted condition", (o) => (st(o).conditions = conditions(o).filter((c) => c.type !== "Evicted")), evicted);
  add("evicted 3 times, no message, requeue count", (o) => {
    delete conditionOf(o, "Evicted")!.message;
    delete st(o).schedulingStats;
  }, evicted);
  add("evicted 3 times, no message, one reason", (o) => delete conditionOf(o, "Evicted")!.message, evicted);
  add("evicted 1 + 2 times, no message", (o) => {
    delete conditionOf(o, "Evicted")!.message;
    st(o).schedulingStats = { evictions: [{ reason: "Preempted", count: 1 }, { reason: "PodsReadyTimeout", count: 2 }] };
  }, evicted);
  add("evicted 3 times, an empty message", (o) => (conditionOf(o, "Evicted")!.message = ""), evicted);
  add("requeued 3 times, an empty message", (o) => {
    conditionOf(o, "Evicted")!.message = "";
    delete st(o).schedulingStats;
  }, evicted);
  add("evicted 3 times, deactivated", (o) => (spec(o).active = false), evicted);
  return out;
}

// ---------- The model ----------

describe("the model", () => {
  it("reads a queue's state, the quota against usage, a Workload's state, queues and owner", () => {
    expect(queueState(cq())).toBe("active");
    expect(queueState(gpuQueue())).toBe("inactive");
    expect(quotaRows(cq())[0]).toEqual({ flavor: "default-flavor", resource: "cpu", nominal: "9", borrowingLimit: "2", lendingLimit: undefined, reserved: "10", borrowed: "1", used: "10", percent: 111 });
    expect(workloadInfo(pending())).toMatchObject({ state: "pending", queue: "user-queue", evictions: 0, why: { type: "QuotaReserved", reason: "Pending" } });
    expect(workloadInfo(evicted())).toMatchObject({ state: "admitted", clusterQueue: "cluster-queue", priorityClass: "high-priority", evictions: 3 });
    expect(ownerOf(pending())).toEqual({ apiVersion: "batch/v1", kind: "Job", name: "sample-job" });
    const job = { metadata: { name: "j", labels: { "kueue.x-k8s.io/prebuilt-workload-name": "from-label" } } } as unknown as KubeObject;
    expect(prebuiltWorkloadOf(job)).toBe("from-label");
  });
});

// ---------- Problems and "Only problems" ----------

describe("the problem rules, against the built-in categories kueue and kueueWorkloads", () => {
  it("find for queues what the built-in detector found, with its reason, message, start and group, at every time", () => {
    for (const [kind, label, obj] of queueVariants()) expectSame(kind, obj, `${kind} ${label}`);
  });

  it("find for Workloads what the built-in detector found, at every time", () => {
    for (const [label, obj] of workloadVariants()) expectSame("Workload", obj, label);
  });

  it("an inactive ClusterQueue counts 2 minutes after it turned inactive, with Kueue's reason", () => {
    const [d] = rulesOf("ClusterQueue").flatMap((r) => engine.detectRule(r, gpuQueue()));
    expect(d).toMatchObject({ reason: "FlavorNotFound", group: "inactive", graceMs: QUEUE_GRACE_MS, activeFrom: at("2026-10-20T10:00:00Z") + QUEUE_GRACE_MS });
    expect(d!.message).toContain("gpu-flavor");
  });

  it("a Workload waiting for quota counts after 30 minutes with the scheduler's message, in the opt-in category", () => {
    const [d] = rulesOf("Workload").flatMap((r) => engine.detectRule(r, pending()));
    expect(d).toMatchObject({ reason: "PendingQuota", group: "pending", activeFrom: at("2026-10-20T09:00:01Z") + PENDING_GRACE_MS });
    expect(d!.message).toContain("insufficient unused quota for cpu");
    // The built-in categories, each the extension's own: agents never got them and never get these (#410).
    expect(manifest.contributes.problemCategories).toEqual([
      { id: "queues", title: "Kueue queues", optIn: false },
      { id: "workloads", title: "Kueue Workloads waiting or evicted", optIn: true },
    ]);
    for (const rule of RULES) expect((rule as { category?: string }).category, rule.id).toBe(rule.kind.kind === "Workload" ? "workloads" : "queues");
  });

  it("a Workload inadmissible because its queue is stopped is told through the queue, as the built-in view read it", () => {
    const o = withCondition(pending(), reserved("Inadmissible", "ClusterQueue cluster-queue is inactive"));
    expect(workloadInfo(o).state).toBe("pending");
    expect(builtInFound("Workload", o, TIMES[7]!)).toEqual([]);
    expect(windowFound("Workload", o, TIMES[7]!)).toEqual([]);
  });

  it("a queue without a reason is Inactive, in one rule", () => {
    const o = gpuQueue();
    conditionOf(o, "Active")!.reason = "";
    expect(rulesOf("ClusterQueue").flatMap((r) => engine.detectRule(r, o)).map((d) => d.reason)).toEqual(["Inactive"]);
    expect(rulesOf("ClusterQueue")).toHaveLength(1);
  });

  it("a repeatedly evicted Workload counts again from each new eviction count, as the built-in stamp did", () => {
    const stampOf = (o: KubeObject) => rulesOf("Workload").flatMap((r) => engine.detectRule(r, o)).find((d) => d.reason === "EvictedRepeatedly")?.stamp;
    const builtIn = (o: KubeObject) => workloadProblems(o).find((d) => d.reason === "EvictedRepeatedly")?.stamp;
    type Step = (o: KubeObject) => void;
    const counts = (o: KubeObject) => (st(o).schedulingStats as { evictions: { reason: string; count: number }[] }).evictions;
    // A Workload's life as Kueue writes it: counts only grow, a new reason comes with a count of 1.
    const steps: [string, Step][] = [
      ["another eviction", (o) => counts(o)[0]!.count++],
      ["the priority changes", (o) => (spec(o).priority = 5)],
      ["a new reason", (o) => counts(o).push({ reason: "Preempted", count: 1 })],
      ["the message changes", (o) => (conditionOf(o, "Evicted")!.message = "Preempted again")],
      ["another eviction of the new reason", (o) => counts(o)[1]!.count++],
      ["the message goes", (o) => delete conditionOf(o, "Evicted")!.message],
      ["another eviction", (o) => counts(o)[0]!.count++],
    ];
    const o = evicted();
    for (const [label, step] of steps) {
      const [window, built] = [stampOf(o), builtIn(o)];
      step(o);
      expect(stampOf(o) !== window, label).toBe(builtIn(o) !== built);
    }
    // Without counts, the requeue count.
    const requeued = evicted();
    delete st(requeued).schedulingStats;
    for (const [label, step] of [
      ["requeued again", (w: KubeObject) => ((st(w).requeueState as { count: number }).count += 1)],
      ["the priority changes", (w: KubeObject) => (spec(w).priority = 5)],
      ["the message goes", (w: KubeObject) => delete conditionOf(w, "Evicted")!.message],
      ["requeued again", (w: KubeObject) => ((st(w).requeueState as { count: number }).count += 1)],
    ] as [string, Step][]) {
      const [window, built] = [stampOf(requeued), builtIn(requeued)];
      step(requeued);
      expect(stampOf(requeued) !== window, label).toBe(builtIn(requeued) !== built);
    }
    // The sum, as the built-in: 1 + 2 is 3 as much as 3 is.
    const of = (counts: number[]) => {
      const w = evicted();
      st(w).schedulingStats = { evictions: counts.map((count, i) => ({ reason: `R${i}`, count })) };
      return w;
    };
    expect(stampOf(of([1, 2]))).toBe(stampOf(of([3])));
    expect(builtIn(of([1, 2]))).toBe(builtIn(of([3])));
    expect(stampOf(of([1, 3]))).not.toBe(stampOf(of([3])));
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.kueue:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = at("2026-10-21T10:00:00Z");
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
interface Drawn {
  title?: string;
  tone?: string;
}
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject): Drawn {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title, tone: node?.props?.tone };
}
const joined = (reason?: string, message?: string) => [reason, message].filter(Boolean).join(": ") || undefined;

describe("the columns, against the built-in ones", () => {
  it("are placed after the name or namespace in the built-in order, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const order = (kind: string) => manifest.contributes.columns.filter((c) => c.kind.kind === kind).map((c) => [c.afterColumn, c.id]);
    expect(order("ClusterQueue")).toEqual([
      ["name", "cq-status"],
      ["cq-status", "cq-cohort"],
      ["cq-cohort", "cq-pending"],
      ["cq-pending", "cq-reserving"],
      ["cq-reserving", "cq-admitted"],
      ["cq-admitted", "cq-strategy"],
    ]);
    expect(order("Workload").map(([, id]) => id)).toEqual(["wl-status", "wl-queue", "wl-cluster-queue", "wl-owner", "wl-priority", "wl-evictions"]);
    expect(order("Workload")[0]![0]).toBe("namespace");
  });

  it("have the built-in columns' widths", () => {
    const WIDTHS: Record<string, string> = {
      "cq-status": "110px",
      "cq-cohort": "minmax(120px, 1fr)",
      "cq-pending": "90px",
      "cq-reserving": "90px",
      "cq-admitted": "90px",
      "cq-strategy": "130px",
      "lq-status": "110px",
      "lq-cluster-queue": "minmax(120px, 1fr)",
      "lq-pending": "90px",
      "lq-reserving": "90px",
      "lq-admitted": "90px",
      "wl-status": "120px",
      "wl-queue": "minmax(100px, 1fr)",
      "wl-cluster-queue": "minmax(100px, 1fr)",
      "wl-owner": "minmax(140px, 1.5fr)",
      "wl-priority": "80px",
      "wl-evictions": "90px",
      "rf-node-labels": "minmax(160px, 2fr)",
      "rf-topology": "120px",
      "cohort-parent": "minmax(120px, 1fr)",
      "ac-status": "110px",
      "ac-controller": "minmax(160px, 2fr)",
      "pc-value": "90px",
      "pc-description": "minmax(160px, 2fr)",
    };
    expect(Object.fromEntries(manifest.contributes.columns.map((c) => [c.id, windowColumn(c.id).width]))).toEqual(WIDTHS);
  });

  it("Status of a queue: its state in its tone, the Active condition's reason and message on hover, sorted and filtered by the state", () => {
    for (const [kind, label, o] of queueVariants()) {
      const id = kind === "ClusterQueue" ? "cq-status" : "lq-status";
      const state = queueState(o);
      const active = conditionOf(o, "Active");
      expect(cell(id, o), label).toBe(en[`queueState.${state}` as keyof typeof en]);
      expect(drawn(id, o), label).toEqual({ title: joined(active?.reason, active?.message), tone: QUEUE_TONE[state] });
      expect(windowColumn(id).value(o), label).toBe(state);
      expect(windowColumn(id).filter!.value(o, { now: NOW }), label).toBe(state);
    }
    for (const [reason, message] of [["", "only a message"], ["OnlyAReason", undefined], ["OnlyAReason", ""]] as const) {
      const o = withCondition(gpuQueue(), { type: "Active", status: "False", reason, message, lastTransitionTime: "2026-10-20T10:00:00Z" });
      expect(drawn("cq-status", o).title, `${reason}/${message}`).toBe(joined(reason, message));
    }
    const check = find("AdmissionCheck", "prov-check");
    expect(cell("ac-status", check)).toBe("Active");
  });

  it("Status of a Workload: its state in its tone, the condition Kueue wrote on hover, sorted and filtered by the state", () => {
    for (const [label, o] of workloadVariants()) {
      const info = workloadInfo(o);
      expect(cell("wl-status", o), label).toBe(en[`workloadState.${info.state}` as keyof typeof en]);
      expect(drawn("wl-status", o), label).toEqual({ title: info.state === "admitted" ? undefined : joined(info.why?.reason, info.why?.message), tone: WORKLOAD_TONE[info.state] });
      expect(windowColumn("wl-status").value(o), label).toBe(info.state);
      expect(windowColumn("wl-status").filter!.value(o, { now: NOW }), label).toBe(info.state);
    }
  });

  it("the counts, cohort, strategy, queues, priority and evictions", () => {
    expect(cell("cq-pending", cq())).toBe("1");
    expect(cell("cq-reserving", gpuQueue())).toBe("0");
    const fresh = cq();
    delete st(fresh).pendingWorkloads;
    expect(cell("cq-pending", fresh)).toBe("0");
    expect(cell("cq-cohort", cq())).toBe("research");
    const old = cq();
    delete spec(old).cohortName;
    spec(old).cohort = "legacy";
    expect(cell("cq-cohort", old)).toBe("legacy");
    expect(cell("cq-strategy", gpuQueue())).toBe("BestEffortFIFO");
    expect(cell("lq-cluster-queue", find("LocalQueue", "team-queue"))).toBe("missing-queue");
    expect(cell("wl-queue", pending())).toBe("user-queue");
    expect(cell("wl-cluster-queue", evicted())).toBe("cluster-queue");
    expect(cell("wl-priority", evicted())).toBe("10000");
    // Evictions: the counts added up, else the requeue count, else 0 — sorted and filtered as that number.
    for (const [label, o] of workloadVariants()) {
      expect(cell("wl-evictions", o), label).toBe(String(evictionCount(o)));
      expect(windowColumn("wl-evictions").value(o), label).toBe(evictionCount(o));
      expect(windowColumn("wl-evictions").filter!.value(o, { now: NOW }), label).toBe(evictionCount(o));
    }
    expect(cell("pc-value", find("WorkloadPriorityClass", "high-priority"))).toBe("10000");
    expect(cell("ac-controller", find("AdmissionCheck", "prov-check"))).toBe("kueue.x-k8s.io/provisioning-request");
  });

  it("the owner: the controller reference, else the first, else the composable job's annotations", () => {
    const ownerText = (o: KubeObject) => {
      const owner = ownerOf(o);
      return owner ? `${owner.kind}/${owner.name}` : undefined;
    };
    const variants: [string, KubeObject][] = [
      ["a Job's", pending()],
      ["a JobSet's", evicted()],
    ];
    const add = (label: string, make: (o: KubeObject) => void) => {
      const o = pending();
      make(o);
      variants.push([label, o]);
    };
    const refs = (o: KubeObject, list: unknown[]) => ((o.metadata as { ownerReferences?: unknown[] }).ownerReferences = list);
    const job = { apiVersion: "batch/v1", kind: "Job", name: "first", uid: "u1" };
    const set = { apiVersion: "jobset.x-k8s.io/v1alpha2", kind: "JobSet", name: "controller", uid: "u2", controller: true };
    add("the controller after another", (o) => refs(o, [job, set]));
    add("no controller", (o) => refs(o, [job, { ...set, controller: false }]));
    const composed = (gvk: string, name = "db") => (o: KubeObject) => {
      refs(o, []);
      o.metadata.annotations = { "kueue.x-k8s.io/job-owner-gvk": gvk, "kueue.x-k8s.io/job-owner-name": name };
    };
    for (const gvk of ["apps/v1, Kind=StatefulSet", "apps/v1, Kind=Deployment", "/v1, Kind=Pod", "batch/v1, Kind=Job", "jobset.x-k8s.io/v1alpha2, Kind=JobSet", "leaderworkerset.x-k8s.io/v1, Kind=LeaderWorkerSet", "kubeflow.org/v1, Kind=PyTorchJob", "ray.io/v1, Kind=RayJob"])
      add(`composed of ${gvk}`, composed(gvk));
    add("an incomplete controller reference, composed", (o) => {
      composed("apps/v1, Kind=StatefulSet")(o);
      refs(o, [{ kind: "Job", name: "x", controller: true }, job]);
    });
    add("an incomplete first reference, composed", (o) => {
      composed("apps/v1, Kind=Deployment")(o);
      refs(o, [{ kind: "Job", name: "x" }]);
    });
    add("composed without a name", composed("apps/v1, Kind=StatefulSet", ""));
    add("no owner", (o) => refs(o, []));
    for (const [label, o] of variants) {
      expect(cell("wl-owner", o), label).toBe(ownerText(o));
      expect(windowColumn("wl-owner").value(o), label).toBe(ownerText(o));
    }
  });

  it("the owner of a composed Workload of any kind: the kind after the GVK's last \", Kind=\"", () => {
    const ownerText = (o: KubeObject) => {
      const owner = ownerOf(o);
      return owner ? `${owner.kind}/${owner.name}` : undefined;
    };
    for (const gvk of ["example.com/v1, Kind=Trainer", "example.com/v1, Kind=JobFoo", "x/v1, Kind=A, Kind=B", "x/v1, Kind=", "x/v1 Kind=Job", "no kind"]) {
      const o = pending();
      o.metadata.ownerReferences = [];
      o.metadata.annotations = { "kueue.x-k8s.io/job-owner-gvk": gvk, "kueue.x-k8s.io/job-owner-name": "t" };
      expect(cell("wl-owner", o), gvk).toBe(ownerText(o));
    }
  });

  it("a flavor's node labels and topology", () => {
    const flavor = find("ResourceFlavor", "spot");
    const labels = (o: KubeObject) =>
      Object.entries(((o.spec as { nodeLabels?: Record<string, unknown> } | undefined)?.nodeLabels ?? {}))
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ") || undefined;
    expect(cell("rf-node-labels", flavor)).toBe("instance-type=spot");
    (flavor.spec as Record<string, unknown>).nodeLabels = { "instance-type": "spot", zone: "a" };
    expect(cell("rf-node-labels", flavor)).toBe(labels(flavor));
    // Joined with ", " in every language, as the built-in column.
    expect(columnOf("rf-node-labels")).toMatchObject({ format: "entries", separator: ", " });
    expect(cell("rf-node-labels", find("ResourceFlavor", "default-flavor"))).toBe(labels(find("ResourceFlavor", "default-flavor")));
    const order = manifest.contributes.columns.filter((c) => c.kind.kind === "ResourceFlavor").map((c) => [c.afterColumn, c.id]);
    expect(order).toEqual([
      ["name", "rf-node-labels"],
      ["rf-node-labels", "rf-topology"],
    ]);
  });
});

// ---------- The manifest ----------


describe("the manifest", () => {
  it("lists the Kueue kinds in the section kueue after DRA's, with its counter and a details section of order 20", () => {
    expect(manifest.contributes.kinds.map((k) => [k.kind, k.title, k.icon, k.order])).toEqual([
      ["ClusterQueue", "Cluster Queues", "kueueClusterQueue", 10],
      ["LocalQueue", "Local Queues", "kueueLocalQueue", 20],
      ["Workload", "Workloads", "kueueWorkload", 30],
      ["ResourceFlavor", "Resource Flavors", "kueueResourceFlavor", 40],
      ["Cohort", "Cohorts", "kueueCohort", 50],
      ["AdmissionCheck", "Admission Checks", "kueueAdmissionCheck", 60],
      ["WorkloadPriorityClass", "Workload Priority Classes", "kueuePriorityClass", 70],
    ]);
    expect(manifest.contributes.sections).toEqual([{ section: "kueue", title: "Kueue", icon: "kueue", after: "dra" }]);
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "kueue", label: { one: "{{count}} object needs attention", other: "{{count}} objects need attention" } }]);
    expect(manifest.contributes.detailsSections.map((s) => [s.id, s.order])).toEqual([
      ["kueue", 20],
      ["queue", 25],
    ]);
  });

  it("puts the Queue section on the kinds Kueue queues, hidden until the frame finds it has something to show", () => {
    const section = manifest.contributes.detailsSections.find((s) => s.id === "queue")!;
    expect(section.kinds).toEqual(QUEUED_KINDS);
    expect(section).toMatchObject({ heading: false, startHidden: true });
    expect(section).not.toHaveProperty("when");
    // The built-in Kueue section had no heading of its own either.
    expect(manifest.contributes.detailsSections.find((s) => s.id === "kueue")).toMatchObject({ heading: false });
  });

  it("asks to read the Kueue kinds and the jobs it shows the queue of, with no action of its own", () => {
    const kinds = manifest.permissions.rules[0]!.kinds as { kinds: { group: string; kind: string }[] };
    expect(kinds.kinds).toEqual([...manifest.contributes.kinds.map((k) => ({ group: k.group, kind: k.kind })), ...QUEUED_KINDS]);
    expect(manifest.permissions.rules[0]!.actions).toEqual(["read"]);
    expect(manifest.permissions.rules).toHaveLength(1);
    expect("actions" in manifest.contributes).toBe(false);
    expect([CLUSTER_QUEUE, LOCAL_QUEUE, WORKLOAD].every((k) => kinds.kinds.some((x) => x.kind === k.kind))).toBe(true);
  });
});
