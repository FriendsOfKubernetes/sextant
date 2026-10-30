// Every change the extension makes, as the smallest merge patch or YAML of Rook's own objects (Rook v1.21.1,
// pkg/apis/ceph.rook.io/v1 and Documentation/). A patch carries the `metadata.resourceVersion` the user saw: the API
// server refuses it with a conflict when the object changed in between, so nothing is sent on top of a change the
// user has not seen. Rook's operator applies each change to Ceph; the extension runs no `ceph` command.
import { ROOK_TOOLBOX_YAML, TOOLBOX_IMAGE_LINE, TOOLBOX_NAMESPACE_LINE } from "./toolbox";

type Patch = Record<string, unknown>;

const guarded = (resourceVersion: string | undefined, patch: Patch): Patch => {
  const metadata = (patch.metadata as Patch | undefined) ?? {};
  return resourceVersion ? { ...patch, metadata: { ...metadata, resourceVersion } } : patch;
};

/** A health check code Rook accepts as a key of `muteHealthWarning` (the CRD's rule `^[A-Z]+(_[A-Z]+)+$`). */
export const MUTE_CODE = /^[A-Z]+(_[A-Z]+)+$/;
/** At most this many codes in `muteHealthWarning` (the CRD's `MaxProperties`). */
export const MAX_MUTED = 10;

/**
 * Mutes or unmutes a Ceph health warning: `spec.healthCheck.muteHealthWarning.<code>.policy` (`MuteHealthWarningSpec`,
 * types.go). Unmuting writes `unmute`, which Rook applies; a later mute writes `mute` again.
 */
export function mutePatch(code: string, mute: boolean, resourceVersion?: string): Patch {
  if (!MUTE_CODE.test(code)) throw new Error(`\`${code}\` is not a Ceph health check code`);
  return guarded(resourceVersion, {
    spec: { healthCheck: { muteHealthWarning: { [code]: { policy: mute ? "mute" : "unmute" } } } },
  });
}

/** The codes muted now (policy `mute`), and how many entries the map holds (muted or unmuted). */
export function mutedCodes(spec: unknown): { muted: string[]; entries: number } {
  const map = (spec as { healthCheck?: { muteHealthWarning?: Record<string, { policy?: string }> } } | undefined)?.healthCheck
    ?.muteHealthWarning;
  const entries = map ? Object.keys(map) : [];
  return { muted: entries.filter((code) => map![code]?.policy === "mute").sort(), entries: entries.length };
}

/** Rook's label that pauses reconciling of the object it is on (`SkipReconcileLabelKey`, labels.go). */
export const DO_NOT_RECONCILE = "ceph.rook.io/do-not-reconcile";

/** Pauses (`true`) or resumes reconciling of a CephCluster by its label. */
export function reconcilePatch(paused: boolean, resourceVersion?: string): Patch {
  return guarded(resourceVersion, { metadata: { labels: { [DO_NOT_RECONCILE]: paused ? "true" : null } } });
}

/** `spec.metadataServer` of a CephFilesystem (`MetadataServerSpec`: `activeCount` 1–50). */
export function mdsPatch(activeCount: number, activeStandby: boolean, resourceVersion?: string): Patch {
  if (!Number.isInteger(activeCount) || activeCount < 1 || activeCount > 50) throw new Error("activeCount is 1 to 50");
  return guarded(resourceVersion, { spec: { metadataServer: { activeCount, activeStandby } } });
}

/** `spec.gateway.instances` of a CephObjectStore. */
export function gatewayPatch(instances: number, resourceVersion?: string): Patch {
  if (!Number.isInteger(instances) || instances < 1 || instances > 100) throw new Error("instances is 1 to 100");
  return guarded(resourceVersion, { spec: { gateway: { instances } } });
}

export interface PoolSettings {
  /** `spec.replicated.size`; `undefined` leaves it (an erasure-coded pool has none). */
  size?: number;
  /** `spec.quotas.maxSize` as a quantity (`10Gi`), or `null` to remove the quota. */
  maxSize?: string | null;
  /** `spec.quotas.maxObjects`, or `null` to remove it. */
  maxObjects?: number | null;
}

/** A Kubernetes quantity of bytes such as `500Mi`, `10Gi`, `1Ti` or `1000000`. */
export const QUANTITY = /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/;

