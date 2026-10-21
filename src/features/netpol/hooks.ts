// The live objects the connectivity views reason over, bounded to what a question involves: the Namespaces (their
// labels), and for each namespace in view its pods and policies (NetworkPolicies, and Cilium / Calico policies when
// the cluster serves them), Services only where asked, cluster-wide policies of the kinds the cluster serves, and the
// cluster DNS pods (`k8s-app=kube-dns` in kube-system) for the DNS check. Every list is a shared watch
// (`resource-map/watches.ts`), per (kind, namespace) as the resource map opens them, so the map, the "Related" tab and
// these views list a namespace once; all of them close when the view unmounts. Nothing is watched before discovery.
//
// For an AI agent's answer (`NetpolOptions.scope`, ADR-0094) nothing is watched beyond what the agent may read: a
// policy list of a kind in a namespace (or cluster-wide) it may not read is never opened and counts as unreadable, so
// whatever it could decide is "unknown"; pods, Services, the DNS pods and the Namespaces it may not read are not listed.
import { useMemo, useRef } from "react";
import type { ClusterId, KindRef, KubeObject, WatchSpec, WatchState } from "../../api";
import { findKind, status, useClusterKinds } from "../../resources";
import { useSharedWatches } from "../resource-map/watches";
import { calicoPolicy } from "./calico";
import { ciliumPolicies, isCiliumHostPolicy } from "./cilium";
import { DNS_LABELS, DNS_NAMESPACE, type Unreadable, type World } from "./engine";
import { kubernetesPolicy } from "./kubernetes";
import { isFinished, namespaceLabels, podInfo, type Labels, type PodInfo, type Policy } from "./model";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const POD = k("", "v1", "Pod");
export const SERVICE = k("", "v1", "Service");
export const NAMESPACE = k("", "v1", "Namespace");
export const NETWORK_POLICY = k("networking.k8s.io", "v1", "NetworkPolicy");
export const CILIUM_POLICY = k("cilium.io", "v2", "CiliumNetworkPolicy");
export const CILIUM_CLUSTERWIDE = k("cilium.io", "v2", "CiliumClusterwideNetworkPolicy");
export const CALICO_POLICY = k("projectcalico.org", "v3", "NetworkPolicy");
export const CALICO_GLOBAL = k("projectcalico.org", "v3", "GlobalNetworkPolicy");
export const CALICO_CRD_POLICY = k("crd.projectcalico.org", "v1", "NetworkPolicy");
export const CALICO_CRD_GLOBAL = k("crd.projectcalico.org", "v1", "GlobalNetworkPolicy");
export const ADMIN_POLICY = k("policy.networking.k8s.io", "v1alpha1", "AdminNetworkPolicy");
export const BASELINE_POLICY = k("policy.networking.k8s.io", "v1alpha1", "BaselineAdminNetworkPolicy");

/**
 * Policy kinds of other network plugins and APIs that can allow or deny pod traffic and that the engine does not
 * evaluate: any object of a served one makes the traffic it could select "unknown" (a namespaced object: traffic of
 * pods in its namespace; a cluster-wide one: all traffic). Calico's staged policies are left out: they do not enforce.
 */
export const UNEVALUATED_KINDS: readonly KindRef[] = [
  ADMIN_POLICY,
  BASELINE_POLICY,
  k("policy.networking.k8s.io", "v1alpha2", "ClusterNetworkPolicy"),
  k("crd.antrea.io", "v1beta1", "NetworkPolicy"),
  k("crd.antrea.io", "v1beta1", "ClusterNetworkPolicy"),
  k("k8s.ovn.org", "v1", "EgressFirewall"),
  k("k8s.ovn.org", "v1", "AdminPolicyBasedExternalRoute"),
  k("networking.gke.io", "v1alpha3", "FQDNNetworkPolicy"),
];

/** How a policy kind is named in a reason: the group tells apart kinds of the same name (Antrea's NetworkPolicy). */
export const kindLabel = (kind: KindRef) =>
  kind.group === NETWORK_POLICY.group || kind.group === "cilium.io" || kind.group === "policy.networking.k8s.io"
    ? kind.kind
    : `${kind.kind} (${kind.group})`;

