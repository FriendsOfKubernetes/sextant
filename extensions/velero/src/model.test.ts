// The model, the forms and the manifest's declarative parts. The manifest's columns, its kinds' "Only problems" and
// its action conditions are judged here by Sextant's own window engine (src/extensions/problemRules.ts and
// columns.tsx, loaded at run time so the type check stays inside the extension) and compared with the model they
// replace — the reading of Sextant's former built-in view, ported unchanged — on the fixtures in `fixtures/`.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import fixtures from "../fixtures/objects.json";
import { explanation } from "./details";
import { stamp, suffixed, validNamespace, validTtl, validVeleroName, veleroBackupOf, veleroRestoreOf } from "./forms";
import {
  BACKUP,
  BACKUP_STORAGE_LOCATION,
  errorCount,
  explainVelero,
  get,
  hasVeleroProblem,
  includedNamespaces,
  phaseOf,
  phaseTone,
  RESTORE,
  SCHEDULE,
  VOLUME_SNAPSHOT_LOCATION,
  veleroNamespaceOf,
  warningCount,
  type KindOf,
} from "./model";

const f = fixtures as unknown as Record<string, KubeObject>;
const fx = (name: string): KubeObject => structuredClone(f[name]!);
const all = Object.keys(f).map(fx);
const ofKind = (kind: string) => all.filter((o) => o.kind === kind);
const KIND_OF: Record<string, KindOf> = {
  Backup: BACKUP,
  Schedule: SCHEDULE,
  Restore: RESTORE,
  BackupStorageLocation: BACKUP_STORAGE_LOCATION,
  VolumeSnapshotLocation: VOLUME_SNAPSHOT_LOCATION,
};
const velero = all.filter((o) => o.kind! in KIND_OF);

/** Every phase Velero writes (pkg/apis/velero/v1), and ones it may add (the built-in matched `…PartiallyFailed`). */
const PHASES = [
  "New",
  "FailedValidation",
  "InProgress",
  "WaitingForPluginOperations",
  "WaitingForPluginOperationsPartiallyFailed",
  "Finalizing",
  "FinalizingPartiallyFailed",
  "Completed",
  "PartiallyFailed",
  "Failed",
  "Deleting",
  "Enabled",
  "Available",
  "Unavailable",
  "SomethingNew",
  "UploadingPartiallyFailed",
  "PartiallyFailedRetrying",
];
const withPhase = (obj: KubeObject, phase: string | undefined): KubeObject => {
  const copy = structuredClone(obj);
  copy.status = { ...(copy.status ?? {}) };
  if (phase === undefined) delete copy.status.phase;
  else copy.status.phase = phase;
  return copy;
};

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  filter?: { type: string; value(obj: KubeObject, ctx: { now: number }): unknown };
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
/** Sextant's own `formatList` (src/i18n/format.ts), which the window's list cells use. */
let windowList: (items: readonly string[]) => string;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  ({ formatList: windowList } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/format.ts"))) as { formatList: typeof windowList });
});

const holds = (condition: unknown, obj: KubeObject) => engine.evaluate(condition, obj).holds;
type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.velero:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
/** A cell's text, as the window searches and copies it; ages as `common:age.<unit>:<count>`. */
const cell = (id: string, obj: KubeObject, now = Date.now()) => windowColumn(id).searchText(obj, { now, t: T }) ?? undefined;
/** A cell's tone: that of the status word it draws, nothing for plain text. */
function toneOf(id: string, obj: KubeObject): string | undefined {
  const drawn = windowColumn(id).render(obj, { now: Date.now() }) as { props?: { tone?: string } } | string | null;
  return typeof drawn === "object" && drawn !== null ? drawn.props?.tone : undefined;
}
const kindEntry = (kind: string) => manifest.contributes.kinds.find((k) => k.kind === kind)!;
const actionOf = (id: string) => manifest.contributes.actions.find((a) => a.id === id)!;
/** The phrases of the built-in view, in English. */
const texts = (kind: KindOf, obj: KubeObject) => explainVelero(kind, obj).map((p) => explanation(p).textContent);

