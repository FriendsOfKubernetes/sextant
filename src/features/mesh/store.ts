// The Istio configuration of a cluster, shared by the section counter, the problems provider, the details and the
// request check (#155): one watch per Istio kind the cluster serves (VirtualServices, DestinationRules, Gateways,
// ServiceEntries, Sidecars, PeerAuthentications, AuthorizationPolicies — few, small objects) in all namespaces, plus a
// metadata-only list of the Services in the namespaces those objects name (at most `MAX_SERVICE_NAMESPACES`; beyond it
// no host is judged missing). Kinds the cluster does not serve are never watched and nothing is watched before
// discovery. The watches are the shared ones of the resource map (`acquireWatch`), so a view listing the same kind
// reuses them; they are released `LINGER_MS` after the last user, and taken anew when the cluster reconnects.
import { useEffect, useSyncExternalStore } from "react";
import type { ClusterId, KindRef, KubeObject, WatchSpec, WatchState } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import { parseAuthorizationPolicy, type AuthzPolicy } from "./authz";
import {
  parseDestinationRule,
  parseIstioGateway,
  parseServiceEntry,
  parseVirtualService,
  serviceOfHost,
  allDestinations,
  type DestinationRuleInfo,
  type IstioGatewayInfo,
  type ServiceEntryInfo,
  type VirtualService,
} from "./istio";
import {
  AUTHORIZATION_POLICY,
  DESTINATION_RULE,
  ISTIO_GATEWAY,
  PEER_AUTHENTICATION,
  SERVICE_ENTRY,
  SIDECAR,
  VIRTUAL_SERVICE,
} from "./kinds";
import { parsePeerAuthentication, type PeerAuthInfo } from "./mtls";
import { meshProblems, type MeshProblem } from "./problems";

export const LINGER_MS = 5000;
export const MAX_SERVICE_NAMESPACES = 40;
const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };

/** The kinds watched, in a fixed order. */
export const WATCHED = [VIRTUAL_SERVICE, DESTINATION_RULE, ISTIO_GATEWAY, SERVICE_ENTRY, SIDECAR, PEER_AUTHENTICATION, AUTHORIZATION_POLICY];

export interface MeshConfig {
  /** Discovery or a list has not come yet. */
  loading: boolean;
  /** Whether the cluster serves VirtualServices or DestinationRules (Istio's traffic API). */
  istio: boolean;
  virtualServices: VirtualService[];
  destinationRules: DestinationRuleInfo[];
  gateways: IstioGatewayInfo[] | undefined;
  serviceEntries: ServiceEntryInfo[];
  sidecarNamespaces: Set<string>;
  peerAuthentications: PeerAuthInfo[];
  authorizationPolicies: AuthzPolicy[];
  /** `undefined`: the namespace's Services are not known. */
  serviceExists: (namespace: string, name: string) => boolean | undefined;
  problems: MeshProblem[];
}

interface Entry {
  clusterId: ClusterId;
  refs: number;
  linger?: ReturnType<typeof setTimeout>;
  held: Map<string, { spec: WatchSpec; release: () => void }>;
  epoch: number;
  /** The served version of each watched kind (`null`: not served), `undefined` before discovery. */
  served?: (KindRef | null)[];
  servicesSpec?: WatchSpec;
  config?: MeshConfig;
}

const entries = new Map<ClusterId, Entry>();
const listeners = new Set<() => void>();
let unsubscribeShared: (() => void) | undefined;
/** Uids of objects with mesh problems, per cluster (the "Only problems" filter). */
const problemUids = new Map<ClusterId, Set<string>>();

const everywhere = (kind: KindRef): WatchSpec => ({ kind, namespaces: null, labelSelector: null, fieldSelector: null });

/** Parses each watched object once: a watch hands out the same object until it changes. */
function cached<T>(parse: (obj: KubeObject) => T): (obj: KubeObject) => T {
  const memo = new WeakMap<KubeObject, T>();
  return (obj) => {
    let value = memo.get(obj);
    if (value === undefined) {
      value = parse(obj);
      memo.set(obj, value);
    }
    return value;
  };
}