/** The kinds whose details get the plain-words policy section. */
export const POLICY_KINDS: readonly KindRef[] = [
  NETWORK_POLICY,
  CILIUM_POLICY,
  CILIUM_CLUSTERWIDE,
  CALICO_POLICY,
  CALICO_GLOBAL,
  CALICO_CRD_POLICY,
  CALICO_CRD_GLOBAL,
];

export const isPolicyKind = (kind: Pick<KindRef, "group" | "kind">) =>
  POLICY_KINDS.some((p) => p.group === kind.group && p.kind === kind.kind);

/** The engine's policies of one object of a policy kind (none for a kind it does not know). */
export function policiesOf(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Policy[] {
  if (kind.group === NETWORK_POLICY.group && kind.kind === NETWORK_POLICY.kind) return [kubernetesPolicy(obj)];
  if (kind.group === "cilium.io") return ciliumPolicies(obj, kind.kind === CILIUM_CLUSTERWIDE.kind);
  if (kind.group === "projectcalico.org" || kind.group === "crd.projectcalico.org") {
    const p = calicoPolicy(obj, kind.kind === "GlobalNetworkPolicy");
    return p ? [p] : [];
  }
  return [];
}

/** A host policy (coverage of hostNetwork pods): a Cilium policy with `nodeSelector`, any Calico GlobalNetworkPolicy. */
export function isHostPolicy(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): boolean {
  if (kind.group === "cilium.io") return isCiliumHostPolicy(obj);
  return (kind.group === "projectcalico.org" || kind.group === "crd.projectcalico.org") && kind.kind === "GlobalNetworkPolicy";
}

type Kinds = ReturnType<typeof useClusterKinds>;

/** The served version of an optional kind: `null` not served (or discovery failed), `undefined` while discovering. */
function optional(kinds: Kinds, ref: KindRef): KindRef | null | undefined {
  if (kinds.kinds) return findKind(kinds.kinds, ref)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

/** A built-in kind: the served version, the registered one when discovery failed. */
function builtIn(kinds: Kinds, ref: KindRef): KindRef | null | undefined {
  if (kinds.kinds) return findKind(kinds.kinds, ref)?.kindRef ?? null;
  return kinds.error ? ref : undefined;
}

export interface ServedPolicyKinds {
  networkPolicy: KindRef | null;
  cilium: KindRef | null;
  ciliumClusterwide: KindRef | null;
  calico: KindRef | null;
  calicoGlobal: KindRef | null;
  /** Served kinds the engine does not evaluate (`UNEVALUATED_KINDS`), with their scope. */
  unevaluated: { kind: KindRef; namespaced: boolean }[];
  /** Discovery failed: which optional policy kinds exist is unknown, so every verdict is "unknown". */
  discoveryFailed: boolean;
}

/** The policy kinds the cluster serves; `undefined` while discovery is coming. Calico's API server wins over its CRDs. */
export function servedPolicyKinds(kinds: Kinds): ServedPolicyKinds | undefined {
  const all = [NETWORK_POLICY, CILIUM_POLICY, CILIUM_CLUSTERWIDE, CALICO_POLICY, CALICO_GLOBAL, CALICO_CRD_POLICY, CALICO_CRD_GLOBAL];
  const resolved = all.map((ref, i) => (i === 0 ? builtIn(kinds, ref) : optional(kinds, ref)));
  if (resolved.some((r) => r === undefined)) return undefined;
  const [np, cnp, ccnp, cal, calG, crd, crdG] = resolved as (KindRef | null)[];
  const unevaluated = UNEVALUATED_KINDS.flatMap((ref) => {
    const found = findKind(kinds.kinds, ref);
    return found ? [{ kind: found.kindRef, namespaced: found.namespaced }] : [];
  });
  return {
    networkPolicy: np ?? null,
    cilium: cnp ?? null,
    ciliumClusterwide: ccnp ?? null,
    calico: cal ?? crd ?? null,
    calicoGlobal: calG ?? crdG ?? null,
    unevaluated,
    discoveryFailed: !kinds.kinds,
  };
}

const spec = (kind: KindRef, namespaces: string[] | null, labelSelector: string | null = null): WatchSpec => ({
  kind,
  namespaces,
  labelSelector,
  fieldSelector: null,
});

export interface NetpolOptions {
  /** Namespaces whose Services are listed. */
  services?: readonly string[];
  /** List the cluster DNS pods (for the DNS check). */
  dns?: boolean;
  /** List the pods of the namespaces in view (default); a pod's own isolation needs only the policies. */
  pods?: boolean;
  /** For an AI agent: only lists it may read are watched; the rest are unreadable (policies) or not listed. */
  scope?: NetpolScope;
}

/** What an AI agent may read (`null` namespace: in every namespace, or a cluster-wide kind). */
export interface NetpolScope {
  may(kind: Pick<KindRef, "group" | "kind">, namespace: string | null): boolean;
}

export interface NetpolData {
  /** Discovery or a list has not come yet. */
  loading: boolean;
  world: World;
  /** Names of every namespace; `null` when Namespaces cannot be listed. */
  namespaces: string[] | null;
  /** Running pods of a namespace in view (finished ones take no traffic); `undefined` when not listed. */
  pods(namespace: string): KubeObject[] | undefined;
  services(namespace: string): KubeObject[] | undefined;
  /** The cluster DNS pods (`[]` when none could be read). */
  dnsPods: PodInfo[];
  /** The policy kinds served, once discovery came. */
  served: ServedPolicyKinds | undefined;
}

interface Planned {
  spec: WatchSpec;
  role: "namespaces" | "pods" | "services" | "dns" | "policies";
  namespace: string | null;
  /** Policy lists: the kind as shown when unreadable. */
  policyKind?: KindRef;
  /** A kind the engine does not evaluate: its objects make the verdict unknown. */
  unevaluated?: boolean;
}

const unique = (list: readonly string[]) => [...new Set(list.filter(Boolean))].sort();

function readable(state: WatchState, namespace: string | null): boolean {
  if (state.status !== "ready") return false;
  return namespace === null || !(state.forbidden ?? []).includes(namespace);
}

function itemsIn(state: WatchState, namespace: string | null): KubeObject[] {
  const all = [...state.items.values()];
  return namespace === null ? all : all.filter((o) => o.metadata?.namespace === namespace);
}

export function useNetpolData(clusterId: ClusterId, namespacesInView: readonly string[], options: NetpolOptions = {}): NetpolData {
  const kinds = useClusterKinds(clusterId);
  const served = servedPolicyKinds(kinds);
  const pod = builtIn(kinds, POD);
  const svc = builtIn(kinds, SERVICE);
  const ns = builtIn(kinds, NAMESPACE);
  const inView = unique(namespacesInView);
  const serviceNs = unique(options.services ?? []);
  const dnsListed = options.dns === true && (options.pods === false || !inView.includes(DNS_NAMESPACE));
  const scope = options.scope;
  const may = (kind: KindRef, namespace: string | null) => !scope || scope.may(kind, namespace);

  const plan: Planned[] = [];
  // Policy lists an agent may not read: never watched, unreadable to the engine.
  const withheld: Unreadable[] = [];
  const policies = (kind: KindRef, namespace: string | null, unevaluated?: boolean) => {
    if (!may(kind, namespace)) withheld.push({ kind: kindLabel(kind), namespace });
    else plan.push({ spec: spec(kind, namespace === null ? null : [namespace]), role: "policies", namespace, policyKind: kind, unevaluated });
  };
  if (served && pod !== undefined && svc !== undefined && ns !== undefined) {
    if (ns && may(ns, null)) plan.push({ spec: spec(ns, null), role: "namespaces", namespace: null });
    for (const namespace of inView) {
      if (pod && options.pods !== false && may(pod, namespace)) plan.push({ spec: spec(pod, [namespace]), role: "pods", namespace });
      for (const kind of [served.networkPolicy, served.cilium, served.calico]) if (kind) policies(kind, namespace);
      for (const { kind } of served.unevaluated.filter((u) => u.namespaced)) policies(kind, namespace, true);
    }
    for (const namespace of serviceNs) if (svc && may(svc, namespace)) plan.push({ spec: spec(svc, [namespace]), role: "services", namespace });
    if (dnsListed && pod && may(pod, DNS_NAMESPACE)) {
      plan.push({ spec: spec(pod, [DNS_NAMESPACE], Object.entries(DNS_LABELS).map(([a, b]) => `${a}=${b}`).join(",")), role: "dns", namespace: DNS_NAMESPACE });
    }
    for (const kind of [served.ciliumClusterwide, served.calicoGlobal]) if (kind) policies(kind, null);
    for (const { kind } of served.unevaluated.filter((u) => !u.namespaced)) policies(kind, null, true);
  }
  const states = useSharedWatches(clusterId, plan.map((p) => p.spec));
  const statusKey = states.map((s) => `${s.status}:${(s.forbidden ?? []).join(",")}`).join("|");
  const items = useStable(states.map((s) => s.items));
  const planKey = JSON.stringify([plan.map((p) => p.spec), withheld]);
  const servedKey = JSON.stringify(served ?? null);

  return useMemo((): NetpolData => {
    const entries = plan.map((p, i) => ({ ...p, state: states[i]! }));
    const nsEntry = entries.find((e) => e.role === "namespaces");
    const nsLabels = new Map<string, Labels>();
    const nsReadable = nsEntry ? readable(nsEntry.state, null) : false;
    if (nsEntry && nsReadable) for (const o of nsEntry.state.items.values()) nsLabels.set(o.metadata?.name ?? "", namespaceLabels(o));

    const policies: Policy[] = [];
    const unreadable: Unreadable[] = [...withheld];
    const unevaluated: NonNullable<World["unevaluated"]>[number][] = [];
    const hostPolicies: NonNullable<World["hostPolicies"]>[number][] = [];
    // Without discovery the Cilium, Calico and other plugins' policy kinds cannot be known: nothing is "allowed".
    if (served?.discoveryFailed) {
      for (const kind of [CILIUM_POLICY, CALICO_POLICY, ...UNEVALUATED_KINDS]) unreadable.push({ kind: kindLabel(kind), namespace: null });
    }
    for (const e of entries) {
      if (e.role !== "policies" || !e.policyKind) continue;
      if (!readable(e.state, e.namespace)) {
        unreadable.push({ kind: kindLabel(e.policyKind), namespace: e.namespace });
        continue;
      }
      const items = itemsIn(e.state, e.namespace);
      if (e.unevaluated) {
        for (const o of items) {
          unevaluated.push({ kind: kindLabel(e.policyKind), name: o.metadata?.name ?? "", namespace: o.metadata?.namespace ?? null });
        }
        continue;
      }
      for (const o of items) {
        policies.push(...policiesOf(e.policyKind, o));
        if (isHostPolicy(e.policyKind, o)) hostPolicies.push({ kind: kindLabel(e.policyKind), name: o.metadata?.name ?? "" });
      }
    }
    // Policies of namespaces out of view are not listed: a side in such a namespace is unknown.
    const world: World = {
      policies,
      unreadable,
      unevaluated,
      hostPolicies,
      namespaceLabels: (name) => (nsReadable ? (nsLabels.get(name) ?? { "kubernetes.io/metadata.name": name }) : undefined),
    };
    const listOf = (role: Planned["role"], namespace: string) => {
      const e = entries.find((x) => x.role === role && x.namespace === namespace);
      return e && readable(e.state, namespace) ? itemsIn(e.state, namespace) : undefined;
    };
    const dnsEntry = entries.find((e) => e.role === "dns");
    const dnsObjects = dnsEntry
      ? readable(dnsEntry.state, DNS_NAMESPACE)
        ? [...dnsEntry.state.items.values()]
        : []
      : (listOf("pods", DNS_NAMESPACE) ?? []).filter((o) =>
          Object.entries(DNS_LABELS).every(([a, b]) => status.labelsOf(o)[a] === b),
        );
    return {
      loading: !served || entries.some((e) => e.state.status === "loading"),
      world,
      namespaces: nsReadable ? [...nsLabels.keys()].sort() : null,
      pods: (namespace) => listOf("pods", namespace)?.filter((o) => !isFinished(o)),
      services: (namespace) => listOf("services", namespace),
      dnsPods: dnsObjects.filter((o) => !isFinished(o)).map(podInfo),
      served,
    };
    // `statusKey` and `items` stand for the states by value, `planKey` for the plan and the withheld lists.
  }, [statusKey, items, planKey, servedKey]);
}

/** Keeps the previous array while every element is the same object, so a memo keyed on it holds. */
function useStable<T>(values: readonly T[]): readonly T[] {
  const ref = useRef<readonly T[]>(values);
  const prev = ref.current;
  if (prev.length !== values.length || prev.some((v, i) => v !== values[i])) ref.current = values;
  return ref.current;
}

/** Whether the world holds every policy list a pod of `namespace` needs. */
export function coversNamespace(world: World, namespace: string): boolean {
  return !world.unreadable.some((u) => u.namespace === null || u.namespace === namespace);
}