// ---------- The model ----------

describe("Velero in plain words", () => {
  it("a phase's tone and what needs attention", () => {
    expect(phaseTone("Completed")).toBe("success");
    expect(phaseTone("WaitingForPluginOperationsPartiallyFailed")).toBe("warning");
    expect(phaseTone("FailedValidation")).toBe("danger");
    expect(phaseTone("InProgress")).toBe("muted");
    expect(phaseTone(undefined)).toBe("muted");
    expect(hasVeleroProblem(fx("backupFailed"))).toBe(true);
    expect(hasVeleroProblem(fx("backupCompleted"))).toBe(false);
  });

  it("why it was refused or failed, how much went wrong, how far it got", () => {
    expect(texts(BACKUP, fx("backupFailedValidation"))).toEqual([
      "Velero refused it: an existing backup storage location wasn't specified at backup creation time and the default 'missing' wasn't found, an existing backup storage location is required",
    ]);
    expect(texts(BACKUP, fx("backupFailed"))).toEqual([
      "It failed: error checking if backup already exists in object storage: rpc error: code = Unknown desc = AccessDenied",
      "The details are in the log: velero backup logs nightly-20261020020000",
    ]);
    expect(texts(RESTORE, fx("restorePartiallyFailed"))).toEqual([
      "2 errors: some objects were not restored.",
      "1 warning.",
      "The details are in the log: velero restore logs nightly-restore",
    ]);
    expect(texts(BACKUP, fx("backupInProgress"))).toEqual(["3 of 10 items done."]);
    expect(texts(RESTORE, fx("restoreFromSchedule"))).toEqual(["7 of 50 items done."]);
    expect(texts(BACKUP, fx("backupDeleting"))).toEqual(["Velero is deleting it."]);
    expect(texts(SCHEDULE, fx("schedulePaused"))).toEqual(["Paused: no new backups are made."]);
    expect(texts(BACKUP_STORAGE_LOCATION, fx("locationUnavailable"))).toEqual([
      'Velero cannot reach this storage location: BackupStorageLocation "archive" is unavailable: rpc error: code = Unknown desc = AccessDenied: Access Denied status code: 403',
    ]);
    const noMessage = fx("locationUnavailable");
    delete noMessage.status!.message;
    expect(texts(BACKUP_STORAGE_LOCATION, noMessage)).toEqual(["Velero cannot reach this storage location: check its credentials and bucket."]);
    expect(texts(BACKUP, withPhase(fx("backupFailed"), "Failed"))).toHaveLength(2);
    const failedNoReason = fx("backupFailed");
    delete failedNoReason.status!.failureReason;
    delete failedNoReason.status!.errors;
    expect(texts(BACKUP, failedNoReason)).toEqual([
      "It failed; Velero gave no reason.",
      "The details are in the log: velero backup logs nightly-20261020020000",
    ]);
    expect(texts(BACKUP, fx("backupCompleted"))).toEqual(["2 warnings."]);
    expect(texts(BACKUP_STORAGE_LOCATION, fx("locationDefault"))).toEqual([]);
  });

  it("finds Velero's namespace by its default storage location, else the first, else velero", () => {
    expect(veleroNamespaceOf([fx("locationOther"), fx("locationDefault")])).toBe("velero");
    const otherDefault = fx("locationOther");
    otherDefault.spec!.default = true;
    const notDefault = fx("locationDefault");
    notDefault.spec!.default = false;
    expect(veleroNamespaceOf([notDefault, otherDefault])).toBe("backup-system");
    expect(veleroNamespaceOf([fx("locationOther")])).toBe("backup-system");
    expect(veleroNamespaceOf([])).toBe("velero");
  });

  it("the namespaces of a backup, of a schedule's template, or every one", () => {
    expect(includedNamespaces(fx("backupFailed"))).toEqual(["shop", "db"]);
    expect(includedNamespaces(fx("scheduleEnabled"))).toEqual(["shop", "db"]);
    expect(includedNamespaces(fx("backupInProgress"))).toEqual([]);
  });
});

