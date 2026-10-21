// Registers the Traefik kinds (both groups) in the discovered sidebar section `traefik` (shown only for kinds the
// cluster serves), their columns with the "Only problems" filter (an object with a broken reference), their details
// section, and the "Diagnose" action on IngressRoutes (#208's traffic diagnosis, `diagnose/traefik.ts`). Read-only:
// the kinds offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import "../diagnose/traefik";
import {
  middlewareColumns,
  middlewareTcpColumns,
  routeColumns,
  serversTransportColumns,
  serversTransportTcpColumns,
  tlsOptionColumns,
  tlsStoreColumns,
  traefikServiceColumns,
  udpRouteColumns,
} from "./columns";
import { TraefikSection } from "./details";
import { TRAEFIK_KINDS, traefikKind, type TraefikKind } from "./model";
import { breaks } from "./resolve";
import { judgementOf } from "./store";

const ICONS: Record<string, IconName> = {
  IngressRoute: "traefikRoute",
  IngressRouteTCP: "traefikRoute",
  IngressRouteUDP: "traefikRoute",
  Middleware: "traefikMiddleware",
  MiddlewareTCP: "traefikMiddleware",
  TraefikService: "traefikService",
  TLSOption: "tlsCertificates",
  TLSStore: "tlsCertificates",
  ServersTransport: "config",
  ServersTransportTCP: "config",
};

const COLUMNS: Record<string, ColumnDef[]> = {
  IngressRoute: routeColumns,
  IngressRouteTCP: routeColumns,
  IngressRouteUDP: udpRouteColumns,
  Middleware: middlewareColumns,
  MiddlewareTCP: middlewareTcpColumns,
  TraefikService: traefikServiceColumns,
  TLSOption: tlsOptionColumns,
  TLSStore: tlsStoreColumns,
  ServersTransport: serversTransportColumns,
  ServersTransportTCP: serversTransportTcpColumns,
};

/** An object whose references break it (or a route Traefik skips), as far as the held store knows. */
function isProblem(obj: Parameters<typeof judgementOf>[0]): boolean {
  const j = judgementOf(obj);
  return j !== undefined && (j.issues.length > 0 || j.checks.some(breaks));
}

for (const def of TRAEFIK_KINDS as readonly TraefikKind[]) {
  const name = def.kind.kind;
  registerResource({
    kind: def.kind,
    sidebar: { section: "traefik", order: def.order, labelKey: `traefik:sidebar.${def.label}`, icon: ICONS[name] },
    columns: COLUMNS[name] ?? [],
    actions: name === "IngressRoute" ? ["edit", "delete", "diagnose"] : ["edit", "delete"],
    namespaced: true,
    problem: name === "MiddlewareTCP" ? undefined : isProblem,
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "traefik", order: 20, appliesTo: (kind) => traefikKind(kind) !== undefined, Component: TraefikSection });
