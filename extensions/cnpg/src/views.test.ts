// The details section, driven through the SDK's stand-in for Sextant's window.
import type { KubeObject } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import backupJson from "../fixtures/backup.json";
import clusterJson from "../fixtures/cluster.json";
import { startDetails } from "./details";
import { setLanguage, t } from "./i18n";

const cluster = clusterJson as unknown as KubeObject;
const backup = backupJson as unknown as KubeObject;
const scheduled = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "ScheduledBackup",
  metadata: { name: "nightly", namespace: "db" },
  spec: { cluster: { name: "cluster-example" }, schedule: "0 0 0 * * *", suspend: true, method: "volumeSnapshot" },
  status: { lastScheduleTime: "2026-10-10T00:00:00Z", nextScheduleTime: "2026-10-11T00:00:00Z" },
} as unknown as KubeObject;
const pooler = {
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Pooler",
  metadata: { name: "pooler-rw", namespace: "db" },
  spec: { cluster: { name: "cluster-example" }, instances: 2, pgbouncer: { poolMode: "session" } },
} as unknown as KubeObject;

const ref = (o: KubeObject) => ({
  kind: { group: "postgresql.cnpg.io", version: "v1", kind: o.kind! },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject, options: TestHostOptions = {}) {
  host = await startTestHost({
    ...options,
    context: { view: "details", contribution: "cnpg", selection: [ref(obj)], resourceVersion: "1", ...options.context },
    handlers: {
      "resources.get": () => structuredClone(obj),
      "ui.setHidden": () => null,
      "ui.openDetails": () => null,
      ...options.handlers,
    },
  });
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, "cnpg");
  await expect.poll(() => root.querySelector(".sx-fields")).not.toBeNull();
}

const text = () => root.textContent ?? "";
const fields = (within: ParentNode = root) =>
  Object.fromEntries([...within.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
const links = () => [...root.querySelectorAll<HTMLButtonElement>("button.sx-link")];
const notes = () => [...root.querySelectorAll(".cnpg-note")].map((n) => [n.textContent, n.className]);

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

describe("a Cluster's details", () => {
  it("the switchover, the instances with roles and health, failing archiving and backups", async () => {
    await open(cluster);
    expect(notes()).toEqual([
      ["The primary is moving from cluster-example-1 to cluster-example-2.", "cnpg-note cnpg-note--warning"],
      ["unexpected failure invoking barman-cloud-wal-archive: exit status 4", "cnpg-note cnpg-note--danger"],
      ["can't execute backup: exit status 1", "cnpg-note cnpg-note--danger"],
    ]);
    expect(fields()).toMatchObject({
      Status: "Switchover",
      Phase: "Switchover in progress",
      Instances: "2 of 3 ready",
      "Current primary": "cluster-example-1",
      "Target primary": "cluster-example-2",
      Image: "ghcr.io/cloudnative-pg/postgresql:17.5",
      Storage: "1Gi",
      "Continuous archiving": "Failing",
      "Last backup": "Failed",
    });
    const status = [...root.querySelectorAll("dd .sx-status")].find((s) => s.textContent === "Switchover")!;
    expect(status.className).toBe("sx-status sx-status--warning");
    expect((status as HTMLElement).title).toBe("Switchover in progress");
    const rows = [...root.querySelectorAll("tbody tr")].map((r) => r.textContent);
    expect(rows).toEqual(["cluster-example-1Primaryhealthy1", "cluster-example-2Replicahealthy1", "cluster-example-3Replicafailed1"]);
    expect([...root.querySelectorAll("tbody .sx-status--danger")].map((s) => s.textContent)).toEqual(["failed"]);
    expect([...root.querySelectorAll(".sx-block__title")].map((h) => h.textContent)).toEqual(["Instances", "Backups"]);
    expect(links().filter((b) => b.textContent === "cluster-example-2")).toHaveLength(2);
    links()[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "", version: "v1", kind: "Pod" },
      namespace: "db",
      name: "cluster-example-1",
    });
  });

  it("a failover, an unhealthy phase's reason, hibernation, a replica cluster and no backup at all", async () => {
    const failing = structuredClone(cluster);
    const s = failing.status as Record<string, unknown>;
    s.targetPrimary = "pending";
    s.conditions = [];
    delete s.lastSuccessfulBackup;
    await open(failing);
    expect(notes()).toEqual([["Failing over: cluster-example-1 is gone and a new primary is being chosen.", "cnpg-note cnpg-note--danger"]]);
    expect(fields()["Target primary"]).toBeUndefined();
    expect(text()).toContain("No backup is set up for this cluster.");
    stop();
    host.close();
    root.remove();

    const stuck = structuredClone(cluster);
    Object.assign(stuck.status as object, { phase: "Unable to create required cluster objects", phaseReason: "secrets \"app\" is forbidden", targetPrimary: "cluster-example-1" });
    (stuck.spec as Record<string, unknown>).replica = { enabled: true };
    await open(stuck);
    expect(notes()[0]).toEqual(['secrets "app" is forbidden', "cnpg-note cnpg-note--danger"]);
    expect(text()).toContain("A replica cluster: its primary follows another cluster.");
    stop();
    host.close();
    root.remove();

    const sleeping = structuredClone(cluster);
    sleeping.metadata.annotations = { "cnpg.io/hibernation": "on" };
    (sleeping.status as Record<string, unknown>).conditions = [{ type: "cnpg.io/hibernation", status: "True", reason: "Hibernated" }];
    (sleeping.status as Record<string, unknown>).targetPrimary = "cluster-example-1";
    await open(sleeping);
    expect(fields().Status).toBe("Hibernated");
    expect(text()).toContain(t("hibernation.hibernated"));
    expect(root.querySelector("dd .sx-status")!.className).toBe("sx-status sx-status--muted");
  });

  it("reads the Cluster again when it changes, and speaks the UI language", async () => {
    setLanguage("ru");
    await open(cluster, { context: { language: "ru" } });
    expect(text()).toContain(t("members.title"));
    expect(t("members.title")).not.toBe("Instances");
    host.setContext({ resourceVersion: "2" });
    await expect.poll(() => host.calls.filter((c) => c.method === "resources.get").length).toBe(2);
  });
});

