// The path through a Contour HTTPProxy (#233), registered with the diagnosis as a route kind (`routeKinds.ts`): what
// Contour says of the proxy (valid, invalid with its errors, orphaned, not processed yet), for a root its virtual
// host, the address Contour reports and the TLS Secret (one of another namespace only through a
// TLSCertificateDelegation there), then each route's services — a share of the requests above 0 (or a mirror), a
// Service that exists in the proxy's own namespace (Contour never looks elsewhere), and on into the Service's checks —
// and each include: the included proxy exists, is not a root, and its own routes, down to `MAX_DEPTH` levels.
//
// What the engine reads beside the Services: the HTTPProxy lists of the proxy's namespace and of its direct includes'
// namespaces (an include deeper in a namespace not listed is "unknown"), and the TLSCertificateDelegations of a
// delegated Secret's namespace. Contour's own flags (`--root-namespaces`, ExternalName Services allowed or not) are
// not visible to Sextant: the status tells the first, the second is said as a doubt.
import type { KindRef, KubeObject } from "../../api";
import {
  CONTOUR_GROUP,
  delegationFor,
  fqdnOf,
  HTTP_PROXY,
  includesOf,
  ingressClassOf,
  isRoot,
  joinPrefixes,
  proxyAddresses,
  proxyState,
  routesOf,
  servedInPart,
  shares,
  TLS_DELEGATION,
  tcpServicesOf,
  tlsOf,
  validCondition,
  type ProxyService,
} from "../contour/model";
import { phrase as diagnosePhrase, Walk, type Chain, type ClusterView, type Finding, type LinkRef, type Param, type Phrase } from "./model";
import { linkOf, nameOf, namespaceOf, SECRET, SERVICE } from "./objects";
import type { ListRef, RouteDiagnoser, SecretRef } from "./routeKinds";
import { diagnoseService } from "./service";
import { hostCovered, certificateNames } from "./tls";

/** Include levels followed below the diagnosed proxy. */
export const MAX_DEPTH = 3;
/** Service chains a diagnosis follows at most (as a route's backends). */
export const MAX_SERVICES = 30;

const say = (key: string, params?: Record<string, Param>): Phrase => ({ key: `contour:diagnose.${key}`, params });
const proxyLink = (namespace: string, name: string): LinkRef => ({ kind: HTTP_PROXY, namespace, name });

/** What Contour says of the proxy, as the first link of its chain. */
export function statusFinding(proxy: KubeObject, id = "contour.status"): Finding {
  const valid = validCondition(proxy);
  const errors = valid?.errors ?? [];
  const notes = [...errors, ...(valid?.warnings ?? [])].map((e) => say("contourSaid", { reason: e.reason ?? e.type, message: e.message ?? "" }));
  const name = nameOf(proxy);
  switch (proxyState(proxy)) {
    case "valid":
      return { id, status: (valid?.warnings.length ?? 0) > 0 ? "warn" : "ok", text: say("valid", { name }), notes };
    case "orphaned":
      return { id, status: "broken", text: say("orphaned", { name }), notes: [say("orphanedWhy")] };
    case "pending": {
      const ingressClass = ingressClassOf(proxy);
      return { id, status: "warn", text: ingressClass ? say("pendingClass", { name, class: ingressClass }) : say("pending", { name }) };
    }
    case "invalid": {
      const reason = errors[0]?.reason ?? errors[0]?.type ?? "";
      const rootNamespace = errors.some((e) => e.type === "RootNamespaceError");
      const more = rootNamespace ? [say("rootNamespaces")] : [];
      // Contour leaves out only the part that failed for these errors: the rest is checked below.
      if (servedInPart(proxy)) return { id, status: "warn", text: say("invalidInPart", { name, reason }), notes };
      return { id, status: "broken", text: say("invalid", { name, reason }), notes: [...notes, ...more] };
    }
  }
}

function hostFinding(proxy: KubeObject): Finding {
  const fqdn = fqdnOf(proxy) ?? "";
  const addresses = proxyAddresses(proxy);
  if (addresses.length === 0) return { id: "contour.host", status: "warn", text: say("hostNoAddress", { fqdn }), notes: [say("hostNoAddressWhy")] };
  return { id: "contour.host", status: "ok", text: say("host", { fqdn, addresses }) };
}

/** The TLS of a root: passthrough, or a Secret (delegated when of another namespace) with a certificate for the host. */
function tlsFindings(proxy: KubeObject, view: ClusterView): Finding[] {
  const tls = tlsOf(proxy);
  if (!tls) return [];
  const own = namespaceOf(proxy);
  const fqdn = fqdnOf(proxy) ?? "";
  if (tls.passthrough) return [{ id: "contour.tls", status: "ok", text: say("tlsPassthrough") }];
  const secret = tls.secret;
  if (!secret) return [{ id: "contour.tls", status: "broken", text: say("tlsNoSecret") }];
  const found: Finding[] = [];
  const links: LinkRef[] = [{ kind: SECRET, namespace: secret.namespace, name: secret.name }];
  if (secret.delegated) {
    const delegations = view.objects?.(TLS_DELEGATION, secret.namespace);
    const id = "contour.delegation";
    if (delegations === null) found.push({ id, status: "broken", text: say("delegationNotServed", { namespace: secret.namespace }) });
    else if (!delegations) found.push({ id, status: "unknown", text: say("delegationUnknown", { namespace: secret.namespace }) });
    else {
      const delegation = delegationFor(delegations, secret, own);
      if (!delegation) found.push({ id, status: "broken", text: say("delegationMissing", { name: secret.name, namespace: secret.namespace, target: own }) });
      else found.push({ id, status: "ok", text: say("delegation", { name: secret.name, namespace: secret.namespace }), links: [linkOf(TLS_DELEGATION, delegation)] });
    }
  }
  found.push(certificateFinding(secret, fqdn, links, view));
  return found;
}

