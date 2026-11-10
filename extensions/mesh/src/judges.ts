// The problem judges (ADR-0168) the backend answers: the built-in Istio checks (`meshProblems`, ported unchanged into
// `engine/problems.ts`) run over the objects Sextant sends, each judge over the kinds its reasons need, so a kind a
// cluster cannot read stops only the reasons that rest on it (a kind the built-in took as empty where it was not served
// is an optional read). Each finding becomes a fact of its object, named by its reason (`unknown-host`, …) and given
// once per finding with the built-in message's values, in the built-in order; the manifest's rules (`each`) turn
// every fact into a problem with the built-in message.
//
//   hosts             VirtualServices, DestinationRules, ServiceEntries, Services → UnknownHost, MissingDestinationRule,
//                     MissingSubset (a Service's namespace is known only when the objects name at most 40 namespaces,
//                     as the built-in store watched them)
//   gateways          VirtualServices, Gateways → MissingGateway
//   virtual-services  VirtualServices → InvalidVirtualService, ConflictingVirtualService
//   tls               DestinationRules, PeerAuthentications → TlsConflict
//
// Pure: it runs in the backend's sandbox with no host call and no network, and in tests directly.
import type { KubeObject } from "@sextant/extension-sdk";
import { allDestinations, parseDestinationRule, parseIstioGateway, parseServiceEntry, parseVirtualService, serviceOfHost } from "./engine/istio";
import { parsePeerAuthentication } from "./engine/mtls";
import { meshProblems, type AnalysisInput, type MeshProblemReason } from "./engine/problems";

/** An object as a judge gets it (the SDK's `JudgedObject`). */
export interface JudgedInput {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string | null; uid: string; creationTimestamp?: string | null };
  values: Record<string, unknown>;
}

/** One fact of an answer (the SDK's `JudgedFact`). */
export interface JudgedOutput {
  uid: string;
  fact: string;
  values?: Record<string, string>;
}

/** As the built-in store: beyond this many namespaces no host is judged missing. */
export const MAX_SERVICE_NAMESPACES = 40;

/** The fields each read kind carries: the whole spec of the Istio kinds the engines parse; Services by name only. */
export const SPEC = ".spec";
export const NAME = ".metadata.name";

export type JudgeId = "hosts" | "gateways" | "virtual-services" | "tls";

/** What each judge reads and the reasons it tells, with the names of each reason's values. */
export const JUDGES: Record<JudgeId, { reads: { group: string; kind: string; path: string; optional?: boolean }[]; reasons: MeshProblemReason[] }> = {
  hosts: {
    reads: [
      { group: "networking.istio.io", kind: "VirtualService", path: SPEC },
      { group: "networking.istio.io", kind: "DestinationRule", path: SPEC, optional: true },
      { group: "networking.istio.io", kind: "ServiceEntry", path: SPEC, optional: true },
      { group: "", kind: "Service", path: NAME },
    ],
    reasons: ["UnknownHost", "MissingDestinationRule", "MissingSubset"],
  },
  gateways: {
    reads: [
      { group: "networking.istio.io", kind: "VirtualService", path: SPEC },
      { group: "networking.istio.io", kind: "Gateway", path: NAME },
    ],
    reasons: ["MissingGateway"],
  },
  "virtual-services": {
    reads: [{ group: "networking.istio.io", kind: "VirtualService", path: SPEC }],
    reasons: ["InvalidVirtualService", "ConflictingVirtualService"],
  },
  tls: {
    reads: [
      { group: "networking.istio.io", kind: "DestinationRule", path: SPEC },
      { group: "security.istio.io", kind: "PeerAuthentication", path: SPEC, optional: true },
    ],
    reasons: ["TlsConflict"],
  },
};

