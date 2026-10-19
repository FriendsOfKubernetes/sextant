import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, KindRef, KubeObject, ResourceKind, VolumeUsageReport } from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import { resetAppStore, useAppStore } from "../../app/store";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { loadClusterKinds, resetClusterKinds } from "../../resources";
import { getAction, getActionsFor, runAction, type ActionId } from "../actions/registry";
import { watchBackend, type WatchBackend } from "../details/testing";
import { CATEGORY_SOURCES, sourceKey } from "../problems/sources";
import { acquireSource, getSource, resetProblemSources } from "../problems/store";
import "./index";
import { BACKUP, NAMESPACE, PVC, VOLUME_SNAPSHOT } from "./model";
import { acquireVolumeUsage, getVolumeUsage, LINGER_MS, resetVolumeUsage, USAGE_POLL_MS, volumeUsageStats } from "./usageStore";

function obj(kind: KindRef, name: string, namespace: string | undefined, extra: Record<string, unknown> = {}): KubeObject {
  return {
    apiVersion: kind.group ? `${kind.group}/${kind.version}` : kind.version,
    kind: kind.kind,
    metadata: { name, namespace, uid: `${kind.kind}-${name}` },
    ...extra,
  };
}

const served = (kinds: KindRef[]): ResourceKind[] =>
  kinds.map((kindRef) => ({ kindRef, plural: `${kindRef.kind.toLowerCase()}s`, namespaced: true, verbs: ["list"], printerColumns: [] }));

const report = (volumes: VolumeUsageReport["volumes"]): VolumeUsageReport => ({
  source: "kubelet",
  volumes,
  nodes: 1,
  nodesFailed: 0,
  kubeletForbidden: false,
  truncated: false,
});

let wb: WatchBackend;
beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetVolumeUsage();
  resetProblemSources();
  wb = watchBackend();
  render(<ActionDialogHost />);
  while (screen.queryAllByRole("dialog").length > 0) fireEvent.keyDown(window, { key: "Escape" });
});
afterEach(() => {
  vi.useRealTimers();
  wb.backend.restore();
});

const calls = (cmd: string) => wb.backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

async function serve(kinds: KindRef[]) {
  wb.backend.on("cluster_kinds", () => served(kinds));
  useAppStore.setState({ activeClusterId: "c1" });
  loadClusterKinds("c1");
  await waitFor(() => expect(calls("cluster_kinds")).toHaveLength(1));
  await act(async () => undefined);
}

async function run(id: ActionId, kind: KindRef, objects: KubeObject[]) {
  await act(async () => {
    await runAction(getAction(id)!, "c1", kind, objects);
  });
}


describe("actions are offered only where they can work", () => {
  const bound = obj(PVC, "data-0", "db", { status: { phase: "Bound" } });
  const ids = (o: KubeObject, kind: KindRef, list: ActionId[]) => getActionsFor([o], kind, list).map((a) => a.id);

  it("snapshots of bound claims and Velero backups of namespaces need their APIs", async () => {
    expect(ids(bound, PVC, ["snapshotCreate"])).toEqual([]);
    expect(ids(obj(NAMESPACE, "shop", undefined), NAMESPACE, ["veleroBackup"])).toEqual([]);
    await serve([VOLUME_SNAPSHOT, BACKUP]);
    expect(ids(bound, PVC, ["snapshotCreate"])).toEqual(["snapshotCreate"]);
    expect(ids(obj(PVC, "x", "db", { status: { phase: "Pending" } }), PVC, ["snapshotCreate"])).toEqual([]);
    expect(ids(obj(NAMESPACE, "shop", undefined), NAMESPACE, ["veleroBackup"])).toEqual(["veleroBackup"]);
  });

  it("a snapshot is restored only once it is ready", () => {
    const ready = obj(VOLUME_SNAPSHOT, "s", "db", { status: { readyToUse: true } });
    expect(ids(ready, VOLUME_SNAPSHOT, ["snapshotRestore"])).toEqual(["snapshotRestore"]);
    expect(ids(obj(VOLUME_SNAPSHOT, "s", "db", { status: { readyToUse: false } }), VOLUME_SNAPSHOT, ["snapshotRestore"])).toEqual([]);
  });
});