describe("other details", () => {
  it("a Backup: its Cluster, phase and error", async () => {
    await open(backup);
    expect(fields()).toMatchObject({ Status: "Failed", Cluster: "cluster-example", Method: "barmanObjectStore", "Destination": "s3://backups/" });
    expect(root.querySelector("dd .sx-status")!.className).toBe("sx-status sx-status--danger");
    expect(notes()).toEqual([["can't execute backup: exit status 1", "cnpg-note cnpg-note--danger"]]);
    expect([...root.querySelectorAll(".sx-block__title")].map((h) => h.textContent)).toEqual(["Error"]);
    links()[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "postgresql.cnpg.io", version: "v1", kind: "Cluster" },
      namespace: "db",
      name: "cluster-example",
    });
  });

  it("a ScheduledBackup: its Cluster, schedule, suspension, method and runs", async () => {
    await open(scheduled);
    expect(fields()).toMatchObject({ Cluster: "cluster-example", Schedule: "0 0 0 * * *", Suspended: "Yes", Method: "volumeSnapshot" });
    expect(Object.keys(fields())).toEqual(["Cluster", "Schedule", "Suspended", "Method", "Last run", "Next run"]);
  });

  it("a Pooler: its Cluster, type, instances and pool mode", async () => {
    await open(pooler);
    expect(fields()).toEqual({ Cluster: "cluster-example", Type: "rw", Instances: "2", "Pool mode": "session" });
  });

  it("says when Sextant refuses to read", async () => {
    host = await startTestHost({
      context: { view: "details", contribution: "cnpg", selection: [ref(pooler)], resourceVersion: "1" },
      handlers: {
        "resources.get": () => {
          throw new Error("boom");
        },
      },
    });
    root = document.createElement("main");
    document.body.append(root);
    stop = startDetails(host.sextant, root, "cnpg");
    await expect.poll(text).toContain("boom");
  });
});
