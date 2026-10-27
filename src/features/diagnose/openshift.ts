// The path through an OpenShift Route (#267, ADR-0120), registered with the diagnosis as a route kind
// (`routeKinds.ts`): whether a router admitted it (`status.ingress[].conditions[Admitted]`; a rejection in the router's
// words, none at all when no router's shard selects it), where it answers, its TLS beside the path (the certificate
// fields are inline in the Route and only whether they are set is read — the private key never — so a certificate's
// expiry is not judged here), then each backend (`spec.to` and `spec.alternateBackends`): a weight above 0, a Service
// of the Route's own namespace (the router looks nowhere else), the Service port the Route's `targetPort` selects, and on
// into the Service's own checks. The router matches `targetPort` against the endpoints' port name (which is the
// Service port's name) or number (the pod port; `endpointsForAlias` in pkg/router/template/template_helper.go of
// github.com/openshift/router); without it, it sends to every port of the Service.
//
// What the engine reads beside what every diagnosis reads (the Services, EndpointSlices and pods of the namespace): no
// list of its own and no Secret.
import type { KindRef, KubeObject } from "../../api";
import { serviceInfo, type ServicePort } from "../netpol/model";
import { isKind, ROUTE, routeAdmissions, routeBackends, routeHost, routeState, routeTargetPort, routeTls, routeUrl, type RouteBackend } from "../openshift/model";
import { phrase as diagnosePhrase, Walk, type Chain, type ClusterView, type Finding, type Param, type Phrase } from "./model";
import { linkOf, minutesSince, nameOf, namespaceOf, portLabel, SERVICE } from "./objects";
import type { RouteDiagnoser } from "./routeKinds";
import { diagnoseService } from "./service";

/** Backends a diagnosis follows at most (`spec.to` and at most 3 alternate backends: route/v1/types.go). */
export const MAX_BACKENDS = 4;

const say = (key: string, params?: Record<string, Param>): Phrase => ({ key: `openshift:diagnose.${key}`, params });

/** What the routers say of the Route, as the first link of its chain. */
export function admissionFinding(route: KubeObject, now: number): Finding {
  const id = "openshift.admitted";
  const all = routeAdmissions(route);
  const admitted = all.filter((a) => a.admitted === "True").map((a) => a.routerName || "?");
  const notes = all
    .filter((a) => a.admitted === "False")
    .map((a) => say("routerSaid", { router: a.routerName || "?", reason: a.reason ?? "", message: a.message ?? "" }));
  switch (routeState(route)) {
    case "admitted":
      return { id, status: notes.length > 0 ? "warn" : "ok", text: say("admitted", { routers: admitted }), notes };
    case "rejected":
      return { id, status: "broken", text: say("rejected", { reason: all.find((a) => a.admitted === "False")?.reason ?? "" }), notes };
    case "pending": {
      const minutes = minutesSince(route, now);
      const late = minutes !== undefined && minutes >= 2;
      return { id, status: late ? "broken" : "warn", text: say(late ? "notAdmitted" : "pending"), notes: late ? [say("notAdmittedWhy")] : undefined };
    }
  }
}

function hostFinding(route: KubeObject): Finding {
  const url = routeUrl(route);
  if (!routeHost(route) || !url) return { id: "openshift.host", status: "warn", text: say("noHost") };
  const canonical = routeAdmissions(route).find((a) => a.admitted === "True" && a.canonicalHostname)?.canonicalHostname;
  return { id: "openshift.host", status: "ok", text: say("url", { url }), notes: canonical ? [say("canonical", { name: canonical })] : undefined };
}

/** TLS beside the path: where it ends, and what the certificate fields leave to the router. */
function tlsFinding(route: KubeObject): Finding {
  const id = "openshift.tls";
  const tls = routeTls(route);
  if (!tls) return { id, status: "ok", text: say("tlsNone") };
  const notes: Phrase[] = [];
  if (tls.insecure === "Redirect") notes.push(say("insecureRedirect"));
  else if (tls.insecure === "Allow") notes.push(say("insecureAllow"));
  switch (tls.termination) {
    case "passthrough":
      return { id, status: "ok", text: say("tlsPassthrough"), notes };
    case "edge":
    case "reencrypt": {
      if (tls.externalCertificate) notes.push(say("tlsExternal", { name: tls.externalCertificate }));
      else if (!tls.certificate) notes.push(say("tlsRouterCertificate"));
      else if (!tls.key) return { id, status: "broken", text: say("tlsNoKey"), notes };
      if (tls.termination === "reencrypt" && !tls.destinationCACertificate) notes.push(say("tlsServiceCa"));
      return { id, status: "ok", text: say(tls.termination === "edge" ? "tlsEdge" : "tlsReencrypt"), notes };
    }
    default:
      return { id, status: "broken", text: say("tlsUnknown", { termination: tls.termination ?? "" }) };
  }
}

