// The Istio configuration of a cluster, as the built-in store held it (#155) for the problems of an object's details,
// a Gateway's bound VirtualServices, the mTLS and "who may call" blocks and the request check: one watch per Istio
// kind the cluster serves (VirtualServices, DestinationRules, Gateways, ServiceEntries, Sidecars, PeerAuthentications,
// AuthorizationPolicies — few, small objects) in all namespaces, plus a metadata-only watch of the Services in the
// namespaces those objects name (at most `MAX_SERVICE_NAMESPACES`; beyond it no host is judged missing). Kinds the
// cluster does not serve are never watched and nothing is watched before discovery. Sextant's extension watch hub
// shares each list with the other frames of the extension (ADR-0145), as the built-in shared its watches between views.
import { trackObjects, type KindRef, type KubeObject, type ResourceKind, type Sextant, type Watch, type WatchParams } from "@sextant/extension-sdk";
import { parseAuthorizationPolicy, type AuthzPolicy } from "./engine/authz";
import {
  allDestinations,
  parseDestinationRule,
  parseIstioGateway,
  parseServiceEntry,
  parseVirtualService,
  serviceOfHost,
  type DestinationRuleInfo,
  type IstioGatewayInfo,
  type ServiceEntryInfo,
  type VirtualService,
} from "./engine/istio";
import { AUTHORIZATION_POLICY, DESTINATION_RULE, ISTIO_GATEWAY, PEER_AUTHENTICATION, SERVICE_ENTRY, SIDECAR, VIRTUAL_SERVICE, sameKind } from "./engine/kinds";
import { parsePeerAuthentication, type PeerAuthInfo } from "./engine/mtls";
import { meshProblems, type MeshProblem } from "./engine/problems";

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

export const EMPTY_CONFIG: MeshConfig = {
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

/** A list as the built-in shared watch kept it: loading, ready with its objects, or failed (no objects). */
export interface ListState {
  status: "loading" | "ready" | "error";
  items: KubeObject[];
  /** Namespaces the list may not read. */
  forbidden: string[];
}

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

/** The served version of `kind` (any version), from discovery. */
export function servedKind(kinds: readonly ResourceKind[] | undefined, kind: Pick<KindRef, "group" | "kind">): KindRef | null {
  return kinds?.find((k) => sameKind(k.kindRef, kind))?.kindRef ?? null;
}

/**
 * Lists watched by what they watch: each drawing asks for the lists it needs between `begin` and `end` (a list starts
 * when first asked for), and `end` stops the lists it did not ask for.
 */
export class Lists {
  private readonly open = new Map<string, { watch: Watch; state: ListState }>();
  private wanted = new Set<string>();

  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  begin(): void {
    this.wanted = new Set();
  }

  get(spec: Omit<WatchParams, "clusterId">): ListState {
    const key = JSON.stringify(spec);
    this.wanted.add(key);
    return (this.open.get(key) ?? this.start(key, spec)).state;
  }

  end(): void {
    for (const [key, entry] of this.open) {
      if (this.wanted.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
  }

  stop(): void {
    this.begin();
    this.end();
  }

  private start(key: string, spec: Omit<WatchParams, "clusterId">): { watch: Watch; state: ListState } {
    const state: ListState = { status: "loading", items: [], forbidden: [] };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          state.items = items;
          state.status = "ready";
          this.changed();
        },
        (other) => {
          if (other.type === "error") {
            state.status = "error";
            state.items = [];
          } else if (other.type === "forbidden") state.forbidden = [...other.namespaces];
          else return;
          this.changed();
        },
      ),
      onError: () => {
        state.status = "error";
        state.items = [];
        this.changed();
      },
    });
    watch.started.catch(() => undefined);
    const entry = { watch, state };
    this.open.set(key, entry);
    return entry;
  }
}

const everywhere = (kind: KindRef): Omit<WatchParams, "clusterId"> => ({ kind: { group: kind.group, version: kind.version, kind: kind.kind } });

/** The namespaces whose Services the problems need: of the objects, and of the Services they name. */
function serviceNamespaces(virtualServices: readonly KubeObject[], destinationRules: readonly KubeObject[]): string[] {
  const out = new Set<string>();
  for (const obj of virtualServices) {
    const vs = virtualServiceOf(obj);
    out.add(vs.namespace);
    for (const d of allDestinations(vs)) {
      const s = serviceOfHost(d.fqdn);
      if (s) out.add(s.namespace);
    }
  }
  for (const obj of destinationRules) {
    const s = serviceOfHost(destinationRuleOf(obj).fqdn);
    if (s) out.add(s.namespace);
  }
  return [...out].filter(Boolean).sort();
}

/**
 * The cluster's Istio configuration from `lists` (asked for now, so a drawing holds them): `kinds` is discovery's
 * answer (`undefined` before it comes).
 */
export function meshConfig(lists: Lists, kinds: readonly ResourceKind[] | undefined): MeshConfig {
  if (!kinds) return EMPTY_CONFIG;
  const served = WATCHED.map((k) => servedKind(kinds, k));
  const states = served.map((k) => (k ? lists.get(everywhere(k)) : undefined));
  const list = (i: number) => states[i]?.items ?? [];
  const namespaces = serviceNamespaces(list(0), list(1));
  const servicesSpec =
    namespaces.length > 0 && namespaces.length <= MAX_SERVICE_NAMESPACES
      ? { kind: { group: "", version: "v1", kind: SERVICE.kind }, namespaces, metadataOnly: true }
      : undefined;
  const services = servicesSpec ? lists.get(servicesSpec) : undefined;
  const loading = states.some((s) => s?.status === "loading");
  const known = new Set(servicesSpec?.namespaces ?? []);
  const names = new Set<string>();
  for (const s of services?.items ?? []) names.add(`${s.metadata.namespace ?? ""}/${s.metadata.name}`);
  const serviceExists = (namespace: string, name: string): boolean | undefined => {
    if (!services || services.status !== "ready" || !known.has(namespace) || services.forbidden.includes(namespace)) return undefined;
    return names.has(`${namespace}/${name}`);
  };
  const config: MeshConfig = {
    loading,
    istio: !!served[0] || !!served[1],
    virtualServices: list(0).map(virtualServiceOf),
    destinationRules: list(1).map(destinationRuleOf),
    gateways: served[2] && states[2]?.status === "ready" ? list(2).map(gatewayOf) : undefined,
    serviceEntries: list(3).map(serviceEntryOf),
    sidecarNamespaces: new Set(list(4).map((o) => o.metadata.namespace ?? "")),
    peerAuthentications: list(5).map(peerAuthenticationOf),
    authorizationPolicies: list(6).map(authorizationPolicyOf),
    serviceExists,
    problems: [],
  };
  config.problems = loading ? [] : meshProblems(config);
  return config;
}

/** What the cluster serves, asked once per frame (discovery), and told to `changed` when it comes. */
export class Discovery {
  kinds: ResourceKind[] | undefined;
  private asked = false;

  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The answer, asking for it the first time; `undefined` until it comes (or when it fails). */
  get(): ResourceKind[] | undefined {
    if (!this.asked) {
      this.asked = true;
      this.sextant.kinds().then(
        (kinds) => {
          this.kinds = kinds;
          this.changed();
        },
        () => undefined,
      );
    }
    return this.kinds;
  }

  served(kind: Pick<KindRef, "group" | "kind">): boolean {
    return servedKind(this.kinds, kind) !== null;
  }
}