function certificateFinding(secret: { namespace: string; name: string }, fqdn: string, links: LinkRef[], view: ClusterView): Finding {
  const id = "contour.certificate";
  const { name, namespace } = secret;
  const state = view.certificates(namespace, name);
  if (!state) return { id, status: "unknown", text: diagnosePhrase("ingress.tlsUnknown", { name }), links };
  if (state.state === "notFound") return { id, status: "broken", text: diagnosePhrase("ingress.tlsSecretMissing", { name, namespace }) };
  if (state.state === "error") {
    const key = state.code === "invalid" ? "ingress.tlsInvalid" : state.code === "forbidden" ? "ingress.tlsForbidden" : "ingress.tlsUnknown";
    return { id, status: state.code === "invalid" ? "broken" : "unknown", text: diagnosePhrase(key, { name }), links };
  }
  const leaf = state.info.chain[0];
  if (!leaf) return { id, status: "broken", text: diagnosePhrase("ingress.tlsInvalid", { name }), links };
  const notAfter = Date.parse(leaf.notAfter);
  const notBefore = Date.parse(leaf.notBefore);
  if (Number.isFinite(notAfter) && notAfter < view.now) return { id, status: "broken", text: diagnosePhrase("ingress.tlsExpired", { name }), links };
  if (Number.isFinite(notBefore) && notBefore > view.now) return { id, status: "broken", text: diagnosePhrase("ingress.tlsNotYetValid", { name }), links };
  if (fqdn && !hostCovered(leaf, fqdn)) {
    return { id, status: "broken", text: diagnosePhrase("ingress.tlsHostNotCovered", { name, hosts: [fqdn], names: certificateNames(leaf) }), links };
  }
  return { id, status: "ok", text: diagnosePhrase("ingress.tlsOk", { name, hosts: [fqdn] }), links };
}

interface Budget {
  used: number;
  skipped: number;
}

function serviceChain(proxy: KubeObject, title: Phrase, service: ProxyService, share: number, view: ClusterView): Chain {
  const walk = new Walk(title);
  const namespace = namespaceOf(proxy);
  const { name, port } = service;
  if (service.mirror) walk.add({ id: "contour.mirror", status: "ok", text: say("mirror", { percent: Math.round(share) }) });
  else if (share === 0) walk.add({ id: "contour.share", status: "warn", text: say("shareZero", { name }) });
  if (port === undefined) {
    walk.add({ id: "contour.service", status: "broken", text: say("noPort", { name }) });
    return walk.chain;
  }
  const services = view.services(namespace);
  if (!services) {
    walk.add({ id: "contour.service", status: "unknown", text: diagnosePhrase("route.servicesUnknown", { namespace }) });
    return walk.chain;
  }
  const svc = services.find((s) => nameOf(s) === name);
  if (!svc) {
    walk.add({ id: "contour.service", status: "broken", text: say("serviceMissing", { name, namespace }) });
    return walk.chain;
  }
  const externalName = svc.spec && (svc.spec as Record<string, unknown>).type === "ExternalName";
  const notes = externalName ? [say("externalName")] : undefined;
  walk.add({ id: "contour.service", status: externalName ? "warn" : "ok", text: say("service", { name, port }), links: [linkOf(SERVICE, svc)], notes });
  for (const f of diagnoseService(svc, view, { focus: port, source: { type: "outside" } }).findings) if (!walk.add(f)) break;
  return walk.chain;
}

