import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import fixtures from "../fixtures/objects.json";
import {
  asYaml,
  cephImagePatch,
  deviceSetCountPatch,
  DO_NOT_RECONCILE,
  filesystemObject,
  gatewayPatch,
  mdsPatch,
  mutedCodes,
  mutePatch,
  nodeLabelsPatch,
  poolPatch,
  poolPlacementPatch,
  purgeJobObject,
  reconcilePatch,
  replaceOsdPatch,
  storageClassObject,
  storagePatch,
  toolboxImagePatch,
  toolboxYaml,
} from "./changes";
import { crushTree, osdMetrics, osdOf, type Deployment } from "./crush";
import { canRestart } from "./daemons";
import type { Pod } from "./components";
import { nodeClassOwners } from "./nodeTopology";
import { pgsClean } from "./osds";
import type { CephCluster } from "./rook";
import { ROOK_TOOLBOX_YAML } from "./toolbox";
import { showPreview } from "./ui";
import { upgradeChecks, versionOfImage } from "./upgrade";

const cluster = fixtures.clusters[0] as unknown as CephCluster;

describe("the changes", () => {
  it("are the smallest merge patches of Rook's fields, guarded by the resourceVersion seen", () => {
    expect(mutePatch("OSD_DOWN", true, "7")).toEqual({
      spec: { healthCheck: { muteHealthWarning: { OSD_DOWN: { policy: "mute" } } } },
      metadata: { resourceVersion: "7" },
    });
    expect(mutePatch("OSD_DOWN", false)).toEqual({ spec: { healthCheck: { muteHealthWarning: { OSD_DOWN: { policy: "unmute" } } } } });
    expect(() => mutePatch("osd_down", true)).toThrow();
    expect(reconcilePatch(true)).toEqual({ metadata: { labels: { [DO_NOT_RECONCILE]: "true" } } });
    expect(reconcilePatch(false)).toEqual({ metadata: { labels: { [DO_NOT_RECONCILE]: null } } });
    expect(mdsPatch(2, true)).toEqual({ spec: { metadataServer: { activeCount: 2, activeStandby: true } } });
    expect(() => mdsPatch(51, true)).toThrow();
    expect(gatewayPatch(3)).toEqual({ spec: { gateway: { instances: 3 } } });
    expect(poolPatch({ size: 3, maxSize: "10Gi", maxObjects: null })).toEqual({ spec: { replicated: { size: 3 }, quotas: { maxSize: "10Gi", maxObjects: null } } });
    expect(() => poolPatch({ maxSize: "ten" })).toThrow();
    expect(poolPlacementPatch({ failureDomain: "rack", deviceClass: null })).toEqual({ spec: { failureDomain: "rack", deviceClass: null } });
    expect(replaceOsdPatch(5, true)).toEqual({ metadata: { annotations: { "osd.rook.io/replace": "yes-really-replace-osd-5" } } });
    expect(replaceOsdPatch(5, false)).toEqual({ metadata: { annotations: { "osd.rook.io/replace": null } } });
    expect(cephImagePatch("quay.io/ceph/ceph:v20.2.4")).toEqual({ spec: { cephVersion: { image: "quay.io/ceph/ceph:v20.2.4" } } });
    expect(toolboxImagePatch(0, "x")).toEqual([
      { op: "test", path: "/spec/template/spec/containers/0/name", value: "rook-ceph-tools" },
      { op: "replace", path: "/spec/template/spec/containers/0/image", value: "x" },
    ]);
    expect(storagePatch({ useAllDevices: false, deviceFilter: null })).toEqual({ spec: { storage: { useAllDevices: false, deviceFilter: null } } });
  });

  it("reads the muted codes and Rook's limit of entries", () => {
    expect(mutedCodes({ healthCheck: { muteHealthWarning: { B_C: { policy: "mute" }, A_B: { policy: "unmute" }, D_E: { policy: "mute" } } } })).toEqual({
      muted: ["B_C", "D_E"],
      entries: 3,
    });
    expect(mutedCodes(undefined)).toEqual({ muted: [], entries: 0 });
  });

  it("change node labels only among those Rook reads for CRUSH", () => {
    expect(nodeLabelsPatch({ "topology.rook.io/rack": "rack1", "topology.kubernetes.io/zone": null })).toEqual({
      metadata: { labels: { "topology.rook.io/rack": "rack1", "topology.kubernetes.io/zone": null } },
    });
    expect(() => nodeLabelsPatch({ "kubernetes.io/hostname": "x" })).toThrow();
    expect(() => nodeLabelsPatch({ "topology.rook.io/rack": "rack 1" })).toThrow();
  });

  it("change a device set's count only after testing its name", () => {
    expect(deviceSetCountPatch(1, "set1", 4)).toEqual([
      { op: "test", path: "/spec/storage/storageClassDeviceSets/1/name", value: "set1" },
      { op: "replace", path: "/spec/storage/storageClassDeviceSets/1/count", value: 4 },
    ]);
  });

  it("deploy Rook's own toolbox with the cluster's namespace and image only", () => {
    const yaml = toolboxYaml("ceph-b", "quay.io/ceph/ceph:v19.2.3");
    expect(yaml).toContain('  namespace: "ceph-b"');
    expect(yaml).toContain('          image: "quay.io/ceph/ceph:v19.2.3"');
    expect(yaml.split("\n").length).toBe(ROOK_TOOLBOX_YAML.split("\n").length);
    expect(yaml).toContain("${ROOK_CEPH_USERNAME}");
  });

  it("write YAML that reads back as the same objects", () => {
    const tricky = {
      metadata: { name: "x", labels: { "app.kubernetes.io/name": "yes", true: "no", "1x": "007" }, annotations: {} },
      spec: { list: [], items: [{ a: 1, b: [true, null, "on"] }, "plain", ["nested"]], quote: 'a "b" \\ c\nd', empty: "" },
    };
    expect(parseAllDocuments(asYaml([tricky])).map((d) => d.toJS())).toEqual([tricky]);
  });

  it("purge one OSD with Rook's Job, never forced", () => {
    const job = purgeJobObject("rook-ceph", 3, "docker.io/rook/ceph:v1.21.1");
    expect(job.metadata).toEqual({ name: "rook-ceph-purge-osd-3", namespace: "rook-ceph", labels: { app: "rook-ceph-purge-osd" } });
    expect(job.spec.template.spec.containers[0]!.args).toEqual([
      "ceph", "osd", "remove", "--preserve-pvc", "false", "--force-osd-removal", "false", "--osd-ids", "3",
    ]);
  });

  it("write new objects as Rook's examples do, in one YAML", () => {
    const fs = filesystemObject({ name: "myfs", namespace: "rook-ceph", failureDomain: "host", size: 3, activeCount: 1 });
    expect(fs.spec.dataPools[0]).toMatchObject({ name: "replicated", replicated: { size: 3, requireSafeReplicaSize: true } });
    const sc = storageClassObject({
      name: "rook-cephfs",
      clusterNamespace: "rook-ceph",
      driverPrefix: "rook-ceph",
      target: { type: "cephfs", filesystem: "myfs", dataPool: "myfs-replicated" },
      reclaimPolicy: "Delete",
    });
    expect(sc).toMatchObject({ provisioner: "rook-ceph.cephfs.csi.ceph.com", parameters: { clusterID: "rook-ceph", fsName: "myfs", pool: "myfs-replicated" } });
    const bucket = storageClassObject({
      name: "b",
      clusterNamespace: "rook-ceph",
      driverPrefix: "rook-operator",
      bucketProvisioner: "ceph.rook.io/bucket",
      target: { type: "bucket", objectStore: "my-store" },
      reclaimPolicy: "Retain",
    });
    expect(bucket.provisioner).toBe("ceph.rook.io/bucket");
    expect(parseAllDocuments(asYaml([fs, sc])).map((d) => d.toJS())).toEqual([fs, sc]);
  });
});

