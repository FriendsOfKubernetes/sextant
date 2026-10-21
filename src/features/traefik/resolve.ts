// Whether the references of a Traefik object lead anywhere (#232). Traefik writes no status on its CRDs, so this is all
// that can be judged from the objects: a route that names a Middleware, Service, TraefikService or TLSOption that does
// not exist is skipped by Traefik (its log says why, the client gets a 404), a missing TLS Secret makes it serve its
// default certificate. What cannot be judged stays open, never "fine" and never "broken":
//   - a reference into another namespace: Traefik follows it only when the provider runs with `allowCrossNamespace`
//     (off by default), a flag of Traefik's static configuration that no object shows;
//   - `name@provider`: an object of another provider (file, …) Sextant cannot see — except Traefik's own `@internal`
//     services (`api@internal`, `noop@internal`, …), which always exist;
//   - a list Sextant could not read.
// A TLSStore reference of a route is shown but never breaks it: Traefik's routers do not use it (only the store named
// `default` exists). Pure.
import type { KindRef, KubeObject } from "../../api";
import { isRouteKind, isTraefik, INGRESS_ROUTE, INGRESS_ROUTE_UDP, referencesOf, routeSpec, type Ref, type RefKind } from "./model";

export type RefState = "found" | "missing" | "crossNamespace" | "otherProvider" | "unknown" | "badKind";

export interface Lookup {
  /** Whether `kind` `name` exists in `namespace`; `undefined` when that list is not known. */
  exists(kind: RefKind, namespace: string, name: string): boolean | undefined;
}

export interface RefCheck {
  ref: Ref;
  state: RefState;
}

/** Traefik's own services: always there. */
const INTERNAL = "internal";

export function checkRef(ref: Ref, lookup: Lookup): RefState {
  if (ref.badKind) return "badKind";
  if (ref.provider) return ref.provider === INTERNAL ? "found" : "otherProvider";
  const found = lookup.exists(ref.kind, ref.namespace, ref.name);
  if (found === undefined) return "unknown";
  if (!found) return "missing";
  return ref.crossNamespace ? "crossNamespace" : "found";
}

/** A reference whose target is missing (or of an unknown kind) breaks its object. */
export const breaks = (check: RefCheck) => (check.state === "missing" || check.state === "badKind") && check.ref.kind !== "TLSStore";

/** A route Traefik skips by its own shape. */
export interface RouteIssue {
  type: "emptyMatch" | "unsupportedKind";
  /** 0-based. */
  route: number;
  value?: string;
}

export function routeIssues(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): RouteIssue[] {
  if (!isRouteKind(kind) || isTraefik(kind, INGRESS_ROUTE_UDP)) return [];
  const http = isTraefik(kind, INGRESS_ROUTE);
  return routeSpec(kind, obj).routes.flatMap((r): RouteIssue[] => {
    if (http && r.kind && r.kind !== "Rule") return [{ type: "unsupportedKind", route: r.index, value: r.kind }];
    if (!r.match.trim()) return [{ type: "emptyMatch", route: r.index }];
    return [];
  });
}

/** `ok`: every reference found; `partial`: some could not be judged; `failed`: one is broken; `loading`: lists pending. */
export type Health = "ok" | "partial" | "failed" | "loading";

export interface Judgement {
  health: Health;
  checks: RefCheck[];
  issues: RouteIssue[];
}

export function judge(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject, lookup: Lookup): Judgement {
  const checks = referencesOf(kind, obj).map((ref) => ({ ref, state: checkRef(ref, lookup) }));
  const issues = routeIssues(kind, obj);
  const health: Health =
    issues.length > 0 || checks.some(breaks) ? "failed" : checks.some((c) => c.state !== "found") ? "partial" : "ok";
  return { health, checks, issues };
}

export const HEALTH_TONE = { ok: "success", partial: "muted", failed: "danger", loading: "muted" } as const;

/** `Kind name` or `Kind namespace/name` of a reference, for a message. */
export function refText(ref: Ref, from: string): string {
  const name = ref.provider ? `${ref.name}@${ref.provider}` : ref.namespace !== from ? `${ref.namespace}/${ref.name}` : ref.name;
  return `${ref.kind} ${name}`;
}