/** A chain per service of each route (mirrors included) and of the TCP proxy; a route without one says what answers. */
function routeChains(walk: Walk, proxy: KubeObject, prefixes: (string | undefined)[], view: ClusterView, budget: Budget): void {
  const proxyName = nameOf(proxy);
  for (const route of routesOf(proxy)) {
    const n = route.index + 1;
    const prefix = joinPrefixes([...prefixes, route.prefix]);
    const only = (finding: Finding) => {
      const w = new Walk(say("routeTitle", { proxy: proxyName, route: n, prefix }));
      w.add(finding);
      walk.branch(w.chain);
    };
    if (route.redirect) {
      only({ id: "contour.route", status: "ok", text: say("routeRedirect") });
      continue;
    }
    if (route.directResponse !== undefined) {
      only({ id: "contour.route", status: "ok", text: say("routeDirect", { code: route.directResponse }) });
      continue;
    }
    if (!route.services.some((s) => !s.mirror)) {
      only({ id: "contour.route", status: "broken", text: say("routeNoService") });
      continue;
    }
    const share = shares(route.services);
    route.services.forEach((service, i) => {
      if (budget.used++ >= MAX_SERVICES) {
        budget.skipped++;
        return;
      }
      const title = say("serviceTitle", { proxy: proxyName, route: n, prefix, name: service.name, port: service.port ?? "" });
      walk.branch(serviceChain(proxy, title, service, share[i] ?? 0, view));
    });
  }
  const tcp = tcpServicesOf(proxy);
  const tcpShare = shares(tcp);
  tcp.forEach((service, i) => {
    if (budget.used++ >= MAX_SERVICES) {
      budget.skipped++;
      return;
    }
    walk.branch(serviceChain(proxy, say("tcpTitle", { proxy: proxyName, name: service.name, port: service.port ?? "" }), service, tcpShare[i] ?? 0, view));
  });
}

/** An include: the proxy it names exists, is not a root and is no cycle; then its own routes and includes. */
function includeChains(walk: Walk, proxy: KubeObject, prefixes: (string | undefined)[], path: string[], depth: number, view: ClusterView, budget: Budget): void {
  for (const inc of includesOf(proxy)) {
    const key = `${inc.namespace}/${inc.name}`;
    const prefix = joinPrefixes([...prefixes, inc.prefix]);
    const sub = new Walk(say(inc.tcp ? "tcpIncludeTitle" : "includeTitle", { name: key, prefix }), proxyLink(inc.namespace, inc.name));
    walk.branch(sub.chain);
    const list = view.objects?.(HTTP_PROXY, inc.namespace);
    if (!list) {
      sub.add({ id: "contour.include", status: "unknown", text: say("proxiesUnknown", { namespace: inc.namespace }) });
      continue;
    }
    const child = list.find((p) => nameOf(p) === inc.name);
    if (!child) {
      sub.add({ id: "contour.include", status: "broken", text: say("includeMissing", { name: inc.name, namespace: inc.namespace }) });
      continue;
    }
    if (path.includes(key)) {
      sub.add({ id: "contour.include", status: "broken", text: say("includeCycle", { name: key }) });
      continue;
    }
    if (isRoot(child)) {
      sub.add({ id: "contour.include", status: "broken", text: say("includeRoot", { name: key }) });
      continue;
    }
    if (!sub.add(statusFinding(child, "contour.include.status"))) continue;
    if (depth >= MAX_DEPTH) {
      sub.add({ id: "contour.depth", status: "unknown", text: say("deeper", { name: key }) });
      continue;
    }
    const next = [...prefixes, inc.prefix];
    routeChains(sub, child, next, view, budget);
    includeChains(sub, child, next, [...path, key], depth + 1, view, budget);
  }
}

export function diagnoseProxy(proxy: KubeObject, kind: KindRef, view: ClusterView): Chain {
  const walk = new Walk(undefined, linkOf(kind, proxy));
  if (!walk.add(statusFinding(proxy))) return walk.chain;
  if (isRoot(proxy)) {
    if (!walk.add(hostFinding(proxy))) return walk.chain;
    for (const f of tlsFindings(proxy, view)) if (!walk.add(f)) return walk.chain;
  } else {
    walk.add({ id: "contour.included", status: "ok", text: say("included") });
  }
  const budget: Budget = { used: 0, skipped: 0 };
  routeChains(walk, proxy, [], view, budget);
  includeChains(walk, proxy, [], [`${namespaceOf(proxy)}/${nameOf(proxy)}`], 1, view, budget);
  if (budget.skipped > 0) walk.add({ id: "contour.more", status: "ok", text: say("moreServices", { count: budget.skipped }) });
  return walk.chain;
}

function delegatedSecret(obj: KubeObject | null): SecretRef | undefined {
  const tls = obj ? tlsOf(obj) : undefined;
  return tls && !tls.passthrough && tls.secret ? { namespace: tls.secret.namespace, name: tls.secret.name } : undefined;
}

export const contourDiagnoser: RouteDiagnoser = {
  appliesTo: (kind) => kind.group === CONTOUR_GROUP && kind.kind === HTTP_PROXY.kind,
  // Contour looks up a proxy's Services in its own namespace: the included proxies' namespaces hold theirs.
  namespaces: (obj) => (obj ? includesOf(obj).map((i) => i.namespace) : []),
  lists: (obj, own) => {
    const namespaces = [...new Set([own, ...(obj ? includesOf(obj).map((i) => i.namespace) : [])])];
    const lists: ListRef[] = namespaces.map((namespace) => ({ kind: HTTP_PROXY, namespace }));
    const tls = obj ? tlsOf(obj)?.secret : undefined;
    if (tls?.delegated) lists.push({ kind: TLS_DELEGATION, namespace: tls.namespace });
    return lists;
  },
  secrets: (obj) => {
    const secret = delegatedSecret(obj);
    return secret ? [secret] : [];
  },
  diagnose: diagnoseProxy,
};
