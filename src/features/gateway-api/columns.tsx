// Columns of the Gateway API tables. Gateway: class, addresses, listeners programmed ("2/3"), attached routes, status
// ("Programmed" or the problem). Routes:
// hostnames (the first + "+N"), parents with their status ("public-gw ✓", "internal ✗ NoMatchingListenerHostname"),
// rule count. GatewayClass, ReferenceGrant and BackendTLSPolicy: what tells them apart.
import type { KindRef, KubeObject } from "../../api";
import { ageColumn, column, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import { sortStatusesBy, type Tone } from "../../resources/status";
import { i18n } from "../../i18n";
import {
  attachedRouteCount,
  controllerName,
  explainReason,
  gatewayAddresses,
  gatewayHealth,
  gatewayClassHealth,
  gatewayClassName,
  grantFrom,
  grantTo,
  isKind,
  listenersProgrammed,
  parentStatuses,
  policyAncestors,
  policyTargets,
  routeHostnames,
  ruleCount,
  TCP_ROUTE,
  UDP_ROUTE,
  type Health,
  type ParentStatus,
} from "./model";
import { status } from "../../resources";

const { get, str } = status;

/** A column with an i18n header `gateway:columns.<id>`. */
function gwColumn(id: string, value: ColumnDef["value"], options: Partial<Omit<ColumnDef, "id" | "value">> = {}) {
  return { ...column(id, value, options), titleKey: `gateway:columns.${id}` };
}

export const HEALTH_TONE: Record<Health, Tone> = { ok: "success", pending: "warning", problem: "danger" };

/** "✓" / "✗" / "?" of a condition status. */
export function statusMark(value: string | undefined): string {
  if (value === "True") return i18n.t("gateway:status.true");
  if (value === "False") return i18n.t("gateway:status.false");
  return i18n.t("gateway:status.unknown");
}

/** "public-gw ✓", "internal ✗ NoMatchingListenerHostname", "edge ? Pending". */
export function parentText(parent: ParentStatus): string {
  const mark = parent.health === "ok" ? statusMark("True") : parent.health === "problem" ? statusMark("False") : statusMark(undefined);
  const reason = parent.health === "ok" ? undefined : (parent.problem?.reason ?? i18n.t("gateway:health.pending"));
  return [parent.ref.name, mark, reason].filter(Boolean).join(" ");
}

/** Each parent's full status, the plain-language explanation of its reason and the controller's message. */
export function parentsTooltip(parents: readonly ParentStatus[]): string {
  return parents
    .map((p) => {
      const explained = p.health === "ok" ? undefined : explainReason(p.problem?.reason);
      return [parentText(p), explained ? i18n.t(explained) : undefined, p.health === "ok" ? undefined : p.problem?.message]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/**
 * A route's parents in one fixed order for the table (problems first, then pending, then accepted; by text within
 * each), not the order of `spec.parentRefs` or of the controllers' `status.parents`.
 */
export function sortedParents(route: KubeObject): ParentStatus[] {
  return sortStatusesBy(parentStatuses(route), (p) => HEALTH_TONE[p.health], parentText);
}

function ParentsCell({ route }: { route: KubeObject }) {
  const parents = sortedParents(route);
  // The cell is cut to the column: the tooltip has every parent in full.
  return (
    <span className="rt-status-list" title={parentsTooltip(parents)}>
      {parents.map((p, i) => (
        <StatusText key={`${i}:${p.ref.name}`} value={parentText(p)} tone={HEALTH_TONE[p.health]} />
      ))}
    </span>
  );
}

/** "api.example.com +1". */
export function hostnamesText(route: KubeObject): string {
  const [first, ...rest] = routeHostnames(route);
  if (!first) return "";
  return rest.length > 0 ? `${first} +${rest.length}` : first;
}

const parentsColumn = gwColumn("parents", (o) => sortedParents(o).map(parentText).join(", "), {
  width: "minmax(200px, 3fr)",
  render: (o) => <ParentsCell route={o} />,
});

const hostnamesColumn = gwColumn("hostnames", hostnamesText, {
  width: "minmax(160px, 2fr)",
  render: (o) => <span title={routeHostnames(o).join(", ")}>{hostnamesText(o)}</span>,
});

const rulesColumn = gwColumn("rules", ruleCount, { width: "70px" });

/** Columns of a route kind; TCP and UDP routes have no hostnames. */
export function routeColumns(kind: KindRef): ColumnDef[] {
  const hostnames = isKind(kind, TCP_ROUTE, UDP_ROUTE) ? [] : [hostnamesColumn];
  return [nameColumn, namespaceColumn, ...hostnames, parentsColumn, rulesColumn, ageColumn];
}

/** "Programmed", or what is wrong: "Listener https: InvalidCertificateRef", "Programmed: AddressNotAssigned". */
export function gatewayStatusText(gateway: KubeObject): string {
  const { health, problem, listener } = gatewayHealth(gateway);
  if (health === "ok") return i18n.t("gateway:gatewayStatus.programmed");
  const reason = problem?.reason ?? (health === "pending" ? i18n.t("gateway:health.pending") : problem?.type ?? "");
  if (listener) return i18n.t("gateway:gatewayStatus.listener", { name: listener, reason });
  return problem ? `${problem.type}: ${reason}` : reason;
}

function GatewayStatusCell({ gateway }: { gateway: KubeObject }) {
  const { health, problem } = gatewayHealth(gateway);
  const explained = health === "ok" ? undefined : explainReason(problem?.reason);
  const title = [gatewayStatusText(gateway), explained ? i18n.t(explained) : undefined, problem?.message]
    .filter(Boolean)
    .join("\n");
  return (
    <span title={title}>
      <StatusText value={gatewayStatusText(gateway)} tone={HEALTH_TONE[health]} />
    </span>
  );
}

/** "2/3", red when a listener is not programmed. */
export function listenersText(gateway: KubeObject): string {
  const { programmed, total } = listenersProgrammed(gateway);
  return `${programmed}/${total}`;
}

export const gatewayColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  gwColumn("class", gatewayClassName, { width: "minmax(90px, 1fr)" }),
  gwColumn("addresses", (o) => gatewayAddresses(o).join(", "), { width: "minmax(120px, 1.5fr)" }),
  gwColumn("listeners", (o) => listenersProgrammed(o).programmed, {
    width: "90px",
    render: (o) => {
      const { programmed, total } = listenersProgrammed(o);
      return <StatusText value={listenersText(o)} tone={programmed === total ? "success" : "danger"} />;
    },
  }),
  gwColumn("attachedRoutes", attachedRouteCount, { width: "120px" }),
  gwColumn("status", gatewayStatusText, {
    width: "minmax(140px, 2fr)",
    render: (o) => <GatewayStatusCell gateway={o} />,
  }),
  ageColumn,
];

function acceptedText(gatewayClass: KubeObject): string {
  const { health, problem } = gatewayClassHealth(gatewayClass);
  if (health === "ok") return statusMark("True");
  return [statusMark(problem?.status), problem?.reason].filter(Boolean).join(" ");
}

export const gatewayClassColumns: ColumnDef[] = [
  nameColumn,
  gwColumn("controller", controllerName, { width: "minmax(200px, 3fr)" }),
  gwColumn("accepted", acceptedText, {
    width: "minmax(100px, 1fr)",
    render: (o) => <StatusText value={acceptedText(o)} tone={HEALTH_TONE[gatewayClassHealth(o).health]} />,
  }),
  gwColumn("description", (o) => str(get(o, "spec", "description")), { width: "minmax(140px, 2fr)" }),
  ageColumn,
];

export const referenceGrantColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  gwColumn("from", (o) => grantFrom(o).map((f) => `${f.kind} (${f.namespace})`).join(", "), {
    width: "minmax(180px, 2fr)",
  }),
  gwColumn("to", (o) => grantTo(o).map((t) => (t.name ? `${t.kind} ${t.name}` : t.kind)).join(", "), {
    width: "minmax(140px, 2fr)",
  }),
  ageColumn,
];

/**
 * "public-gw ✓", "edge ✗ Conflicted" per ancestor of a policy, in one fixed order (problems first, then pending, then
 * accepted; by text within each) whatever order the controllers reported them in.
 */
export function policyStatusText(policy: KubeObject): string {
  const entries = policyAncestors(policy).map((a) => {
    const mark = a.health === "ok" ? statusMark("True") : statusMark(a.health === "problem" ? "False" : undefined);
    const text = [a.ref.name, mark, a.health === "ok" ? undefined : a.problem?.reason].filter(Boolean).join(" ");
    return { text, tone: HEALTH_TONE[a.health] };
  });
  return sortStatusesBy(entries, (e) => e.tone, (e) => e.text)
    .map((e) => e.text)
    .join(", ");
}

export const backendTlsPolicyColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  gwColumn("targets", (o) => policyTargets(o).map((t) => `${t.kind} ${t.name}`).join(", "), {
    width: "minmax(140px, 2fr)",
  }),
  gwColumn("hostname", (o) => str(get(o, "spec", "validation", "hostname")), { width: "minmax(140px, 2fr)" }),
  gwColumn("status", policyStatusText, { width: "minmax(140px, 2fr)" }),
  ageColumn,
];
