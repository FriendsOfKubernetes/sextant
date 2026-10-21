// The path through a Traefik IngressRoute (#232), registered as a route kind of the traffic diagnosis (`routeKinds.ts`):
// the entry points it is served on, its TLS (the Secret's certificate read by the core, the TLSOption it names), then
// each route — a match rule Traefik accepts, every middleware it names, and each service: a Kubernetes Service on into
// the Service's own checks (`service.ts`), or a TraefikService followed through its weighted, mirrored, highest random
// weight or failover children down to Services. Traefik writes no status, so a link is broken only when an object it
// names does not exist (Traefik then skips the route: its clients get a 404); a reference into another namespace
// depends on the provider's `allowCrossNamespace`, which no object shows, and another provider's object
// (`name@file`) cannot be seen: both stay unknown, never "ok" and never "broken". The TLS never stops the walk:
// Traefik builds the router whether or not the route's certificate loads (`getTLSHTTP` errors are only logged) and
// picks a certificate by the requested name among all it holds, so a missing Secret, one without a valid certificate
// and a certificate that does not cover a host are warnings, and the routes, middlewares and services after them are
// still followed. Where both groups are served, a Traefik object is looked up in `traefik.io` (all Traefik v3 reads);
// one only in `traefik.containo.us` is unknown.
import type { KindRef, KubeObject } from "../../api";
import {
  hostsOf,
  INGRESS_ROUTE,
  isTraefik,
  routeSpec,
  traefikServiceRefs,
  TRAEFIK_GROUPS,
  LEGACY_GROUP,
  TRAEFIK_GROUP,
  type Ref,
  type RefKind,
  type Route,
} from "../traefik/model";
import { checkRef, type Lookup, type RefState } from "../traefik/resolve";
import { Walk, type Chain, type ClusterView, type Finding, type LinkRef, type Param, type Phrase } from "./model";
import { linkOf, nameOf, namespaceOf, SECRET, SERVICE } from "./objects";
import { registerRouteDiagnoser, type ListRef } from "./routeKinds";
import { diagnoseService } from "./service";
import { certificateNames, hostCovered } from "./tls";

/** Services (and TraefikServices) one diagnosis follows at most, and how deep TraefikServices nest. */
export const MAX_TRAEFIK_BACKENDS = 30;
export const MAX_TRAEFIK_DEPTH = 4;
/** Namespaces whose Traefik objects a diagnosis lists (the route's own first). */
export const MAX_LISTED_NAMESPACES = 4;

const phrase = (key: string, params?: Record<string, Param>): Phrase => ({ key: `traefik:diagnose.${key}`, params });

/** The Traefik kinds a diagnosis lists (both groups; the hook watches only the served ones). */
const LISTED: RefKind[] = ["Middleware", "TraefikService", "TLSOption", "TLSStore"];
const kindRef = (group: string, kind: string): KindRef => ({ group, version: "v1alpha1", kind });

/**
 * The lookup over the view: a Traefik kind in `traefik.io` where the cluster serves it there (Traefik v3 reads nothing
 * else), else in `traefik.containo.us`; `legacy` tells whether the old group has the name too. Services; nothing else
 * is listed.
 */
export function viewLookup(view: ClusterView): Lookup {
  const has = (list: readonly KubeObject[] | null | undefined, name: string) => (list ? list.some((o) => nameOf(o) === name) : list);
  const lists = (kind: RefKind, namespace: string) => ({
    own: view.objects!({ group: TRAEFIK_GROUP, kind }, namespace),
    legacy: view.objects!({ group: LEGACY_GROUP, kind }, namespace),
  });
  return {
    exists(kind, namespace, name) {
      if (kind === "Service") {
        const list = view.services(namespace);
        return list ? list.some((s) => nameOf(s) === name) : undefined;
      }
      if (!LISTED.includes(kind) || !view.objects) return undefined;
      const { own, legacy } = lists(kind, namespace);
      // `null`: the group does not serve the kind (no objects); `undefined`: not known.
      const found = has(own !== null ? own : legacy, name);
      return found === null ? false : found;
    },
    legacy(kind, namespace, name) {
      if (!LISTED.includes(kind) || !view.objects) return false;
      const { own, legacy } = lists(kind, namespace);
      if (own === null || legacy === null) return false;
      return has(legacy, name) ?? undefined;
    },
  };
}

