// A cluster's CRUSH tree as Rook placed its OSDs: each OSD Deployment carries `topology-location-<level>` labels for
// its CRUSH location (`getOSDTopologyLocationLabels`, pkg/operator/ceph/cluster/osd/labels.go; `root` and `host`
// always, the node's topology labels for the levels between) and `device-class`. Up/in and the override weight come
// from the Ceph mgr's metrics, an OSD's bytes from Rook's ceph-exporter (`ceph_osd_stat_bytes*`), when scraped. This is the tree Rook asked for; what `ceph osd tree` shows
// after a change made in the toolbox can differ, and the view says so.
import type { KubeObject } from "@sextant/extension-sdk";
import { OSD_ON_PVC, READY_FOR_SWAP, REPLACE_IN_PROGRESS, REPLACE_OSD, DO_NOT_RECONCILE } from "./changes";

/** CRUSH levels from the top, as Ceph names its bucket types; `host` is the last level above an OSD. */
export const CRUSH_LEVELS = [
  "root",
  "region",
  "zone",
  "datacenter",
  "room",
  "pod",
  "pdu",
  "row",
  "rack",
  "chassis",
  "host",
] as const;

export type Deployment = KubeObject<
  { replicas?: number; template?: { spec?: { nodeName?: string; nodeSelector?: Record<string, string> } } },
  { readyReplicas?: number; replicas?: number }
>;

export interface Osd {
  id: number;
  deployment: Deployment;
  /** CRUSH location by level, from the Deployment's labels. */
  location: Partial<Record<(typeof CRUSH_LEVELS)[number], string>>;
  deviceClass: string | null;
  /** Backed by a PVC (`ceph.rook.io/pvc`): Rook's annotation replacement does not apply. */
  onPvc: boolean;
  ready: boolean;
  /** Rook's replacement state, from its annotations. */
  replace: "none" | "requested" | "inProgress" | "readyForSwap";
  /** `ceph.rook.io/do-not-reconcile` is set on the Deployment. */
  reconcilePaused: boolean;
}

/** An OSD from its Deployment (`rook-ceph-osd-<id>`, label `ceph-osd-id`), or `null` for another Deployment. */
export function osdOf(deployment: Deployment): Osd | null {
  const labels = deployment.metadata.labels ?? {};
  if (labels.app !== "rook-ceph-osd") return null;
  const id = Number(labels["ceph-osd-id"]);
  if (!Number.isInteger(id) || id < 0) return null;
  const location: Osd["location"] = {};
  for (const level of CRUSH_LEVELS) {
    const value = labels[`topology-location-${level}`];
    if (value) location[level] = value;
  }
  const annotations = deployment.metadata.annotations ?? {};
  const replace = annotations[READY_FOR_SWAP] === "true"
    ? "readyForSwap"
    : annotations[REPLACE_IN_PROGRESS] === "true"
      ? "inProgress"
      : annotations[REPLACE_OSD]
        ? "requested"
        : "none";
  const wanted = deployment.spec?.replicas ?? 1;
  return {
    id,
    deployment,
    location,
    deviceClass: labels["device-class"] || null,
    onPvc: Boolean(labels[OSD_ON_PVC]),
    ready: wanted > 0 && (deployment.status?.readyReplicas ?? 0) >= wanted,
    replace,
    reconcilePaused: DO_NOT_RECONCILE in labels,
  };
}

export interface CrushNode {
  /** `root`, `zone`, …, `host`. */
  level: string;
  name: string;
  children: CrushNode[];
  osds: Osd[];
}

/** The tree of buckets down to hosts, OSDs at their host (`root default` when a label is missing), sorted by name. */
export function crushTree(osds: readonly Osd[]): CrushNode[] {
  const roots: CrushNode[] = [];
  for (const osd of [...osds].sort((a, b) => a.id - b.id)) {
    let level = roots;
    let node: CrushNode | undefined;
    for (const name of CRUSH_LEVELS) {
      const value = osd.location[name] ?? (name === "root" ? "default" : name === "host" ? "?" : undefined);
      if (value === undefined) continue;
      node = level.find((n) => n.level === name && n.name === value);
      if (!node) {
        node = { level: name, name: value, children: [], osds: [] };
        level.push(node);
        level.sort((a, b) => a.name.localeCompare(b.name));
      }
      level = node.children;
    }
    node!.osds.push(osd);
  }
  return roots;
}

/** Usage of each OSD from the `osd-usage` metric query: by `ceph_daemon` (`osd.3`) and metric name. */
export interface OsdMetrics {
  up?: number;
  in?: number;
  /** Ceph's override weight (`ceph osd reweight`, 0–1), not the CRUSH weight. */
  reweight?: number;
  bytes?: number;
  used?: number;
}

export function osdMetrics(series: readonly { labels: Record<string, string>; points: [number, number | null][] }[]) {
  const names: Record<string, keyof OsdMetrics> = {
    ceph_osd_up: "up",
    ceph_osd_in: "in",
    ceph_osd_weight: "reweight",
    ceph_osd_stat_bytes: "bytes",
    ceph_osd_stat_bytes_used: "used",
  };
  const out = new Map<number, OsdMetrics>();
  for (const s of series) {
    const id = Number(/^osd\.(\d+)$/.exec(s.labels.ceph_daemon ?? "")?.[1]);
    const key = names[s.labels.__name__ ?? ""];
    const value = s.points.at(-1)?.[1];
    if (!Number.isInteger(id) || !key || value === null || value === undefined) continue;
    out.set(id, { ...out.get(id), [key]: value });
  }
  return out;
}
