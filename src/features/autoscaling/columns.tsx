// Columns of the KEDA and Karpenter tables: targets, replica ranges, trigger types and the state in one word for
// KEDA; NodePool usage against its limits, NodeClaims' instance and node, and Ready for every kind with it.
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import { statusTone } from "../../resources/status";
import { authSources, scaleTargetOf, stateWord, triggerTypes } from "./keda";
import { CAPACITY_TYPE_LABEL, disruptionSettings, INSTANCE_TYPE_LABEL, launchProblem, limitRows, nodePoolOf, ZONE_LABEL } from "./karpenter";
import { conditionOf } from "./model";

const { get, num, record, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `autoscaling:columns.${id}`,
  value,
  ...options,
});

const readyOf = (o: KubeObject) => conditionOf(o, "Ready")?.status;

const readyColumn = col("ready", readyOf, {
  width: "80px",
  render: (o) => {
    const value = readyOf(o);
    return value ? <StatusText value={value} tone={value === "True" ? "success" : value === "False" ? "danger" : "warning"} /> : null;
  },
});

const stateColumn = col("state", stateWord, {
  width: "100px",
  render: (o) => {
    const value = stateWord(o);
    if (!value) return null;
    const tone = value === "Active" ? "success" : value === "Inactive" ? "muted" : value === "Paused" || value === "Fallback" ? "warning" : statusTone(value);
    return <StatusText value={value} tone={tone} />;
  },
});

const triggersColumn = col("triggers", (o) => triggerTypes(o).join(", "), { width: "minmax(120px, 1.5fr)" });

export const scaledObjectColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("target", (o) => {
    const t = scaleTargetOf(o);
    return t ? `${t.kind}/${t.name}` : undefined;
  }, { width: "minmax(140px, 1.5fr)" }),
  col("min", (o) => num(get(o, "spec", "minReplicaCount")) ?? 0, { width: "60px" }),
  col("max", (o) => num(get(o, "spec", "maxReplicaCount")) ?? 100, { width: "60px" }),
  triggersColumn,
  readyColumn,
  stateColumn,
  ageColumn,
];

export const scaledJobColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("max", (o) => num(get(o, "spec", "maxReplicaCount")) ?? 100, { width: "60px" }),
  triggersColumn,
  readyColumn,
  stateColumn,
  ageColumn,
];

export function authColumns(namespaced: boolean): ColumnDef[] {
  return [
    nameColumn,
    ...(namespaced ? [namespaceColumn] : []),
    col(
      "sources",
      (o) => {
        const { sources, podIdentity } = authSources(o);
        return [...new Set([...sources.map((s) => s.from), ...(podIdentity ? [podIdentity] : [])])].join(", ");
      },
      { width: "minmax(160px, 2fr)" },
    ),
    ageColumn,
  ];
}

export const nodePoolColumns: ColumnDef[] = [
  nameColumn,
  col("nodeClass", (o) => str(get(o, "spec", "template", "spec", "nodeClassRef", "name")), { width: "minmax(110px, 1fr)" }),
  col("nodes", (o) => num(get(o, "status", "resources", "nodes")) ?? str(get(o, "status", "resources", "nodes")), { width: "70px" }),
  col(
    "limits",
    (o) =>
      limitRows(o)
        .map((l) => `${l.resource} ${l.used ?? "0"}/${l.limit}`)
        .join(", "),
    {
      width: "minmax(160px, 2fr)",
      render: (o) => {
        const rows = limitRows(o);
        const text = rows.map((l) => `${l.resource} ${l.used ?? "0"}/${l.limit}`).join(", ");
        return rows.some((l) => l.reached) ? <StatusText value={text} tone="danger" /> : <span>{text}</span>;
      },
    },
  ),
  col("consolidation", (o) => disruptionSettings(o).consolidationPolicy, { width: "minmax(120px, 1fr)" }),
  readyColumn,
  ageColumn,
];

const label = (key: string) => (o: KubeObject) => str(record(o.metadata?.labels)[key]);

export const nodeClaimColumns: ColumnDef[] = [
  nameColumn,
  col("nodePool", nodePoolOf, { width: "minmax(100px, 1fr)" }),
  col("instanceType", label(INSTANCE_TYPE_LABEL), { width: "minmax(100px, 1fr)" }),
  col("capacityType", label(CAPACITY_TYPE_LABEL), { width: "90px" }),
  col("zone", label(ZONE_LABEL), { width: "minmax(90px, 1fr)" }),
  col("node", (o) => str(get(o, "status", "nodeName")), { width: "minmax(140px, 1.5fr)" }),
  col("state", (o) => launchProblem(o)?.params?.reason as string | undefined, { width: "minmax(100px, 1fr)" }),
  readyColumn,
  ageColumn,
];

export const nodeClassColumns: ColumnDef[] = [
  nameColumn,
  col("role", (o) => str(get(o, "spec", "role")) ?? str(get(o, "spec", "instanceProfile")), { width: "minmax(140px, 2fr)" }),
  readyColumn,
  ageColumn,
];

/** Whether a KEDA or Karpenter object needs attention (the tables' "Only problems" filter). */
export function hasProblem(o: KubeObject): boolean {
  const ready = conditionOf(o, "Ready");
  if (ready && ready.status === "False") return true;
  if (limitRows(o).some((l) => l.reached)) return true;
  return false;
}
