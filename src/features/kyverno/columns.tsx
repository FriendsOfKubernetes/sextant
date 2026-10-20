// Columns of the Kyverno tables: a policy's readiness (colored), mode (Enforce / Audit / Mixed), background scans and
// rule count; a report's object and its pass / fail / warn / error / skip counts, failures colored.
import { useTranslation } from "react-i18next";
import type { KindRef, KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import {
  backgroundScan,
  modeTone,
  policyMessage,
  policyMode,
  policyReady,
  policyRules,
  readyTone,
  reportScope,
  reportSummary,
  type ResultValue,
} from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `kyverno:columns.${id}`,
  value,
  ...options,
});

function Ready({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const value = policyReady(obj);
  if (!value) return null;
  return <StatusText value={t(`kyverno:ready.${value}`)} tone={readyTone(value)} />;
}

function ModeText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const mode = policyMode(obj);
  if (!mode) return null;
  return <StatusText value={t(`kyverno:mode.${mode}`)} tone={modeTone(mode)} />;
}

function Background({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  return <>{backgroundScan(obj) ? t("kyverno:yes") : t("kyverno:no")}</>;
}

export const policyColumns = (namespaced: boolean): ColumnDef[] => [
  nameColumn,
  ...(namespaced ? [namespaceColumn] : []),
  col("ready", policyReady, { width: "90px", render: (o) => <Ready obj={o} /> }),
  col("mode", policyMode, { width: "90px", render: (o) => <ModeText obj={o} /> }),
  col("background", backgroundScan, { width: "100px", render: (o) => <Background obj={o} /> }),
  col("rules", (o) => policyRules(o).length, { width: "70px" }),
  col("message", policyMessage, {
    width: "minmax(160px, 3fr)",
    render: (o) => {
      const text = policyMessage(o);
      return text ? <span title={text}>{text}</span> : null;
    },
  }),
  ageColumn,
];

const count = (kind: KindRef, value: ResultValue) =>
  col(value, (o) => reportSummary(kind, o)[value], {
    width: "70px",
    render: (o) => {
      const n = reportSummary(kind, o)[value];
      return (value === "fail" || value === "error") && n > 0 ? <StatusText value={String(n)} tone="danger" /> : String(n);
    },
  });

function scopeText(kind: KindRef, o: KubeObject): string | undefined {
  const scope = reportScope(kind, o);
  return scope ? `${scope.kind.kind}/${scope.name}` : undefined;
}

export const reportColumns = (kind: KindRef, namespaced: boolean): ColumnDef[] => [
  nameColumn,
  ...(namespaced ? [namespaceColumn] : []),
  col("object", (o) => scopeText(kind, o), { width: "minmax(160px, 2fr)" }),
  count(kind, "pass"),
  count(kind, "fail"),
  count(kind, "warn"),
  count(kind, "error"),
  count(kind, "skip"),
  ageColumn,
];