/** Replication and quotas of a CephBlockPool (`ReplicatedSpec.Size`, `QuotaSpec`, types.go). */
export function poolPatch(settings: PoolSettings, resourceVersion?: string): Patch {
  const spec: Patch = {};
  if (settings.size !== undefined) {
    if (!Number.isInteger(settings.size) || settings.size < 1 || settings.size > 9) throw new Error("size is 1 to 9");
    spec.replicated = { size: settings.size };
  }
  const quotas: Patch = {};
  if (settings.maxSize !== undefined) {
    if (settings.maxSize !== null && !QUANTITY.test(settings.maxSize)) throw new Error("maxSize is a quantity such as 10Gi");
    quotas.maxSize = settings.maxSize;
  }
  if (settings.maxObjects !== undefined) {
    if (settings.maxObjects !== null && (!Number.isInteger(settings.maxObjects) || settings.maxObjects < 1)) {
      throw new Error("maxObjects is a whole number above 0");
    }
    quotas.maxObjects = settings.maxObjects;
  }
  if (Object.keys(quotas).length) spec.quotas = quotas;
  return guarded(resourceVersion, { spec });
}

/** Rook's annotations of an OSD replacement (labels.go, Documentation/.../ceph-osd-mgmt.md). */
export const REPLACE_OSD = "osd.rook.io/replace";
export const REPLACE_IN_PROGRESS = "osd.rook.io/replace-in-progress";
export const READY_FOR_SWAP = "osd.rook.io/replace-ready-for-swap";
/** Set on an OSD Deployment backed by a PVC, which Rook does not replace this way (`OSDOverPVCLabelKey`). */
export const OSD_ON_PVC = "ceph.rook.io/pvc";

/** Starts (`true`) or cancels the replacement of OSD `id` on its Deployment `rook-ceph-osd-<id>`. */
export function replaceOsdPatch(id: number, replace: boolean, resourceVersion?: string): Patch {
  if (!Number.isInteger(id) || id < 0) throw new Error("an OSD id is a whole number");
  return guarded(resourceVersion, {
    metadata: { annotations: { [REPLACE_OSD]: replace ? `yes-really-replace-osd-${id}` : null } },
  });
}

/** `spec.cephVersion.image` of a CephCluster: what Rook upgrades Ceph to, daemon by daemon. */
export function cephImagePatch(image: string, resourceVersion?: string): Patch {
  return guarded(resourceVersion, { spec: { cephVersion: { image } } });
}

/** The toolbox container's image, for a toolbox that should run the cluster's new Ceph. */
export function toolboxImagePatch(index: number, image: string): object[] {
  // A JSON patch: a merge patch would replace the whole containers list (command, env, mounts and all).
  const at = `/spec/template/spec/containers/${index}`;
  return [
    { op: "test", path: `${at}/name`, value: TOOLBOX_CONTAINER },
    { op: "replace", path: `${at}/image`, value: image },
  ];
}

/** The toolbox's container in Rook's toolbox.yaml. */
export const TOOLBOX_CONTAINER = "rook-ceph-tools";

/** Rook's toolbox Deployment for the cluster in `namespace`, running `image`. */
export function toolboxYaml(namespace: string, image: string): string {
  if (!ROOK_TOOLBOX_YAML.includes(TOOLBOX_NAMESPACE_LINE) || !ROOK_TOOLBOX_YAML.includes(TOOLBOX_IMAGE_LINE)) {
    throw new Error("the vendored toolbox manifest changed");
  }
  return ROOK_TOOLBOX_YAML.replace(TOOLBOX_NAMESPACE_LINE, `  namespace: ${yamlString(namespace)}`).replace(
    TOOLBOX_IMAGE_LINE,
    `          image: ${yamlString(image)}`,
  );
}

/** A YAML scalar that is read back as exactly `text`. */
export function yamlString(text: string): string {
  return JSON.stringify(text);
}

// ---------------------------------------------------------------------------------------------------------------
// New objects, after Rook's examples (deploy/examples/pool.yaml, filesystem.yaml, object.yaml, object-user.yaml,
// csi/rbd/storageclass.yaml, csi/cephfs/storageclass.yaml, storageclass-bucket-delete.yaml). JSON is YAML, so the
// documents are built as objects and written as JSON: no quoting can go wrong.

