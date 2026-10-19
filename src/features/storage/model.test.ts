import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { i18n } from "../../i18n";
import {
  BACKUP,
  BACKUP_STORAGE_LOCATION,
  explainSnapshot,
  explainVelero,
  hasVeleroProblem,
  phaseTone,
  RESTORE,
  snapshotState,
  veleroNamespaceOf,
} from "./model";

const velero = (kind: string, status: Record<string, unknown>, spec: Record<string, unknown> = {}): KubeObject => ({
  apiVersion: "velero.io/v1",
  kind,
  metadata: { name: "nightly", namespace: "velero" },
  spec,
  status,
});

const texts = (kind: typeof BACKUP, obj: KubeObject) =>
  explainVelero(kind, obj).map((p) =>
    i18n.t(`storage:${p.key}`, { ...p.params, ...Object.fromEntries(Object.entries(p.lists ?? {}).map(([k, v]) => [k, v.join(", ")])) }),
  );

describe("Velero in plain words", () => {
  it("phases have tones, and failures count as problems", () => {
    expect(phaseTone("Completed")).toBe("success");
    expect(phaseTone("PartiallyFailed")).toBe("warning");
    expect(phaseTone("WaitingForPluginOperationsPartiallyFailed")).toBe("warning");
    expect(phaseTone("FailedValidation")).toBe("danger");
    expect(phaseTone("InProgress")).toBe("muted");
    expect(hasVeleroProblem(velero("Backup", { phase: "Failed" }))).toBe(true);
    expect(hasVeleroProblem(velero("Backup", { phase: "Completed" }))).toBe(false);
  });

  it("says why, how much went wrong and where the details are", () => {
    expect(texts(BACKUP, velero("Backup", { phase: "FailedValidation", validationErrors: ["a", "b"] }))).toEqual(["Velero refused it: a, b"]);
    expect(texts(BACKUP, velero("Backup", { phase: "Failed", failureReason: "bucket missing" }))).toEqual([
      "It failed: bucket missing",
      "The details are in the log: velero backup logs nightly",
    ]);
    expect(texts(RESTORE, velero("Restore", { phase: "PartiallyFailed", errors: 2, warnings: 1 }))).toEqual([
      "2 errors: some objects were not restored.",
      "1 warning.",
      "The details are in the log: velero restore logs nightly",
    ]);
    expect(texts(BACKUP, velero("Backup", { phase: "InProgress", progress: { itemsBackedUp: 3, totalItems: 10 } }))).toEqual([
      "3 of 10 items done.",
    ]);
    expect(texts(BACKUP_STORAGE_LOCATION, velero("BackupStorageLocation", { phase: "Unavailable", message: "403 from S3" }))).toEqual([
      "Velero cannot reach this storage location: 403 from S3",
    ]);
  });

  it("finds Velero's namespace by its default storage location", () => {
    const loc = (ns: string, isDefault: boolean): KubeObject => ({ metadata: { name: "l", namespace: ns }, spec: { default: isDefault } });
    expect(veleroNamespaceOf([loc("a", false), loc("b", true)])).toBe("b");
    expect(veleroNamespaceOf([loc("a", false)])).toBe("a");
    expect(veleroNamespaceOf([])).toBe("velero");
  });
});

describe("snapshots", () => {
  it("ready, failed with the driver's message, or waiting", () => {
    const snap = (status: Record<string, unknown>): KubeObject => ({ metadata: { name: "s" }, status });
    expect(snapshotState(snap({ readyToUse: true })).word).toBe("Ready");
    expect(snapshotState(snap({ readyToUse: false, error: { message: "quota" } }))).toEqual({ word: "Failed", tone: "danger" });
    expect(explainSnapshot(snap({ error: { message: "quota" } }))?.params).toEqual({ message: "quota" });
    expect(explainSnapshot(snap({}))?.key).toBe("snapshot.explain.unbound");
    expect(explainSnapshot(snap({ boundVolumeSnapshotContentName: "c" }))?.key).toBe("snapshot.explain.pending");
  });
});
