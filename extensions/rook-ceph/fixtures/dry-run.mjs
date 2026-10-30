#!/usr/bin/env node
// Checks fixtures/objects.json against Rook's own CRDs: every Rook and ObjectBucketClaim object is created on a
// throwaway cluster (nothing runs Rook there, so nothing acts on them), its status is sent as a server-side dry run
// of the status subresource (a replace) with strict field validation, and everything is removed again; StorageClasses and
// claims are created as a dry run. Then every change the extension sends (src/changes.ts) is sent as a server-side dry
// run: the patches to the fixtures, a node, a device set and an OSD-like Deployment (created with no replicas), and the
// objects it creates. Run it against Sextant's kind test cluster only:
//
//   node extensions/rook-ceph/fixtures/dry-run.mjs "$(scripts/test-cluster.sh kubeconfig)"
//
// The CRDs come from Rook's release (ROOK_VERSION); CRDs that were not there before are deleted at the end.
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOK_VERSION = "v1.21.1";
const CRDS = `https://raw.githubusercontent.com/rook/rook/${ROOK_VERSION}/deploy/examples/crds.yaml`;
const kubeconfig = process.argv[2];
if (!kubeconfig) {
  process.stderr.write("usage: dry-run.mjs <kubeconfig of a throwaway cluster>\n");
  process.exit(2);
}
const kubectl = (args, input) =>
  execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

/** src/changes.ts and its one import, loaded without a build (Node's type stripping). */
const here = dirname(fileURLToPath(import.meta.url));
const asModule = (file, replace = (text) => text) =>
  `data:text/javascript;base64,${Buffer.from(replace(stripTypeScriptTypes(readFileSync(join(here, "../src", file), "utf8")))).toString("base64")}`;
const changes = await import(asModule("changes.ts", (text) => text.replace('from "./toolbox"', `from "${asModule("toolbox.ts")}"`)));

const fixtures = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "objects.json"), "utf8"));
const rook = [...fixtures.clusters, ...fixtures.pools, ...fixtures.filesystems, ...fixtures.objectStores, ...fixtures.others, ...fixtures.objectBucketClaims];
const dryOnly = [...fixtures.storageClasses, ...fixtures.pvcs];

/**
 * Fields of `value` that `schema` does not name. Rook declares its statuses with
 * `x-kubernetes-preserve-unknown-fields`, so the API server keeps an unknown status field instead of refusing it:
 * this walk is what catches a misspelt one.
 */
function unknownFields(value, schema, path) {
  if (value === null || typeof value !== "object" || !schema) return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => unknownFields(item, schema.items, `${path}[${i}]`));
  return Object.entries(value).flatMap(([key, field]) => {
    const known = schema.properties?.[key];
    if (known) return unknownFields(field, known, `${path}.${key}`);
    if (typeof schema.additionalProperties === "object") return unknownFields(field, schema.additionalProperties, `${path}.${key}`);
    return [`${path}.${key}`];
  });
}
const schemas = new Map();
const schemaOf = (object) => {
  const [group, version] = object.apiVersion.split("/");
  const key = `${object.kind}.${group}`;
  if (!schemas.has(key)) {
    const crd = JSON.parse(kubectl(["get", "crd", "-o", "json"])).items.find(
      (c) => c.spec.group === group && c.spec.names.kind === object.kind,
    );
    schemas.set(key, crd.spec.versions.find((v) => v.name === version).schema.openAPIV3Schema);
  }
  return schemas.get(key);
};

/** The object as created by hand: no status, no fields the API server sets. */
const bare = (object) => {
  const copy = JSON.parse(JSON.stringify(object));
  delete copy.status;
  for (const field of ["uid", "resourceVersion", "creationTimestamp"]) delete copy.metadata[field];
  return copy;
};

const before = new Set(kubectl(["get", "crd", "-o", "name"]).split("\n").filter(Boolean));
const crdYaml = await (await globalThis.fetch(CRDS)).text();
kubectl(["apply", "--server-side", "-f", "-"], crdYaml);
const after = kubectl(["get", "crd", "-o", "name"]).split("\n").filter(Boolean);
const added = after.filter((name) => !before.has(name) && /\.(ceph\.rook\.io|objectbucket\.io)$/.test(name));
kubectl(["wait", "--for=condition=Established", "--timeout=60s", ...after.filter((n) => /ceph\.rook\.io|objectbucket\.io/.test(n))]);

const namespaces = [...new Set([...rook, ...dryOnly].map((o) => o.metadata.namespace).filter(Boolean))];
const createdNamespaces = namespaces.filter((ns) => {
  try {
    kubectl(["get", "namespace", ns]);
    return false;
  } catch {
    kubectl(["create", "namespace", ns]);
    return true;
  }
});

let failed = 0;
const created = [];