const virtualServiceOf = cached(parseVirtualService);
const destinationRuleOf = cached(parseDestinationRule);
const gatewayOf = cached(parseIstioGateway);
const serviceEntryOf = cached(parseServiceEntry);
const peerAuthenticationOf = cached(parsePeerAuthentication);
const authorizationPolicyOf = cached(parseAuthorizationPolicy);

function notify(): void {
  for (const fn of [...listeners]) fn();
}

function onShared(): void {
  for (const entry of entries.values()) {
    entry.config = undefined;
    sync(entry);
  }
  notify();
}

/** The namespaces whose Services the problems need: of the objects, and of the Services they name. */
function serviceNamespaces(entry: Entry, served: (KindRef | null)[]): string[] {
  const out = new Set<string>();
  const [vsKind, drKind] = served;
  for (const obj of items(entry, vsKind)) {
    const vs = virtualServiceOf(obj);
    out.add(vs.namespace);
    for (const d of allDestinations(vs)) {
      const s = serviceOfHost(d.fqdn);
      if (s) out.add(s.namespace);
    }
  }
  for (const obj of items(entry, drKind)) {
    const s = serviceOfHost(destinationRuleOf(obj).fqdn);
    if (s) out.add(s.namespace);
  }
  return [...out].filter(Boolean).sort();
}

function items(entry: Entry, kind: KindRef | null | undefined): KubeObject[] {
  if (!kind) return [];
  return [...watchState(entry.clusterId, everywhere(kind)).items.values()];
}

/** Takes the watches the entry needs now and lets go of the others. */
function sync(entry: Entry): void {
  if (entry.refs === 0 && !entry.linger) return;
  if (entry.epoch !== epochOf(entry.clusterId)) {
    // The cluster reconnected: the shared watches were dropped; take them anew.
    for (const h of entry.held.values()) h.release();
    entry.held.clear();
    entry.epoch = epochOf(entry.clusterId);
  }
  const kinds = knownClusterKinds(entry.clusterId);
  entry.served = kinds ? WATCHED.map((k) => findKind(kinds, k)?.kindRef ?? null) : undefined;
  const wanted = new Map<string, WatchSpec>();
  for (const kind of entry.served ?? []) if (kind) wanted.set(specKey(entry.clusterId, everywhere(kind)), everywhere(kind));
  const namespaces = entry.served ? serviceNamespaces(entry, entry.served) : [];
  entry.servicesSpec =
    namespaces.length > 0 && namespaces.length <= MAX_SERVICE_NAMESPACES
      ? { kind: SERVICE, namespaces, labelSelector: null, fieldSelector: null, metadataOnly: true }
      : undefined;
  if (entry.servicesSpec) wanted.set(specKey(entry.clusterId, entry.servicesSpec), entry.servicesSpec);
  for (const [key, h] of [...entry.held]) {
    if (wanted.has(key)) continue;
    h.release();
    entry.held.delete(key);
  }
  for (const [key, spec] of wanted) {
    if (!entry.held.has(key)) entry.held.set(key, { spec, release: acquireWatch(entry.clusterId, spec) });
  }
}

