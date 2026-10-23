// Columns of the GPU Operator tables. ClusterPolicies: the state the operator reports, where its operands run and the
// MIG strategy. NVIDIADrivers: the state, the driver type and version, and the nodes they select. The components of a
// ClusterPolicy (its DaemonSets) are in the details: a table cell opens no watch.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, StatusText, type ColumnDef } from "../../resources";
import { driverNodeSelectorOf, driverTypeOf, driverVersionOf, failureOf, migStrategyOf, operandNamespaceOf, stateOf, STATE_TONE } from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `gpuoperator:columns.${id}`,
  value,
  ...options,
});

/** The state in words, colored; the operator's message as its tooltip. */
export function StateCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = stateOf(obj);
  return (
    <span title={failureOf(obj)?.message || undefined}>
      <StatusText value={t(`gpuoperator:state.${state}`)} tone={STATE_TONE[state]} />
    </span>
  );
}

const stateColumn = col("state", (o) => stateOf(o), { width: "120px", render: (o) => <StateCell obj={o} /> });

export const policyColumns: ColumnDef[] = [
  nameColumn,
  stateColumn,
  col("namespace", (o) => operandNamespaceOf(o), { width: "minmax(120px, 1fr)" }),
  // The strategy is an API value (none, single, mixed): shown as it is in every language.
  col("migStrategy", (o) => migStrategyOf(o), { width: "120px" }),
  ageColumn,
];

export const driverColumns: ColumnDef[] = [
  nameColumn,
  stateColumn,
  col("driverType", driverTypeOf, { width: "140px" }),
  col("version", driverVersionOf, { width: "minmax(100px, 1fr)" }),
  col("nodeSelector", (o) => Object.entries(driverNodeSelectorOf(o)).map(([k, v]) => `${k}=${v}`).join(", "), { width: "minmax(140px, 1fr)" }),
  ageColumn,
];
