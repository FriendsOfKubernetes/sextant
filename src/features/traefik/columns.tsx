// Columns of the Traefik tables. Traefik writes no status, so the state column says what the references find (store.ts):
// "References found", "Broken reference" or "Not all checked" (another namespace, another provider, a list not read).
// Routes show their entry points, hosts and services; the other kinds their type and main settings.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type CellContext, type ColumnDef } from "../../resources";
import { hostsOf, middlewareType, routeSpec, secretsOf, traefikServiceRefs, traefikServiceType, SERVERS_TRANSPORT, SERVERS_TRANSPORT_TCP, TLS_STORE, type Ref } from "./model";
import { HEALTH_TONE } from "./resolve";
import { useTraefik } from "./store";

const { get, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `traefik:columns.${id}`,
  value,
  ...options,
});

function Health({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const state = useTraefik(clusterId);
  const uid = obj.metadata?.uid;
  const found = uid ? state.byUid.get(uid) : undefined;
  const health = found?.judgement.health ?? "loading";
  return <StatusText value={t(`traefik:health.${health}`)} tone={HEALTH_TONE[health]} />;
}

const stateColumn = col("state", () => undefined, {
  width: "140px",
  sortable: false,
  render: (o: KubeObject, ctx: CellContext) => <Health clusterId={ctx.clusterId} obj={o} />,
});

const text = (value: string | undefined) => (value ? <span title={value}>{value}</span> : null);
const listColumn = (id: string, values: (o: KubeObject, ctx: CellContext) => string[], width = "minmax(140px, 2fr)") =>
  col(id, (o) => values(o, { clusterId: "", kind: { group: "", version: "", kind: "" }, now: 0 }).join(", "), {
    width,
    render: (o, ctx) => text(values(o, ctx).join(", ")),
  });

const refName = (r: Ref) => (r.provider ? `${r.name}@${r.provider}` : r.name);

const entryPointsColumn = listColumn("entryPoints", (o, ctx) => routeSpec(ctx.kind, o).entryPoints, "minmax(100px, 1fr)");
const hostsColumn = listColumn("hosts", (o, ctx) => [...new Set(routeSpec(ctx.kind, o).routes.flatMap((r) => hostsOf(r.match)))]);
const servicesColumn = listColumn("services", (o, ctx) => [...new Set(routeSpec(ctx.kind, o).routes.flatMap((r) => r.services.map(refName)))]);
const tlsColumn = col("tls", (o) => (get(o, "spec", "tls") ? "TLS" : ""), {
  width: "70px",
  render: (o) => {
    const tls = get(o, "spec", "tls");
    if (!tls) return null;
    return <TlsText passthrough={get(tls, "passthrough") === true} />;
  },
});

function TlsText({ passthrough }: { passthrough: boolean }) {
  const { t } = useTranslation();
  return <span>{t(passthrough ? "traefik:values.passthrough" : "traefik:values.tls")}</span>;
}

export const routeColumns: ColumnDef[] = [nameColumn, namespaceColumn, stateColumn, entryPointsColumn, hostsColumn, servicesColumn, tlsColumn, ageColumn];
export const udpRouteColumns: ColumnDef[] = [nameColumn, namespaceColumn, stateColumn, entryPointsColumn, servicesColumn, ageColumn];

const typeColumn = col("type", (o) => middlewareType(o), { width: "minmax(120px, 1fr)" });
export const middlewareColumns: ColumnDef[] = [nameColumn, namespaceColumn, stateColumn, typeColumn, ageColumn];
export const middlewareTcpColumns: ColumnDef[] = [nameColumn, namespaceColumn, typeColumn, ageColumn];

const strategyColumn = col("strategy", (o) => traefikServiceType(o), { width: "minmax(120px, 1fr)" });
const childrenColumn = listColumn("services", (o) => [...new Set(traefikServiceRefs(o).filter((r) => r.kind === "Service" || r.kind === "TraefikService").map(refName))]);
export const traefikServiceColumns: ColumnDef[] = [nameColumn, namespaceColumn, stateColumn, strategyColumn, childrenColumn, ageColumn];

const secretsColumn = (kind: typeof TLS_STORE) => listColumn("secrets", (o) => secretsOf(kind, o).map((r) => r.name));
const minVersionColumn = col("minVersion", (o) => str(get(o, "spec", "minVersion")), { width: "110px" });
const clientAuthColumn = col("clientAuth", (o) => str(get(o, "spec", "clientAuth", "clientAuthType")), { width: "minmax(120px, 1fr)" });
export const tlsOptionColumns: ColumnDef[] = [nameColumn, namespaceColumn, stateColumn, minVersionColumn, clientAuthColumn, ageColumn];
const defaultCertColumn = col("defaultCertificate", (o) => str(get(o, "spec", "defaultCertificate", "secretName")), { width: "minmax(140px, 1fr)" });
export const tlsStoreColumns: ColumnDef[] = [nameColumn, namespaceColumn, stateColumn, defaultCertColumn, secretsColumn(TLS_STORE), ageColumn];

const serverNameColumn = col("serverName", (o) => str(get(o, "spec", "serverName")) ?? str(get(o, "spec", "tls", "serverName")), { width: "minmax(120px, 1fr)" });
const insecureColumn = col("insecureSkipVerify", (o) => (get(o, "spec", "insecureSkipVerify") ?? get(o, "spec", "tls", "insecureSkipVerify")) === true, {
  width: "110px",
  render: (o) => ((get(o, "spec", "insecureSkipVerify") ?? get(o, "spec", "tls", "insecureSkipVerify")) === true ? <InsecureText /> : null),
});

function InsecureText() {
  const { t } = useTranslation();
  return <StatusText value={t("traefik:values.insecure")} tone="warning" />;
}

export const serversTransportColumns: ColumnDef[] = [nameColumn, namespaceColumn, stateColumn, serverNameColumn, insecureColumn, secretsColumn(SERVERS_TRANSPORT), ageColumn];
export const serversTransportTcpColumns: ColumnDef[] = [nameColumn, namespaceColumn, stateColumn, serverNameColumn, insecureColumn, secretsColumn(SERVERS_TRANSPORT_TCP), ageColumn];