/** Sends `send()`'s change as a dry run; 1 when the API server refused it. */
function check(name, send) {
  try {
    send();
    process.stdout.write(`ok   ${name}\n`);
    return 0;
  } catch (err) {
    process.stdout.write(`FAIL ${name}: ${String(err.stderr || err.message).trim()}\n`);
    return 1;
  }
}
const live = (kind, ns, name) => JSON.parse(kubectl(["get", kind, ...(ns ? ["-n", ns] : []), name, "-o", "json"]));
const patch = (kind, ns, name, type, body) =>
  kubectl(["patch", kind, ...(ns ? ["-n", ns] : []), name, "--dry-run=server", "--type", type, "-p", JSON.stringify(body)]);
const createDry = (object) => kubectl(["create", "--dry-run=server", "--validate=strict", "-f", "-"], typeof object === "string" ? object : JSON.stringify(object));

/** Every change of src/changes.ts as the extension sends it. */
function checkChanges() {
  let failures = 0;
  const [cluster] = fixtures.clusters;
  const ns = cluster.metadata.namespace;
  const rv = (kind, name) => live(kind, ns, name).metadata.resourceVersion;
  const onCluster = (name, body) =>
    (failures += check(`CephCluster patch: ${name}`, () => patch("cephcluster", ns, cluster.metadata.name, "merge", body)));
  onCluster("mute", changes.mutePatch("OSD_DOWN", true, rv("cephcluster", cluster.metadata.name)));
  onCluster("unmute", changes.mutePatch("OSD_DOWN", false));
  onCluster("pause reconciling", changes.reconcilePatch(true, rv("cephcluster", cluster.metadata.name)));
  onCluster("Ceph image", changes.cephImagePatch("quay.io/ceph/ceph:v20.2.4-20260818"));
  onCluster("storage switches", changes.storagePatch({ useAllNodes: false, useAllDevices: false, deviceFilter: "^sd[b-d]", allowDeviceClassUpdate: true, allowOsdCrushWeightUpdate: true }));
  onCluster("automatic OSD removal", changes.autoRemovePatch(true));

  const [pool] = fixtures.pools;
  failures += check("CephBlockPool patch: size and quotas", () =>
    patch("cephblockpool", ns, pool.metadata.name, "merge", changes.poolPatch({ size: 2, maxSize: "10Gi", maxObjects: 1000 }, rv("cephblockpool", pool.metadata.name))));
  failures += check("CephBlockPool patch: placement", () =>
    patch("cephblockpool", ns, pool.metadata.name, "merge", changes.poolPlacementPatch({ failureDomain: "rack", deviceClass: "ssd", crushRoot: null })));
  const [fs] = fixtures.filesystems;
  failures += check("CephFilesystem patch: MDS", () => patch("cephfilesystem", ns, fs.metadata.name, "merge", changes.mdsPatch(2, true)));
  const [store] = fixtures.objectStores;
  failures += check("CephObjectStore patch: gateways", () => patch("cephobjectstore", ns, store.metadata.name, "merge", changes.gatewayPatch(3)));

  const node = JSON.parse(kubectl(["get", "nodes", "-o", "json"])).items[0];
  failures += check("Node patch: CRUSH labels", () =>
    patch("node", null, node.metadata.name, "merge", changes.nodeLabelsPatch({ "topology.rook.io/rack": "rack1", [changes.NODE_DEVICE_CLASS]: "ssd" }, node.metadata.resourceVersion)));

  for (const object of [
    changes.poolObject({ name: "dry-run-pool", namespace: ns, failureDomain: "host", size: 3 }),
    changes.filesystemObject({ name: "dry-run-fs", namespace: ns, failureDomain: "host", size: 3, activeCount: 1 }),
    changes.objectStoreObject({ name: "dry-run-store", namespace: ns, failureDomain: "osd", size: 1, instances: 1 }),
    changes.objectUserObject({ name: "dry-run-user", namespace: ns, store: store.metadata.name, displayName: "Dry run" }),
    ...[
      { type: "rbd", pool: "dry-run-pool" },
      { type: "cephfs", filesystem: "dry-run-fs", dataPool: "dry-run-fs-replicated" },
      { type: "bucket", objectStore: "dry-run-store" },
    ].map((target) => changes.storageClassObject({ name: `dry-run-${target.type}`, clusterNamespace: ns, driverPrefix: ns, target, reclaimPolicy: "Delete" })),
    changes.purgeJobObject(ns, 1, "docker.io/rook/ceph:v1.21.1"),
  ]) {
    failures += check(`create ${object.kind} ${object.metadata.name} (dry run)`, () => createDry(object));
  }
  failures += check("create Rook's toolbox (dry run)", () => createDry(changes.toolboxYaml(ns, "quay.io/ceph/ceph:v20.2.4")));

  // A device set's count: a second CephCluster with one, removed at once (nothing runs Rook here).
  const withSet = {
    apiVersion: "ceph.rook.io/v1",
    kind: "CephCluster",
    metadata: { name: "dry-run-device-sets", namespace: ns },
    spec: {
      cephVersion: { image: "quay.io/ceph/ceph:v20.2.4" },
      dataDirHostPath: "/var/lib/rook",
      mon: { count: 1 },
      storage: {
        storageClassDeviceSets: [
          {
            name: "set1",
            count: 1,
            volumeClaimTemplates: [
              { metadata: { name: "data" }, spec: { resources: { requests: { storage: "10Gi" } }, volumeMode: "Block", accessModes: ["ReadWriteOnce"] } },
            ],
          },
        ],
      },
    },
  };
  kubectl(["create", "--validate=strict", "-f", "-"], JSON.stringify(withSet));
  try {
    failures += check("CephCluster JSON patch: device set count", () =>
      patch("cephcluster", ns, withSet.metadata.name, "json", changes.deviceSetCountPatch(0, "set1", 3)));
    failures += check("CephCluster JSON patch: a device set's name is tested", () => {
      try {
        patch("cephcluster", ns, withSet.metadata.name, "json", changes.deviceSetCountPatch(0, "set2", 3));
      } catch {
        return;
      }
      throw new Error("a patch naming another device set was accepted");
    });
  } finally {
    kubectl(["delete", "--wait=false", "-f", "-"], JSON.stringify(withSet));
  }

  // The OSD and toolbox patches on a Deployment shaped like Rook's, created with no replicas so nothing runs.
  const deployment = JSON.parse(kubectl(["create", "--dry-run=client", "-o", "json", "-f", "-"], changes.toolboxYaml(ns, "quay.io/ceph/ceph:v20.2.4")));
  deployment.metadata.name = "dry-run-osd-0";
  deployment.metadata.labels = { app: "rook-ceph-osd", "ceph-osd-id": "0" };
  deployment.spec.replicas = 0;
  const saved = JSON.parse(kubectl(["create", "-o", "json", "-f", "-"], JSON.stringify(deployment)));
  try {
    // The Deployment controller writes its status at once: each patch carries the version read just before it.
    const version = () => live("deployment", ns, saved.metadata.name).metadata.resourceVersion;
    const onDeployment = (name, type, body) =>
      (failures += check(`Deployment patch: ${name}`, () => patch("deployment", ns, saved.metadata.name, type, body)));
    onDeployment("replace an OSD", "merge", changes.replaceOsdPatch(0, true, version()));
    onDeployment("stop an OSD", "merge", { ...changes.daemonReconcilePatch(true, version()), spec: { replicas: 0 } });
    onDeployment("start an OSD", "merge", { ...changes.daemonReconcilePatch(false, version()), spec: { replicas: 1 } });
    onDeployment("toolbox image", "json", changes.toolboxImagePatch(0, "quay.io/ceph/ceph:v20.2.4-20260818"));
    const after = JSON.parse(
      kubectl(["patch", "deployment", "-n", ns, saved.metadata.name, "--dry-run=server", "--type", "json", "-o", "json", "-p", JSON.stringify(changes.toolboxImagePatch(0, "x.io/y:v1"))]),
    );
    const container = after.spec.template.spec.containers[0];
    failures += check("Deployment patch: the toolbox keeps its command and mounts", () => {
      if (container.image !== "x.io/y:v1" || !container.command?.length || !container.volumeMounts?.length) throw new Error(JSON.stringify(container));
    });
  } finally {
    kubectl(["delete", "--wait=false", "deployment", "-n", ns, saved.metadata.name]);
  }
  return failures;
}
try {
  for (const object of rook) {
    const name = `${object.kind} ${object.metadata.namespace}/${object.metadata.name}`;
    try {
      const fields = { ...bare(object), status: object.status };
      delete fields.metadata;
      const unknown = unknownFields(fields, schemaOf(object), "");
      if (unknown.length) throw new Error(`fields Rook's CRD does not name: ${unknown.join(", ")}`);
      const saved = JSON.parse(kubectl(["create", "--validate=strict", "-o", "json", "-f", "-"], JSON.stringify(bare(object))));
      created.push(object);
      if (object.status) {
        kubectl(
          ["replace", "--subresource=status", "--dry-run=server", "--validate=strict", "-f", "-"],
          JSON.stringify({ ...saved, status: object.status }),
        );
      }
      process.stdout.write(`ok   ${name}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAIL ${name}: ${String(err.stderr || err.message).trim()}\n`);
    }
  }
  for (const object of dryOnly) {
    const name = `${object.kind} ${object.metadata.namespace ?? ""}/${object.metadata.name}`;
    try {
      kubectl(["create", "--dry-run=server", "--validate=strict", "-f", "-"], JSON.stringify(bare(object)));
      process.stdout.write(`ok   ${name} (dry run)\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAIL ${name}: ${String(err.stderr || err.message).trim()}\n`);
    }
  }
  failed += checkChanges();
} finally {
  for (const object of created.reverse()) {
    kubectl(["delete", "--wait=false", "-f", "-"], JSON.stringify(bare(object)));
  }
  // Nothing runs Rook here, so nothing removes Rook's finalizers: there are none on objects created by hand.
  for (const ns of createdNamespaces) kubectl(["delete", "namespace", ns, "--wait=true", "--timeout=120s"]);
  if (added.length) kubectl(["delete", ...added]);
}
process.stdout.write(failed ? `${failed} failed\n` : "every fixture and change is valid against Rook's CRDs\n");
process.exitCode = failed ? 1 : 0;
