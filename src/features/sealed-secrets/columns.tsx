// Columns of the SealedSecrets table: the Synced state (synced / pending / failed, the controller's message as its
// tooltip), the scope it was sealed for, how many keys it seals, and the message. The target Secret has the
// SealedSecret's own name, so it needs no column. No value, sealed or not, is shown.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import { scopeOf, sealedKeys, SYNC_TONE, syncOf } from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `sealedsecrets:columns.${id}`,
  value,
  ...options,
});

/** The Synced state in words, colored; the controller's message as its tooltip. */
export function SyncCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const s = syncOf(obj);
  return (
    <span title={s.message || undefined}>
      <StatusText value={t(`sealedsecrets:state.${s.state}`)} tone={SYNC_TONE[s.state]} />
    </span>
  );
}

function ScopeCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  return <>{t(`sealedsecrets:scope.${scopeOf(obj)}`)}</>;
}

export const sealedSecretColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", (o) => syncOf(o).state, { width: "100px", render: (o) => <SyncCell obj={o} /> }),
  col("scope", scopeOf, { width: "130px", render: (o) => <ScopeCell obj={o} /> }),
  col("keys", (o) => sealedKeys(o).length, { width: "70px" }),
  col("message", (o) => syncOf(o).message, { width: "minmax(160px, 2fr)" }),
  ageColumn,
];
