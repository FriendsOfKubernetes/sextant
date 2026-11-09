// The model and the manifest's declarative parts. The manifest's problem rules (which also make the kind's "Only
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
  firstFailedJob,
  IGNORING_ACTION,
  isProblem,
  JOBSET,
  JOBSET_TONE,
  jobSetProblems,
  jobSetState,
  RECENT_FAILURE_MS,
  replicatedJobs,
  restartsOf,
  type Found,
} from "./model";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const find = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const failed = () => find("JobSet", "failure-policy");
const running = () => find("JobSet", "success-policy");
const st = (o: KubeObject) => o.status as Record<string, unknown>;
const spec = (o: KubeObject) => o.spec as Record<string, unknown>;
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
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
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
});

const active = (d: { activeFrom?: number; until?: number }, now: number) => (d.activeFrom === undefined || d.activeFrom <= now) && (d.until === undefined || d.until > now);

/** The problems the manifest's rules find in `obj`, as the window finds them. */
const windowProblems = (obj: KubeObject): Detected[] => manifest.contributes.problems.flatMap((rule) => engine.detectRule(rule, obj));

/** What the window counts at `now`, one per notification group (the rules of a group notify once). */
function windowFound(obj: KubeObject, now: number) {
  const byGroup = new Map<string, Detected>();
  for (const d of windowProblems(obj)) if (active(d, now) && !byGroup.has(d.group)) byGroup.set(d.group, d);
  return [...byGroup.values()].map((d) => ({ reason: d.reason, group: d.group, message: d.message, since: d.since, until: d.until }));
}

/** The English text of the built-in restarts message (`messages.jobsetRestarts`). */
const restartsMessage = (used: number, max: number) => `${used} of ${max} allowed restarts used: a failure past the limit fails the JobSet.`;

function builtInFound(obj: KubeObject, now: number) {
  return jobSetProblems(obj, now).map((d: Found) => ({
    reason: d.reason,
    group: d.group ?? "restarts-near-limit",
    message: d.messageParams ? restartsMessage(d.messageParams.used!, d.messageParams.max!) : (d.message ?? ""),
    since: d.since,
    until: d.until,
  }));
}

const TIMES = ["2026-10-20T08:10:00Z", "2026-10-20T09:00:00Z", "2026-10-21T08:19:00Z", "2026-10-21T08:21:00Z", "2030-01-01T00:00:00Z"].map(at);

function expectSame(obj: KubeObject, label: string): void {
  for (const now of TIMES) {
    expect(windowFound(obj, now), `${label} at ${new Date(now).toISOString()}`).toEqual(builtInFound(obj, now));
    // "Only problems" comes from the same rules (the kind has no `problemWhen` of its own).
    expect(windowFound(obj, now).length > 0, `${label} Only problems`).toBe(isProblem(obj, now));
  }
}

