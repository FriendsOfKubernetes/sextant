// Istio configuration mistakes found across objects (#155), the kind `istioctl analyze` reports. Pure:
//   UnknownHost                a destination names a Service that does not exist and no ServiceEntry covers it
//                              (only judged where the Service's namespace is known);
//   MissingDestinationRule     a destination names a subset but no DestinationRule covers its host;
//   MissingSubset              the DestinationRule of the host has no subset of that name;
//   MissingGateway             a VirtualService is bound to an Istio Gateway that does not exist;
//   TlsConflict                a DestinationRule sets a TLS mode other than ISTIO_MUTUAL toward workloads whose
//                              PeerAuthentication is STRICT (they refuse anything but Istio mTLS);
//   InvalidVirtualService      the host `*` on a VirtualService bound to the sidecars: Istio rejects it (it routes
//                              nothing), so its routes are not judged further;
//   ConflictingVirtualService  two VirtualServices for the same host on the sidecars (`mesh`: Istio uses only the
//                              oldest), or on one Gateway where an older one ends in a catch-all route that leaves
//                              the newer one's routes unreachable.
// A DestinationRule is looked up as a client in the VirtualService's namespace would (client, Service, root).
//
// Each finding also says what it rests on (`needs`): the lists it was judged against — in a namespace, or in all of
// them — and the objects its words name. A view for someone who may not read all of them (an AI agent, ADR-0094)
// leaves the finding out, so it says nothing about namespaces that someone may not read.
import type { KindRef } from "../../api";
import { allDestinations, MESH_GATEWAY, meshWildcardInvalid, olderFirst, ROOT_NAMESPACE, serviceOfHost, type DestinationRuleInfo, type IstioGatewayInfo, type Ref, type ServiceEntryInfo, type VirtualService } from "./istio";
import { DESTINATION_RULE, ISTIO_GATEWAY, PEER_AUTHENTICATION, SERVICE_ENTRY, VIRTUAL_SERVICE } from "./kinds";
import { mtlsModeFor, type PeerAuthInfo } from "./mtls";
import { resolveDestination } from "./routing";

export type MeshProblemReason =
  | "UnknownHost"
  | "MissingDestinationRule"
  | "MissingSubset"
  | "MissingGateway"
  | "TlsConflict"
  | "InvalidVirtualService"
  | "ConflictingVirtualService";

/** A list a finding was judged against (`namespace` `null`: in every namespace), or one object of it (`name`). */
export interface MeshNeed {
  kind: Pick<KindRef, "group" | "kind">;
  namespace: string | null;
  name?: string;
}

export interface MeshProblem {
  ref: Ref;
  uid: string;
  reason: MeshProblemReason;
  /** Values of the message (`problems:messages.mesh<Reason>`). */
  params: Record<string, string>;
  /** What the finding rests on and the objects its words name (besides `ref`). */
  needs: MeshNeed[];
}

const SERVICE_KIND = { group: "", kind: "Service" };

export interface AnalysisInput {
  virtualServices: readonly VirtualService[];
  destinationRules: readonly DestinationRuleInfo[];
  /** `undefined` when Istio Gateways are not served or not listed yet. */
  gateways: readonly IstioGatewayInfo[] | undefined;
  serviceEntries: readonly ServiceEntryInfo[];
  peerAuthentications: readonly PeerAuthInfo[];
  serviceExists: (namespace: string, name: string) => boolean | undefined;
}

const uidOf = (r: { obj: { metadata?: { uid?: string } }; ref: Ref }) => r.obj.metadata?.uid ?? `${r.ref.namespace}/${r.ref.name}`;

/** The namespaces an object is visible in: `all`, or a set. */
function visibility(exportTo: readonly string[], own: string): "all" | Set<string> {
  if (exportTo.length === 0 || exportTo.includes("*")) return "all";
  return new Set(exportTo.filter((e) => e !== "~").map((e) => (e === "." ? own : e)));
}

function exportsOverlap(a: VirtualService, b: VirtualService): boolean {
  const va = visibility(a.exportTo, a.namespace);
  const vb = visibility(b.exportTo, b.namespace);
  if (va === "all") return vb === "all" || vb.size > 0;
  if (vb === "all") return va.size > 0;
  return [...va].some((n) => vb.has(n));
}

const catchAll = (vs: VirtualService) => vs.http.some((r) => r.matches.length === 0);

