import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { detect, resolve } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import backupJson from "./fixtures/backup.json";
import clusterJson from "./fixtures/cluster.json";
import "./index";
import { BACKUP, backupState, CLUSTER_GRACE_MS, clusterInfo, FAILED_BACKUP_MS, HEALTHY_PHASE, PG_CLUSTER, POOLER, SCHEDULED_BACKUP } from "./model";

const cluster = clusterJson as KubeObject;
const backup = backupJson as KubeObject;

/** The fixture as a healthy cluster: all ready, one primary, archiving and backups working. */
function healthy(): KubeObject {
  const c = copy(cluster);
  const s = c.status as Record<string, unknown>;
  s.phase = HEALTHY_PHASE;
  s.readyInstances = 3;
  s.targetPrimary = "cluster-example-1";
  s.instancesStatus = { healthy: ["cluster-example-1", "cluster-example-2", "cluster-example-3"] };
  s.conditions = [
    { type: "Ready", status: "True", reason: "ClusterIsReady" },
    { type: "ContinuousArchiving", status: "True", reason: "ContinuousArchivingSuccess" },
    { type: "LastBackupSucceeded", status: "True", reason: "LastBackupSucceeded" },
  ];
  return c;
}

describe("the model", () => {
  it("reads the instances, their roles and health, and a switchover in progress", () => {
    const info = clusterInfo(cluster);
    expect(info).toMatchObject({ instances: 3, ready: 2, currentPrimary: "cluster-example-1", targetPrimary: "cluster-example-2", changingPrimary: true, state: "switchover" });
    expect(info.members).toEqual([
      { name: "cluster-example-1", role: "primary", health: "healthy", timeline: 1 },
      { name: "cluster-example-2", role: "replica", health: "healthy", timeline: 1 },
      { name: "cluster-example-3", role: "replica", health: "failed", timeline: 1 },
    ]);
    expect(clusterInfo(healthy()).state).toBe("healthy");
    const failing = copy(cluster);
    (failing.status as Record<string, unknown>).targetPrimary = "pending";
    expect(clusterInfo(failing).state).toBe("failover");
    const stuck = healthy();
    (stuck.status as Record<string, unknown>).phase = "Cluster is in an unrecoverable state, needs manual intervention";
    expect(clusterInfo(stuck).state).toBe("unhealthy");
  });

  it("an unhealthy cluster counts after a grace; failing archiving and backups at once", () => {
    const found = detect(PG_CLUSTER, cluster);
    expect(found.map((d) => d.reason)).toEqual(["ClusterIsNotReady", "ContinuousArchivingFailing", "LastBackupFailed"]);
    expect(found[0]?.graceMs).toBe(CLUSTER_GRACE_MS);
    expect(detect(PG_CLUSTER, healthy())).toEqual([]);
    const now = Date.parse("2026-10-10T08:01:00Z");
    const problems = resolve(PG_CLUSTER, cluster, now);
    expect(problems.find((p) => p.reason === "ClusterIsNotReady")?.activeAt).toBe(Date.parse("2026-10-10T08:00:00Z") + CLUSTER_GRACE_MS);
  });

  it("a failed Backup is a problem for a day after it stopped", () => {
    expect(backupState(backup)).toBe("failed");
    const [d] = detect(BACKUP, backup);
    expect(d).toMatchObject({ reason: "BackupFailed", message: "can't execute backup: exit status 1" });
    expect(d?.until).toBe(Date.parse("2026-10-10T00:00:09Z") + FAILED_BACKUP_MS);
    const done = copy(backup);
    (done.status as Record<string, unknown>).phase = "completed";
    expect(detect(BACKUP, done)).toEqual([]);
  });

  it("the tables show the state, instances and primary; the filter marks failures", () => {
    const def = getResourceDef(PG_CLUSTER);
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "status", "instances", "primary", "phase", "age"]);
    expect(def.columns.find((c) => c.id === "instances")!.value(cluster)).toBe("2/3");
    expect(def.problem?.(cluster)).toBe(true);
    expect(def.problem?.(healthy())).toBe(false);
    expect(getResourceDef(BACKUP).problem?.(backup)).toBe(true);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });

let wb: WatchBackend;
let discovery: KindRef[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [POD, PG_CLUSTER, BACKUP, SCHEDULED_BACKUP, POOLER];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the CloudNativePG section", () => {
  it("is there for a cluster that serves the kinds and counts the failed Backups", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("CloudNativePG"));
    emitSnapshot(wb, await watchOf(wb, "Cluster"), [healthy()]);
    const fresh = copy(backup);
    (fresh.status as Record<string, unknown>).stoppedAt = new Date().toISOString();
    emitSnapshot(wb, await watchOf(wb, "Backup"), [fresh]);
    await waitFor(() => expect(screen.getByTitle("1 object needs attention")).toHaveTextContent("1"));
  });

  it("is not there without the CRDs", async () => {
    discovery = [POD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Workloads"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("CloudNativePG");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  return { kind: { group: "postgresql.cnpg.io", version: "v1", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  await waitFor(() => expect(document.querySelector("[data-section='cnpg']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='cnpg']")!);

describe("details", () => {
  it("of a Cluster: the switchover, the instances with roles and health, failing archiving and backups", async () => {
    const container = await openDetails(cluster);
    const v = view();
    expect(v.getByText("The primary is moving from cluster-example-1 to cluster-example-2.")).toBeInTheDocument();
    expect(v.getByText("2 of 3 ready")).toBeInTheDocument();
    expect(v.getAllByRole("button", { name: "Open Pod cluster-example-1" }).length).toBeGreaterThan(0);
    expect(v.getAllByRole("button", { name: "Open Pod cluster-example-2" })).toHaveLength(2);
    const rows = v.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("cluster-example-1Primaryhealthy1");
    expect(rows).toContain("cluster-example-3Replicafailed1");
    expect(v.getAllByText("Failing")[0]).toHaveClass("rt-status--danger");
    expect(v.getByText("unexpected failure invoking barman-cloud-wal-archive: exit status 4")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a Backup: its Cluster, phase and error", async () => {
    const container = await openDetails(backup);
    const v = view();
    expect(v.getByRole("button", { name: "Open Cluster cluster-example" })).toBeInTheDocument();
    expect(v.getByText("Failed")).toHaveClass("rt-status--danger");
    expect(v.getByText("can't execute backup: exit status 1")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