export interface NewPool {
  name: string;
  namespace: string;
  failureDomain: "host" | "osd";
  size: number;
}

export function poolObject(p: NewPool) {
  return {
    apiVersion: "ceph.rook.io/v1",
    kind: "CephBlockPool",
    metadata: { name: p.name, namespace: p.namespace },
    spec: { failureDomain: p.failureDomain, replicated: { size: p.size, requireSafeReplicaSize: p.size > 1 } },
  };
}

export interface NewFilesystem {
  name: string;
  namespace: string;
  failureDomain: "host" | "osd";
  size: number;
  activeCount: number;
}

export function filesystemObject(f: NewFilesystem) {
  const replicated = { size: f.size, requireSafeReplicaSize: f.size > 1 };
  return {
    apiVersion: "ceph.rook.io/v1",
    kind: "CephFilesystem",
    metadata: { name: f.name, namespace: f.namespace },
    spec: {
      metadataPool: { replicated },
      dataPools: [{ name: "replicated", failureDomain: f.failureDomain, replicated }],
      preserveFilesystemOnDelete: true,
      metadataServer: { activeCount: f.activeCount, activeStandby: true },
    },
  };
}

export interface NewObjectStore {
  name: string;
  namespace: string;
  failureDomain: "host" | "osd";
  size: number;
  instances: number;
}

export function objectStoreObject(o: NewObjectStore) {
  const pool = { failureDomain: o.failureDomain, replicated: { size: o.size, requireSafeReplicaSize: o.size > 1 } };
  return {
    apiVersion: "ceph.rook.io/v1",
    kind: "CephObjectStore",
    metadata: { name: o.name, namespace: o.namespace },
    spec: { metadataPool: pool, dataPool: pool, preservePoolsOnDelete: true, gateway: { port: 80, instances: o.instances } },
  };
}

export interface NewObjectUser {
  name: string;
  namespace: string;
  store: string;
  displayName: string;
}

export function objectUserObject(u: NewObjectUser) {
  return {
    apiVersion: "ceph.rook.io/v1",
    kind: "CephObjectStoreUser",
    metadata: { name: u.name, namespace: u.namespace },
    spec: { store: u.store, displayName: u.displayName },
  };
}

export type ClassTarget =
  | { type: "rbd"; pool: string }
  | { type: "cephfs"; filesystem: string; dataPool: string }
  | { type: "bucket"; objectStore: string };

export interface NewStorageClass {
  name: string;
  /** The CephCluster's namespace: Rook's default `clusterID`, and where the CSI secrets are. */
  clusterNamespace: string;
  /** The CSI drivers' name prefix: the operator's namespace by default. */
  driverPrefix: string;
  /** The bucket provisioner's name as the operator registers it: an existing bucket class's, else Rook's
   * operator.yaml default `<cluster namespace>.ceph.rook.io/bucket` (`GetObjectBucketProvisioner`). */
  bucketProvisioner?: string;
  target: ClassTarget;
  reclaimPolicy: "Delete" | "Retain";
}

/** A StorageClass as Rook's examples write it, with the secrets Rook creates for the CSI drivers. */
export function storageClassObject(c: NewStorageClass) {
  const ns = c.clusterNamespace;
  const secrets = (kind: "rbd" | "cephfs") => ({
    "csi.storage.k8s.io/provisioner-secret-name": `rook-csi-${kind}-provisioner`,
    "csi.storage.k8s.io/provisioner-secret-namespace": ns,
    "csi.storage.k8s.io/controller-expand-secret-name": `rook-csi-${kind}-provisioner`,
    "csi.storage.k8s.io/controller-expand-secret-namespace": ns,
    "csi.storage.k8s.io/node-stage-secret-name": `rook-csi-${kind}-node`,
    "csi.storage.k8s.io/node-stage-secret-namespace": ns,
  });
  const base = { apiVersion: "storage.k8s.io/v1", kind: "StorageClass", metadata: { name: c.name }, reclaimPolicy: c.reclaimPolicy };
  switch (c.target.type) {
    case "rbd":
      return {
        ...base,
        provisioner: `${c.driverPrefix}.rbd.csi.ceph.com`,
        allowVolumeExpansion: true,
        parameters: {
          clusterID: ns,
          pool: c.target.pool,
          imageFormat: "2",
          imageFeatures: "layering",
          ...secrets("rbd"),
          "csi.storage.k8s.io/fstype": "ext4",
        },
      };
    case "cephfs":
      return {
        ...base,
        provisioner: `${c.driverPrefix}.cephfs.csi.ceph.com`,
        allowVolumeExpansion: true,
        parameters: { clusterID: ns, fsName: c.target.filesystem, pool: c.target.dataPool, ...secrets("cephfs") },
      };
    case "bucket":
      return {
        ...base,
        provisioner: c.bucketProvisioner ?? `${ns}.ceph.rook.io/bucket`,
        parameters: { objectStoreName: c.target.objectStore, objectStoreNamespace: ns },
      };
  }
}

