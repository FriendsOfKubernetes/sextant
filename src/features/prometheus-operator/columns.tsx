// Columns of the Prometheus Operator tables: monitors show the namespaces they look in, their selector and the ports
// they scrape; probes their prober and module; PrometheusRules their groups and rules; Prometheus and Alertmanager
// their readiness (from the operator's conditions) and available replicas of desired.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { formatList } from "../../i18n";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import {
  endpointsOf,
  monitorSelector,
  POD_MONITOR,
  ruleCount,
  ruleGroupsOf,
  selectorText,
  SERVER_TONE,
  serverReadiness,
  SERVICE_MONITOR,
  targetNamespaces,
} from "./model";

const { get, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `prometheusoperator:columns.${id}`,
  value,
  ...options,
});

export function ServerStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const r = serverReadiness(obj);
  return (
    <span title={[r.reason, r.message].filter(Boolean).join(": ") || undefined}>
      <StatusText value={t(`prometheusoperator:state.${r.state}`)} tone={SERVER_TONE[r.state]} />
    </span>
  );
}

function NamespacesText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const where = targetNamespaces(obj);
  return <>{where.type === "any" ? t("prometheusoperator:anyNamespace") : formatList(where.names)}</>;
}

function SelectorText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const text = selectorText(monitorSelector(obj));
  return <>{text === "" ? t("prometheusoperator:selectsAll") : (text ?? t("prometheusoperator:selectsNone"))}</>;
}

const monitorColumns = (kind: typeof SERVICE_MONITOR): ColumnDef[] => [
  nameColumn,
  namespaceColumn,
  col(
    "namespaces",
    (o) => {
      const where = targetNamespaces(o);
      return where.type === "any" ? "*" : where.names.join(",");
    },
    { width: "minmax(120px, 1fr)", render: (o) => <NamespacesText obj={o} /> },
  ),
  col("selector", (o) => selectorText(monitorSelector(o)), {
    width: "minmax(160px, 2fr)",
    render: (o) => <SelectorText obj={o} />,
  }),
  col(
    "ports",
    (o) =>
      formatList(endpointsOf(o, kind).map((e) => e.port ?? e.targetPort ?? (e.number === undefined ? "" : String(e.number)))),
    {
      width: "minmax(100px, 1fr)",
    },
  ),
  ageColumn,
];

export const serviceMonitorColumns = monitorColumns(SERVICE_MONITOR);
export const podMonitorColumns = monitorColumns(POD_MONITOR);

export const probeColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("prober", (o) => str(get(o, "spec", "prober", "url")), {
    width: "minmax(160px, 2fr)",
  }),
  col("module", (o) => str(get(o, "spec", "module")), { width: "110px" }),
  col("interval", (o) => str(get(o, "spec", "interval")), { width: "80px" }),
  ageColumn,
];

export const ruleColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("groups", (o) => ruleGroupsOf(o).length, { width: "80px" }),
  col("rules", ruleCount, { width: "80px" }),
  ageColumn,
];

export const serverColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", (o) => serverReadiness(o).state, {
    width: "110px",
    render: (o) => <ServerStateText obj={o} />,
  }),
  col(
    "replicas",
    (o) => {
      const r = serverReadiness(o);
      return `${r.available ?? 0}/${r.desired}`;
    },
    { width: "90px" },
  ),
  col("version", (o) => str(get(o, "spec", "version")) ?? str(get(o, "status", "version")), { width: "90px" }),
  col("reason", (o) => serverReadiness(o).reason, {
    width: "minmax(120px, 1fr)",
  }),
  ageColumn,
];