/** Variants of the fixtures the rules and columns are compared on. */
function variants(): [string, KubeObject][] {
  const completed = running();
  st(completed).terminalState = "Completed";
  st(completed).conditions = [{ type: "Completed", status: "True", reason: "AllJobsCompleted", message: "jobset completed successfully", lastTransitionTime: "2026-10-20T08:30:00Z" }];
  const completedByCondition = copy(completed);
  delete st(completedByCondition).terminalState;
  const completedNoMessage = copy(completed);
  delete (st(completedNoMessage).conditions as Record<string, unknown>[])[0]!.message;
  const failedNoReason = failed();
  delete (st(failedNoReason).conditions as Record<string, unknown>[])[0]!.reason;
  const failedEmptyReason = failed();
  (st(failedEmptyReason).conditions as Record<string, unknown>[])[0]!.reason = "";
  const failedNoMessage = failed();
  delete (st(failedNoMessage).conditions as Record<string, unknown>[])[0]!.message;
  const failedNoTime = failed();
  delete (st(failedNoTime).conditions as Record<string, unknown>[])[0]!.lastTransitionTime;
  const failedByTerminal = failed();
  delete st(failedByTerminal).conditions;
  const failedByCondition = failed();
  delete st(failedByCondition).terminalState;
  const deleting = failed();
  deleting.metadata.deletionTimestamp = "2026-10-20T08:30:00Z";
  const suspended = running();
  spec(suspended).suspend = true;
  const suspendedByCondition = running();
  st(suspendedByCondition).conditions = [{ type: "Suspended", status: "True", reason: "SuspendJobs" }];
  const resumed = running();
  st(resumed).conditions = [{ type: "Suspended", status: "False", reason: "ResumeJobs" }];
  const restarting = running();
  st(restarting).conditions = [{ type: "RestartingJobSet", status: "True" }];
  const starting = running();
  st(starting).conditions = [{ type: "StartupPolicyInProgress", status: "True" }];
  const fresh = running();
  delete (fresh as { status?: unknown }).status;
  const idle = running();
  for (const s of st(idle).replicatedJobsStatus as Record<string, unknown>[]) s.active = s.ready = 0;
  const lateReady = running();
  st(lateReady).replicatedJobsStatus = Array.from({ length: 13 }, (_, i) => ({ name: `r${i}`, ready: i === 12 ? 1 : 0, active: 0, succeeded: 0, failed: 0, suspended: 0 }));
  spec(lateReady).replicatedJobs = Array.from({ length: 13 }, (_, i) => ({ name: `r${i}`, replicas: 1 }));
  const single = running();
  spec(single).replicatedJobs = [(spec(single).replicatedJobs as unknown[])[1]];
  st(single).replicatedJobsStatus = [{ name: "workers", ready: 2, succeeded: 3, failed: 1, active: 2, suspended: 0 }];
  (spec(single).replicatedJobs as Record<string, unknown>[])[0]!.replicas = 4;
  const singleFresh = copy(single);
  delete st(singleFresh).replicatedJobsStatus;
  const noPolicy = running();
  delete spec(noPolicy).failurePolicy;
  const noPolicyNoRestarts = copy(noPolicy);
  delete st(noPolicyNoRestarts).restarts;
  const noMax = running();
  spec(noMax).failurePolicy = { restartStrategy: "Recreate" };
  const noMaxOld = copy(noMax);
  delete st(noMaxOld).restartsCountTowardsMax;
  const noMaxIgnoring = copy(noMaxOld);
  spec(noMaxIgnoring).failurePolicy = { rules: [{ name: "p", action: IGNORING_ACTION }] };
  const ignoring = running();
  st(ignoring).restarts = 5;
  delete st(ignoring).restartsCountTowardsMax;
  spec(ignoring).failurePolicy = { maxRestarts: 3, rules: [{ name: "preempted", action: IGNORING_ACTION, onJobFailureReasons: ["PodFailurePolicy"] }] };
  const oldController = copy(ignoring);
  spec(oldController).failurePolicy = { maxRestarts: 3 };
  const atLimit = running();
  st(atLimit).restartsCountTowardsMax = 2;
  const early = running();
  st(early).restartsCountTowardsMax = 0;
  st(early).restarts = 0;
  return [
    ["failed", failed()],
    ["running", running()],
    ["completed", completed],
    ["completedByCondition", completedByCondition],
    ["completedNoMessage", completedNoMessage],
    ["failedNoReason", failedNoReason],
    ["failedEmptyReason", failedEmptyReason],
    ["failedNoMessage", failedNoMessage],
    ["failedNoTime", failedNoTime],
    ["failedByTerminal", failedByTerminal],
    ["failedByCondition", failedByCondition],
    ["deleting", deleting],
    ["suspended", suspended],
    ["suspendedByCondition", suspendedByCondition],
    ["resumed", resumed],
    ["restarting", restarting],
    ["starting", starting],
    ["fresh", fresh],
    ["idle", idle],
    ["lateReady", lateReady],
    ["single", single],
    ["singleFresh", singleFresh],
    ["noPolicy", noPolicy],
    ["noPolicyNoRestarts", noPolicyNoRestarts],
    ["noMax", noMax],
    ["noMaxOld", noMaxOld],
    ["noMaxIgnoring", noMaxIgnoring],
    ["ignoring", ignoring],
    ["oldController", oldController],
    ["atLimit", atLimit],
    ["early", early],
  ];
}

// ---------- The model ----------