/** Objects as one YAML text of JSON documents. */
export function asYaml(objects: readonly object[]): string {
  return objects.map((o) => JSON.stringify(o, null, 2)).join("\n---\n");
}

/** A DNS-1123 subdomain: the name of a Rook object or StorageClass. */
export function isObjectName(name: string): boolean {
  return name.length <= 253 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(name);
}

// ---------------------------------------------------------------------------------------------------------------
// CRUSH and OSDs (Documentation/CRDs/Cluster/ceph-cluster-crd.md "OSD Topology", "OSD Device Class via Node Label";
// Documentation/Storage-Configuration/Advanced/ceph-osd-mgmt.md).

/** The node labels Rook reads for an OSD's CRUSH location, highest level first; `host` is added by Rook itself. */
export const TOPOLOGY_LABELS: readonly { level: string; label: string }[] = [
  { level: "region", label: "topology.kubernetes.io/region" },
  { level: "zone", label: "topology.kubernetes.io/zone" },
  { level: "datacenter", label: "topology.rook.io/datacenter" },
  { level: "room", label: "topology.rook.io/room" },
  { level: "pod", label: "topology.rook.io/pod" },
  { level: "pdu", label: "topology.rook.io/pdu" },
  { level: "row", label: "topology.rook.io/row" },
  { level: "rack", label: "topology.rook.io/rack" },
  { level: "chassis", label: "topology.rook.io/chassis" },
];

/** The node label that gives every OSD of a node its device class (`NodeDeviceClassLabelKey`, osd.go). */
export const NODE_DEVICE_CLASS = "osd.rook.io/device-class";

/** A CRUSH bucket name or device class: letters, digits, `-`, `_` and `.` (also a valid label value). */
export const CRUSH_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

/** A node's topology labels and device class: a value sets the label, `null` removes it. */
export function nodeLabelsPatch(labels: Readonly<Record<string, string | null>>, resourceVersion?: string): Patch {
  const allowed = new Set([...TOPOLOGY_LABELS.map((t) => t.label), NODE_DEVICE_CLASS]);
  for (const [label, value] of Object.entries(labels)) {
    if (!allowed.has(label)) throw new Error(`\`${label}\` is not a label Rook reads for CRUSH`);
    if (value !== null && !CRUSH_NAME.test(value)) throw new Error(`\`${value}\` is not a CRUSH name`);
  }
  return guarded(resourceVersion, { metadata: { labels: { ...labels } } });
}

/** The CephCluster's `spec.storage` switches (`StorageScopeSpec`, types.go). */
export interface StorageSwitches {
  allowDeviceClassUpdate?: boolean;
  allowOsdCrushWeightUpdate?: boolean;
  useAllNodes?: boolean;
  useAllDevices?: boolean;
  /** A regular expression of device names, or `null` to remove it. */
  deviceFilter?: string | null;
}

export function storagePatch(switches: StorageSwitches, resourceVersion?: string): Patch {
  const storage: Patch = {};
  for (const [key, value] of Object.entries(switches)) if (value !== undefined) storage[key] = value;
  return guarded(resourceVersion, { spec: { storage } });
}

/** The CephCluster's `spec.removeOSDsIfOutAndSafeToRemove`. */
export function autoRemovePatch(enabled: boolean, resourceVersion?: string): Patch {
  return guarded(resourceVersion, { spec: { removeOSDsIfOutAndSafeToRemove: enabled } });
}