describe("the objects the actions create", () => {
  it("a Velero backup of one namespace, in Velero's namespace", () => {
    expect(veleroBackupOf({ veleroNamespace: "velero", name: "shop-20261019-1432", namespace: "shop", ttl: "720h0m0s", storageLocation: "" })).toEqual({
      apiVersion: "velero.io/v1",
      kind: "Backup",
      metadata: { name: "shop-20261019-1432", namespace: "velero" },
      spec: { includedNamespaces: ["shop"], ttl: "720h0m0s" },
    });
    expect(veleroBackupOf({ veleroNamespace: "v", name: "b", namespace: "shop", ttl: "1h", storageLocation: "aws" }).spec).toMatchObject({
      storageLocation: "aws",
    });
  });

  it("a Velero restore, mapping only the namespaces that change", () => {
    expect(veleroRestoreOf({ veleroNamespace: "velero", name: "r1", backup: "b1", mapping: { shop: "shop-copy", db: "", api: "api" } })).toEqual({
      apiVersion: "velero.io/v1",
      kind: "Restore",
      metadata: { name: "r1", namespace: "velero" },
      spec: { backupName: "b1", namespaceMapping: { shop: "shop-copy" } },
    });
    expect(veleroRestoreOf({ veleroNamespace: "velero", name: "r1", backup: "b1", mapping: {} }).spec).toEqual({ backupName: "b1" });
  });

  it("names Velero also writes as labels, namespaces, TTLs and the suffix", () => {
    expect(validVeleroName("shop-20261019-1432")).toBe(true);
    expect(validVeleroName("a".repeat(64))).toBe(false);
    expect(validVeleroName("Shop")).toBe(false);
    expect(validNamespace("shop-copy")).toBe(true);
    expect(validNamespace("shop.copy")).toBe(false);
    expect(validTtl("720h0m0s")).toBe(true);
    expect(validTtl("72h30m")).toBe(true);
    expect(validTtl("")).toBe(false);
    expect(validTtl("3d")).toBe(false);
    expect(stamp(new Date(2026, 9, 19, 14, 32))).toBe("20261019-1432");
    const name = suffixed("a-very-long-namespace-name-that-goes-on-and-on-and-on-forever", "20261019-1432");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith("-20261019-1432")).toBe(true);
    expect(validVeleroName(name)).toBe(true);
    expect(suffixed("db-", "x")).toBe("db-x");
  });
});

// ---------- The manifest against the model ----------

describe("the kinds' \"Only problems\"", () => {
  it("is the built-in problem: failed, partly failed, refused or unreachable", () => {
    for (const obj of velero) {
      for (const phase of [...PHASES, undefined]) {
        const o = withPhase(obj, phase);
        expect(holds(kindEntry(obj.kind!).problemWhen, o), `${obj.kind} ${phase}`).toBe(hasVeleroProblem(o));
      }
    }
  });
});