describe("the model", () => {
  it("reads the state, the replicated jobs and the restarts against the limit", () => {
    expect(jobSetState(failed())).toBe("failed");
    expect(jobSetState(running())).toBe("running");
    expect(restartsOf(failed())).toEqual({ total: 3, counted: 3, max: 3 });
    expect(replicatedJobs(failed())[0]).toMatchObject({ name: "leader", replicas: 1, completions: 2, parallelism: 2, failed: 1 });
    expect(firstFailedJob("jobset failed due to one or more job failures (first failed job: js-workers-1)")).toBe("js-workers-1");
    const plain = running();
    delete spec(plain).failurePolicy;
    expect(restartsOf(plain).max).toBeUndefined();
    const perJob = running();
    (st(perJob).replicatedJobsStatus as Record<string, unknown>[])[1]!.jobRestartsCountTowardsMax = [1, 0];
    expect(restartsOf(perJob).counted).toBe(2);
  });

  it("a missing restartsCountTowardsMax is 0 when restarts are ignored by a rule (the field is omitempty)", () => {
    const states = Object.fromEntries(variants());
    expect(restartsOf(states.ignoring!)).toEqual({ total: 5, counted: 0, max: 3 });
    expect(restartsOf(states.oldController!).counted).toBe(5);
  });
});

// ---------- Problems and "Only problems" ----------