export function meshProblems(input: AnalysisInput): MeshProblem[] {
  const out: MeshProblem[] = [];
  const seen = new Set<string>();
  const add = (
    owner: { obj: { metadata?: { uid?: string } }; ref: Ref },
    reason: MeshProblemReason,
    params: Record<string, string>,
    needs: MeshNeed[] = [],
  ) => {
    const key = `${uidOf(owner)}|${reason}|${JSON.stringify(params)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ref: owner.ref, uid: uidOf(owner), reason, params, needs });
  };

  for (const vs of input.virtualServices) {
    if (meshWildcardInvalid(vs)) {
      add(vs, "InvalidVirtualService", { host: "*" });
      continue;
    }
    for (const d of allDestinations(vs)) {
      const r = resolveDestination(d, 0, vs.namespace, input);
      const service = serviceOfHost(d.fqdn);
      // Where a client in the VirtualService's namespace looks for the host's DestinationRule.
      const lookup = [...new Set([vs.namespace, service?.namespace, ROOT_NAMESPACE].filter((n): n is string => !!n))];
      const rules: MeshNeed[] = lookup.map((namespace) => ({ kind: DESTINATION_RULE, namespace }));
      if (r.problem === "unknownHost") {
        const needs: MeshNeed[] = [{ kind: SERVICE_ENTRY, namespace: null }];
        if (service) needs.push({ kind: SERVICE_KIND, namespace: service.namespace, name: service.name });
        add(vs, "UnknownHost", { host: d.host }, needs);
      } else if (r.problem === "noDestinationRule") add(vs, "MissingDestinationRule", { host: d.host, subset: d.subset ?? "" }, rules);
      else if (r.problem === "missingSubset") {
        const named: MeshNeed[] = r.rule ? [{ kind: DESTINATION_RULE, namespace: r.rule.namespace, name: r.rule.name }] : [];
        add(vs, "MissingSubset", { host: d.host, subset: d.subset ?? "", rule: r.rule?.name ?? "" }, [...rules, ...named]);
      }
    }
    if (input.gateways) {
      for (const g of vs.gateways) {
        if (g === MESH_GATEWAY || input.gateways.some((x) => x.key === g)) continue;
        const [namespace = "", name = ""] = g.split("/");
        add(vs, "MissingGateway", { gateway: g }, [{ kind: ISTIO_GATEWAY, namespace, name }]);
      }
    }
  }

  for (const rule of input.destinationRules) {
    if (rule.hasWorkloadSelector) continue;
    const service = serviceOfHost(rule.fqdn);
    if (!service) continue;
    const modes = [rule.tlsMode, ...rule.portTls.map((p) => p.mode), ...rule.subsets.map((s) => s.tlsMode)].filter(
      (m): m is string => !!m,
    );
    const bad = modes.find((m) => m !== "ISTIO_MUTUAL");
    if (!bad) continue;
    // The workload's own selector policies need the pods' labels: the namespace and mesh levels decide here.
    const mtls = mtlsModeFor(service.namespace, {}, input.peerAuthentications);
    if (mtls.mode === "STRICT") {
      const needs: MeshNeed[] = [...new Set([service.namespace, ROOT_NAMESPACE])].map((namespace) => ({ kind: PEER_AUTHENTICATION, namespace }));
      if (mtls.policy) needs.push({ kind: PEER_AUTHENTICATION, namespace: mtls.policy.namespace, name: mtls.policy.name });
      add(rule, "TlsConflict", { host: rule.host, mode: bad, policy: mtls.policy?.name ?? "" }, needs);
    }
  }

  // The same host on the same gateway.
  const groups = new Map<string, VirtualService[]>();
  for (const vs of input.virtualServices) {
    if (vs.delegate || meshWildcardInvalid(vs)) continue;
    for (const gateway of new Set(vs.gateways)) {
      for (const host of new Set(vs.fqdnHosts)) {
        const key = `${gateway}\u0000${host}`;
        groups.set(key, [...(groups.get(key) ?? []), vs]);
      }
    }
  }
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const [gateway = "", host = ""] = key.split("\u0000");
    const ordered = [...list].sort(olderFirst);
    for (const [i, vs] of ordered.entries()) {
      if (i === 0) continue;
      const earlier = ordered.slice(0, i).filter((o) => exportsOverlap(o, vs));
      const winner = gateway === MESH_GATEWAY ? earlier[0] : earlier.find(catchAll);
      if (winner) {
        // Judged against every namespace's VirtualServices, and it names the other one.
        const needs: MeshNeed[] = [
          { kind: VIRTUAL_SERVICE, namespace: null },
          { kind: VIRTUAL_SERVICE, namespace: winner.namespace, name: winner.ref.name },
        ];
        add(vs, "ConflictingVirtualService", { host, gateway, other: `${winner.namespace}/${winner.ref.name}` }, needs);
      }
    }
  }
  return out;
}

