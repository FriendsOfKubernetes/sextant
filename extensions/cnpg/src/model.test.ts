// The manifest's declarative parts against the built-in reading they replace. The problem rules, "Only problems" and
// the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded
// at run time so the type check stays inside the extension) and compared with `./model`, Sextant's former built-in
// CloudNativePG model ported unchanged, over every combination of the fields they read.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import backupJson from "../fixtures/backup.json";
import clusterJson from "../fixtures/cluster.json";
import manifest from "../sextant-extension.json";
import en from "./locales/en.json";
import {
  backupState,
  backupStoppedAt,
  BACKUP_TONE,
  CLUSTER_GRACE_MS,
  CLUSTER_TONE,
  clusterInfo,
  cnpgProblems,
  FAILED_BACKUP_MS,
  HEALTHY_PHASE,
  isProblem,
  STUCK_PHASE,
  type CnpgKind,
} from "./model";

const EN = en as Record<string, string>;
/** The tests over every Cluster the fields make take seconds; a loaded machine may take longer. */
const HEAVY_MS = 60_000;
const cluster = clusterJson as unknown as KubeObject;
const backup = backupJson as unknown as KubeObject;
const copy = <T>(value: T): T => structuredClone(value);
const st = (obj: KubeObject) => obj.status as Record<string, unknown>;

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
  value(obj: KubeObject): unknown;
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

