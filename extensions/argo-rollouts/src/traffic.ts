// Whether a canary's traffic really reaches the canary (#341, ADR-0171): the Istio VirtualServices and DestinationRule
// a Rollout names, and its canary and stable Services, read as the controller of Argo Rollouts v1.10.2 uses them
// (rollout/trafficrouting/istio/istio.go):
// - a VirtualService named `name`, `name.namespace` or `name.namespace.svc.cluster.local` (utils/istio/istio.go
//   `GetVirtualServiceNamespaceName`: the last dot-separated part is the namespace once `.cluster.local` is cut), in the
//   Rollout's namespace when none is given;
// - its HTTP routes named in `virtualService.routes`, or, with none named, its only HTTP route or else its first route
//   without a name (`getHttpRouteIndexesToPatch`); a named route it lacks stops the controller ("HTTP Route '…' is not
//   found"), and so does a route without both the canary and the stable destination (`validateDestinationRule`); a
//   destination's host is compared up to its first dot (`getHost`);
// - the DestinationRule's canary and stable subsets, whose `rollouts-pod-template-hash` label the controller sets to the
//   canary's and the stable ReplicaSet's hash (`UpdateHash`) once the ReplicaSets are available
//   (`shouldDelayDestinationRuleUpdate`); the canary and stable Services' selectors the same way.
// "Same hash" is a problem only while an update runs and the canary has weight: after a promotion both point at the
// stable pods, which is normal. Anything the lookups cannot tell is left out, never reported. Pure.
import type { KubeObject } from "@sextant/extension-sdk";
import { POD_TEMPLATE_HASH_LABEL, arr, canaryServices, currentHash, get, num, record, setWeight, stableHash, str, updating } from "./model";

/** An object found, `null` for one that is not there, `undefined` where that cannot be told. */
export type Found = KubeObject | null | undefined;

export interface TrafficLookups {
  virtualService(namespace: string, name: string): Found;
  destinationRule(namespace: string, name: string): Found;
  service(namespace: string, name: string): Found;
  /** Available pods of the Rollout's ReplicaSet with this template hash; `undefined` when not known. */
  available?(hash: string): number | undefined;
}

export type TrafficLevel = "problem" | "warning" | "normal";

export interface TrafficFinding {
  code: TrafficCode;
  level: TrafficLevel;
  values: Record<string, string>;
}

export type TrafficCode =
  | "virtual-service-missing"
  | "route-missing"
  | "route-not-chosen"
  | "route-without-canary"
  | "route-without-stable"
  | "destination-rule-missing"
  | "subset-missing"
  | "same-hash"
  | "canary-not-new"
  | "no-pods"
  | "promoted-same-hash";

interface VirtualServiceRef {
  namespace: string;
  name: string;
  routes: string[];
  /** Whether TLS or TCP routes are named, which this module does not read. */
  otherRoutes: boolean;
}

/** `GetVirtualServiceNamespaceName`. */
export function virtualServiceKey(ref: string, rolloutNamespace: string): { namespace: string; name: string } {
  const fields = ref.replace(/\.cluster\.local$/, "").split(".");
  if (fields.length >= 2) return { name: fields.slice(0, -1).join("."), namespace: fields[fields.length - 1]! };
  return { name: fields[0] ?? "", namespace: rolloutNamespace };
}

const istio = (ro: KubeObject) => get(ro, "spec", "strategy", "canary", "trafficRouting", "istio");

/** The VirtualServices a Rollout names (`virtualService` and `virtualServices`). */
export function virtualServiceRefs(ro: KubeObject): VirtualServiceRef[] {
  const ns = ro.metadata?.namespace ?? "";
  const one = get(istio(ro), "virtualService");
  const list = [...(one === undefined ? [] : [one]), ...arr(get(istio(ro), "virtualServices"))];
  return list.flatMap((v) => {
    const ref = str(get(v, "name"));
    if (!ref) return [];
    const key = virtualServiceKey(ref, ns);
    return [
      {
        ...key,
        routes: arr(get(v, "routes")).flatMap((r) => (typeof r === "string" && r ? [r] : [])),
        otherRoutes: arr(get(v, "tlsRoutes")).length > 0 || arr(get(v, "tcpRoutes")).length > 0,
      },
    ];
  });
}

export interface DestinationRuleRef {
  name: string;
  canarySubset: string;
  stableSubset: string;
}

