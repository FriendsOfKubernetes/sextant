// A CephCluster's components, found by the labels Rook and ceph-csi-operator put on their pods:
// - Ceph's daemons: `app=rook-ceph-<daemon>` and `rook_cluster=<the cluster's namespace>` (Rook's `AppLabels`,
//   pkg/operator/ceph/controller/spec.go), the daemon's id in `ceph_daemon_id`, an OSD's in `ceph-osd-id`;
// - the operator: `app=rook-ceph-operator` (deploy/examples/operator.yaml), in any namespace;
// - the CSI drivers in the operator's namespace: ceph-csi-operator's `app=<driver name>-nodeplugin|-ctrlplugin`
//   (its internal/controller/driver_controller.go; Rook names the drivers `<prefix>.rbd.csi.ceph.com`, `.cephfs.`,
//   pkg/operator/ceph/csi/config.go), or Rook's own older `app=csi-rbdplugin`, … (the list Rook itself looks
//   pods up by, pkg/operator/ceph/cluster/cephstatus.go);
// - the toolbox: `app=rook-ceph-tools` (deploy/examples/toolbox.yaml), in the cluster's namespace.
import type { KubeObject } from "@sextant/extension-sdk";

export type Pod = KubeObject<
  { nodeName?: string; containers?: { name: string }[] },
  {
    phase?: string;
    conditions?: { type?: string; status?: string }[];
    containerStatuses?: { name?: string; ready?: boolean; restartCount?: number; state?: Record<string, { reason?: string }> }[];
  }
>;

export type ComponentId = "operator" | "mon" | "mgr" | "osd" | "mds" | "rgw" | "nfs" | "rbdMirror" | "fsMirror" | "nvmeof" | "exporter" | "crash" | "csi";

/** The components, in the order shown; each one's title is `components.<id>` in the catalogs. */
export const COMPONENTS: readonly { id: ComponentId; apps: readonly string[] }[] = [
  { id: "operator", apps: ["rook-ceph-operator"] },
  { id: "mon", apps: ["rook-ceph-mon"] },
  { id: "mgr", apps: ["rook-ceph-mgr"] },
  { id: "osd", apps: ["rook-ceph-osd"] },
  { id: "mds", apps: ["rook-ceph-mds"] },
  { id: "rgw", apps: ["rook-ceph-rgw"] },
  { id: "nfs", apps: ["rook-ceph-nfs"] },
  { id: "rbdMirror", apps: ["rook-ceph-rbd-mirror"] },
  { id: "fsMirror", apps: ["rook-ceph-fs-mirror"] },
  { id: "nvmeof", apps: ["rook-ceph-nvmeof"] },
  { id: "exporter", apps: ["rook-ceph-exporter"] },
  { id: "crash", apps: ["rook-ceph-crashcollector"] },
  { id: "csi", apps: [] },
];

export const OPERATOR_SELECTOR = "app=rook-ceph-operator";
export const TOOLBOX_APP = "rook-ceph-tools";
/** Rook's own CSI pods, before ceph-csi-operator. */
const LEGACY_CSI_APPS = new Set([
  "csi-rbdplugin",
  "csi-rbdplugin-provisioner",
  "csi-cephfsplugin",
  "csi-cephfsplugin-provisioner",
  "csi-nfsplugin",
  "csi-nfsplugin-provisioner",
]);
const CSI_OPERATOR_APP = /\.(rbd|cephfs|nfs)\.csi\.ceph\.com-(nodeplugin|ctrlplugin)$/;

export function appOf(pod: Pod): string {
  return pod.metadata.labels?.app ?? "";
}

export function isCsiPod(pod: Pod): boolean {
  const app = appOf(pod);
  return LEGACY_CSI_APPS.has(app) || CSI_OPERATOR_APP.test(app);
}

/** Running, and every container ready (the pod's `Ready` condition). */
export function isReady(pod: Pod): boolean {
  if (pod.status?.phase !== "Running") return false;
  return pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
}

