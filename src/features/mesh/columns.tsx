// Columns of the Istio and Linkerd tables (#155): what tells the objects of each kind apart at a glance — hosts,
// gateways and route counts of VirtualServices, a DestinationRule's host, subsets and TLS mode, a policy's scope and
// mode or action, a Linkerd Server's port and protocol.
import type { KindRef, KubeObject } from "../../api";
import { i18n } from "../../i18n";
import { ageColumn, column, nameColumn, namespaceColumn, status, type ColumnDef } from "../../resources";
import { parseAuthorizationPolicy } from "./authz";
import { parseDestinationRule, parseIstioGateway, parseServiceEntry, parseVirtualService, ROOT_NAMESPACE } from "./istio";
import { DESTINATION_RULE, sameKind, VIRTUAL_SERVICE } from "./kinds";
import { isMeshProblem } from "./store";

const { arr, get, record, str } = status;

function meshColumn(id: string, value: ColumnDef["value"], options: Partial<Omit<ColumnDef, "id" | "value">> = {}): ColumnDef {
  return { ...column(id, value, options), titleKey: `mesh:columns.${id}` };
}

/** "a.example.com +2". */
export function firstPlus(values: readonly string[]): string {
  const [first, ...rest] = values;
  if (!first) return "";
  return rest.length > 0 ? `${first} +${rest.length}` : first;
}

const join = (values: readonly (string | undefined)[]) => values.filter(Boolean).join(", ");

/** Where a policy applies: its selector, the namespace or the whole mesh. */
export function scopeText(obj: KubeObject, selectorPath: string[] = ["spec", "selector", "matchLabels"]): string {
  const selector = record(get(obj, ...selectorPath));
  if (Object.keys(selector).length > 0) return join(Object.entries(selector).map(([k, v]) => `${k}=${String(v)}`));
  return obj.metadata?.namespace === ROOT_NAMESPACE ? i18n.t("mesh:scope.mesh") : i18n.t("mesh:scope.namespace");
}

function hostsColumn(read: (o: KubeObject) => string[]): ColumnDef {
  return meshColumn("hosts", (o) => firstPlus(read(o)), {
    width: "minmax(160px, 2fr)",
    render: (o) => <span title={read(o).join("\n")}>{firstPlus(read(o))}</span>,
  });
}

const base = (...cols: ColumnDef[]): ColumnDef[] => [nameColumn, namespaceColumn, ...cols, ageColumn];

const virtualServiceColumns = base(
  hostsColumn((o) => parseVirtualService(o).hosts),
  meshColumn("gateways", (o) => join(parseVirtualService(o).gateways), { width: "minmax(120px, 2fr)" }),
  meshColumn("routes", (o) => {
    const vs = parseVirtualService(o);
    return vs.http.length + vs.l4.length;
  }, { width: "80px" }),
);

const destinationRuleColumns = base(
  meshColumn("host", (o) => str(get(o, "spec", "host")), { width: "minmax(160px, 2fr)" }),
  meshColumn("subsets", (o) => join(parseDestinationRule(o).subsets.map((s) => s.name)), { width: "minmax(100px, 1fr)" }),
  meshColumn("tlsMode", (o) => parseDestinationRule(o).tlsMode, { width: "minmax(100px, 1fr)" }),
);

const gatewayColumns = base(
  meshColumn("servers", (o) => join(parseIstioGateway(o).servers.map((s) => `${s.port ?? ""}/${s.protocol ?? ""}`)), { width: "minmax(120px, 1fr)" }),
  hostsColumn((o) => [...new Set(parseIstioGateway(o).servers.flatMap((s) => s.hosts))]),
);

const serviceEntryColumns = base(
  hostsColumn((o) => parseServiceEntry(o).hosts),
  meshColumn("location", (o) => parseServiceEntry(o).location, { width: "120px" }),
  meshColumn("resolution", (o) => parseServiceEntry(o).resolution, { width: "110px" }),
);

const sidecarColumns = base(
  meshColumn("appliesTo", (o) => scopeText(o, ["spec", "workloadSelector", "labels"]), { width: "minmax(140px, 2fr)" }),
  meshColumn("egressHosts", (o) => arr(get(o, "spec", "egress")).flatMap((e) => arr(get(e, "hosts"))).length, { width: "110px" }),
);

const workloadEntryColumns = base(
  meshColumn("address", (o) => str(get(o, "spec", "address")), { width: "minmax(120px, 1fr)" }),
  meshColumn("serviceAccount", (o) => str(get(o, "spec", "serviceAccount")), { width: "minmax(120px, 1fr)" }),
);

const peerAuthenticationColumns = base(
  meshColumn("appliesTo", (o) => scopeText(o), { width: "minmax(140px, 2fr)" }),
  meshColumn("mtlsMode", (o) => str(get(o, "spec", "mtls", "mode")) ?? "UNSET", { width: "120px" }),
);