describe("the problem rules, against the built-in category jobset", () => {
  it("find what the built-in detector found, with its reason, message, start and end, at every time", () => {
    for (const [label, obj] of variants()) expectSame(obj, label);
  });

  it("a failed JobSet is a problem for a day after it failed, with the controller's reason", () => {
    const [d] = windowProblems(failed());
    expect(d).toMatchObject({ reason: "ReachedMaxRestarts", group: "failed", since: "2026-10-20T08:20:00Z", until: at("2026-10-20T08:20:00Z") + RECENT_FAILURE_MS });
    expect(d!.message).toContain("first failed job: failure-policy-leader-0");
    expect(d!.graceMs).toBeUndefined();
    // Without a reason the built-in one, "Failed"; without a time of failure, a day from its creation.
    const states = Object.fromEntries(variants());
    expect(windowProblems(states.failedNoReason!)[0]).toMatchObject({ reason: "Failed" });
    expect(windowProblems(states.failedByTerminal!)[0]).toMatchObject({ reason: "Failed", since: "2026-10-20T08:00:00Z", until: at("2026-10-20T08:00:00Z") + RECENT_FAILURE_MS });
  });

  it("restarts that leave at most one before the limit, while it runs, with the counted restarts in the message", () => {
    const [p] = windowProblems(running());
    expect(p).toMatchObject({ reason: "RestartsNearLimit", group: "restarts-near-limit", message: restartsMessage(1, 2) });
    expect(p!.since).toBeUndefined();
  });

  it("restarts near any limit up to 19 (11 on a controller without restartsCountTowardsMax); past that, at the limit only", () => {
    for (const counted of [true, false]) {
      for (let max = 0; max <= 24; max++) {
        for (let used = 0; used <= max + 1; used++) {
          const obj = running();
          spec(obj).failurePolicy = { maxRestarts: max };
          if (counted) st(obj).restartsCountTowardsMax = used;
          else delete st(obj).restartsCountTowardsMax;
          st(obj).restarts = used;
          const label = `${counted ? "counted" : "all"} ${used}/${max}`;
          const expected = builtInFound(obj, TIMES[1]!);
          const covered = max <= (counted ? 19 : 11);
          // Past the enumerated limits the rules see a JobSet at or over its limit, not one restart before it.
          const shown = covered || used !== max - 1 ? expected : [];
          expect(windowFound(obj, TIMES[1]!), label).toEqual(shown);
        }
      }
    }
  });

  it("every rule may notify, none waits a grace period, and the rules judge only JobSets", () => {
    for (const rule of manifest.contributes.problems) {
      expect((rule as { notify?: boolean }).notify).toBeUndefined();
      expect((rule as { graceMinutes?: number }).graceMinutes).toBeUndefined();
      expect(rule.kind).toEqual({ group: "jobset.x-k8s.io", kind: "JobSet" });
    }
    expect(manifest.contributes.kinds[0]).not.toHaveProperty("problemWhen");
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.jobset:${id}`, columnOf(id));
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
const toneOf = (tone: string) => (tone === "muted" ? "neutral" : tone);
const sum = (o: KubeObject, pick: (r: ReturnType<typeof replicatedJobs>[number]) => number) => replicatedJobs(o).reduce((n, r) => n + pick(r), 0);

/** The built-in title of the state: the Failed or Completed condition's reason and message. */
function builtInTitle(o: KubeObject): string | undefined {
  const state = jobSetState(o);
  if (state !== "failed" && state !== "completed") return undefined;
  const type = state === "completed" ? "Completed" : "Failed";
  const c = ((st(o)?.conditions ?? []) as { type: string; reason?: string; message?: string }[]).find((x) => x.type === type);
  return [c?.reason, c?.message].filter(Boolean).join(": ") || undefined;
}

describe("the columns, against the built-in ones", () => {
  it("are placed after the namespace in the built-in order, with the CRD's own columns left out", () => {
    expect(manifest.contributes.kinds[0]!.printerColumns).toBe(false);
    expect(manifest.contributes.columns.map((c) => [c.afterColumn, c.id])).toEqual([
      ["namespace", "jobset-status"],
      ["jobset-status", "jobset-succeeded"],
      ["jobset-succeeded", "jobset-active"],
      ["jobset-active", "jobset-failed"],
      ["jobset-failed", "jobset-restarts"],
    ]);
  });

  it("Status: the state in its tone, the Failed or Completed condition's reason and message on hover", () => {
    for (const [label, o] of variants()) {
      const state = jobSetState(o);
      expect(cell("jobset-status", o), label).toBe(en[`state.${state}` as keyof typeof en]);
      expect(drawn("jobset-status", o), label).toEqual({ title: builtInTitle(o), tone: toneOf(JOBSET_TONE[state]) });
    }
  });

  it("Restarts: the restarts, or those counted against the limit", () => {
    for (const [label, o] of variants()) {
      const r = restartsOf(o);
      expect(cell("jobset-restarts", o), label).toBe(r.max === undefined ? String(r.total) : `${r.counted}/${r.max}`);
    }
  });

  it("Succeeded, Active and Failed: the sums for one replicated job, each replicated job's count for more", () => {
    for (const [label, o] of variants()) {
      const jobs = replicatedJobs(o);
      if (jobs.length !== 1 && o.status?.replicatedJobsStatus !== undefined) continue;
      if (jobs.length === 1) expect(cell("jobset-succeeded", o), label).toBe(`${sum(o, (r) => r.succeeded)}/${sum(o, (r) => r.replicas)}`);
      expect(cell("jobset-active", o), label).toBe(String(sum(o, (r) => r.active)));
      expect(cell("jobset-failed", o), label).toBe(String(sum(o, (r) => r.failed)));
    }
    // Two replicated jobs (the window cannot add): each one's count.
    expect(cell("jobset-succeeded", failed())).toBe("0/1 + 0/1");
    expect(cell("jobset-active", running())).toBe("1 + 1");
    expect(cell("jobset-failed", failed())).toBe("1 + 0");
    const fresh = Object.fromEntries(variants()).fresh!;
    expect(cell("jobset-succeeded", fresh)).toBe("0/1 + 0/1");
    expect(cell("jobset-active", fresh)).toBe("0");
    const many = Object.fromEntries(variants()).lateReady!;
    expect(cell("jobset-succeeded", many)).toBe("0/1 + 0/1 + …");
    expect(cell("jobset-active", many)).toBe("0 + 0 + 0 + 0 + …");
  });
});

describe("the manifest", () => {
  it("lists JobSets in the section jobset after Kueue's, with a details section of order 20", () => {
    expect(manifest.contributes.kinds.map((k) => [k.group, k.kind, k.section, k.title, k.icon, k.order])).toEqual([["jobset.x-k8s.io", "JobSet", "jobset", "Job Sets", "jobset", 10]]);
    expect(manifest.contributes.sections).toEqual([{ section: "jobset", title: "JobSet", icon: "jobset", after: "kueue" }]);
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "jobset", label: { one: "{{count}} JobSet needs attention", other: "{{count}} JobSets need attention" } }]);
    expect(manifest.contributes.detailsSections).toEqual([{ id: "jobset", title: "JobSet", kinds: [{ group: JOBSET.group, kind: JOBSET.kind }], placement: "section", order: 20 }]);
  });

  it("asks to read JobSets, Jobs and Pods only, with no action of its own", () => {
    expect(manifest.permissions.rules).toEqual([
      {
        namespaces: { type: "all" },
        kinds: {
          type: "only",
          kinds: [
            { group: "jobset.x-k8s.io", kind: "JobSet" },
            { group: "batch", kind: "Job" },
            { group: "", kind: "Pod" },
          ],
        },
        actions: ["read"],
      },
    ]);
    expect("actions" in manifest.contributes).toBe(false);
  });
});