describe("before a Ceph upgrade", () => {
  it("reads the version in an image's tag", () => {
    expect(versionOfImage("quay.io/ceph/ceph:v20.2.4-20260818")).toEqual({ major: 20, minor: 2, patch: 4 });
    expect(versionOfImage("quay.io/ceph/ceph:v20")).toEqual({ major: 20, minor: null, patch: null });
    expect(versionOfImage("quay.io/ceph/ceph:latest")).toBeNull();
  });

  it("blocks what Rook does not support or refuses, and warns about the rest", () => {
    const healthy = { ...cluster, status: { ...cluster.status, ceph: { ...cluster.status!.ceph, health: "HEALTH_OK", versions: { overall: { "ceph version 20.2.0 (x) tentacle (stable)": 3 } } } } } as CephCluster;
    const ids = (c: CephCluster, image: string) => upgradeChecks(c, image).map((x) => `${x.level}:${x.id}`);
    expect(ids(healthy, "quay.io/ceph/ceph:v20.2.4-20260818")).toEqual([]);
    expect(ids(healthy, "quay.io/ceph/ceph:v20.2.0")).toContain("block:notRecommended");
    expect(ids(healthy, "quay.io/ceph/ceph:v19.2.3")).toContain("block:downgrade");
    expect(ids(healthy, "quay.io/ceph/ceph:v21.1.0")).toContain("block:unsupported");
    expect(ids(healthy, "quay.io/ceph/ceph:v20")).toEqual(["warn:majorTag"]);
    expect(ids(healthy, "example.com/ceph:v20.2.4")).toEqual(["warn:otherRegistry"]);
    expect(ids(healthy, "not an image")).toEqual(["block:badImage"]);
    // The fixture: HEALTH_WARN and two versions running.
    expect(ids(cluster, "quay.io/ceph/ceph:v20.2.4")).toEqual(["block:mixedVersions", "warn:healthWarn"]);
    const failing = { ...healthy, status: { ...healthy.status, ceph: { ...healthy.status!.ceph, health: "HEALTH_ERR" } } } as CephCluster;
    expect(ids(failing, "quay.io/ceph/ceph:v20.2.4")).toContain("block:healthError");
  });
});

