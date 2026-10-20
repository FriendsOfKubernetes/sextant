// What the diagnosis reads, as bounded live watches shared with the rest of the app: only the namespaces the path
// goes through (the object's own; a route's backend and parent namespaces, at most `MAX_NAMESPACES` of them), only
// kinds the cluster serves, nothing before discovery. Each list is one spec per (kind, namespace), the shape the
// resource map, the "Related" tab and the connectivity views use, so they share one stream (`useSharedWatches`);
// pods and network policies come from the connectivity engine's own hook (`useNetpolData`). Cluster-wide lists are
// only IngressClasses and, for a controller Sextant knows, its pods by label selector. TLS certificates are read by
// the core (`tls_certificate_info`), once per Secret and Ingress version. Everything is let go on unmount.
import { useEffect, useMemo, useState } from "react";
import { api, toApiError, type ClusterId, type KindRef, type KubeObject, type WatchSpec, type WatchState } from "../../api";
import { useClusterKinds } from "../../resources";
import { servedKind, useGrants } from "../gateway-api/hooks";
import { GATEWAY, parentRefs, routeRules } from "../gateway-api/model";
import { useNetpolData } from "../netpol/hooks";
import { isFinished } from "../netpol/model";
import { useSharedWatches } from "../resource-map/watches";
import { controllerOf, controllerSelector, resolveClass } from "./controllers";
import { diagnosedKind } from "./engine";
import type { CertificateState, ClusterView } from "./model";
import { ENDPOINT_SLICE, INGRESS_CLASS, nameOf, POD, SERVICE } from "./objects";
import { tlsEntries } from "./tls";

/** Namespaces a diagnosis lists at once (the object's own included). */
export const MAX_NAMESPACES = 4;
/** TLS Secrets an Ingress diagnosis reads at most. */
export const MAX_SECRETS = 8;
/** How often "now" moves on (a load balancer pending for how long). */
export const CLOCK_MS = 30_000;

type Role = "root" | "services" | "slices" | "classes" | "controller" | "gateways";
interface Planned {
  role: Role;
  namespace: string | null;
  spec: WatchSpec;
}

const spec = (kind: KindRef, namespace: string | null, labelSelector: string | null = null): WatchSpec => ({
  kind,
  namespaces: namespace === null ? null : [namespace],
  labelSelector,
  fieldSelector: null,
});

const capped = (list: readonly string[]) => [...new Set(list.filter(Boolean))].slice(0, MAX_NAMESPACES);