const holdsNow = (condition: unknown, obj: KubeObject, now = Date.now()) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && (v.activeFrom === undefined || v.activeFrom <= now) && (v.until === undefined || v.until > now);
};

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.cnpg:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
/** A cell's text, as the window searches and copies it; ages as `common:age.<unit>:<count>`. */
const cell = (id: string, obj: KubeObject, now = Date.now()) => windowColumn(id).searchText(obj, { now, t: T }) ?? undefined;
/** What a cell draws: its `title` and, for a status word, its tone. */
function drawn(id: string, obj: KubeObject, now = Date.now()): { title?: string; tone?: string } {
  let node = windowColumn(id).render(obj, { now }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node?.props?.children as typeof node;
  return { title, tone: node?.props?.tone };
}

const rules = manifest.contributes.problems;
const detected = (kind: CnpgKind, obj: KubeObject) =>
  rules
    .filter((rule) => rule.kind.kind === kind)
    .flatMap((rule) => engine.detectRule({ notify: true, toldThroughOwner: false, graceMinutes: 0, ...rule }, obj));
const kindEntry = (kind: CnpgKind) => manifest.contributes.kinds.find((k) => k.kind === kind)!;

// ---------- Every Cluster the fields make ----------

type Vary = (c: KubeObject) => void;
const ann = (value: string | undefined): Vary => (c) => {
  c.metadata.annotations = value === undefined ? {} : { "cnpg.io/hibernation": value };
};
const conditions = (c: KubeObject) => (st(c).conditions ??= []) as Record<string, unknown>[];
const setCondition = (type: string, status?: string | null, reason?: string, since?: string): Vary => (c) => {
  const list = conditions(c).filter((x) => x.type !== type);
  // `null`: the entry without a status.
  if (status !== undefined)
    list.push({ type, ...(status === null ? {} : { status }), ...(reason ? { reason } : {}), ...(since ? { lastTransitionTime: since, message: `${type} says ${status}` } : {}) });
  st(c).conditions = list;
};
const spec = (field: string, value: unknown): Vary => (c) => {
  const s = (c.spec ??= {}) as Record<string, unknown>;
  if (value === undefined) delete s[field];
  else s[field] = value;
};
const set = (field: string, value: unknown): Vary => (c) => {
  if (value === undefined) delete st(c)[field];
  else st(c)[field] = value;
};

const AXES: Record<string, Vary[]> = {
  hibernation: [
    ann(undefined),
    (c) => (ann("on")(c), setCondition("cnpg.io/hibernation", "True", "Hibernated")(c)),
    (c) => (ann("on")(c), setCondition("cnpg.io/hibernation", "False", "DeletingPods")(c)),
    (c) => (ann("on")(c), setCondition("cnpg.io/hibernation", "False", "WaitingForHealthy")(c)),
    (c) => (ann("on")(c), setCondition("cnpg.io/hibernation", "Unknown", "WaitingForHealthy")(c)),
    (c) => (ann("off")(c), setCondition("cnpg.io/hibernation", "True", "Hibernated")(c)),
    (c) => (ann("on")(c), setCondition("cnpg.io/hibernation", null, "WaitingForHealthy")(c)),
    (c) => (ann("on")(c), setCondition("cnpg.io/hibernation", "True", "WaitingForHealthy")(c)),
  ],
  phase: [
    set("phase", HEALTHY_PHASE),
    set("phase", "Switchover in progress"),
    set("phase", "Failing over"),
    set("phase", "Setting up primary"),
    set("phase", "Cluster is unrecoverable and needs manual intervention"),
    // A phase the operator may add: the built-in words matched it in any case.
    set("phase", "Instance manager ERROR while applying configuration"),
    set("phase", ""),
    set("phase", undefined),
  ],
  ready: [
    setCondition("Ready", "False", "ClusterIsNotReady", "2026-10-10T08:00:00Z"),
    // Without a reason: the built-in's ClusterNotReady.
    setCondition("Ready", "False", undefined, "2026-10-10T08:00:00Z"),
    setCondition("Ready", "True", "ClusterIsReady", "2026-10-10T07:00:00Z"),
    setCondition("Ready", undefined),
  ],
  instances: [set("readyInstances", 3), set("readyInstances", 2), set("readyInstances", 0), set("readyInstances", undefined)],
  primaries: [
    (c) => (set("currentPrimary", "cluster-example-1")(c), set("targetPrimary", "cluster-example-1")(c)),
    (c) => (set("currentPrimary", "cluster-example-1")(c), set("targetPrimary", "cluster-example-2")(c)),
    (c) => (set("currentPrimary", "cluster-example-1")(c), set("targetPrimary", "pending")(c)),
    (c) => (set("currentPrimary", undefined)(c), set("targetPrimary", "pending")(c)),
    (c) => (set("currentPrimary", undefined)(c), set("targetPrimary", "cluster-example-1")(c)),
    // Empty names, which the built-in read as none.
    (c) => (set("currentPrimary", "")(c), set("targetPrimary", "pending")(c)),
    (c) => (set("currentPrimary", "cluster-example-1")(c), set("targetPrimary", "")(c)),
  ],
  phaseReason: [set("phaseReason", "Switching over to cluster-example-2"), set("phaseReason", ""), set("phaseReason", undefined)],
  // Wanted instances: spec.instances, else status.instances, else 0.
  wanted: [
    (c) => (spec("instances", 3)(c), set("instances", undefined)(c)),
    (c) => (spec("instances", 3)(c), set("instances", 2)(c)),
    (c) => (spec("instances", undefined)(c), set("instances", 3)(c)),
    (c) => (spec("instances", undefined)(c), set("instances", 0)(c)),
    (c) => (spec("instances", undefined)(c), set("instances", undefined)(c)),
  ],
};

function* combinations(axes: Vary[][], at = 0, chosen: Vary[] = []): Generator<Vary[]> {
  if (at === axes.length) {
    yield chosen;
    return;
  }
  for (const vary of axes[at]!) yield* combinations(axes, at + 1, [...chosen, vary]);
}

/**
 * The fixture with archiving and backups working, varied along every axis but the wanted instances (spec.instances
 * set), and along every axis but hibernation and the phase's reason (none, set): 25 984 Clusters.
 */
function clusters(extra: Vary[] = []): KubeObject[] {
  const out: KubeObject[] = [];
  const { wanted, hibernation, phaseReason, ...rest } = AXES;
  const families = [
    [hibernation!, phaseReason!, ...Object.values(rest), [wanted![0]!]],
    [[hibernation![0]!], [phaseReason![0]!], ...Object.values(rest), wanted!],
  ];
  for (const axes of families) {
    for (const varies of combinations(axes)) {
      const c = copy(cluster);
      st(c).conditions = [];
      for (const vary of [...varies, ...extra]) vary(c);
      out.push(c);
    }
  }
  return out;
}

/** What a problem says, the built-in group's name as the manifest writes it. */
const said = (p: { reason: string; group?: string; message?: string; since?: string; graceMs?: number; until?: number }, defaultGroup = "") => ({
  reason: p.reason,
  group: p.group === "notReady" ? "not-ready" : (p.group ?? defaultGroup),
  message: p.message || undefined,
  since: p.since,
  graceMs: p.graceMs,
  until: p.until,
});

describe("the manifest's problem rules on Clusters", () => {
  it("find what the built-in rules found, for every Cluster the fields make", { timeout: HEAVY_MS }, () => {
    let found = 0;
    for (const c of clusters()) {
      const builtIn = cnpgProblems("Cluster", c).map((p) => said(p));
      const ours = detected("Cluster", c).map((d) => said({ ...d, group: d.group }));
      expect(ours, JSON.stringify(c.status)).toEqual(builtIn);
      found += builtIn.length;
    }
    // Most combinations are not ready, a hibernated or healthy one is not.
    expect(found).toBeGreaterThan(5000);
  });

  it("never hold together: one problem of readiness at most", { timeout: HEAVY_MS }, () => {
    for (const c of clusters()) expect(detected("Cluster", c).filter((d) => d.group === "not-ready").length).toBeLessThanOrEqual(1);
  });

  it("count a Cluster not ready after five minutes from its Ready condition's change", () => {
    const [d] = detected("Cluster", cluster);
    expect(d).toMatchObject({ reason: "ClusterIsNotReady", graceMs: CLUSTER_GRACE_MS, since: "2026-10-10T08:00:00Z", group: "not-ready", message: "Switchover in progress" });
    const readiness = rules.filter((r) => r.group === "not-ready");
    expect(readiness.map((r) => r.id)).toEqual(["cluster-failing-over", "cluster-failing-over-phase", "cluster-not-ready", "cluster-not-ready-phase"]);
    expect(readiness.every((r) => r.graceMinutes === 5)).toBe(true);
  });

  it("are seven, one per reading the built-in told apart by its reason and message", () => {
    expect(rules.map((r) => [r.id, r.kind.kind])).toEqual([
      ["cluster-failing-over", "Cluster"],
      ["cluster-failing-over-phase", "Cluster"],
      ["cluster-not-ready", "Cluster"],
      ["cluster-not-ready-phase", "Cluster"],
      ["archiving-failing", "Cluster"],
      ["last-backup-failed", "Cluster"],
      ["backup-failed", "Backup"],
    ]);
  });

  it("tell failing archiving and backups at once, with the conditions' reasons and messages", { timeout: HEAVY_MS }, () => {
    const failing = (status: string, deleted: boolean): Vary[] => [
      setCondition("ContinuousArchiving", status, status === "False" ? "ContinuousArchivingFailing" : "ContinuousArchivingSuccess", "2026-10-10T08:00:00Z"),
      setCondition("LastBackupSucceeded", status, status === "False" ? "LastBackupFailed" : "LastBackupSucceeded", "2026-10-10T00:00:09Z"),
      (c) => {
        if (deleted) c.metadata.deletionTimestamp = "2026-10-10T09:00:00Z";
      },
    ];
    for (const deleted of [false, true]) {
      for (const status of ["False", "True", "Unknown"]) {
        for (const c of clusters(failing(status, deleted)).slice(0, 400)) {
          const builtIn = cnpgProblems("Cluster", c).map((p) => said(p, p.reason === "ContinuousArchivingFailing" ? "archiving-failing" : "last-backup-failed"));
          expect(detected("Cluster", c).map((d) => said(d))).toEqual(builtIn);
        }
      }
    }
    expect(detected("Cluster", cluster).map((d) => d.reason)).toEqual(["ClusterIsNotReady", "ContinuousArchivingFailing", "LastBackupFailed"]);
    // A False condition without a reason: the built-in's own words.
    const bare = copy(cluster);
    for (const vary of [setCondition("ContinuousArchiving", "False"), setCondition("LastBackupSucceeded", "False"), setCondition("Ready", "False")]) vary(bare);
    expect(detected("Cluster", bare).map((d) => d.reason)).toEqual(cnpgProblems("Cluster", bare).map((p) => p.reason));
    expect(detected("Cluster", bare).map((d) => d.reason)).toEqual(["ClusterNotReady", "ContinuousArchivingFailing", "LastBackupFailed"]);
  });

  it("let a hibernated Cluster be: a steady state, never a problem", () => {
    const sleeping = copy(cluster);
    sleeping.metadata.annotations = { "cnpg.io/hibernation": "on" };
    Object.assign(st(sleeping), { phase: HEALTHY_PHASE, readyInstances: 0, instancesStatus: {}, targetPrimary: "cluster-example-1" });
    st(sleeping).conditions = [
      { type: "Ready", status: "False", reason: "ClusterIsNotReady", lastTransitionTime: "2026-10-10T08:00:00Z" },
      { type: "cnpg.io/hibernation", status: "True", reason: "Hibernated", message: "Cluster has been hibernated" },
    ];
    expect(clusterInfo(sleeping).state).toBe("hibernated");
    expect(detected("Cluster", sleeping)).toEqual([]);
    expect(holdsNow(kindEntry("Cluster").problemWhen, sleeping)).toBe(false);
  });

  it("are all counted on the section, as the built-in counter counted every problem of the category", () => {
    expect(manifest.contributes.sectionBadges).toEqual([
      { section: "cnpg", label: { one: "{{count}} object needs attention", other: "{{count}} objects need attention" } },
    ]);
  });
});

describe("the manifest's problem rules on Backups", () => {
  // Any case, as the built-in compared the phase in lower case.
  const PHASES = ["failed", "Failed", "fAiLeD", "walArchivingFailing", "WALARCHIVINGfailing", "completed", "running", "pending", undefined];
  const TIMES = ["stoppedAt", "reconciliationTerminatedAt", "startedAt", "reconciliationStartedAt"] as const;

  it("find a failed Backup for a day from when it stopped, timed as the built-in timed it", () => {
    const now0 = Date.parse("2026-10-10T00:00:00Z");
    let counted = 0;
    for (const phase of PHASES) {
      for (let mask = 0; mask < 1 << (TIMES.length + 1); mask++) {
        const b = copy(backup);
        const s = st(b);
        // The last bit: the Backup without its creation time, so failed for good.
        if (mask & (1 << TIMES.length)) delete b.metadata.creationTimestamp;
        s.phase = phase;
        TIMES.forEach((field, i) => {
          if (mask & (1 << i)) s[field] = new Date(now0 + (i + 1) * 3600_000).toISOString();
          else delete s[field];
        });
        const ours = detected("Backup", b);
        const builtIn = cnpgProblems("Backup", b);
        expect(ours.map((d) => said(d)), `${phase} ${mask}`).toEqual(builtIn.map((p) => said(p, "backup-failed")));
        for (const hours of [1, 23, 24, 25, 30, 48]) {
          const now = now0 + hours * 3600_000;
          const active = ours.filter((d) => (d.activeFrom ?? 0) <= now && (d.until === undefined || d.until > now));
          expect(active.length, `${phase} ${mask} +${hours}h`).toBe(cnpgProblems("Backup", b, now).length);
          counted += active.length;
        }
        expect(holdsNow(kindEntry("Backup").problemWhen, b), `${phase}`).toBe(isProblem(b, "Backup"));
      }
    }
    expect(counted).toBeGreaterThan(0);
  });

  it("say the error, and stop counting a day after reconciliationTerminatedAt when stoppedAt is not there", () => {
    const [d] = detected("Backup", backup);
    expect(d).toMatchObject({ reason: "BackupFailed", message: "can't execute backup: exit status 1", until: Date.parse("2026-10-10T00:00:09Z") + FAILED_BACKUP_MS });
    const failed = copy(backup);
    delete st(failed).stoppedAt;
    delete st(failed).startedAt;
    st(failed).reconciliationTerminatedAt = "2026-10-10T00:00:04Z";
    expect(backupStoppedAt(failed)).toBe("2026-10-10T00:00:04Z");
    expect(detected("Backup", failed)[0]?.until).toBe(Date.parse("2026-10-10T00:00:04Z") + FAILED_BACKUP_MS);
    delete st(failed).reconciliationTerminatedAt;
    expect(detected("Backup", failed)[0]?.since).toBe("2026-10-10T00:00:00Z");
  });
});

describe("the manifest's kinds and section", () => {
  it("are the built-in section's: its id, title and icon, its kinds in order, their icons, without the CRDs' printer columns", () => {
    expect(manifest.contributes.sections).toEqual([{ section: "cnpg", title: "CloudNativePG", icon: "cnpg", after: "sealedSecrets" }]);
    expect(manifest.contributes.kinds.map((k) => [k.kind, k.title, k.icon, k.order])).toEqual([
      ["Cluster", "Clusters", "postgresCluster", 10],
      ["Backup", "Backups", "postgresBackup", 20],
      ["ScheduledBackup", "Scheduled Backups", "postgresScheduledBackup", 21],
      ["Pooler", "Poolers", "postgresPooler", 30],
    ]);
    expect(manifest.contributes.kinds.every((k) => k.section === "cnpg" && k.group === "postgresql.cnpg.io" && k.printerColumns === false)).toBe(true);
  });

  it("show in Only problems what the built-in tables did: Clusters with a problem (no grace), every failed Backup", { timeout: HEAVY_MS }, () => {
    const extra: Vary[][] = [
      [],
      [setCondition("ContinuousArchiving", "False", "ContinuousArchivingFailing")],
      [setCondition("LastBackupSucceeded", "False", "LastBackupFailed")],
      [(c) => void (c.metadata.deletionTimestamp = "2026-10-10T09:00:00Z")],
    ];
    for (const more of extra) {
      for (const c of clusters(more)) {
        expect(holdsNow(kindEntry("Cluster").problemWhen, c), JSON.stringify(c.status)).toBe(isProblem(c, "Cluster"));
      }
    }
    expect(holdsNow(kindEntry("Cluster").problemWhen, cluster)).toBe(true);
    expect(holdsNow(kindEntry("Backup").problemWhen, backup)).toBe(true);
  });

  it("have one details section for the four kinds, where the built-in one was, without a heading as it had none", () => {
    expect(manifest.contributes.detailsSections).toEqual([
      {
        id: "cnpg",
        title: "CloudNativePG",
        kinds: ["Cluster", "Backup", "ScheduledBackup", "Pooler"].map((kind) => ({ group: "postgresql.cnpg.io", kind })),
        placement: "section",
        order: 20,
        heading: false,
      },
    ]);
  });

  it("only read: the four kinds, nothing changed, deleted or logged", () => {
    expect(manifest.permissions.rules).toEqual([
      {
        namespaces: { type: "all" },
        kinds: { type: "only", kinds: ["Cluster", "Backup", "ScheduledBackup", "Pooler"].map((kind) => ({ group: "postgresql.cnpg.io", kind })) },
        actions: ["read"],
      },
    ]);
  });
});

const TONES: Record<string, string> = { success: "success", danger: "danger", warning: "warning", muted: "muted" };
/** What a column filters by (Sextant's table filters read `filter.value`, else `value`). */
const filtered = (id: string, obj: KubeObject, now = Date.now()) => {
  const column = windowColumn(id) as WindowColumn & { filter?: { value(obj: KubeObject, ctx: { now: number }): unknown } };
  return column.filter ? column.filter.value(obj, { now }) : column.value(obj);
};
/** The built-in columns' widths (src/features/cnpg/columns.tsx). */
const WIDTHS: Record<string, string> = {
  "cluster-status": "120px",
  "cluster-instances": "90px",
  "cluster-primary": "minmax(140px, 1.5fr)",
  "cluster-phase": "minmax(160px, 2fr)",
  "backup-status": "110px",
  "backup-cluster": "minmax(120px, 1fr)",
  "backup-method": "140px",
  "backup-started": "100px",
  "scheduled-cluster": "minmax(120px, 1fr)",
  "scheduled-schedule": "130px",
  "scheduled-suspended": "100px",
  "scheduled-last-backup": "110px",
  "pooler-cluster": "minmax(120px, 1fr)",
  "pooler-type": "70px",
  "pooler-instances": "90px",
  "pooler-pool-mode": "110px",
};

describe("the manifest's columns", () => {
  const ids = (kind: string) => manifest.contributes.columns.filter((c) => c.kind.kind === kind).map((c) => [c.id, c.afterColumn]);

  it("are the built-in ones, in order after Name and Namespace", () => {
    expect(ids("Cluster")).toEqual([
      ["cluster-status", "namespace"],
      ["cluster-instances", "cluster-status"],
      ["cluster-primary", "cluster-instances"],
      ["cluster-phase", "cluster-primary"],
    ]);
    expect(ids("Backup")).toEqual([
      ["backup-status", "namespace"],
      ["backup-cluster", "backup-status"],
      ["backup-method", "backup-cluster"],
      ["backup-started", "backup-method"],
    ]);
    expect(ids("ScheduledBackup")).toEqual([
      ["scheduled-cluster", "namespace"],
      ["scheduled-schedule", "scheduled-cluster"],
      ["scheduled-suspended", "scheduled-schedule"],
      ["scheduled-last-backup", "scheduled-suspended"],
    ]);
    expect(ids("Pooler")).toEqual([
      ["pooler-cluster", "namespace"],
      ["pooler-type", "pooler-cluster"],
      ["pooler-instances", "pooler-type"],
      ["pooler-pool-mode", "pooler-instances"],
    ]);
    expect(Object.fromEntries(manifest.contributes.columns.map((c) => [c.id, c.width]))).toEqual(WIDTHS);
    const titles = Object.fromEntries(manifest.contributes.columns.map((c) => [c.id, c.title]));
    expect(titles).toMatchObject({ "cluster-status": "Status", "cluster-instances": "Instances", "backup-started": "Started", "scheduled-last-backup": "Last backup", "pooler-pool-mode": "Pool mode" });
  });

  it("of Clusters: the state in words and tone sorted and filtered by its name, the phase and its reason on hover, ready of desired, the primary and phase", { timeout: HEAVY_MS }, () => {
    let states = new Set<string>();
    for (const c of clusters()) {
      const info = clusterInfo(c);
      states = states.add(info.state);
      expect(cell("cluster-status", c), JSON.stringify(c.status)).toBe(EN[`state.${info.state}`]);
      // Sorted and filtered by the state's name, as the built-in column's value.
      expect(windowColumn("cluster-status").value(c)).toBe(info.state);
      expect(filtered("cluster-status", c)).toBe(info.state);
      const { title, tone } = drawn("cluster-status", c);
      expect(title).toBe([info.phase, info.phaseReason].filter(Boolean).join(": ") || undefined);
      expect(tone).toBe(TONES[CLUSTER_TONE[info.state]]);
      // The built-in's text, which it sorted by.
      expect(cell("cluster-instances", c), JSON.stringify([c.spec, c.status])).toBe(`${info.ready}/${info.instances}`);
      expect(windowColumn("cluster-instances").value(c)).toBe(`${info.ready}/${info.instances}`);
      expect(cell("cluster-primary", c)).toBe(info.currentPrimary);
      expect(cell("cluster-phase", c)).toBe(info.phase);
    }
    expect([...states].sort()).toEqual(["failover", "healthy", "hibernated", "hibernating", "progressing", "switchover", "unhealthy"]);
    // The ready count Kubernetes leaves out is 0, as the built-in read it.
    const none = copy(cluster);
    delete st(none).readyInstances;
    expect(cell("cluster-instances", none)).toBe("0/3");
  });

  it("call unhealthy what the built-in's words matched, in any case", () => {
    const status = columnOf("cluster-status") as { cases: { when: { type: string; path?: string; values?: string[]; ignoreCase?: boolean } }[] };
    expect(status.cases[5]!.when).toEqual({ type: "contains", path: ".status.phase", values: ["unrecoverable", "cannot", "unable", "waiting for user", "error"], ignoreCase: true });
    const unhealthy = (phase: string) => {
      const c = copy(cluster);
      Object.assign(st(c), { phase, currentPrimary: "a", targetPrimary: "a" });
      st(c).conditions = [];
      return cell("cluster-status", c) === EN["state.unhealthy"];
    };
    // CloudNativePG's phases (api/v1/cluster_types.go, now and before) and made-up ones, against the built-in words.
    for (const phase of [
      "Waiting for user action",
      "Cluster cannot proceed to reconciliation due to an unknown plugin being required",
      "Cluster cannot proceed to reconciliation due to an error while interacting with plugins",
      "Cluster cannot proceed to reconciliation due to an unknown image catalog",
      "Cluster is unrecoverable and needs manual intervention",
      "Cluster is in an unrecoverable state, needs manual intervention",
      "Cluster cannot execute instance online upgrade due to missing architecture binary",
      "Unable to create required cluster objects",
      "UNRECOVERABLE",
      "Some Error",
      "Waiting For User",
    ]) {
      expect(STUCK_PHASE.test(phase), phase).toBe(true);
      expect(unhealthy(phase), phase).toBe(true);
    }
    for (const phase of [
      "Setting up primary",
      "Creating a new replica",
      "Upgrading cluster",
      "Upgrading Postgres major version",
      "Cluster upgrade delayed",
      "Primary instance is being restarted in-place",
      "Primary instance is being restarted without a switchover",
      "Waiting for the instances to become active",
      "Online upgrade in progress",
      "Applying configuration",
    ]) {
      expect(STUCK_PHASE.test(phase), phase).toBe(false);
      expect(unhealthy(phase), phase).toBe(false);
    }
  });

  it("of Backups: the state in words and tone with the error on hover, the Cluster, the method and when it started", () => {
    const now = Date.parse("2026-10-10T07:00:01Z");
    for (const phase of ["failed", "Failed", "fAILED", "walArchivingFailing", "WalArchivingFAILING", "completed", "COMPLETED", "started", "Running", "finaLizing", "pending", "", "failedx", undefined]) {
      const b = copy(backup);
      st(b).phase = phase;
      const state = backupState(b);
      expect(cell("backup-status", b), String(phase)).toBe(EN[`backupState.${state}`]);
      expect(windowColumn("backup-status").value(b)).toBe(state);
      expect(filtered("backup-status", b)).toBe(state);
      expect(drawn("backup-status", b)).toEqual({ title: "can't execute backup: exit status 1", tone: TONES[BACKUP_TONE[state]] });
    }
    expect(cell("backup-cluster", backup)).toBe("cluster-example");
    expect(cell("backup-method", backup)).toBe("barmanObjectStore");
    const plain = copy(backup);
    delete (plain.spec as Record<string, unknown>).method;
    st(plain).method = "volumeSnapshot";
    expect(cell("backup-method", plain)).toBe("volumeSnapshot");
    delete st(plain).method;
    expect(cell("backup-method", plain)).toBe("barmanObjectStore");
    expect(cell("backup-started", backup, now)).toBe("common:age.hours:7");
  });

  it("of ScheduledBackups and Poolers: as the built-in", () => {
    const now = Date.parse("2026-10-10T07:00:00Z");
    const scheduled = {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "ScheduledBackup",
      metadata: { name: "nightly", namespace: "db" },
      spec: { cluster: { name: "cluster-example" }, schedule: "0 0 0 * * *" },
      status: { lastScheduleTime: "2026-10-10T00:00:00Z" },
    } as unknown as KubeObject;
    expect(cell("scheduled-cluster", scheduled)).toBe("cluster-example");
    expect(cell("scheduled-schedule", scheduled)).toBe("0 0 0 * * *");
    expect(cell("scheduled-suspended", scheduled)).toBe("False");
    expect(cell("scheduled-suspended", { ...scheduled, spec: { suspend: true } } as KubeObject)).toBe("True");
    expect(cell("scheduled-last-backup", scheduled, now)).toBe("common:age.hours:7");
    const pooler = {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Pooler",
      metadata: { name: "pooler-rw", namespace: "db" },
      spec: { cluster: { name: "cluster-example" }, instances: 2, pgbouncer: { poolMode: "session" } },
    } as unknown as KubeObject;
    expect(cell("pooler-cluster", pooler)).toBe("cluster-example");
    expect(cell("pooler-type", pooler)).toBe("rw");
    expect(cell("pooler-type", { ...pooler, spec: { type: "ro" } } as KubeObject)).toBe("ro");
    expect(cell("pooler-instances", pooler)).toBe("2");
    expect(windowColumn("pooler-instances").value(pooler)).toBe(2);
    expect(cell("pooler-pool-mode", pooler)).toBe("session");
  });
});