function findTraefikService(view: ClusterView, namespace: string, name: string): { obj: KubeObject; group: string } | undefined {
  for (const group of TRAEFIK_GROUPS) {
    const obj = view.objects?.({ group, kind: "TraefikService" }, namespace)?.find((o) => nameOf(o) === name);
    if (obj) return { obj, group };
  }
  return undefined;
}

const refLink = (ref: Ref, group: string): LinkRef[] =>
  ref.provider
    ? []
    : [{ kind: ref.kind === "Service" ? SERVICE : ref.kind === "Secret" ? SECRET : kindRef(group, ref.kind), namespace: ref.namespace, name: ref.name }];

const refName = (ref: Ref) => (ref.provider ? `${ref.name}@${ref.provider}` : ref.name);

/**
 * One reference as a finding: `missing` and an unknown service kind break the path; another namespace, another provider
 * and a list not read are unknown.
 */
export function refFinding(id: string, ref: Ref, state: RefState, group: string): Finding {
  // A target only in the old group: linked there.
  if (state === "legacyOnly") return { id, status: "unknown", text: phrase("refLegacyOnly", { kind: ref.kind, name: refName(ref) }), links: refLink(ref, LEGACY_GROUP) };
  const params = { kind: ref.kind, name: refName(ref), namespace: ref.namespace };
  const links = refLink(ref, group);
  switch (state) {
    case "found":
      return { id, status: "ok", text: phrase("refFound", params), links };
    case "missing":
      // A TLSStore reference is not used by Traefik's routers.
      if (ref.kind === "TLSStore") return { id, status: "warn", text: phrase("storeMissing", params) };
      return { id, status: "broken", text: phrase("refMissing", params), notes: [phrase("refMissingNote")] };
    case "badKind":
      return { id, status: "broken", text: phrase("badKind", { name: ref.name, kind: ref.badKind ?? "" }) };
    case "crossNamespace":
      return { id, status: "unknown", text: phrase("refCrossNamespace", params), notes: [phrase("crossNamespaceNote")], links };
    case "otherProvider":
      return { id, status: "unknown", text: phrase("refOtherProvider", params) };
    case "unknown":
      return { id, status: "unknown", text: phrase("refUnknown", params), links };
  }
}

interface Group {
  service: Ref;
  /** The service's own middlewares and servers transport. */
  extras: Ref[];
}

/** Services with the references that belong to them (`serviceRefs` lists them right after their service). */
function groups(refs: readonly Ref[]): Group[] {
  const out: Group[] = [];
  for (const ref of refs) {
    if (ref.kind === "Service" || ref.kind === "TraefikService") out.push({ service: ref, extras: [] });
    else if ((ref.place === "middleware" || ref.place === "transport") && out.length > 0) out[out.length - 1]!.extras.push(ref);
  }
  return out;
}

interface Context {
  view: ClusterView;
  lookup: Lookup;
  /** The route is of `traefik.containo.us` (read only by a Traefik that reads both groups). */
  fromLegacy: boolean;
  /** Backends left to follow. */
  budget: { left: number };
}

function serviceTitle(ref: Ref): Phrase {
  const key = ref.place === "mirror" ? "mirrorTitle" : ref.place === "fallback" ? "fallbackTitle" : "serviceTitle";
  return phrase(key, { kind: ref.kind, name: ref.port === undefined ? refName(ref) : `${refName(ref)}:${ref.port}` });
}

