// Columns of the External Secrets tables: every kind shows its Ready state (ready / pending / failed, with the
// condition's reason); ExternalSecrets also the store, the target Secret, the refresh interval and the last sync;
// stores their provider; PushSecrets their source Secret. No Secret value is ever shown (none reaches the window).
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { Age } from "../../components";
import { formatList } from "../../i18n";
import { ageColumn, ageOptions, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import {
  capabilitiesOf,
  lastSyncOf,
  providerOf,
  pushSourceSecret,
  pushStoreRefs,
  readinessOf,
  READY_TONE,
  refreshIntervalOf,
  storeRefOf,
  targetSecretName,
} from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `externalsecrets:columns.${id}`,
  value,
  ...options,
});

/** The Ready state in words, colored; the reason and message as its tooltip. */
export function ReadyCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const r = readinessOf(obj);
  const tip = [r.reason, r.message].filter(Boolean).join(": ");
  return (
    <span title={tip || undefined}>
      <StatusText value={t(`externalsecrets:state.${r.state}`)} tone={READY_TONE[r.state]} />
    </span>
  );
}

const statusColumn = col("status", (o) => readinessOf(o).state, {
  width: "100px",
  render: (o) => <ReadyCell obj={o} />,
});
const reasonColumn = col("reason", (o) => readinessOf(o).reason, {
  width: "minmax(120px, 1fr)",
});
const storeColumn = col(
  "store",
  (o) => {
    const ref = storeRefOf(o);
    return ref ? `${ref.kind}/${ref.name}` : undefined;
  },
  { width: "minmax(140px, 1.5fr)" },
);
const targetColumn = col("target", targetSecretName, {
  width: "minmax(120px, 1fr)",
});
const refreshColumn = col("refresh", refreshIntervalOf, { width: "90px" });
const lastSyncColumn = col("lastSync", (o) => lastSyncOf(o), {
  width: "100px",
  render: (o, ctx) => <Age timestamp={lastSyncOf(o)} now={ctx.now} />,
  ...ageOptions(lastSyncOf),
});

export const externalSecretColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  statusColumn,
  storeColumn,
  targetColumn,
  refreshColumn,
  lastSyncColumn,
  reasonColumn,
  ageColumn,
];

export const clusterExternalSecretColumns: ColumnDef[] = [nameColumn, statusColumn, refreshColumn, reasonColumn, ageColumn];

const providerColumn = col("provider", providerOf, { width: "110px" });
const capabilitiesColumn = col("capabilities", capabilitiesOf, {
  width: "110px",
});

export const storeColumns = (namespaced: boolean): ColumnDef[] => [
  nameColumn,
  ...(namespaced ? [namespaceColumn] : []),
  statusColumn,
  providerColumn,
  capabilitiesColumn,
  reasonColumn,
  ageColumn,
];

const sourceColumn = col("source", pushSourceSecret, {
  width: "minmax(120px, 1fr)",
});
const storesColumn = col("stores", (o) => formatList(pushStoreRefs(o).map((r) => r.name)), { width: "minmax(140px, 1.5fr)" });

export const pushSecretColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  statusColumn,
  sourceColumn,
  storesColumn,
  refreshColumn,
  lastSyncColumn,
  reasonColumn,
  ageColumn,
];
