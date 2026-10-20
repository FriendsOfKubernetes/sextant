// The "Service mesh" problems for an agent (`get_problems`, ADR-0094): Istio's mistakes are judged across objects
// (a VirtualService's subset in another namespace's DestinationRule, a host against every namespace's ServiceEntries,
// a conflict with another namespace's VirtualService), so the window's shared configuration (`mesh/store.ts`) would
// tell about namespaces the agent may not read. Here the same engine (`meshProblems`) runs on what the agent may read
// only: each Istio kind is watched in every namespace when the agent may read them all, else only in the namespaces of
// its rules, and a finding is kept only when everything it rests on (`MeshProblem.needs`) was read — anything else is
// unknown, so no finding (and no sign that something exists) comes from a namespace the agent may not read.
import type { ClusterId, KindRef, KubeObject, ReadRule, ResourceKind, WatchSpec, WatchState } from "../../api";
import { findKind } from "../../resources";
import { allDestinations, parseDestinationRule, parseIstioGateway, parseServiceEntry, parseVirtualService, serviceOfHost } from "../mesh/istio";
import { DESTINATION_RULE, ISTIO_GATEWAY, PEER_AUTHENTICATION, SERVICE_ENTRY, VIRTUAL_SERVICE } from "../mesh/kinds";
import { parsePeerAuthentication } from "../mesh/mtls";
import { meshProblems, type MeshNeed, type MeshProblem } from "../mesh/problems";
import { MAX_SERVICE_NAMESPACES } from "../mesh/store";
import { useSharedWatches } from "../resource-map/watches";
import { canRead, watchedNamespaces, type ListRef } from "./scope";

/** The Istio kinds the mesh findings are judged from, in this order. */
export const MESH_KINDS = [VIRTUAL_SERVICE, DESTINATION_RULE, ISTIO_GATEWAY, SERVICE_ENTRY, PEER_AUTHENTICATION] as const;
const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };

const same = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) => a.group === b.group && a.kind === b.kind;

/** One kind as read for the agent. */
export interface MeshList {
  kind: Pick<KindRef, "group" | "kind">;
  /** The cluster serves the kind (an unserved one is known to be empty everywhere). */
  served: boolean;
  items: readonly KubeObject[];
  /** Whether the list was read in `namespace` (`null`: in every namespace). */
  known: (namespace: string | null) => boolean;
}

/** Whether a watch read `namespace` in full: it covers it (`namespaces` `null`: all of them) and has listed it. */
export function coveredBy(state: WatchState | undefined, namespaces: readonly string[] | null, namespace: string | null): boolean {
  if (!state || state.status !== "ready") return false;
  const forbidden = state.forbidden ?? [];
  if (namespaces === null) return namespace === null ? forbidden.length === 0 : !forbidden.includes(namespace);
  return namespace !== null && namespaces.includes(namespace) && !forbidden.includes(namespace);
}

/**
 * The mesh findings from `lists` (one per `MESH_KINDS`) and the Services read (`services`): only those whose every
 * need was read.
 */
export function agentMeshProblems(lists: readonly MeshList[], services: MeshList): MeshProblem[] {
  const [vs, dr, gw, se, pa] = lists;
  const names = new Set(services.items.map((s) => `${s.metadata?.namespace ?? ""}/${s.metadata?.name ?? ""}`));
  const found = meshProblems({
    virtualServices: (vs?.items ?? []).map(parseVirtualService),
    destinationRules: (dr?.items ?? []).map(parseDestinationRule),
    // Not served: nothing to judge a gateway against (as on the screen).
    gateways: gw?.served ? gw.items.map(parseIstioGateway) : undefined,
    serviceEntries: (se?.items ?? []).map(parseServiceEntry),
    peerAuthentications: (pa?.items ?? []).map(parsePeerAuthentication),
    serviceExists: (namespace, name) => (services.known(namespace) ? names.has(`${namespace}/${name}`) : undefined),
  });
  const known = (need: MeshNeed): boolean => {
    if (same(need.kind, SERVICE)) return services.known(need.namespace);
    const list = lists.find((l) => same(l.kind, need.kind));
    return !!list && list.known(need.namespace);
  };
  return found.filter((p) => p.needs.every(known));
}

