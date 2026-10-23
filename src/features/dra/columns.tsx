// Columns of the DRA tables. ResourceClaims: the state (allocated and reserved, allocated, pending, binding failed),
// the device classes asked for, the devices allocated, the node they are bound to and the pods that reserved them.
// Templates: the classes their claims will ask for. DeviceClasses: how many CEL selectors and which drivers they
// configure (the expressions themselves are in the details, as text). ResourceSlices: where the devices are, the
// driver, the pool and how many devices.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import {
  allocatedDevicesOf,
  allocatedNodeOf,
  claimSpecOf,
  claimState,
  classConfigOf,
  classesOf,
  classSelectorsOf,
  deviceKey,
  extendedResourceOf,
  requestsOf,
  reservingPods,
  sliceDevicesOf,
  sliceDriver,
  slicePool,
  sliceScope,
  STATE_TONE,
} from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `dra:columns.${id}`,
  value,
  ...options,
});

export function ClaimStateCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = claimState(obj);
  return <StatusText value={t(`dra:state.${state}`)} tone={STATE_TONE[state]} />;
}

function ScopeCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const scope = sliceScope(obj);
  if (scope.type === "node") return <>{scope.node}</>;
  return <span title={scope.type === "selector" ? scope.text.join("\n") : undefined}>{t(`dra:scope.${scope.type}`)}</span>;
}

const classesText = (o: KubeObject) => classesOf(claimSpecOf(o)).join(", ");
const devicesText = (o: KubeObject) => allocatedDevicesOf(o).map((d) => deviceKey(d)).join(", ");
const scopeValue = (o: KubeObject) => {
  const s = sliceScope(o);
  return s.type === "node" ? s.node : s.type;
};

export const claimColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("state", (o) => claimState(o), { width: "140px", render: (o) => <ClaimStateCell obj={o} /> }),
  col("classes", classesText, { width: "minmax(120px, 1fr)" }),
  col("devices", (o) => allocatedDevicesOf(o).length, {
    width: "90px",
    render: (o) => <span title={devicesText(o) || undefined}>{allocatedDevicesOf(o).length}</span>,
  }),
  col("node", (o) => allocatedNodeOf(o), { width: "minmax(100px, 1fr)" }),
  col("reservedFor", (o) => reservingPods(o).join(", "), { width: "minmax(120px, 1fr)" }),
  ageColumn,
];

export const templateColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("classes", classesText, { width: "minmax(120px, 1fr)" }),
  col("requests", (o) => requestsOf(claimSpecOf(o)).length, { width: "90px" }),
  ageColumn,
];

export const deviceClassColumns: ColumnDef[] = [
  nameColumn,
  col("selectors", (o) => classSelectorsOf(o).length, {
    width: "90px",
    render: (o) => <span title={classSelectorsOf(o).join("\n") || undefined}>{classSelectorsOf(o).length}</span>,
  }),
  col("drivers", (o) => [...new Set(classConfigOf(o).map((c) => c.driver))].join(", "), { width: "minmax(120px, 1fr)" }),
  col("extendedResource", (o) => extendedResourceOf(o), { width: "minmax(120px, 1fr)" }),
  ageColumn,
];

export const sliceColumns: ColumnDef[] = [
  nameColumn,
  col("node", scopeValue, { width: "minmax(120px, 1fr)", render: (o) => <ScopeCell obj={o} /> }),
  col("driver", sliceDriver, { width: "minmax(120px, 1fr)" }),
  col("pool", slicePool, { width: "minmax(100px, 1fr)" }),
  col("deviceCount", (o) => sliceDevicesOf(o).length, { width: "90px" }),
  ageColumn,
];