/** The values each reason's message shows (the built-in `params`). */
export const REASON_VALUES: Record<MeshProblemReason, string[]> = {
  UnknownHost: ["host"],
  MissingDestinationRule: ["host", "subset"],
  MissingSubset: ["host", "subset", "rule"],
  MissingGateway: ["gateway"],
  TlsConflict: ["host", "mode", "policy"],
  InvalidVirtualService: ["host"],
  ConflictingVirtualService: ["host", "gateway", "other"],
};

/** The fact of a reason: `UnknownHost` → `unknown-host`. */
export const factId = (reason: MeshProblemReason): string => reason.replace(/[A-Z]/g, (c, i: number) => `${i > 0 ? "-" : ""}${c.toLowerCase()}`);

/** An object the engines can parse: its identity and its spec. */
export function objectOf(o: JudgedInput): KubeObject {
  const metadata: KubeObject["metadata"] = { name: o.metadata.name, uid: o.metadata.uid };
  if (o.metadata.namespace) metadata.namespace = o.metadata.namespace;
  if (o.metadata.creationTimestamp) metadata.creationTimestamp = o.metadata.creationTimestamp;
  const spec = o.values[SPEC];
  return { apiVersion: o.apiVersion, kind: o.kind, metadata, ...(spec && typeof spec === "object" ? { spec: spec as Record<string, unknown> } : {}) };
}

/** The engines' input from the objects sent; kinds a judge does not read are empty (Gateways: not known). */
export function analysisInput(objects: readonly JudgedInput[]): AnalysisInput {
  const of = (kind: string, group: string) => objects.filter((o) => o.kind === kind && (o.apiVersion.split("/").length === 1 ? group === "" : o.apiVersion.startsWith(`${group}/`))).map(objectOf);
  const virtualServices = of("VirtualService", "networking.istio.io");
  const destinationRules = of("DestinationRule", "networking.istio.io");
  const gateways = of("Gateway", "networking.istio.io");
  const services = of("Service", "");
  // The namespaces whose Services the built-in store watched: of the objects, and of the Services they name.
  const namespaces = new Set<string>();
  for (const obj of virtualServices) {
    const vs = parseVirtualService(obj);
    namespaces.add(vs.namespace);
    for (const d of allDestinations(vs)) {
      const s = serviceOfHost(d.fqdn);
      if (s) namespaces.add(s.namespace);
    }
  }
  for (const obj of destinationRules) {
    const s = serviceOfHost(parseDestinationRule(obj).fqdn);
    if (s) namespaces.add(s.namespace);
  }
  namespaces.delete("");
  const known = namespaces.size <= MAX_SERVICE_NAMESPACES ? namespaces : new Set<string>();
  const names = new Set(services.map((s) => `${s.metadata.namespace ?? ""}/${s.metadata.name}`));
  return {
    virtualServices: virtualServices.map(parseVirtualService),
    destinationRules: destinationRules.map(parseDestinationRule),
    gateways: gateways.length > 0 || objects.some((o) => o.kind === "Gateway") ? gateways.map(parseIstioGateway) : undefined,
    serviceEntries: of("ServiceEntry", "networking.istio.io").map(parseServiceEntry),
    peerAuthentications: of("PeerAuthentication", "security.istio.io").map(parsePeerAuthentication),
    serviceExists: (namespace, name) => (known.has(namespace) ? names.has(`${namespace}/${name}`) : undefined),
  };
}

/** The facts of one judge over the objects sent. */
export function judge(id: JudgeId, objects: readonly JudgedInput[]): JudgedOutput[] {
  const { reasons } = JUDGES[id];
  const input = analysisInput(objects);
  // The gateways judge alone knows the Gateways (a read it needs): with none sent, there are none.
  if (id === "gateways") input.gateways ??= [];
  return meshProblems(input)
    .filter((p) => reasons.includes(p.reason))
    .map((p) => ({ uid: p.uid, fact: factId(p.reason), values: Object.fromEntries(REASON_VALUES[p.reason].map((name) => [name, p.params[name] ?? ""])) }));
}

export const JUDGE_IDS = Object.keys(JUDGES) as JudgeId[];