function backendChain(group: Group, traefikGroup: string, ctx: Context, depth: number): Chain {
  const { service: ref } = group;
  const walk = new Walk(serviceTitle(ref));
  if (ref.weight === 0 && ref.place !== "mirror") walk.add({ id: "traefik.weight", status: "warn", text: phrase("weightZero") });
  const state = checkRef(ref, ctx.lookup, ctx.fromLegacy);
  if (!walk.add(refFinding("traefik.service", ref, state, traefikGroup))) return walk.chain;
  for (const [i, extra] of group.extras.entries()) {
    if (!walk.add(refFinding(`traefik.service.ref.${i}`, extra, checkRef(extra, ctx.lookup, ctx.fromLegacy), traefikGroup))) return walk.chain;
  }
  if (state !== "found" && state !== "crossNamespace") return walk.chain;
  if (ref.kind === "TraefikService") {
    const found = findTraefikService(ctx.view, ref.namespace, ref.name);
    if (!found) return walk.chain;
    if (depth >= MAX_TRAEFIK_DEPTH) {
      walk.add({ id: "traefik.depth", status: "unknown", text: phrase("tooDeep", { count: MAX_TRAEFIK_DEPTH }) });
      return walk.chain;
    }
    const children = groups(traefikServiceRefs(found.obj));
    if (children.length === 0) walk.add({ id: "traefik.children", status: "broken", text: phrase("noChildren", { name: ref.name }) });
    for (const child of children) {
      if (ctx.budget.left-- <= 0) continue;
      walk.branch(backendChain(child, found.group, ctx, depth + 1));
    }
    return walk.chain;
  }
  const svc = ctx.view.services(ref.namespace)?.find((s) => nameOf(s) === ref.name);
  if (!svc) return walk.chain;
  for (const f of diagnoseService(svc, ctx.view, { focus: ref.port, source: { type: "outside" } }).findings) if (!walk.add(f)) break;
  return walk.chain;
}

function routeChain(route: Route, group: string, ctx: Context): Chain {
  const walk = new Walk(phrase("routeTitle", { route: route.index + 1, match: route.match }));
  if (route.kind && route.kind !== "Rule") {
    walk.add({ id: "traefik.rule", status: "broken", text: phrase("unsupportedKind", { kind: route.kind }) });
    return walk.chain;
  }
  if (!route.match.trim()) {
    walk.add({ id: "traefik.rule", status: "broken", text: phrase("emptyMatch") });
    return walk.chain;
  }
  walk.add({ id: "traefik.rule", status: "ok", text: phrase("rule", { match: route.match }), notes: route.priority === undefined ? undefined : [phrase("priority", { priority: route.priority })] });
  for (const [i, m] of route.middlewares.entries()) {
    if (!walk.add(refFinding(`traefik.middleware.${i}`, m, checkRef(m, ctx.lookup, ctx.fromLegacy), group))) return walk.chain;
  }
  const backends = groups(route.refs.filter((r) => r.place !== "route" || r.kind === "Service" || r.kind === "TraefikService"));
  if (backends.length === 0) {
    walk.add({ id: "traefik.services", status: "warn", text: phrase("noServices") });
    return walk.chain;
  }
  for (const b of backends) {
    if (ctx.budget.left-- <= 0) continue;
    walk.branch(backendChain(b, group, ctx, 0));
  }
  return walk.chain;
}

/** The TLS of an IngressRoute: its Secret's certificate (valid now, covering the routes' hosts), options and store. */
function tlsFindings(route: KubeObject, group: string, ctx: Context): Finding[] {
  const spec = routeSpec(INGRESS_ROUTE, route);
  const tls = spec.tls;
  if (!tls) return [];
  const namespace = namespaceOf(route);
  const hosts = [...new Set([...spec.routes.flatMap((r) => hostsOf(r.match)), ...tls.domains.map((d) => d.toLowerCase())])];
  const out: Finding[] = [];
  const id = "traefik.tls";
  if (tls.secretName) {
    const name = tls.secretName;
    const links: LinkRef[] = [{ kind: SECRET, namespace, name }];
    const state = ctx.view.certificates(namespace, name);
    const leaf = state?.state === "ready" ? state.info.chain[0] : undefined;
    if (!state) out.push({ id, status: "unknown", text: phrase("tlsUnknown", { name }), links });
    // Traefik logs that it cannot load the certificate and builds the router anyway: a warning, the walk goes on.
    else if (state.state === "notFound") out.push({ id, status: "warn", text: phrase("tlsSecretMissing", { name, namespace }), notes: [phrase("tlsSniNote")] });
    else if (state.state === "error")
      out.push(
        state.code === "invalid"
          ? { id, status: "warn", text: phrase("tlsInvalid", { name }), notes: [phrase("tlsSniNote")], links }
          : { id, status: "unknown", text: phrase("tlsUnknown", { name }), links },
      );
    else if (!leaf) out.push({ id, status: "warn", text: phrase("tlsInvalid", { name }), notes: [phrase("tlsSniNote")], links });
    else {
      const notAfter = Date.parse(leaf.notAfter);
      const notBefore = Date.parse(leaf.notBefore);
      const uncovered = hosts.filter((h) => !hostCovered(leaf, h));
      if (Number.isFinite(notAfter) && notAfter < ctx.view.now) out.push({ id, status: "broken", text: phrase("tlsExpired", { name }), links });
      else if (Number.isFinite(notBefore) && notBefore > ctx.view.now) out.push({ id, status: "broken", text: phrase("tlsNotYetValid", { name }), links });
      else if (uncovered.length > 0)
        out.push({ id, status: "warn", text: phrase("tlsHostNotCovered", { name, hosts: uncovered, names: certificateNames(leaf) }), notes: [phrase("tlsSniNote")], links });
      else out.push({ id, status: "ok", text: hosts.length > 0 ? phrase("tlsOk", { name, hosts }) : phrase("tlsOkNoHosts", { name }), links });
    }
  } else if (tls.certResolver) {
    out.push({ id, status: "unknown", text: phrase("tlsResolver", { resolver: tls.certResolver }) });
  } else {
    out.push({ id, status: "warn", text: phrase("tlsDefault") });
  }
  if (tls.options) out.push(refFinding("traefik.tls.options", tls.options, checkRef(tls.options, ctx.lookup, ctx.fromLegacy), group));
  if (tls.store) out.push(refFinding("traefik.tls.store", tls.store, checkRef(tls.store, ctx.lookup, ctx.fromLegacy), group));
  return out;
}

