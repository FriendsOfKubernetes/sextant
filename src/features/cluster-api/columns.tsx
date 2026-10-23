// Columns of the Cluster API tables: each object's state in words from its own phase and conditions (the phase or
// the failing condition as the tooltip), replica counts "ready/desired", up to date and available for
// MachineDeployments, MachineSets and KubeadmControlPlanes, a Machine's Node and a MachineHealthCheck's healthy count.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import {
  classOf,
  clusterNameOf,
  clusterReplicasOf,
  clusterState,
  firstFailing,
  healthCheckState,
  healthCountsOf,
  machineState,
  nodeNameOf,
  phaseOf,
  readyText,
  replicasOf,
  scalableState,
  STATE_TONE,
  type ClusterState,
  type HealthCheckState,
  type MachineState,
  type ScalableState,
} from "./model";

const { get, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `clusterapi:columns.${id}`,
  value,
  ...options,
});

type AnyState = ClusterState | MachineState | ScalableState | HealthCheckState;

/** A state in words; the tooltip is the phase and the first failing condition's message. */
export function StateText({ obj, state }: { obj: KubeObject; state: AnyState }) {
  const { t } = useTranslation();
  const failing = firstFailing(obj);
  const tip = [phaseOf(obj), failing?.message ?? failing?.reason].filter(Boolean).join(": ");
  return (
    <span title={tip || undefined}>
      <StatusText value={t(`clusterapi:state.${state}`)} tone={STATE_TONE[state]} />
    </span>
  );
}

const stateColumn = (of: (o: KubeObject) => AnyState): ColumnDef =>
  col("status", of, { width: "130px", render: (o) => <StateText obj={o} state={of(o)} /> });
const clusterColumn = col("cluster", clusterNameOf, { width: "minmax(120px, 1fr)" });
const phaseColumn = col("phase", phaseOf, { width: "110px" });
const readyColumn = col("ready", (o) => readyText(replicasOf(o)), { width: "80px" });
const upToDateColumn = col("upToDate", (o) => replicasOf(o).upToDate, { width: "90px" });
const availableColumn = col("available", (o) => replicasOf(o).available, { width: "90px" });

export const clusterColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  stateColumn(clusterState),
  phaseColumn,
  col("class", (o) => classOf(o)?.name, { width: "minmax(110px, 1fr)" }),
  col("version", (o) => str(get(o, "spec", "topology", "version")), { width: "100px" }),
  col("controlPlane", (o) => readyText(clusterReplicasOf(o).controlPlane), { width: "100px" }),
  col("workers", (o) => readyText(clusterReplicasOf(o).workers), { width: "90px" }),
  ageColumn,
];

export const machineColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  stateColumn(machineState),
  phaseColumn,
  clusterColumn,
  col("node", nodeNameOf, { width: "minmax(140px, 1.5fr)" }),
  col("version", (o) => str(get(o, "spec", "version")), { width: "100px" }),
  ageColumn,
];

/** MachineDeployments and MachineSets. */
export const machineGroupColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  stateColumn(scalableState),
  clusterColumn,
  readyColumn,
  upToDateColumn,
  availableColumn,
  col("version", (o) => str(get(o, "spec", "template", "spec", "version")), { width: "100px" }),
  ageColumn,
];

export const controlPlaneColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  stateColumn(scalableState),
  clusterColumn,
  readyColumn,
  upToDateColumn,
  availableColumn,
  col("version", (o) => str(get(o, "spec", "version")), { width: "100px" }),
  ageColumn,
];

export const healthCheckColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  stateColumn(healthCheckState),
  clusterColumn,
  col(
    "healthy",
    (o) => {
      const c = healthCountsOf(o);
      return c.expected === undefined ? undefined : `${c.healthy ?? 0}/${c.expected}`;
    },
    { width: "90px" },
  ),
  col("remediationsAllowed", (o) => healthCountsOf(o).allowed, { width: "120px" }),
  ageColumn,
];

export const clusterResourceSetColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("strategy", (o) => str(get(o, "spec", "strategy")) ?? "ApplyOnce", { width: "120px" }),
  ageColumn,
];

export const clusterClassColumns: ColumnDef[] = [nameColumn, namespaceColumn, ageColumn];