describe("the CRUSH tree", () => {
  const deployment = (id: number, labels: Record<string, string>, extra: Partial<Deployment> = {}): Deployment => ({
    metadata: { name: `rook-ceph-osd-${id}`, namespace: "rook-ceph", labels: { app: "rook-ceph-osd", "ceph-osd-id": String(id), ...labels } },
    spec: { replicas: 1 },
    status: { readyReplicas: 1 },
    ...extra,
  });

  it("places OSDs by Rook's topology labels on their Deployments", () => {
    const osds = [
      deployment(2, { "topology-location-root": "default", "topology-location-zone": "z1", "topology-location-host": "node-b", "device-class": "ssd" }),
      deployment(0, { "topology-location-root": "default", "topology-location-zone": "z1", "topology-location-host": "node-a", "device-class": "hdd" }),
      deployment(1, { "topology-location-root": "default", "topology-location-host": "node-c" }),
    ].map((d) => osdOf(d)!);
    const tree = crushTree(osds);
    expect(tree.map((n) => `${n.level}:${n.name}`)).toEqual(["root:default"]);
    const root = tree[0]!;
    expect(root.children.map((n) => `${n.level}:${n.name}`)).toEqual(["host:node-c", "zone:z1"]);
    expect(root.children[1]!.children.map((n) => [n.name, n.osds.map((o) => o.id)])).toEqual([
      ["node-a", [0]],
      ["node-b", [2]],
    ]);
    expect(osds.find((o) => o.id === 2)!.deviceClass).toBe("ssd");
  });

  it("reads Rook's replacement, reconcile and PVC marks", () => {
    const osd = (labels: Record<string, string>, annotations: Record<string, string> = {}) =>
      osdOf(deployment(4, labels, { metadata: { name: "rook-ceph-osd-4", labels: { app: "rook-ceph-osd", "ceph-osd-id": "4", ...labels }, annotations } }))!;
    expect(osd({}).replace).toBe("none");
    expect(osd({}, { "osd.rook.io/replace": "yes-really-replace-osd-4" }).replace).toBe("requested");
    expect(osd({}, { "osd.rook.io/replace": "x", "osd.rook.io/replace-in-progress": "true" }).replace).toBe("inProgress");
    expect(osd({}, { "osd.rook.io/replace-ready-for-swap": "true" }).replace).toBe("readyForSwap");
    expect(osd({ [DO_NOT_RECONCILE]: "true" }).reconcilePaused).toBe(true);
    expect(osd({ "ceph.rook.io/pvc": "set1-data-0" }).onPvc).toBe(true);
    expect(osdOf({ metadata: { name: "x", labels: { app: "rook-ceph-mon" } } })).toBeNull();
  });

  it("reads each OSD's metrics by daemon", () => {
    const m = osdMetrics([
      { labels: { __name__: "ceph_osd_up", ceph_daemon: "osd.1" }, points: [[1, 1]] },
      { labels: { __name__: "ceph_osd_stat_bytes", ceph_daemon: "osd.1" }, points: [[1, 100]] },
      { labels: { __name__: "ceph_osd_weight", ceph_daemon: "osd.1" }, points: [[1, 0.5]] },
      { labels: { __name__: "ceph_osd_up", ceph_daemon: "mds.a" }, points: [[1, 1]] },
    ]);
    expect([...m.entries()]).toEqual([[1, { up: 1, bytes: 100, reweight: 0.5 }]]);
  });

  it("tells clean placement groups from the pgs query", () => {
    const answer = (total: number, active: number, clean: number) => ({
      resultType: "vector" as const,
      truncated: false,
      series: [
        { labels: { __name__: "ceph_pg_total" }, points: [[1, total]] as [number, number][] },
        { labels: { __name__: "ceph_pg_active" }, points: [[1, active]] as [number, number][] },
        { labels: { __name__: "ceph_pg_clean" }, points: [[1, clean]] as [number, number][] },
      ],
    });
    expect(pgsClean(answer(49, 49, 49))).toBe(true);
    expect(pgsClean(answer(49, 49, 33))).toBe(false);
    expect(pgsClean(null)).toBeNull();
  });
});

