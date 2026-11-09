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
const setCondition = (type: string, status?: string, reason?: string, since?: string): Vary => (c) => {
  const list = conditions(c).filter((x) => x.type !== type);
  if (status !== undefined) list.push({ type, status, ...(reason ? { reason } : {}), ...(since ? { lastTransitionTime: since, message: `${type} says ${status}` } : {}) });
  st(c).conditions = list;
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
  ],
  phase: [
    set("phase", HEALTHY_PHASE),
    set("phase", "Switchover in progress"),
    set("phase", "Failing over"),
    set("phase", "Setting up primary"),
    set("phase", "Cluster is unrecoverable and needs manual intervention"),
    set("phase", undefined),
  ],
  ready: [
    setCondition("Ready", "False", "ClusterIsNotReady", "2026-10-10T08:00:00Z"),
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
  ],
  phaseReason: [set("phaseReason", "Switching over to cluster-example-2"), set("phaseReason", undefined)],
};

function* combinations(axes: Vary[][], at = 0, chosen: Vary[] = []): Generator<Vary[]> {
  if (at === axes.length) {
    yield chosen;
    return;
  }
  for (const vary of axes[at]!) yield* combinations(axes, at + 1, [...chosen, vary]);
}

/** The fixture with archiving and backups working, varied along every axis: 4320 Clusters. */
function clusters(extra: Vary[] = []): KubeObject[] {
  const out: KubeObject[] = [];
  for (const varies of combinations(Object.values(AXES))) {
    const c = copy(cluster);
    st(c).conditions = [];
    for (const vary of [...varies, ...extra]) vary(c);
    out.push(c);
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
  it("find what the built-in rules found, for every Cluster the fields make", () => {
    let found = 0;
    for (const c of clusters()) {
      const builtIn = cnpgProblems("Cluster", c).map((p) => said(p));
      const ours = detected("Cluster", c).map((d) => said({ ...d, group: d.group }));
      expect(ours, JSON.stringify(c.status)).toEqual(builtIn);
      found += builtIn.length;
    }
    // Most combinations are not ready, a hibernated or healthy one is not.
    expect(found).toBeGreaterThan(2000);
  });

  it("never hold together: one problem of readiness at most", () => {
    for (const c of clusters()) expect(detected("Cluster", c).filter((d) => d.group === "not-ready").length).toBeLessThanOrEqual(1);
  });

  it("count a Cluster not ready after five minutes from its Ready condition's change", () => {
    const [d] = detected("Cluster", cluster);
    expect(d).toMatchObject({ reason: "ClusterIsNotReady", graceMs: CLUSTER_GRACE_MS, since: "2026-10-10T08:00:00Z", group: "not-ready", message: "Switchover in progress" });
    expect(rules.filter((r) => r.id.startsWith("cluster-not-ready")).every((r) => r.graceMinutes === 5)).toBe(true);
  });

  it("tell failing archiving and backups at once, with the conditions' reasons and messages", () => {
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
  const PHASES = ["failed", "Failed", "walArchivingFailing", "completed", "running", "pending", undefined];
  const TIMES = ["stoppedAt", "reconciliationTerminatedAt", "startedAt", "reconciliationStartedAt"] as const;

  it("find a failed Backup for a day from when it stopped, timed as the built-in timed it", () => {
    const now0 = Date.parse("2026-10-10T00:00:00Z");
    let counted = 0;
    for (const phase of PHASES) {
      for (let mask = 0; mask < 1 << TIMES.length; mask++) {
        const b = copy(backup);
        const s = st(b);
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

  it("show in Only problems what the built-in tables did: Clusters with a problem (no grace), every failed Backup", () => {
    const extra: Vary[][] = [
      [],
      [setCondition("ContinuousArchiving", "False", "ContinuousArchivingFailing")],
      [setCondition("LastBackupSucceeded", "False", "LastBackupFailed")],
      [(c) => void (c.metadata.deletionTimestamp = "2026-10-10T09:00:00Z")],
    ];
    for (const more of extra) {
      for (const c of clusters(more)) {
        // Where the README says: the healthy phase with only one of the primaries named.
        const halfNamed = st(c).phase === HEALTHY_PHASE && (st(c).currentPrimary === undefined) !== (st(c).targetPrimary === undefined);
        if (halfNamed) continue;
        expect(holdsNow(kindEntry("Cluster").problemWhen, c), JSON.stringify(c.status)).toBe(isProblem(c, "Cluster"));
      }
    }
    expect(holdsNow(kindEntry("Cluster").problemWhen, cluster)).toBe(true);
    expect(holdsNow(kindEntry("Backup").problemWhen, backup)).toBe(true);
  });

  it("have one details section for the four kinds, where the built-in one was", () => {
    expect(manifest.contributes.detailsSections).toEqual([
      {
        id: "cnpg",
        title: "CloudNativePG",
        kinds: ["Cluster", "Backup", "ScheduledBackup", "Pooler"].map((kind) => ({ group: "postgresql.cnpg.io", kind })),
        placement: "section",
        order: 20,
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

const TONES: Record<string, string> = { success: "success", danger: "danger", warning: "warning", muted: "neutral" };

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
    const titles = Object.fromEntries(manifest.contributes.columns.map((c) => [c.id, c.title]));
    expect(titles).toMatchObject({ "cluster-status": "Status", "cluster-instances": "Instances", "backup-started": "Started", "scheduled-last-backup": "Last backup", "pooler-pool-mode": "Pool mode" });
  });

  it("of Clusters: the state in words and tone, the phase and its reason on hover, ready of desired, the primary and phase", () => {
    let states = new Set<string>();
    for (const c of clusters()) {
      const info = clusterInfo(c);
      states = states.add(info.state);
      expect(cell("cluster-status", c), JSON.stringify(c.status)).toBe(EN[`state.${info.state}`]);
      const { title, tone } = drawn("cluster-status", c);
      expect(title).toBe([info.phase, info.phaseReason].filter(Boolean).join(": ") || undefined);
      expect(tone).toBe(TONES[CLUSTER_TONE[info.state]]);
      if (st(c).readyInstances !== undefined) expect(cell("cluster-instances", c)).toBe(`${info.ready}/${info.instances}`);
      expect(cell("cluster-primary", c)).toBe(info.currentPrimary);
      expect(cell("cluster-phase", c)).toBe(info.phase);
    }
    expect([...states].sort()).toEqual(["failover", "healthy", "hibernated", "hibernating", "progressing", "switchover", "unhealthy"]);
    // The ready count Kubernetes leaves out is 0, as the built-in read it.
    const none = copy(cluster);
    delete st(none).readyInstances;
    expect(cell("cluster-instances", none)).toBe("0/3");
  });

  it("call unhealthy exactly the phases the built-in's words named", () => {
    const status = columnOf("cluster-status") as { cases: { when: { type: string; path?: string; values?: string[] } }[] };
    const stuck = status.cases.find((c) => c.when.type === "in" && c.when.path === ".status.phase" && c.when.values!.includes("Waiting for user action"))!.when.values!;
    for (const phase of stuck) expect(STUCK_PHASE.test(phase), phase).toBe(true);
    // CloudNativePG's other phases (api/v1/cluster_types.go): none of them is unhealthy.
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
    }
  });

  it("of Backups: the state in words and tone with the error on hover, the Cluster, the method and when it started", () => {
    const now = Date.parse("2026-10-10T07:00:01Z");
    for (const phase of ["failed", "Failed", "walArchivingFailing", "completed", "started", "running", "finalizing", "pending", "", undefined]) {
      const b = copy(backup);
      st(b).phase = phase;
      const state = backupState(b);
      expect(cell("backup-status", b), String(phase)).toBe(EN[`backupState.${state}`]);
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