/** What a mesh finding rests on, as the backend checks it again. */
export const meshRefs = (p: MeshProblem): ListRef[] =>
  p.needs.map((n) => ({ group: n.kind.group, kind: n.kind.kind, namespace: n.namespace, ...(n.name ? { name: n.name } : {}) }));

/** The namespaces whose Services the findings need: of the VirtualServices and DestinationRules, and the hosts they name. */
function serviceNamespaces(virtualServices: readonly KubeObject[], rules: readonly KubeObject[]): string[] {
  const out = new Set<string>();
  for (const obj of virtualServices) {
    const v = parseVirtualService(obj);
    out.add(v.namespace);
    for (const d of allDestinations(v)) {
      const s = serviceOfHost(d.fqdn);
      if (s) out.add(s.namespace);
    }
  }
  for (const obj of rules) {
    const s = serviceOfHost(parseDestinationRule(obj).fqdn);
    if (s) out.add(s.namespace);
  }
  return [...out].filter(Boolean).sort();
}

export interface AgentMesh {
  loading: boolean;
  /** The findings from what has been read (computed when called). */
  problems: () => MeshProblem[];
}

/** The mesh findings for an agent while `enabled`, from watches of only what it may read (shared with other views). */
export function useAgentMesh(
  clusterId: ClusterId,
  reads: readonly ReadRule[],
  kinds: ResourceKind[] | null | undefined,
  ruled: readonly string[],
  enabled: boolean,
): AgentMesh {
  const served = MESH_KINDS.map((k) => (kinds ? (findKind(kinds, k)?.kindRef ?? null) : undefined));
  const coverage = MESH_KINDS.map((k, i) => (served[i] ? watchedNamespaces(reads, k, null, ruled) : []));
  const plan = enabled && kinds !== undefined ? MESH_KINDS.map((_, i) => (served[i] && coverage[i]!.length !== 0 ? i : -1)).filter((i) => i >= 0) : [];
  const specs: WatchSpec[] = plan.map((i) => ({ kind: served[i]!, namespaces: coverage[i]!, labelSelector: null, fieldSelector: null }));
  const states = useSharedWatches(clusterId, specs);
  const stateOf = (i: number) => states[plan.indexOf(i)];
  const itemsOf = (i: number): KubeObject[] =>
    [...(stateOf(i)?.items.values() ?? [])].filter((o) => canRead(reads, MESH_KINDS[i]!, o.metadata?.namespace ?? null));

  const vsItems = plan.includes(0) ? itemsOf(0) : [];
  const drItems = plan.includes(1) ? itemsOf(1) : [];
  const serviceNs = enabled
    ? serviceNamespaces(vsItems, drItems).filter((ns) => canRead(reads, SERVICE, ns)).slice(0, MAX_SERVICE_NAMESPACES)
    : [];
  const serviceSpecs: WatchSpec[] =
    serviceNs.length > 0 ? [{ kind: SERVICE, namespaces: serviceNs, labelSelector: null, fieldSelector: null, metadataOnly: true }] : [];
  const [serviceState] = useSharedWatches(clusterId, serviceSpecs);

  const loading = enabled && (kinds === undefined || states.some((s) => s.status === "loading") || serviceState?.status === "loading");
  const problems = (): MeshProblem[] => {
    if (!enabled) return [];
    const lists: MeshList[] = MESH_KINDS.map((kind, i) => {
      if (!served[i]) return { kind, served: false, items: [], known: () => served[i] === null };
      const watched = plan.includes(i);
      return {
        kind,
        served: true,
        items: watched ? itemsOf(i) : [],
        known: (ns) => watched && coveredBy(stateOf(i), coverage[i]!, ns),
      };
    });
    const services: MeshList = {
      kind: SERVICE,
      served: true,
      items: [...(serviceState?.items.values() ?? [])],
      known: (ns) => serviceSpecs.length > 0 && coveredBy(serviceState, serviceNs, ns),
    };
    return agentMeshProblems(lists, services);
  };
  return { loading, problems };
}
