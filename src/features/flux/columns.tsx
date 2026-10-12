// Columns of the Flux tables: every kind gets Ready (colored), Status (the Ready condition's message), Revision,
// Suspended and Age (`fluxColumns`); Kustomizations and HelmReleases also show their source.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import { isSuspended, readyMessage, readyStatus, readyTone, revisionOf, sourceRefOf } from "./model";

const fluxColumn = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `flux:columns.${id}`,
  value,
  ...options,
});

function Suspended({ value }: { value: boolean }) {
  const { t } = useTranslation();
  const text = t(value ? "flux:suspended.yes" : "flux:suspended.no");
  return <StatusText value={text} tone={value ? "warning" : "muted"} />;
}

function Truncated({ text }: { text: string | undefined }) {
  if (!text) return null;
  return <span title={text}>{text}</span>;
}

const readyColumn = fluxColumn("ready", readyStatus, {
  width: "80px",
  render: (o) => {
    const value = readyStatus(o);
    return value ? <StatusText value={value} tone={readyTone(value)} /> : null;
  },
});

const statusColumn = fluxColumn("status", readyMessage, {
  width: "minmax(200px, 4fr)",
  render: (o) => <Truncated text={readyMessage(o)} />,
});

const revisionColumn = fluxColumn("revision", revisionOf, {
  width: "minmax(140px, 2fr)",
  render: (o) => <Truncated text={revisionOf(o)} />,
});

const suspendedColumn = fluxColumn("suspended", isSuspended, {
  width: "100px",
  render: (o) => <Suspended value={isSuspended(o)} />,
});

function sourceText(obj: KubeObject): string | undefined {
  const ref = sourceRefOf(obj);
  if (!ref) return undefined;
  const ns = ref.namespace && ref.namespace !== obj.metadata?.namespace ? `${ref.namespace}/` : "";
  return `${ref.kind}/${ns}${ref.name}`;
}

const sourceColumn = fluxColumn("source", sourceText, { width: "minmax(140px, 2fr)" });

/** Ready, Status, Revision, Suspended, Age — the columns every Flux kind shows after its own. */
export const fluxColumns: ColumnDef[] = [readyColumn, statusColumn, revisionColumn, suspendedColumn, ageColumn];

/** Name, Namespace, `extra` (kind-specific), then `fluxColumns`. */
export function fluxTable(...extra: ColumnDef[]): ColumnDef[] {
  return [nameColumn, namespaceColumn, ...extra, ...fluxColumns];
}

export { sourceColumn };