export function diagnoseIngressRoute(route: KubeObject, kind: KindRef, view: ClusterView): Chain {
  const walk = new Walk(undefined, linkOf(kind, route));
  const spec = routeSpec(kind, route);
  const ctx: Context = { view, lookup: viewLookup(view), fromLegacy: kind.group === LEGACY_GROUP, budget: { left: MAX_TRAEFIK_BACKENDS } };
  const notes = [phrase("noStatus"), ...(spec.ingressClassName ? [phrase("ingressClass", { name: spec.ingressClassName })] : [])];
  walk.add(
    spec.entryPoints.length > 0
      ? { id: "traefik.entryPoints", status: "ok", text: phrase("entryPoints", { entryPoints: spec.entryPoints }), notes }
      : { id: "traefik.entryPoints", status: "ok", text: phrase("allEntryPoints"), notes },
  );
  if (spec.parents.length > 0) {
    walk.add({ id: "traefik.parents", status: "unknown", text: phrase("parents", { names: spec.parents.map((p) => p.name) }) });
  }
  // Beside the path: an expired certificate fails the clients' handshakes, but the routes are built and followed.
  for (const f of tlsFindings(route, kind.group, ctx)) walk.aside(f);
  if (spec.routes.length === 0) {
    walk.add({ id: "traefik.routes", status: "broken", text: phrase("noRoutes") });
    return walk.chain;
  }
  for (const r of spec.routes) walk.branch(routeChain(r, kind.group, ctx));
  if (ctx.budget.left < 0) walk.add({ id: "traefik.more", status: "ok", text: phrase("moreBackends", { count: -ctx.budget.left }) });
  return walk.chain;
}

// ---------- What the hook reads ----------

function ownNamespaces(obj: KubeObject | null, own: string, kinds: readonly RefKind[]): string[] {
  if (!obj) return [own];
  const spec = routeSpec(INGRESS_ROUTE, obj);
  const refs = [...spec.routes.flatMap((r) => r.refs), ...(spec.tls?.options ? [spec.tls.options] : []), ...(spec.tls?.store ? [spec.tls.store] : [])];
  return [...new Set([own, ...refs.filter((r) => kinds.includes(r.kind) && !r.provider).map((r) => r.namespace)])];
}

registerRouteDiagnoser({
  appliesTo: (kind) => isTraefik(kind, INGRESS_ROUTE),
  namespaces: (obj, own) => ownNamespaces(obj, own, ["Service", "TraefikService"]),
  lists: (obj, own): ListRef[] =>
    ownNamespaces(obj, own, LISTED).slice(0, MAX_LISTED_NAMESPACES).flatMap((namespace) => TRAEFIK_GROUPS.flatMap((g) => LISTED.map((k) => ({ kind: kindRef(g, k), namespace })))),
  secrets: (obj, own) => {
    const name = obj ? routeSpec(INGRESS_ROUTE, obj).tls?.secretName : undefined;
    return name ? [{ namespace: own, name }] : [];
  },
  diagnose: diagnoseIngressRoute,
});