export function destinationRuleRef(ro: KubeObject): DestinationRuleRef | undefined {
  const dr = get(istio(ro), "destinationRule");
  const name = str(get(dr, "name"));
  if (!name) return undefined;
  return { name, canarySubset: str(get(dr, "canarySubsetName")) ?? "", stableSubset: str(get(dr, "stableSubsetName")) ?? "" };
}

/** `getHost`: a destination's host up to its first dot. */
const hostOf = (destination: unknown): string => (str(get(destination, "destination", "host")) ?? "").split(".")[0] ?? "";
const subsetOf = (destination: unknown): string => str(get(destination, "destination", "subset")) ?? "";

/** The canary's weight: what the router reported, else the canary destination's in a route, else the step's. */
export function canaryWeight(ro: KubeObject, routes: unknown[] = []): number {
  const reported = num(get(ro, "status", "canary", "weights", "canary", "weight"));
  if (reported !== undefined) return reported;
  const dr = destinationRuleRef(ro);
  const { canary } = canaryServices(ro);
  for (const route of routes) {
    for (const d of arr(get(route, "route"))) {
      if ((dr && subsetOf(d) === dr.canarySubset) || (!dr && canary && hostOf(d) === canary)) {
        const w = num(get(d, "weight"));
        if (w !== undefined) return w;
      }
    }
  }
  return setWeight(ro);
}

/** The HTTP routes of a VirtualService the controller edits for `ref`, or why it cannot. */
function chosenRoutes(vs: KubeObject, ref: VirtualServiceRef, managed: Set<string>): { routes: unknown[]; findings: TrafficFinding[] } {
  const http = arr(get(vs, "spec", "http"));
  const name = (r: unknown) => str(get(r, "name")) ?? "";
  const findings: TrafficFinding[] = [];
  if (ref.routes.length === 0) {
    if (ref.otherRoutes) return { routes: [], findings };
    if (http.length === 1) return { routes: http, findings };
    const unnamed = http.find((r) => name(r) === "");
    const notManaged = http.filter((r) => !managed.has(name(r)));
    if (notManaged.length > 1 || !unnamed) {
      findings.push({ code: "route-not-chosen", level: "problem", values: { virtualService: ref.name } });
      return { routes: unnamed ? [unnamed] : [], findings };
    }
    return { routes: [unnamed], findings };
  }
  const routes: unknown[] = [];
  for (const route of ref.routes) {
    const found = http.find((r) => name(r) === route);
    if (found) routes.push(found);
    else findings.push({ code: "route-missing", level: "problem", values: { virtualService: ref.name, route } });
  }
  return { routes, findings };
}