function build(entry: Entry): MeshConfig {
  const served = entry.served;
  const states: (WatchState | undefined)[] = (served ?? []).map((k) => (k ? watchState(entry.clusterId, everywhere(k)) : undefined));
  const list = (i: number) => [...(states[i]?.items.values() ?? [])];
  const loading = !served || states.some((s) => s?.status === "loading");
  const services = entry.servicesSpec ? watchState(entry.clusterId, entry.servicesSpec) : undefined;
  const known = new Set(entry.servicesSpec?.namespaces ?? []);
  const names = new Set<string>();
  for (const s of services?.items.values() ?? []) names.add(`${s.metadata?.namespace ?? ""}/${s.metadata?.name ?? ""}`);
  const serviceExists = (namespace: string, name: string): boolean | undefined => {
    if (!services || services.status !== "ready" || !known.has(namespace) || services.forbidden?.includes(namespace)) return undefined;
    return names.has(`${namespace}/${name}`);
  };
  const config: MeshConfig = {
    loading,
    istio: !!served && (!!served[0] || !!served[1]),
    virtualServices: list(0).map(virtualServiceOf),
    destinationRules: list(1).map(destinationRuleOf),
    gateways: served?.[2] && states[2]?.status === "ready" ? list(2).map(gatewayOf) : undefined,
    serviceEntries: list(3).map(serviceEntryOf),
    sidecarNamespaces: new Set(list(4).map((o) => o.metadata?.namespace ?? "")),
    peerAuthentications: list(5).map(peerAuthenticationOf),
    authorizationPolicies: list(6).map(authorizationPolicyOf),
    serviceExists,
    problems: [],
  };
  config.problems = loading ? [] : meshProblems(config);
  problemUids.set(entry.clusterId, new Set(config.problems.map((p) => p.uid)));
  return config;
}

/** Holds the cluster's Istio configuration; returns the function that lets go of it. */
export function acquireMesh(clusterId: ClusterId): () => void {
  unsubscribeShared ??= subscribeSharedWatches(onShared);
  let entry = entries.get(clusterId);
  if (!entry) {
    entry = { clusterId, refs: 0, held: new Map(), epoch: epochOf(clusterId) };
    entries.set(clusterId, entry);
  }
  const held = entry;
  if (held.linger) {
    clearTimeout(held.linger);
    held.linger = undefined;
  }
  held.refs++;
  sync(held);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs--;
    if (held.refs > 0) return;
    held.linger = setTimeout(() => {
      held.linger = undefined;
      if (held.refs > 0 || entries.get(clusterId) !== held) return;
      for (const h of held.held.values()) h.release();
      entries.delete(clusterId);
      problemUids.delete(clusterId);
      notify();
    }, LINGER_MS);
  };
}

/** Looks again at what the cluster serves (discovery came or changed). */
export function refreshMesh(clusterId: ClusterId): void {
  const entry = entries.get(clusterId);
  if (!entry) return;
  entry.config = undefined;
  sync(entry);
  notify();
}

const EMPTY: MeshConfig = {
  loading: true,
  istio: false,
  virtualServices: [],
  destinationRules: [],
  gateways: undefined,
  serviceEntries: [],
  sidecarNamespaces: new Set(),
  peerAuthentications: [],
  authorizationPolicies: [],
  serviceExists: () => undefined,
  problems: [],
};

/** The configuration as known now (`loading` while not held or not listed). */
export function getMeshConfig(clusterId: ClusterId): MeshConfig {
  const entry = entries.get(clusterId);
  if (!entry) return EMPTY;
  entry.config ??= build(entry);
  return entry.config;
}

export function subscribeMesh(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether an object has a mesh problem in a cluster whose configuration is held. */
export function isMeshProblem(obj: KubeObject): boolean {
  const uid = obj.metadata?.uid;
  if (!uid) return false;
  for (const set of problemUids.values()) if (set.has(uid)) return true;
  return false;
}

/** The cluster's Istio configuration, held while mounted (`enabled` false holds nothing). */
export function useMeshConfig(clusterId: ClusterId, enabled = true): MeshConfig {
  const { kinds } = useClusterKinds(clusterId);
  useEffect(() => {
    if (!enabled) return;
    return acquireMesh(clusterId);
  }, [clusterId, enabled]);
  useEffect(() => {
    if (enabled) refreshMesh(clusterId);
  }, [clusterId, enabled, kinds]);
  const config = useSyncExternalStore(subscribeMesh, () => getMeshConfig(clusterId));
  return enabled ? config : EMPTY;
}

/** Forgets everything (tests). */
export function resetMeshStore(): void {
  for (const entry of entries.values()) {
    if (entry.linger) clearTimeout(entry.linger);
    for (const h of entry.held.values()) h.release();
  }
  entries.clear();
  problemUids.clear();
  unsubscribeShared?.();
  unsubscribeShared = undefined;
}