/**
 * The Service ports a `targetPort` selects: by name the port of that name; by number the ports whose target is that
 * number. `undefined`: a number that only a named target port could resolve to (the pods decide).
 */
export function selectedPorts(ports: readonly ServicePort[], target: number | string | undefined): ServicePort[] | undefined {
  if (target === undefined) return [...ports];
  if (typeof target === "string") return ports.filter((p) => p.name === target);
  const exact = ports.filter((p) => p.targetPort === target || p.targetPort === String(target));
  if (exact.length > 0) return exact;
  return ports.some((p) => typeof p.targetPort === "string" && !/^\d+$/.test(p.targetPort)) ? undefined : [];
}

function backendChain(route: KubeObject, backend: RouteBackend, allZero: boolean, view: ClusterView): Chain {
  const namespace = namespaceOf(route);
  const { name } = backend;
  const walk = new Walk(say("backendTitle", { name, weight: backend.weight }));
  if (backend.kind !== "Service") {
    walk.add({ id: "openshift.backend", status: "broken", text: say("notService", { kind: backend.kind, name }) });
    return walk.chain;
  }
  if (allZero) walk.add({ id: "openshift.weight", status: "broken", text: say("allWeightsZero") });
  else if (backend.weight === 0) walk.add({ id: "openshift.weight", status: "warn", text: say("weightZero", { name }) });
  const services = view.services(namespace);
  if (!services) {
    walk.add({ id: "openshift.service", status: "unknown", text: diagnosePhrase("route.servicesUnknown", { namespace }) });
    return walk.chain;
  }
  const svc = services.find((s) => nameOf(s) === name);
  if (!svc) {
    walk.add({ id: "openshift.service", status: "broken", text: say("serviceMissing", { name, namespace }) });
    return walk.chain;
  }
  const info = serviceInfo(svc);
  const target = routeTargetPort(route);
  const ports = selectedPorts(info.ports, target);
  const links = [linkOf(SERVICE, svc)];
  if (ports === undefined) {
    walk.add({ id: "openshift.port", status: "unknown", text: say("namedTargetUnknown", { port: String(target), name }), links });
    return walk.chain;
  }
  const available = info.ports.map(portLabel);
  if (ports.length === 0 && info.type !== "ExternalName") {
    const key = typeof target === "string" ? "noNamedPort" : "noTargetPort";
    walk.add({ id: "openshift.port", status: "broken", text: say(key, { port: String(target), name, ports: available }), links });
    return walk.chain;
  }
  const focus = ports.length === 1 ? ports[0]!.port : undefined;
  const notes = target === undefined && ports.length > 1 ? [say("everyPort", { ports: available })] : undefined;
  walk.add({
    id: "openshift.service",
    status: "ok",
    text: focus === undefined ? say("serviceAllPorts", { name }) : say("service", { name, port: portLabel(ports[0]!) }),
    links,
    notes,
  });
  for (const f of diagnoseService(svc, view, { focus: focus ?? ports[0]?.port, source: { type: "outside" } }).findings) if (!walk.add(f)) break;
  return walk.chain;
}

export function diagnoseOpenShiftRoute(route: KubeObject, kind: KindRef, view: ClusterView): Chain {
  const walk = new Walk(undefined, linkOf(kind, route));
  if (!walk.add(admissionFinding(route, view.now))) return walk.chain;
  walk.add(hostFinding(route));
  // Beside the path: the router serves the Route whatever its TLS says; a broken TLS fails the clients' handshakes.
  walk.aside(tlsFinding(route));
  const backends = routeBackends(route);
  if (backends.length === 0) {
    walk.add({ id: "openshift.backends", status: "broken", text: say("noBackend") });
    return walk.chain;
  }
  const allZero = backends.every((b) => b.weight === 0);
  for (const backend of backends.slice(0, MAX_BACKENDS)) walk.branch(backendChain(route, backend, allZero, view));
  if (backends.length > MAX_BACKENDS) walk.add({ id: "openshift.more", status: "ok", text: say("moreBackends", { count: backends.length - MAX_BACKENDS }) });
  return walk.chain;
}

export const openshiftDiagnoser: RouteDiagnoser = {
  appliesTo: (kind) => isKind(kind, ROUTE),
  // A Route's backends are Services of its own namespace.
  namespaces: () => [],
  lists: () => [],
  secrets: () => [],
  diagnose: diagnoseOpenShiftRoute,
};
