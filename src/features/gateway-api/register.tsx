// Registers the Gateway API kinds in the sidebar section `gatewayApi` (shown only for kinds the cluster serves), with
// their columns, and the details section every kind of the section shares.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import {
  backendTlsPolicyColumns,
  gatewayClassColumns,
  gatewayColumns,
  referenceGrantColumns,
  routeColumns,
} from "./columns";
import { GatewayApiSection } from "./details";
import { ExposedBySection, isPolicyTarget, PoliciesAttachedSection, UsedByListenersSection } from "./reverse";
import { TopologySection } from "./TopologyView";
import {
  BACKEND_TLS_POLICY,
  GATEWAY,
  GATEWAY_CLASS,
  GATEWAY_KINDS,
  gatewayKind,
  isKind,
  isProblem,
  isRouteKind,
  REFERENCE_GRANT,
} from "./model";

/** Sidebar icon by the label of the kind in `GATEWAY_KINDS`. */
const ICONS: Record<string, IconName> = {
  gatewayClasses: "gatewayClass",
  gateways: "gateway",
  httpRoutes: "httpRoute",
  grpcRoutes: "grpcRoute",
  tlsRoutes: "tlsRoute",
  tcpRoutes: "tcpRoute",
  udpRoutes: "udpRoute",
  referenceGrants: "referenceGrant",
  backendTlsPolicies: "backendTlsPolicy",
};

function columnsOf(kind: (typeof GATEWAY_KINDS)[number]["kind"]): ColumnDef[] {
  if (isKind(kind, GATEWAY_CLASS)) return gatewayClassColumns;
  if (isKind(kind, GATEWAY)) return gatewayColumns;
  if (isRouteKind(kind)) return routeColumns(kind);
  if (isKind(kind, REFERENCE_GRANT)) return referenceGrantColumns;
  if (isKind(kind, BACKEND_TLS_POLICY)) return backendTlsPolicyColumns;
  return [];
}

for (const { kind, order, label, namespaced } of GATEWAY_KINDS) {
  registerResource({
    kind,
    sidebar: { section: "gatewayApi", order, labelKey: `gateway:sidebar.${label}`, icon: ICONS[label] },
    columns: columnsOf(kind),
    actions: ["edit", "delete"],
    namespaced,
    // ReferenceGrants have no status: nothing to filter.
    problem: isKind(kind, REFERENCE_GRANT) ? undefined : (obj) => isProblem(obj, kind),
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({
  id: "gatewayApi",
  order: 20,
  appliesTo: (kind) => gatewayKind(kind) !== undefined,
  Component: GatewayApiSection,
});

// The Gateway's traffic tree, a tab of its own next to "Overview".
registerDetailsSection({
  id: "gatewayTopology",
  order: 21,
  placement: "tab",
  labelKey: "gateway:topology.title",
  appliesTo: (kind) => isKind(kind, GATEWAY),
  Component: TopologySection,
});

// Reverse links, after the kind's fields (20) and before the conditions (30).
registerDetailsSection({
  id: "gatewayExposedBy",
  order: 26,
  appliesTo: (kind) => kind.group === "" && kind.kind === "Service",
  Component: ExposedBySection,
});
registerDetailsSection({
  id: "gatewaySecretUse",
  order: 26,
  appliesTo: (kind) => kind.group === "" && kind.kind === "Secret",
  Component: UsedByListenersSection,
});
registerDetailsSection({
  id: "gatewayPolicies",
  order: 27,
  appliesTo: isPolicyTarget,
  Component: PoliciesAttachedSection,
});