describe("pods and nodes", () => {
  it("restart only pods their controller re-creates", () => {
    const pod = (kind: string, controller = true) => ({ metadata: { name: "p", ownerReferences: [{ kind, controller }] } }) as unknown as Pod;
    expect(canRestart(pod("ReplicaSet"))).toBe(true);
    expect(canRestart(pod("DaemonSet"))).toBe(true);
    expect(canRestart(pod("Job"))).toBe(false);
    expect(canRestart(pod("ReplicaSet", false))).toBe(false);
    expect(canRestart({ metadata: { name: "bare" } } as Pod)).toBe(false);
  });

  it("find clusters that give a node a device class of their own", () => {
    const c = { metadata: { name: "c", namespace: "rook-ceph" }, spec: { storage: { nodes: [{ name: "n1", config: { deviceClass: "ssd" } }, { name: "n2" }] } } } as never;
    expect(nodeClassOwners([c], "n1")).toEqual(["rook-ceph/c"]);
    expect(nodeClassOwners([c], "n2")).toEqual([]);
  });
});

describe("the change shown before it is sent", () => {
  it("stays open while the form is edited", () => {
    const slot = document.createElement("div");
    showPreview(slot, { size: 2 });
    const details = slot.querySelector("details")!;
    details.open = true;
    showPreview(slot, { size: 3 });
    expect(slot.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector("pre")!.textContent).toContain("3");
    showPreview(slot, null);
    expect(slot.children).toHaveLength(0);
  });
});
