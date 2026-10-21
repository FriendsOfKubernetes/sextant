// Columns of the Contour tables: an HTTPProxy's state in Contour's words (valid / invalid / orphaned / waiting for
// Contour, colored as ready / failed / progressing) with the first error's reason, its host, TLS Secret, includes and
// routes; a TLSCertificateDelegation's Secrets and target namespaces; an ExtensionService's state and services.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import {
  delegationsOf,
  EXTENSION_SERVICE,
  extensionFields,
  firstError,
  fqdnOf,
  HEALTH_TONE,
  healthOf,
  HTTP_PROXY,
  includesOf,
  proxyState,
  routesOf,
  tlsOf,
  validCondition,
} from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `contour:columns.${id}`,
  value,
  ...options,
});

function ProxyStatus({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  return <StatusText value={t(`contour:state.${proxyState(obj)}`)} tone={HEALTH_TONE[healthOf(HTTP_PROXY, obj)]} />;
}

function ExtensionStatus({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const health = healthOf(EXTENSION_SERVICE, obj);
  return <StatusText value={t(`contour:health.${health}`)} tone={HEALTH_TONE[health]} />;
}

const fqdnColumn = col("fqdn", (o) => fqdnOf(o), { width: "minmax(140px, 2fr)" });
const tlsColumn = col("tls", (o) => {
  const tls = tlsOf(o);
  if (!tls) return undefined;
  if (tls.passthrough) return "passthrough";
  return tls.secret ? (tls.secret.delegated ? `${tls.secret.namespace}/${tls.secret.name}` : tls.secret.name) : undefined;
}, { width: "minmax(120px, 1fr)" });

export const proxyColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", proxyState, { width: "110px", render: (o) => <ProxyStatus obj={o} /> }),
  fqdnColumn,
  tlsColumn,
  col("includes", (o) => includesOf(o).length || undefined, { width: "90px" }),
  col("routes", (o) => routesOf(o).length || undefined, { width: "80px" }),
  col("reason", (o) => (proxyState(o) === "orphaned" ? "Orphaned" : firstError(o)?.reason), { width: "minmax(100px, 1fr)" }),
  ageColumn,
];

export const delegationColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("secrets", (o) => delegationsOf(o).map((d) => d.secretName).join(", "), { width: "minmax(140px, 2fr)" }),
  col("targets", (o) => [...new Set(delegationsOf(o).flatMap((d) => d.targetNamespaces))].join(", "), { width: "minmax(140px, 2fr)" }),
  ageColumn,
];

export const extensionColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", (o) => healthOf(EXTENSION_SERVICE, o), { width: "110px", render: (o) => <ExtensionStatus obj={o} /> }),
  col("services", (o) => extensionFields(o).services.map((s) => `${s.name}:${s.port ?? ""}`).join(", "), { width: "minmax(140px, 2fr)" }),
  col("protocol", (o) => extensionFields(o).protocol, { width: "90px" }),
  col("reason", (o) => validCondition(o)?.errors[0]?.reason, { width: "minmax(100px, 1fr)" }),
  ageColumn,
];
