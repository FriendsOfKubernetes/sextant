// The path through an HTTPRoute or GRPCRoute, with the Gateway API section's model (#128): the route names parents,
// a Gateway accepted it on some listener (what its controller wrote in `status.parents`), then each rule's backends:
// a weight above 0, a Service that exists and may be referenced (ReferenceGrant), and on into the Service's checks.
// A route attached to several Gateways is reachable when any of them accepted it: a rejected parent then only warns.
import type { KindRef, KubeObject } from "../../api";
import { routeListeners } from "../gateway-api/exposure";
import {
  backendIssue,
  explainReason,
  gatewayAddresses,
  gatewayHealth,
  GATEWAY,
  GATEWAY_GROUP,
  parentStatuses,
  routeRules,
  type BackendRef,
  type ParentStatus,
} from "../gateway-api/model";
import { phrase, Walk, type Chain, type ClusterView, type Finding, type Phrase } from "./model";
import { linkOf, nameOf, namespaceOf, SERVICE } from "./objects";
import { diagnoseService } from "./service";

/** Backends a route diagnosis follows at most. */
export const MAX_BACKENDS = 30;

const reasonNote = (reason: string | undefined): Phrase[] => {
  const key = explainReason(reason);
  return key ? [{ key }] : [];
};

function parentFinding(route: KubeObject, kind: KindRef, parent: ParentStatus, index: number, view: ClusterView): Finding {
  const id = `route.parent.${index}`;
  const { ref } = parent;
  const gatewayName = ref.name;
  if (ref.group !== GATEWAY_GROUP || ref.kind !== "Gateway") {
    return { id, status: "unknown", text: phrase("route.parentOther", { kind: ref.kind, name: gatewayName }) };
  }
  const namespace = ref.namespace ?? namespaceOf(route);
  const gateways = view.gateways(namespace);
  const gateway = gateways?.find((g) => nameOf(g) === gatewayName);
  const links = [{ kind: GATEWAY, namespace, name: gatewayName }];
  if (gateways && !gateway) return { id, status: "broken", text: phrase("route.gatewayMissing", { name: gatewayName, namespace }) };
  if (parent.accepted?.status === "False") {
    const reason = parent.accepted.reason ?? "";
    const notes = [...reasonNote(reason), ...(parent.accepted.message ? [phrase("route.controllerSaid", { message: parent.accepted.message })] : [])];
    return { id, status: "broken", text: phrase("route.parentRejected", { name: gatewayName, reason }), notes, links };
  }
  if (parent.accepted?.status !== "True") return { id, status: "warn", text: phrase("route.parentPending", { name: gatewayName }), links };
  if (!gateway) return { id, status: "ok", text: phrase("route.parentAcceptedOnly", { name: gatewayName }), links };
  const health = gatewayHealth(gateway);
  const listeners = routeListeners(route, kind, gateway).map((l) => l.listener.name);
  const addresses = gatewayAddresses(gateway);
  const notes: Phrase[] = addresses.length > 0 ? [phrase("route.gatewayAddresses", { addresses })] : [phrase("route.gatewayNoAddress")];
  if (health.health === "problem") {
    const reason = health.problem?.reason ?? "";
    return { id, status: "broken", text: phrase("route.gatewayProblem", { name: gatewayName, reason }), notes: [...reasonNote(reason), ...notes], links };
  }
  return { id, status: "ok", text: phrase("route.parentAccepted", { name: gatewayName, listeners }), notes, links };
}

function backendChain(route: KubeObject, kind: KindRef, backend: BackendRef, rule: number, parents: readonly ParentStatus[], view: ClusterView): Chain {
  const namespace = backend.namespace ?? namespaceOf(route);
  const title = phrase("route.backendTitle", { rule: rule + 1, name: backend.name, port: backend.port ?? "" });
  const walk = new Walk(title);
  const isService = backend.group === "" && backend.kind === "Service";
  if (backend.weight === 0) walk.add({ id: "route.weight", status: "warn", text: phrase("route.weightZero") });
  const issue = backendIssue(backend, {
    routeNamespace: namespaceOf(route),
    routeKind: kind.kind,
    parents,
    servicesIn: (ns) => {
      const list = view.services(ns);
      return list ? new Set(list.map(nameOf)) : undefined;
    },
    grantsIn: (ns) => view.grants(ns),
  });
  if (issue) {
    walk.add({ id: "route.backend", status: "broken", text: phrase("route.backendIssue", { name: backend.name, reason: issue }), notes: reasonNote(issue) });
    return walk.chain;
  }
  if (!isService) {
    walk.add({ id: "route.backend", status: "unknown", text: phrase("route.backendNotService", { kind: backend.kind, name: backend.name }) });
    return walk.chain;
  }
  if (backend.port === undefined) {
    walk.add({ id: "route.backend", status: "broken", text: phrase("route.backendNoPort", { name: backend.name }) });
    return walk.chain;
  }
  const services = view.services(namespace);
  const svc = services?.find((s) => nameOf(s) === backend.name);
  if (!svc) {
    walk.add({ id: "route.backend", status: "unknown", text: phrase("route.servicesUnknown", { namespace }) });
    return walk.chain;
  }
  walk.add({ id: "route.backend", status: "ok", text: phrase("route.service", { name: backend.name, port: backend.port }), links: [linkOf(SERVICE, svc)] });
  for (const f of diagnoseService(svc, view, { focus: backend.port, source: { type: "outside" } }).findings) if (!walk.add(f)) break;
  return walk.chain;
}

export function diagnoseRoute(route: KubeObject, kind: KindRef, view: ClusterView): Chain {
  const walk = new Walk(undefined, linkOf(kind, route));
  const parents = parentStatuses(route);
  if (parents.length === 0) {
    walk.add({ id: "route.parents", status: "broken", text: phrase("route.noParents") });
    return walk.chain;
  }
  const found = parents.map((p, i) => parentFinding(route, kind, p, i, view));
  // Any accepted parent carries the traffic: the others only warn then.
  const reachable = found.some((f) => f.status === "ok");
  for (const f of found) if (!walk.add(reachable && f.status === "broken" ? { ...f, status: "warn" } : f)) return walk.chain;

  let shown = 0;
  for (const rule of routeRules(route, kind)) {
    if (rule.backends.length === 0) {
      const redirect = rule.filterTypes.includes("RequestRedirect");
      const key = redirect ? "route.ruleRedirect" : "route.ruleNoBackends";
      const only = new Walk(phrase("route.ruleTitle", { rule: rule.index + 1 }));
      only.add({ id: "route.rule", status: redirect ? "ok" : "broken", text: phrase(key) });
      walk.branch(only.chain);
      continue;
    }
    for (const backend of rule.backends) {
      if (shown++ >= MAX_BACKENDS) continue;
      walk.branch(backendChain(route, kind, backend, rule.index, parents, view));
    }
  }
  if (shown > MAX_BACKENDS) walk.add({ id: "route.backends", status: "ok", text: phrase("route.moreBackends", { count: shown - MAX_BACKENDS }) });
  return walk.chain;
}