/** Why a pod is not ready, in Kubernetes' own words: a waiting or terminated reason, else its phase. */
export function notReadyReason(pod: Pod): string {
  for (const status of pod.status?.containerStatuses ?? []) {
    if (status.ready) continue;
    const reason = Object.values(status.state ?? {}).find((s) => s?.reason)?.reason;
    if (reason) return reason;
  }
  return pod.status?.phase ?? "Unknown";
}

export function restartsOf(pod: Pod): number {
  return (pod.status?.containerStatuses ?? []).reduce((n, s) => n + (s.restartCount ?? 0), 0);
}

export interface Component {
  id: ComponentId;
  pods: Pod[];
  ready: number;
}

export interface Components {
  /** Only the components that have pods, in `COMPONENTS` order. */
  groups: Component[];
  /** OSD pods by node (`spec.nodeName`; "" while not scheduled), nodes sorted. */
  osdsByNode: { node: string; pods: Pod[] }[];
  toolbox: Pod[];
}

/**
 * Sorts pods into components: `clusterPods` are the cluster namespace's (daemons by `rook_cluster`, the toolbox,
 * and the operator and CSI pods when the operator runs there too), `operatorPods` the operator's, `csiPods` the
 * operator namespaces' pods (only CSI ones are kept). A pod seen twice counts once.
 */
export function componentsOf(namespace: string, clusterPods: Pod[], operatorPods: Pod[], csiPods: Pod[]): Components {
  const byId = new Map<ComponentId, Map<string, Pod>>();
  const add = (id: ComponentId, pod: Pod) => {
    const pods = byId.get(id) ?? new Map<string, Pod>();
    pods.set(pod.metadata.uid ?? `${pod.metadata.namespace}/${pod.metadata.name}`, pod);
    byId.set(id, pods);
  };
  const toolbox: Pod[] = [];
  for (const pod of clusterPods) {
    const app = appOf(pod);
    if (app === TOOLBOX_APP) toolbox.push(pod);
    else if (isCsiPod(pod)) add("csi", pod);
    else if (app === "rook-ceph-operator") add("operator", pod);
    else if (pod.metadata.labels?.rook_cluster === namespace) {
      const component = COMPONENTS.find((c) => c.apps.includes(app));
      if (component) add(component.id, pod);
    }
  }
  for (const pod of operatorPods) if (appOf(pod) === "rook-ceph-operator") add("operator", pod);
  for (const pod of csiPods) if (isCsiPod(pod)) add("csi", pod);

  const groups = COMPONENTS.flatMap((c): Component[] => {
    const pods = [...(byId.get(c.id)?.values() ?? [])].sort(byName);
    return pods.length ? [{ id: c.id, pods, ready: pods.filter(isReady).length }] : [];
  });
  const nodes = new Map<string, Pod[]>();
  for (const pod of byId.get("osd")?.values() ?? []) {
    const node = pod.spec?.nodeName ?? "";
    nodes.set(node, [...(nodes.get(node) ?? []), pod]);
  }
  const osdsByNode = [...nodes.entries()]
    .map(([node, pods]) => ({ node, pods: pods.sort(byOsdId) }))
    .sort((a, b) => a.node.localeCompare(b.node));
  return { groups, osdsByNode, toolbox: toolbox.sort(byName) };
}

/** The daemon's id as Rook labels it: `ceph-osd-id` of an OSD, else `ceph_daemon_id`, else the pod's name. */
export function daemonIdOf(pod: Pod): string {
  const labels = pod.metadata.labels ?? {};
  return labels["ceph-osd-id"] ?? labels.ceph_daemon_id ?? pod.metadata.name;
}

const byName = (a: Pod, b: Pod) => a.metadata.name.localeCompare(b.metadata.name);
const byOsdId = (a: Pod, b: Pod) => {
  const x = Number(a.metadata.labels?.["ceph-osd-id"]);
  const y = Number(b.metadata.labels?.["ceph-osd-id"]);
  return Number.isNaN(x) || Number.isNaN(y) ? byName(a, b) : x - y;
};