describe("the columns", () => {
  const phaseColumns: Record<string, string> = {
    Backup: "backup-phase",
    Schedule: "schedule-phase",
    Restore: "restore-phase",
    BackupStorageLocation: "location-phase",
    VolumeSnapshotLocation: "snapshot-location-phase",
  };

  it("the phase, in the built-in tones", () => {
    for (const obj of velero) {
      const id = phaseColumns[obj.kind!]!;
      for (const phase of PHASES) {
        const o = withPhase(obj, phase);
        expect(cell(id, o), `${id} ${phase}`).toBe(phaseOf(o));
        expect(toneOf(id, o), `${id} ${phase}`).toBe(phaseTone(phase));
      }
      expect(cell(id, withPhase(obj, undefined))).toBeUndefined();
    }
  });

  it("errors and warnings: the count, coloured when there are any, 0 when Velero wrote none", () => {
    for (const [kind, prefix] of [
      ["Backup", "backup"],
      ["Restore", "restore"],
    ] as const) {
      for (const obj of ofKind(kind)) {
        expect(cell(`${prefix}-errors`, obj), obj.metadata.name).toBe(String(errorCount(obj)));
        expect(cell(`${prefix}-warnings`, obj), obj.metadata.name).toBe(String(warningCount(obj)));
        expect(toneOf(`${prefix}-errors`, obj)).toBe(errorCount(obj) > 0 ? "danger" : undefined);
        expect(toneOf(`${prefix}-warnings`, obj)).toBe(warningCount(obj) > 0 ? "warning" : undefined);
      }
    }
    const zero = fx("backupCompleted");
    zero.status!.errors = 0;
    expect(cell("backup-errors", zero)).toBe("0");
    expect(windowColumn("backup-errors").value(zero)).toBe(0);
    expect(windowColumn("backup-errors").value(fx("backupNew"))).toBe(0);
    // Above 0 the count is written by a case (to colour it) whose value is the count read as a number: it sorts and
    // filters as the built-in's number.
    for (const [kind, prefix] of [
      ["Backup", "backup"],
      ["Restore", "restore"],
    ] as const) {
      for (const obj of ofKind(kind)) {
        for (const [id, of] of [
          [`${prefix}-errors`, errorCount],
          [`${prefix}-warnings`, warningCount],
        ] as const) {
          const column = windowColumn(id);
          expect(column.value(obj), `${id} ${obj.metadata.name}`).toBe(of(obj));
          expect(column.filter!.type).toBe("number");
          expect(column.filter!.value(obj, { now: Date.now() })).toBe(of(obj));
        }
      }
    }
    const many = fx("backupFailed");
    many.status!.errors = 10;
    expect(windowColumn("backup-errors").value(many)).toBe(10);
    expect(windowColumn("backup-errors").filter!.value(many, { now: Date.now() })).toBe(10);
  });

  it("the namespaces, * for every one", () => {
    // The built-in column: `formatList(includedNamespaces(o)) || "*"`, Sextant's own list separator.
    for (const obj of ofKind("Backup")) expect(cell("backup-namespaces", obj), obj.metadata.name).toBe(windowList(includedNamespaces(obj)) || "*");
    for (const obj of ofKind("Schedule")) expect(cell("schedule-namespaces", obj), obj.metadata.name).toBe(windowList(includedNamespaces(obj)) || "*");
    expect(cell("backup-namespaces", fx("backupFailed"))).toBe(windowList(["shop", "db"]));
    expect(cell("backup-namespaces", fx("backupFailedValidation"))).toBe("*");
    expect(cell("backup-namespaces", fx("backupDeleting"))).toBe("*");
  });

  it("paused and default: \"true\" or blank, sorted and filtered by that text as the built-in columns' value", () => {
    const check = (id: string, obj: KubeObject, path: string[]) => {
      const built = get(obj, ...path) === true ? "true" : "";
      const column = windowColumn(id);
      expect(cell(id, obj), `${id} ${obj.metadata.name}`).toBe(built);
      expect(column.value(obj)).toBe(built);
      expect(column.filter!.value(obj, { now: Date.now() })).toBe(built);
    };
    for (const obj of ofKind("Schedule")) {
      check("schedule-paused", obj, ["spec", "paused"]);
      for (const paused of [true, false, "true", undefined]) {
        const o = structuredClone(obj);
        if (paused === undefined) delete o.spec!.paused;
        else o.spec!.paused = paused;
        check("schedule-paused", o, ["spec", "paused"]);
      }
    }
    for (const obj of ofKind("BackupStorageLocation")) check("location-default", obj, ["spec", "default"]);
    const noSpec = fx("locationDefault");
    delete noSpec.spec;
    check("location-default", noSpec, ["spec", "default"]);
  });

  it("the built-in columns' widths", () => {
    // `src/features/storage/columns.tsx`: phaseColumn 150px, countColumn 80px, timeColumn 90px, namespacesColumn
    // minmax(120px, 1.5fr), and each column's own.
    const BUILT_IN: Record<string, string> = {
      "backup-namespaces": "minmax(120px, 1.5fr)",
      "backup-phase": "150px",
      "backup-errors": "80px",
      "backup-warnings": "80px",
      "backup-completed": "90px",
      "schedule-schedule": "120px",
      "schedule-namespaces": "minmax(120px, 1.5fr)",
      "schedule-paused": "70px",
      "schedule-phase": "150px",
      "schedule-last-backup": "90px",
      "restore-backup": "minmax(140px, 1.5fr)",
      "restore-phase": "150px",
      "restore-errors": "80px",
      "restore-warnings": "80px",
      "location-provider": "100px",
      "location-bucket": "minmax(120px, 1fr)",
      "location-default": "80px",
      "location-phase": "150px",
      "location-last-validated": "90px",
      "snapshot-location-provider": "120px",
      "snapshot-location-phase": "150px",
    };
    expect(Object.fromEntries(manifest.contributes.columns.map((c) => [c.id, windowColumn(c.id).width]))).toEqual(BUILT_IN);
  });

  it("the fields and ages the built-in columns showed", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(cell("schedule-schedule", fx("scheduleEnabled"))).toBe("0 2 * * *");
    expect(cell("schedule-last-backup", fx("scheduleEnabled"), now)).toBe("common:age.days:1");
    expect(cell("backup-completed", fx("backupCompleted"), now)).toBe("common:age.days:1");
    expect(cell("backup-completed", fx("backupInProgress"), now)).toBeUndefined();
    expect(cell("restore-backup", fx("restoreCompleted"))).toBe("shop-20261019-1432");
    expect(cell("restore-backup", fx("restoreFromSchedule"))).toBe("nightly");
    expect(cell("location-provider", fx("locationDefault"))).toBe("aws");
    expect(cell("location-bucket", fx("locationDefault"))).toBe("velero-backups");
    expect(cell("location-last-validated", fx("locationDefault"), now)).toBe("common:age.minutes:1");
    expect(cell("snapshot-location-provider", fx("snapshotLocationNoStatus"))).toBe("velero.io/csi");
  });

  it("go after Namespace in the built-in order", () => {
    const order = (kind: string) => {
      const own = manifest.contributes.columns.filter((c) => c.kind.kind === kind);
      const out: string[] = [];
      let after = "namespace";
      for (;;) {
        const next = own.find((c) => c.afterColumn === after);
        if (!next) break;
        out.push(next.title);
        after = next.id;
      }
      expect(out).toHaveLength(own.length);
      return out;
    };
    expect(order("Backup")).toEqual(["Namespaces", "Phase", "Errors", "Warnings", "Completed"]);
    expect(order("Schedule")).toEqual(["Schedule", "Namespaces", "Paused", "Phase", "Last backup"]);
    expect(order("Restore")).toEqual(["Backup", "Phase", "Errors", "Warnings"]);
    expect(order("BackupStorageLocation")).toEqual(["Provider", "Bucket", "Default", "Phase", "Validated"]);
    expect(order("VolumeSnapshotLocation")).toEqual(["Provider", "Phase"]);
  });
});

describe("the actions' conditions", () => {
  it("back up a namespace unless it is terminating", () => {
    const when = actionOf("back-up-namespace").when;
    expect(holds(when, fx("namespaceShop"))).toBe(true);
    expect(holds(when, fx("namespaceTerminating"))).toBe(false);
    expect(actionOf("back-up-namespace").kinds).toEqual([{ group: "", kind: "Namespace" }]);
    // Only where the cluster serves Velero's Backups, as the built-in action's `served(BACKUP)`.
    expect(actionOf("back-up-namespace").requiresKinds).toEqual([{ group: "velero.io", kind: "Backup" }]);
  });

  it("restore from a backup unless Velero is deleting it", () => {
    const when = actionOf("restore-backup").when;
    for (const obj of ofKind("Backup")) expect(holds(when, obj), obj.metadata.name).toBe(get(obj, "status", "phase") !== "Deleting");
  });
});