describe("create snapshot", () => {
  const claim = obj(PVC, "data-0", "db", { status: { phase: "Bound" }, spec: { storageClassName: "standard" } });

  it("lists the one object on the confirmation and applies exactly it", async () => {
    wb.backend.on("resource_create", () => ({}));
    await run("snapshotCreate", PVC, [claim]);
    const form = screen.getByRole("dialog", { name: "Create a snapshot of data-0" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "data-0-before-upgrade" } });
    expect(calls("resource_create")).toHaveLength(0);
    fireEvent.click(within(form).getByRole("button", { name: "Review" }));

    const confirm = screen.getByRole("dialog", { name: "Create a snapshot of data-0" });
    expect(within(confirm).getByRole("list", { name: "Objects to create" }).textContent).toBe("VolumeSnapshot db/data-0-before-upgrade");
    expect(calls("resource_create")).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Create" }));
    await screen.findByText("Created VolumeSnapshot db/data-0-before-upgrade.");

    expect(calls("resource_create")).toEqual([
      {
        clusterId: "c1",
        yaml: [
          "apiVersion: snapshot.storage.k8s.io/v1",
          "kind: VolumeSnapshot",
          "metadata:",
          "  name: data-0-before-upgrade",
          "  namespace: db",
          "spec:",
          "  source:",
          "    persistentVolumeClaimName: data-0",
          "",
        ].join("\n"),
      },
    ]);
  });

  it("never touches an object of the same name", async () => {
    // The API server refuses the create of a name that exists (AlreadyExists): nothing else is sent.
    wb.backend.on("resource_create", () => {
      throw { code: "conflict", message: "volumesnapshots \"taken\" already exists" };
    });
    await run("snapshotCreate", PVC, [claim]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText(/VolumeSnapshot db\/taken already exists/);
    expect(calls("resource_create")).toHaveLength(1);
    expect(calls("resource_apply")).toHaveLength(0);
  });

  it("a name that is not valid cannot be reviewed", async () => {
    await run("snapshotCreate", PVC, [claim]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Not_Valid" } });
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("restore to a new PVC", () => {
  it("asks for at least the restore size and creates the claim in the snapshot's namespace", async () => {
    wb.backend.on("resource_create", () => ({}));
    const snapshot = obj(VOLUME_SNAPSHOT, "snap", "db", {
      spec: { source: { persistentVolumeClaimName: "gone" } },
      status: { readyToUse: true, restoreSize: "10Gi" },
    });
    await run("snapshotRestore", VOLUME_SNAPSHOT, [snapshot]);
    const size = screen.getByLabelText("Size");
    expect((size as HTMLInputElement).value).toBe("10Gi");
    fireEvent.change(size, { target: { value: "5Gi" } });
    expect(screen.getByText("Enter a size of at least 10Gi, such as 10Gi.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(size, { target: { value: "20Gi" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("list", { name: "Objects to create" }).textContent).toBe("PersistentVolumeClaim db/snap-restore");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Created PersistentVolumeClaim db/snap-restore.");
    const yaml = calls("resource_create")[0]!.yaml as string;
    expect(yaml).toContain("dataSource:\n    apiGroup: snapshot.storage.k8s.io\n    kind: VolumeSnapshot\n    name: snap");
    expect(yaml).toContain("storage: 20Gi");
  });
});

describe("Velero", () => {
  it("backs up a namespace in Velero's namespace, found by its storage locations", async () => {
    wb.backend.on("resource_create", () => ({}));
    await run("veleroBackup", NAMESPACE, [obj(NAMESPACE, "shop", undefined)]);
    const id = [...wb.specs.entries()].find(([, s]) => s.kind.kind === "BackupStorageLocation")![0];
    act(() =>
      wb.backend.emit(`watch:${id}`, {
        type: "snapshot",
        items: [obj({ group: "velero.io", version: "v1", kind: "BackupStorageLocation" }, "default", "backup-system", { spec: { default: true } })],
      }),
    );
    expect((screen.getByLabelText("Velero namespace") as HTMLInputElement).value).toBe("backup-system");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "shop-now" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("list", { name: "Objects to create" }).textContent).toBe("Backup backup-system/shop-now");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Created Backup backup-system/shop-now.");
    expect(calls("resource_create")[0]!.yaml).toBe(
      ["apiVersion: velero.io/v1", "kind: Backup", "metadata:", "  name: shop-now", "  namespace: backup-system", "spec:", "  includedNamespaces:", "  - shop", "  ttl: 720h0m0s", ""].join("\n"),
    );
  });

  it("a restore says that Velero skips what already exists, and maps namespaces", async () => {
    wb.backend.on("resource_create", () => ({}));
    const backup = obj(BACKUP, "nightly", "velero", { spec: { includedNamespaces: ["shop"] }, status: { phase: "Completed" } });
    await run("veleroRestore", BACKUP, [backup]);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "nightly-copy" } });
    fireEvent.change(screen.getByLabelText("Namespace shop into"), { target: { value: "shop-copy" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText(/Velero skips most objects that already exist/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "Objects to create" }).textContent).toBe("Restore velero/nightly-copy");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByText("Created Restore velero/nightly-copy.");
    expect(calls("resource_create")[0]!.yaml).toContain("namespaceMapping:\n    shop: shop-copy");
  });
});

describe("usage polling", () => {
  it("one poll per cluster however many hold it, every minute, stopped after the last release", async () => {
    vi.useFakeTimers();
    wb.backend.on("storage_volume_usage", () => report([]));
    const a = acquireVolumeUsage("c1");
    const b = acquireVolumeUsage("c1");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("storage_volume_usage")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(calls("storage_volume_usage")).toHaveLength(2);
    a();
    b();
    await vi.advanceTimersByTimeAsync(LINGER_MS);
    expect(volumeUsageStats()).toEqual({ clusters: 0, polling: 0 });
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
    expect(calls("storage_volume_usage")).toHaveLength(2);
  });

  it("never starts a round while one runs, and catches up as soon as it ends", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    wb.backend.on("storage_volume_usage", () => new Promise((resolve) => (finish = () => resolve(report([])))));
    const release = acquireVolumeUsage("c1");
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 2);
    expect(calls("storage_volume_usage")).toHaveLength(1);
    finish!();
    await vi.advanceTimersByTimeAsync(0);
    // The ticks that came during the round asked for another: it starts at once.
    expect(calls("storage_volume_usage")).toHaveLength(2);
    release();
  });

  it("a cluster that connects after it was asked for is measured at once", async () => {
    vi.useFakeTimers();
    wb.backend.on("storage_volume_usage", () => report([]));
    useClustersStore.setState({ states: { c1: { state: "connecting" } as ConnectionState } });
    const release = acquireVolumeUsage("c1");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("storage_volume_usage")).toHaveLength(0);
    useClustersStore.setState({ states: { c1: { state: "connected" } as ConnectionState } });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("storage_volume_usage")).toHaveLength(1);
    release();
    useClustersStore.setState({ states: {} });
  });

  it("the opt-in category's source turns full claims into problems and polls only while held", async () => {
    wb.backend.on("storage_volume_usage", () =>
      report([
        { namespace: "db", claim: "full", capacityBytes: 100, usedBytes: 97, availableBytes: 3, inodes: null, inodesUsed: null, inodesFree: null },
        { namespace: "db", claim: "fine", capacityBytes: 100, usedBytes: 10, availableBytes: 90, inodes: null, inodesUsed: null, inodesFree: null },
      ]),
    );
    const def = CATEGORY_SOURCES.disk[0]!;
    const release = acquireSource("c1", def);
    await waitFor(() => expect(getSource(sourceKey("c1", def))?.status).toBe("ready"));
    const source = getSource(sourceKey("c1", def))!;
    expect(source.problems.map((p) => [p.object.name, p.reason, p.category])).toEqual([["full", "CriticallyFull", "disk"]]);
    // Nothing is watched for it.
    expect(calls("watch_start")).toHaveLength(0);
    expect(getVolumeUsage("c1")).toBeDefined();
    release();
  });
});