function readable(state: WatchState | undefined, namespace: string | null): boolean {
  return state?.status === "ready" && (namespace === null || !(state.forbidden ?? []).includes(namespace));
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The namespaces of a route's backends after its own; the namespaces of its parents. */
function routeNamespaces(kind: KindRef, obj: KubeObject | null, own: string): { backends: string[]; parents: string[] } {
  if (!obj) return { backends: [own], parents: [own] };
  const backends = routeRules(obj, kind).flatMap((r) => r.backends.map((b) => b.namespace ?? own));
  return { backends: capped([own, ...backends]), parents: capped(parentRefs(obj).map((p) => p.namespace ?? own)) };
}

export interface DiagnosisData {
  /** The object as the live list has it (the given one until the list comes); `null` once it is gone. */
  obj: KubeObject | null;
  view: ClusterView;
  loading: boolean;
}

export function useDiagnosisData(clusterId: ClusterId, kind: KindRef, namespace: string, name: string, given: KubeObject | null): DiagnosisData {
  const kinds = useClusterKinds(clusterId);
  const now = useNow();
  const which = diagnosedKind(kind);
  const served = {
    root: servedKind(kinds, kind),
    service: servedKind(kinds, SERVICE),
    slice: servedKind(kinds, ENDPOINT_SLICE),
    ingressClass: which === "ingress" ? servedKind(kinds, INGRESS_CLASS) : null,
    gateway: which === "route" ? servedKind(kinds, GATEWAY) : null,
    pod: servedKind(kinds, POD),
  };
  const discovering = Object.values(served).some((k) => k === undefined);

  // The root first: what it names decides the rest of the plan.
  const rootSpecs = served.root ? [spec(served.root, namespace)] : [];
  const [rootState] = useSharedWatches(clusterId, discovering ? [] : rootSpecs);
  // A list that cannot be read there (no permission) says nothing about the object: the given one stays.
  const live = readable(rootState, namespace) ? ([...rootState!.items.values()].find((o) => nameOf(o) === name) ?? null) : undefined;
  const obj = live === undefined ? given : live;

  const routes = which === "route" ? routeNamespaces(kind, obj, namespace) : { backends: [namespace], parents: [] };
  const namespaces = routes.backends;
  const classesSpec = served.ingressClass ? spec(served.ingressClass, null) : null;
  const plan: Planned[] = [];
  if (!discovering) {
    for (const ns of namespaces) {
      if (served.service) plan.push({ role: "services", namespace: ns, spec: spec(served.service, ns) });
      if (served.slice) plan.push({ role: "slices", namespace: ns, spec: spec(served.slice, ns) });
    }
    if (classesSpec) plan.push({ role: "classes", namespace: null, spec: classesSpec });
    for (const ns of routes.parents) if (served.gateway) plan.push({ role: "gateways", namespace: ns, spec: spec(served.gateway, ns) });
  }
  const firstStates = useSharedWatches(clusterId, plan.map((p) => p.spec));
  const classesState = firstStates[plan.findIndex((p) => p.role === "classes")];

  // The controller of an Ingress's class, once the classes are known: its pods by the labels of its installation.
  const classes = readable(classesState, null) ? [...classesState!.items.values()] : undefined;
  const resolved = which === "ingress" && obj && classes ? resolveClass(obj, classes) : undefined;
  const controller =
    resolved?.type === "named" ? controllerOf(resolved.ingressClass) : resolved?.type === "default" ? controllerOf(resolved.ingressClass) : undefined;
  const selector = controller ? controllerSelector(controller) : undefined;
  const controllerSpecs = selector && served.pod ? [spec(served.pod, null, selector)] : [];
  const [controllerState] = useSharedWatches(clusterId, controllerSpecs);

  const netpol = useNetpolData(clusterId, namespaces, { pods: true });
  const grantsIn = useGrants(clusterId, which === "route" ? namespaces.filter((n) => n !== namespace) : []);
  const certificates = useCertificates(clusterId, which === "ingress" ? obj : null);

  const view = useMemo((): ClusterView => {
    const entries = plan.map((p, i) => ({ ...p, state: firstStates[i] }));
    const listOf = (role: Role, ns: string): KubeObject[] | undefined => {
      const e = entries.find((x) => x.role === role && x.namespace === ns);
      return e && readable(e.state, ns) ? [...e.state!.items.values()].filter((o) => o.metadata?.namespace === ns) : undefined;
    };
    return {
      now,
      services: (ns) => listOf("services", ns),
      endpointSlices: (ns) => listOf("slices", ns),
      pods: (ns) => netpol.pods(ns),
      world: netpol.loading ? undefined : netpol.world,
      ingressClasses: served.ingressClass === null ? null : classes,
      controllerPods: (c) => {
        const sel = controllerSelector(c);
        if (!sel) return null;
        if (c !== controller || !readable(controllerState, null)) return undefined;
        return { selector: sel, pods: [...controllerState!.items.values()].filter((p) => !isFinished(p)) };
      },
      certificates: (ns, secret) => certificates.get(`${ns}/${secret}`),
      gateways: (ns) => (served.gateway === null ? null : listOf("gateways", ns)),
      grants: grantsIn,
    };
  }, [now, firstStates, controllerState, netpol, certificates, classes, controller, grantsIn]);

  const loading =
    discovering ||
    rootState?.status === "loading" ||
    firstStates.some((s) => s.status === "loading") ||
    controllerState?.status === "loading" ||
    netpol.loading ||
    certificates.pending;
  return { obj, view, loading };
}

interface Certificates {
  get(key: string): CertificateState | undefined;
  /** A read has not answered yet. */
  pending: boolean;
}

/** The certificates of an Ingress's TLS Secrets (`namespace/name` → state), read again when the Ingress changes. */
function useCertificates(clusterId: ClusterId, ingress: KubeObject | null): Certificates {
  const namespace = ingress?.metadata?.namespace ?? "";
  const secrets = ingress
    ? [...new Set(tlsEntries(ingress).flatMap((e) => (e.secretName ? [e.secretName] : [])))].slice(0, MAX_SECRETS)
    : [];
  const key = JSON.stringify([clusterId, namespace, secrets, ingress?.metadata?.resourceVersion ?? ""]);
  const [loaded, setLoaded] = useState<{ key: string; states: Map<string, CertificateState> } | null>(null);
  useEffect(() => {
    if (secrets.length === 0) return;
    let cancelled = false;
    void Promise.all(
      secrets.map((secret) =>
        api.tls.certificateInfo(clusterId, namespace, secret).then(
          (info): CertificateState => ({ state: "ready", info }),
          (err: unknown): CertificateState => {
            const code = toApiError(err).code;
            return code === "notFound" ? { state: "notFound" } : { state: "error", code };
          },
        ),
      ),
    ).then((states) => {
      if (!cancelled) setLoaded({ key, states: new Map(secrets.map((s, i) => [`${namespace}/${s}`, states[i]!])) });
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for the cluster, the namespace, the Secrets and the Ingress's version.
  }, [key]);
  const current = loaded?.key === key ? loaded.states : undefined;
  return useMemo(
    () => ({ get: (k: string) => current?.get(k), pending: secrets.length > 0 && !current }),
    [current, secrets.length],
  );
}
