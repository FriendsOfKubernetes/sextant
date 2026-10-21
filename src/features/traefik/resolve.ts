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
// `default` exists). Nor does a route's TLS Secret: Traefik logs that it cannot load it (`getTLSHTTP`) and still builds
// the router, answering with a certificate picked by the requested name among those it holds, else its default one.
// Where a cluster serves both groups, Traefik v3 reads only `traefik.io`: a reference from a `traefik.io` object is
// looked up there, and a target that exists only in `traefik.containo.us` is "legacy only" (Traefik 2.10 reads both,
// v3 does not; which one runs no object shows) — open, never fine and never broken. Pure.
import type { KindRef, KubeObject } from "../../api";
import { isRouteKind, isTraefik, INGRESS_ROUTE, INGRESS_ROUTE_UDP, LEGACY_GROUP, referencesOf, routeSpec, type Ref, type RefKind } from "./model";

export type RefState = "found" | "missing" | "crossNamespace" | "otherProvider" | "unknown" | "badKind" | "legacyOnly";

export interface Lookup {
  /**
   * Whether `kind` `name` exists in `namespace`; `undefined` when that list is not known. A Traefik kind is looked up
   * in `traefik.io` where the cluster serves it there, else in `traefik.containo.us`.
   */
  exists(kind: RefKind, namespace: string, name: string): boolean | undefined;
  /**
   * Whether a `traefik.containo.us` object of that name exists while `traefik.io` serves the kind too (`false` where
   * only one group serves it; `undefined` when the old group's list is not known).
   */
  legacy?(kind: RefKind, namespace: string, name: string): boolean | undefined;
}

export interface RefCheck {
  ref: Ref;
  state: RefState;
  /** Found in `traefik.io`, and an object of the same name exists in `traefik.containo.us` too. */
  legacyToo?: boolean;
}

/** Traefik's own services: always there. */
const INTERNAL = "internal";

/**
 * What a reference finds. `fromLegacy`: the referring object is of `traefik.containo.us` — only a Traefik that reads
 * both groups (2.10) serves it, and that one finds the target in either.
 */
export function checkRef(ref: Ref, lookup: Lookup, fromLegacy = false): RefState {
  if (ref.badKind) return "badKind";
  if (ref.provider) return ref.provider === INTERNAL ? "found" : "otherProvider";
  let found = lookup.exists(ref.kind, ref.namespace, ref.name);
  if (found !== true && lookup.legacy) {
    const legacy = lookup.legacy(ref.kind, ref.namespace, ref.name);
    if (legacy === true) {
      if (!fromLegacy) return "legacyOnly";
      found = true;
    } else if (legacy === undefined) {
      // The old group's list is not known: Traefik 2.10 might find the target there.
      return "unknown";
    }
  }
  if (found === undefined) return "unknown";
  if (!found) return "missing";
  return ref.crossNamespace ? "crossNamespace" : "found";
}

/** A route's TLS Secret: Traefik builds the router without it (another certificate is served). */
export const isRouteTlsSecret = (ref: Ref) => ref.kind === "Secret" && ref.place === "tls";

/**
 * A reference whose target is missing (or of an unknown kind) breaks its object — except a TLSStore reference and a
 * route's TLS Secret, neither of which stops Traefik from building the router.
 */
export const breaks = (check: RefCheck) =>
  (check.state === "missing" || check.state === "badKind") && check.ref.kind !== "TLSStore" && !isRouteTlsSecret(check.ref);

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

/**
 * Judges an object's references; `skip` leaves some out (the shared store does not judge Secrets: only the details of
 * one object list them).
 */
export function judge(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject, lookup: Lookup, skip?: (ref: Ref) => boolean): Judgement {
  const fromLegacy = kind.group === LEGACY_GROUP;
  const checks = referencesOf(kind, obj)
    .filter((ref) => !skip?.(ref))
    .map((ref): RefCheck => {
      const state = checkRef(ref, lookup, fromLegacy);
      const legacyToo = !fromLegacy && (state === "found" || state === "crossNamespace") && !ref.provider && lookup.legacy?.(ref.kind, ref.namespace, ref.name) === true;
      return legacyToo ? { ref, state, legacyToo } : { ref, state };
    });
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