const requestAuthenticationColumns = base(
  meshColumn("appliesTo", (o) => scopeText(o), { width: "minmax(140px, 2fr)" }),
  meshColumn("issuers", (o) => join(arr(get(o, "spec", "jwtRules")).map((r) => str(get(r, "issuer")))), { width: "minmax(160px, 2fr)" }),
);

const authorizationPolicyColumns = base(
  meshColumn("action", (o) => parseAuthorizationPolicy(o).action, { width: "90px" }),
  meshColumn("appliesTo", (o) => (parseAuthorizationPolicy(o).targetRef ? i18n.t("mesh:scope.targetRef") : scopeText(o)), {
    width: "minmax(140px, 2fr)",
  }),
  meshColumn("rules", (o) => parseAuthorizationPolicy(o).rules.length, { width: "70px" }),
);

const telemetryColumns = base(meshColumn("appliesTo", (o) => scopeText(o), { width: "minmax(140px, 2fr)" }));

const serviceProfileColumns = base(meshColumn("routes", (o) => arr(get(o, "spec", "routes")).length, { width: "80px" }));

const serverColumns = base(
  meshColumn("port", (o) => String(get(o, "spec", "port") ?? ""), { width: "90px" }),
  meshColumn("proxyProtocol", (o) => str(get(o, "spec", "proxyProtocol")), { width: "120px" }),
  meshColumn("podSelector", (o) => scopeText(o, ["spec", "podSelector", "matchLabels"]), { width: "minmax(140px, 2fr)" }),
);

const linkerdRouteColumns = base(
  meshColumn("parents", (o) => join(arr(get(o, "spec", "parentRefs")).map((p) => `${str(get(p, "kind")) ?? ""} ${str(get(p, "name")) ?? ""}`)), {
    width: "minmax(140px, 2fr)",
  }),
  hostsColumn((o) => arr(get(o, "spec", "hostnames")).map(String)),
);

const linkerdPolicyColumns = base(
  meshColumn("target", (o) => `${str(get(o, "spec", "targetRef", "kind")) ?? ""} ${str(get(o, "spec", "targetRef", "name")) ?? ""}`, {
    width: "minmax(140px, 2fr)",
  }),
  meshColumn("authentications", (o) => join(arr(get(o, "spec", "requiredAuthenticationRefs")).map((r) => str(get(r, "name")))), {
    width: "minmax(140px, 2fr)",
  }),
);

const serverAuthorizationColumns = base(
  meshColumn("server", (o) => str(get(o, "spec", "server", "name")) ?? scopeText(o, ["spec", "server", "selector", "matchLabels"]), {
    width: "minmax(140px, 2fr)",
  }),
);

const meshTlsColumns = base(
  meshColumn("identities", (o) => join([...arr(get(o, "spec", "identities")).map(String), ...arr(get(o, "spec", "identityRefs")).map((r) => str(get(r, "name")))]), {
    width: "minmax(160px, 3fr)",
  }),
);

const networkColumns = base(
  meshColumn("networks", (o) => join(arr(get(o, "spec", "networks")).map((n) => str(get(n, "cidr")))), { width: "minmax(160px, 3fr)" }),
);

const BY_KIND: Record<string, ColumnDef[]> = {
  VirtualService: virtualServiceColumns,
  DestinationRule: destinationRuleColumns,
  Gateway: gatewayColumns,
  ServiceEntry: serviceEntryColumns,
  Sidecar: sidecarColumns,
  WorkloadEntry: workloadEntryColumns,
  PeerAuthentication: peerAuthenticationColumns,
  RequestAuthentication: requestAuthenticationColumns,
  "security.istio.io/AuthorizationPolicy": authorizationPolicyColumns,
  Telemetry: telemetryColumns,
  ServiceProfile: serviceProfileColumns,
  Server: serverColumns,
  HTTPRoute: linkerdRouteColumns,
  "policy.linkerd.io/AuthorizationPolicy": linkerdPolicyColumns,
  ServerAuthorization: serverAuthorizationColumns,
  MeshTLSAuthentication: meshTlsColumns,
  NetworkAuthentication: networkColumns,
};

export function meshColumns(kind: KindRef): ColumnDef[] {
  return BY_KIND[`${kind.group}/${kind.kind}`] ?? BY_KIND[kind.kind] ?? base();
}

/** VirtualServices and DestinationRules with a mesh problem (the "Only problems" filter). */
export function meshProblemOf(kind: KindRef): ((obj: KubeObject) => boolean) | undefined {
  return sameKind(kind, VIRTUAL_SERVICE) || sameKind(kind, DESTINATION_RULE) ? isMeshProblem : undefined;
}
