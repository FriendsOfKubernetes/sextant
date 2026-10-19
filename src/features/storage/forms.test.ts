import { describe, expect, it } from "vitest";
import {
  restoredClaimOf,
  sizeAtLeast,
  snapshotOf,
  stamp,
  suffixed,
  validName,
  validNamespace,
  validTtl,
  validVeleroName,
  veleroBackupOf,
  veleroRestoreOf,
} from "./forms";

describe("the objects the forms build", () => {
  it("a snapshot of a claim, with or without a class", () => {
    expect(snapshotOf({ namespace: "db", claim: "data-0", name: "data-0-snap", snapshotClass: "csi-hostpath" })).toEqual({
      apiVersion: "snapshot.storage.k8s.io/v1",
      kind: "VolumeSnapshot",
      metadata: { name: "data-0-snap", namespace: "db" },
      spec: { volumeSnapshotClassName: "csi-hostpath", source: { persistentVolumeClaimName: "data-0" } },
    });
    expect(snapshotOf({ namespace: "db", claim: "data-0", name: "s", snapshotClass: "" }).spec).toEqual({
      source: { persistentVolumeClaimName: "data-0" },
    });
  });

  it("a claim restored from a snapshot, in the snapshot's namespace", () => {
    expect(
      restoredClaimOf({
        namespace: "db",
        snapshot: "data-0-snap",
        name: "data-0-restore",
        size: "20Gi",
        storageClass: "fast",
        accessMode: "ReadWriteOnce",
        volumeMode: "Block",
      }),
    ).toEqual({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "data-0-restore", namespace: "db" },
      spec: {
        storageClassName: "fast",
        dataSource: { apiGroup: "snapshot.storage.k8s.io", kind: "VolumeSnapshot", name: "data-0-snap" },
        accessModes: ["ReadWriteOnce"],
        volumeMode: "Block",
        resources: { requests: { storage: "20Gi" } },
      },
    });
    const plain = restoredClaimOf({ namespace: "db", snapshot: "s", name: "r", size: "1Gi", storageClass: "", accessMode: "ReadWriteMany" });
    expect(plain.spec).not.toHaveProperty("storageClassName");
    expect(plain.spec).not.toHaveProperty("volumeMode");
  });

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
});

describe("validation", () => {
  it("sizes are quantities at least the restore size", () => {
    expect(sizeAtLeast("10Gi", "10Gi")).toBe(true);
    expect(sizeAtLeast("20Gi", "10Gi")).toBe(true);
    expect(sizeAtLeast("9Gi", "10Gi")).toBe(false);
    expect(sizeAtLeast("10737418240", "10Gi")).toBe(true);
    expect(sizeAtLeast("10 GB", undefined)).toBe(false);
    expect(sizeAtLeast("1Gi", undefined)).toBe(true);
  });

  it("names, namespaces and durations", () => {
    expect(validName("data-0.snap")).toBe(true);
    expect(validName("Data")).toBe(false);
    expect(validVeleroName("a".repeat(64))).toBe(false);
    expect(validNamespace("shop.prod")).toBe(false);
    expect(validTtl("720h0m0s")).toBe(true);
    expect(validTtl("30d")).toBe(false);
    expect(validTtl("")).toBe(false);
  });

  it("generated names fit in 63 characters", () => {
    expect(stamp(new Date(2026, 9, 19, 14, 32))).toBe("20261019-1432");
    const name = suffixed(`${"a".repeat(60)}-`, "20261019-1432");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(validVeleroName(name)).toBe(true);
  });
});