/** What a Rollout's traffic routing says, in order: missing objects, routes, then where the hashes point. */
export function trafficFindings(ro: KubeObject, look: TrafficLookups): TrafficFinding[] {
  const out: TrafficFinding[] = [];
  const ns = ro.metadata?.namespace ?? "";
  const dr = destinationRuleRef(ro);
  const services = canaryServices(ro);
  const managed = new Set(arr(get(ro, "spec", "strategy", "canary", "trafficRouting", "managedRoutes")).flatMap((m) => str(get(m, "name")) ?? []));
  const routes: unknown[] = [];
  for (const ref of virtualServiceRefs(ro)) {
    const vs = look.virtualService(ref.namespace, ref.name);
    if (vs === undefined) continue;
    if (vs === null) {
      out.push({ code: "virtual-service-missing", level: "problem", values: { name: ref.name, namespace: ref.namespace } });
      continue;
    }
    const chosen = chosenRoutes(vs, ref, managed);
    out.push(...chosen.findings);
    for (const route of chosen.routes) {
      routes.push(route);
      const destinations = arr(get(route, "route"));
      const routeName = str(get(route, "name")) ?? "";
      const has = (target: string | undefined, bySubset: boolean) =>
        Boolean(target) && destinations.some((d) => (bySubset ? subsetOf(d) : hostOf(d)) === target);
      const canary = dr ? dr.canarySubset : services.canary;
      const stable = dr ? dr.stableSubset : services.stable;
      if (canary && !has(canary, Boolean(dr))) {
        out.push({ code: "route-without-canary", level: "problem", values: { virtualService: ref.name, route: routeName, target: canary } });
      }
      if (stable && !has(stable, Boolean(dr))) {
        out.push({ code: "route-without-stable", level: "problem", values: { virtualService: ref.name, route: routeName, target: stable } });
      }
    }
  }

  // Where the canary and stable traffic goes: the DestinationRule's subsets, else the Services' selectors.
  const hashes: { via: "subsets" | "services"; canary?: string; stable?: string }[] = [];
  if (dr) {
    const rule = look.destinationRule(ns, dr.name);
    if (rule === null) out.push({ code: "destination-rule-missing", level: "problem", values: { name: dr.name } });
    else if (rule) {
      const subsets = arr(get(rule, "spec", "subsets"));
      const subset = (name: string) => subsets.find((s) => str(get(s, "name")) === name);
      const hashOf = (s: unknown) => str(record(get(s, "labels"))[POD_TEMPLATE_HASH_LABEL]);
      const canary = subset(dr.canarySubset);
      const stable = subset(dr.stableSubset);
      for (const [name, s] of [
        [dr.canarySubset, canary],
        [dr.stableSubset, stable],
      ] as const) {
        if (name && !s) out.push({ code: "subset-missing", level: "problem", values: { destinationRule: dr.name, subset: name } });
      }
      if (canary && stable) hashes.push({ via: "subsets", canary: hashOf(canary), stable: hashOf(stable) });
    }
  }
  if (services.canary && services.stable) {
    const canary = look.service(ns, services.canary);
    const stable = look.service(ns, services.stable);
    const selected = (svc: Found) => (svc ? str(record(get(svc, "spec", "selector"))[POD_TEMPLATE_HASH_LABEL]) : undefined);
    if (canary && stable) hashes.push({ via: "services", canary: selected(canary), stable: selected(stable) });
  }

  const weight = canaryWeight(ro, routes);
  const newHash = currentHash(ro);
  for (const h of hashes) {
    if (!h.canary || !h.stable) continue;
    if (h.canary === h.stable) {
      if (updating(ro) && weight > 0) out.push({ code: "same-hash", level: "problem", values: { via: h.via, hash: h.canary, weight: String(weight) } });
      else if (!updating(ro) && h.canary === stableHash(ro)) out.push({ code: "promoted-same-hash", level: "normal", values: { via: h.via, hash: h.canary } });
      continue;
    }
    if (updating(ro) && newHash && h.canary !== newHash) {
      out.push({ code: "canary-not-new", level: "warning", values: { via: h.via, hash: h.canary, expected: newHash } });
    }
    for (const [role, hash] of [
      ["canary", h.canary],
      ["stable", h.stable],
    ] as const) {
      const available = look.available?.(hash);
      const carries = role === "canary" ? weight > 0 : weight < 100;
      if (available === 0 && carries) out.push({ code: "no-pods", level: "problem", values: { via: h.via, role, hash } });
    }
  }
  return out;
}

/** English text of a finding, for the agent tool. */
export function trafficText(f: TrafficFinding): string {
  const v = f.values;
  const via = v.via === "subsets" ? "DestinationRule subsets" : "canary and stable Services";
  switch (f.code) {
    case "virtual-service-missing":
      return `VirtualService ${v.namespace}/${v.name} is not there: the controller cannot shift traffic.`;
    case "route-missing":
      return `VirtualService ${v.virtualService} has no HTTP route named ${v.route}: the controller stops with "HTTP Route '${v.route}' is not found".`;
    case "route-not-chosen":
      return `VirtualService ${v.virtualService} has several HTTP routes and the Rollout names none (virtualService.routes): the controller cannot tell which one to edit.`;
    case "route-without-canary":
      return `Route ${v.route || "(unnamed)"} of VirtualService ${v.virtualService} has no destination ${v.target} for the canary.`;
    case "route-without-stable":
      return `Route ${v.route || "(unnamed)"} of VirtualService ${v.virtualService} has no destination ${v.target} for the stable version.`;
    case "destination-rule-missing":
      return `DestinationRule ${v.name} is not there.`;
    case "subset-missing":
      return `DestinationRule ${v.destinationRule} has no subset ${v.subset}.`;
    case "same-hash":
      return `The ${via} both select pods of template hash ${v.hash} while the canary has weight ${v.weight}: canary and stable traffic go to the same pods, so the canary is not isolated and its analysis measures the old version.`;
    case "canary-not-new":
      return `The canary's ${via} select template hash ${v.hash}, not the new ${v.expected}: the controller switches them once the new ReplicaSet is available, so this is expected for a short while.`;
    case "no-pods":
      return `The ${v.role} ${via} select template hash ${v.hash}, which has no available pods, while it should carry traffic.`;
    case "promoted-same-hash":
      return `The ${via} both select the stable template hash ${v.hash}: normal for a fully promoted Rollout.`;
  }
}