/** Where a CephBlockPool's data goes (`PoolSpec.FailureDomain`, `CrushRoot`, `DeviceClass`): `null` removes a field. */
export interface PoolPlacement {
  failureDomain?: string | null;
  deviceClass?: string | null;
  crushRoot?: string | null;
}

export function poolPlacementPatch(placement: PoolPlacement, resourceVersion?: string): Patch {
  const spec: Patch = {};
  for (const [key, value] of Object.entries(placement)) {
    if (value === undefined) continue;
    if (value !== null && !CRUSH_NAME.test(value)) throw new Error(`\`${value}\` is not a CRUSH name`);
    spec[key] = value;
  }
  return guarded(resourceVersion, { spec });
}

/**
 * The `count` of the device set at `index` (PVC-based OSDs, `storageClassDeviceSets`), as a JSON patch that first
 * tests the set's name, so a list that changed in between is refused instead of changing another set.
 */
export function deviceSetCountPatch(index: number, name: string, count: number): object[] {
  if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error("count is 0 to 1000");
  const at = `/spec/storage/storageClassDeviceSets/${index}`;
  return [
    { op: "test", path: `${at}/name`, value: name },
    { op: "replace", path: `${at}/count`, value: count },
  ];
}

/** Pauses (`true`) or resumes reconciling of one daemon by Rook's label on its Deployment (controller/spec.go). */
export function daemonReconcilePatch(paused: boolean, resourceVersion?: string): Patch {
  return reconcilePatch(paused, resourceVersion);
}

/** The name of the purge Job of an OSD; one per OSD, so two removals never share a Job. */
export function purgeJobName(id: number): string {
  return `rook-ceph-purge-osd-${id}`;
}

/**
 * Rook's purge Job (`deploy/examples/osd-purge.yaml` of Rook v1.21.1): `rook ceph osd remove --osd-ids <id>` with the
 * operator's image and the cluster's mon endpoints and admin secret. Never forced: Rook refuses an OSD that is not
 * safe to destroy. `--preserve-pvc false` deletes a PVC-based OSD's claim, as the example does.
 */
export function purgeJobObject(namespace: string, id: number, rookImage: string) {
  if (!Number.isInteger(id) || id < 0) throw new Error("an OSD id is a whole number");
  const secret = (key: string) => ({ secretKeyRef: { key, name: "rook-ceph-mon" } });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: purgeJobName(id), namespace, labels: { app: "rook-ceph-purge-osd" } },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: { app: "rook-ceph-purge-osd" } },
        spec: {
          serviceAccountName: "rook-ceph-purge-osd",
          restartPolicy: "Never",
          containers: [
            {
              name: "osd-removal",
              image: rookImage,
              args: ["ceph", "osd", "remove", "--preserve-pvc", "false", "--force-osd-removal", "false", "--osd-ids", String(id)],
              env: [
                { name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
                { name: "ROOK_MON_ENDPOINTS", valueFrom: { configMapKeyRef: { key: "data", name: "rook-ceph-mon-endpoints" } } },
                { name: "ROOK_CEPH_USERNAME", valueFrom: secret("ceph-username") },
                { name: "ROOK_CONFIG_DIR", value: "/var/lib/rook" },
                { name: "ROOK_CEPH_CONFIG_OVERRIDE", value: "/etc/rook/config/override.conf" },
                { name: "ROOK_FSID", valueFrom: secret("fsid") },
                { name: "ROOK_LOG_LEVEL", value: "DEBUG" },
              ],
              volumeMounts: [
                { mountPath: "/etc/ceph", name: "ceph-conf-emptydir" },
                { mountPath: "/var/lib/rook", name: "rook-config" },
                { name: "ceph-admin-secret", mountPath: "/var/lib/rook-ceph-mon" },
              ],
            },
          ],
          volumes: [
            { name: "ceph-admin-secret", secret: { secretName: "rook-ceph-mon", optional: false, items: [{ key: "ceph-secret", path: "secret.keyring" }] } },
            { name: "ceph-conf-emptydir", emptyDir: {} },
            { name: "rook-config", emptyDir: {} },
          ],
        },
      },
    },
  };
}
