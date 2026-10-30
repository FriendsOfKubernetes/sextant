// Which StorageClasses put volumes on a Ceph pool, filesystem or object store, and which claims use them, as
// Rook's examples set them up (deploy/examples/csi/rbd/storageclass.yaml, csi/cephfs/storageclass.yaml,
// storageclass-bucket-delete.yaml):
// - RBD: provisioner `<prefix>.rbd.csi.ceph.com`, `parameters.clusterID` the CephCluster's namespace (Rook's default
//   clusterID), `parameters.pool` the Ceph pool, or `parameters.dataPool` for an erasure-coded data pool;
// - CephFS: provisioner `<prefix>.cephfs.csi.ceph.com`, `clusterID`, `fsName` the filesystem;
// - buckets: provisioner `<operator namespace>.ceph.rook.io/bucket`, `objectStoreName` and `objectStoreNamespace`.
// A StorageClass with another clusterID (one set up by hand through a ClientProfile, a RADOS namespace or a
// subvolume group) is not matched: Sextant cannot tell from the objects which CephCluster that is.
import type { KubeObject } from "@sextant/extension-sdk";
import { cephPoolName, type CephBlockPool, type RookObject } from "./rook";

export type StorageClass = KubeObject & { provisioner?: string; parameters?: Record<string, string> };
export type Claim = KubeObject<
  { storageClassName?: string; resources?: { requests?: { storage?: string } }; volumeName?: string },
  { phase?: string; capacity?: { storage?: string } }
>;

export type Driver = "rbd" | "cephfs" | "bucket";

/** What a StorageClass's provisioner is, if it is one of Ceph's. */
export function driverOf(storageClass: StorageClass): Driver | null {
  const provisioner = storageClass.provisioner ?? "";
  if (provisioner.endsWith(".rbd.csi.ceph.com")) return "rbd";
  if (provisioner.endsWith(".cephfs.csi.ceph.com")) return "cephfs";
  if (provisioner.endsWith(".ceph.rook.io/bucket")) return "bucket";
  return null;
}

/** The StorageClasses on a CephBlockPool, CephFilesystem or CephObjectStore (its kind says which). */
export function storageClassesOf(target: RookObject, kind: string, classes: StorageClass[]): StorageClass[] {
  const namespace = target.metadata.namespace ?? "";
  return classes
    .filter((sc) => {
      const p = sc.parameters ?? {};
      switch (driverOf(sc)) {
        case "rbd": {
          if (kind !== "CephBlockPool" || p.clusterID !== namespace) return false;
          const pool = cephPoolName(target as CephBlockPool);
          return p.pool === pool || p.dataPool === pool;
        }
        case "cephfs":
          return kind === "CephFilesystem" && p.clusterID === namespace && p.fsName === target.metadata.name;
        case "bucket":
          return kind === "CephObjectStore" && p.objectStoreName === target.metadata.name && p.objectStoreNamespace === namespace;
        default:
          return false;
      }
    })
    .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}

/** Claims (PVCs or ObjectBucketClaims) of the named StorageClasses, by namespace and name. */
export function claimsOf<T extends Claim>(classes: StorageClass[], claims: T[]): T[] {
  const names = new Set(classes.map((sc) => sc.metadata.name));
  return claims
    .filter((c) => names.has(c.spec?.storageClassName ?? ""))
    .sort(
      (a, b) =>
        (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") || a.metadata.name.localeCompare(b.metadata.name),
    );
}

/** What a StorageClass points at, in words: "pool replicapool", "filesystem myfs", "object store my-store". */
export function targetOf(storageClass: StorageClass): string | null {
  const p = storageClass.parameters ?? {};
  switch (driverOf(storageClass)) {
    case "rbd":
      return p.dataPool ? `pool ${p.dataPool} (metadata in ${p.pool ?? "?"})` : p.pool ? `pool ${p.pool}` : null;
    case "cephfs":
      return p.fsName ? `filesystem ${p.fsName}` : null;
    case "bucket":
      return p.objectStoreName ? `object store ${p.objectStoreName}` : null;
    default:
      return null;
  }
}
