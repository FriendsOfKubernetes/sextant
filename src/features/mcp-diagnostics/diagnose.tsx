// `diagnose_service`: the traffic diagnosis of #208 (`useDiagnosisData` + `diagnose`) on a view of only what the agent
// may read, in words: a list the agent may not read is unknown to the engine, as one the user may not read is — and
// is not even watched (`DiagnosisScope`). A TLS Secret's certificate is read only when the backend says the agent has
// "Secret values" there (`checkCertificates`); otherwise its step stays unknown and `tls_certificate_info` is not called.
import { useMemo } from "react";
import type { KindRef, KubeObject, ReadRule } from "../../api";
import { useClusterKinds } from "../../resources";
import { diagnose } from "../diagnose/engine";
import { useDiagnosisData, type DiagnosisScope } from "../diagnose/hooks";
import { chainStatus, firstBroken, type Chain, type ClusterView, type Finding, type LinkRef } from "../diagnose/model";
import { ENDPOINT_SLICE, INGRESS, INGRESS_CLASS, POD, SECRET, SERVICE } from "../diagnose/objects";
import { phraseText, policyLines } from "../diagnose/text";
import { GATEWAY, GRPC_ROUTE, HTTP_ROUTE, isKind, routeRules } from "../gateway-api/model";
import { servedPolicyKinds, type ServedPolicyKinds } from "../netpol/hooks";
import { en } from "./english";
import { restrictWorld } from "./netpol";
import { canRead, objectName } from "./scope";
import { useAnswer, type WorkerProps } from "./worker";

interface Args {
  kind: { group: string; kind: string };
  namespace: string;
  name: string;
  /** The agent may have certificates read (Read and "Secret values" on the namespace's Secrets). */
  checkCertificates?: boolean;
}

const REFERENCE_GRANT = { group: "gateway.networking.k8s.io", kind: "ReferenceGrant" };

/** The kind (with a version) of the object to diagnose; discovery picks the served version of a route. */
function rootKind(kind: Args["kind"]): KindRef {
  if (isKind(kind, INGRESS)) return INGRESS;
  if (isKind(kind, HTTP_ROUTE)) return HTTP_ROUTE;
  if (isKind(kind, GRPC_ROUTE)) return GRPC_ROUTE;
  return SERVICE;
}

/**
 * `view` with only what the agent may read: anything else is unknown (`undefined`) to the engine; certificates only
 * with `certificates`.
 */
export function restrictView(
  view: ClusterView,
  reads: readonly ReadRule[],
  namespaces: readonly string[],
  served: ServedPolicyKinds | undefined,
  certificates: boolean,
): ClusterView {
  const may = (kind: Pick<KindRef, "group" | "kind">, ns: string | null) => canRead(reads, kind, ns);
  return {
    now: view.now,
    services: (ns) => (may(SERVICE, ns) ? view.services(ns) : undefined),
    pods: (ns) => (may(POD, ns) ? view.pods(ns) : undefined),
    endpointSlices: (ns) => (may(ENDPOINT_SLICE, ns) ? view.endpointSlices(ns) : undefined),
    world: view.world && restrictWorld(view.world, served, namespaces, reads),
    ingressClasses: view.ingressClasses === null ? null : may(INGRESS_CLASS, null) ? view.ingressClasses : undefined,
    // A controller's pods live in its own namespace, found by labels across the cluster: only with Read on Pods in
    // every namespace — whatever was found (an empty list would otherwise say "none" about namespaces it may not read).
    controllerPods: (c) => {
      const found = view.controllerPods(c);
      if (found === null) return null;
      return may(POD, null) ? found : undefined;
    },
    certificates: (ns, secret) => (certificates && may(SECRET, ns) ? view.certificates(ns, secret) : undefined),
    gateways: (ns) => {
      const list = view.gateways(ns);
      return list === null ? null : may(GATEWAY, ns) ? list : undefined;
    },
    grants: (ns) => (may(REFERENCE_GRANT, ns) ? view.grants(ns) : undefined),
  };
}

/** The namespaces a diagnosis reads policies of: the object's own, and a route's backends' (as the hook lists them). */
function diagnosedNamespaces(kind: KindRef, obj: KubeObject, own: string): string[] {
  if (!isKind(kind, HTTP_ROUTE, GRPC_ROUTE)) return [own];
  const backends = routeRules(obj, kind).flatMap((r) => r.backends.map((b) => b.namespace ?? own));
  return [...new Set([own, ...backends])];
}

const linkOut = (l: LinkRef) => objectName(l.kind, l.namespace, l.name);

function findingOut(f: Finding) {
  return {
    id: f.id,
    status: f.status,
    text: phraseText(en, f.text),
    notes: (f.notes ?? []).map((n) => phraseText(en, n)),
    objects: (f.links ?? []).map(linkOut),
    policies: f.policies ? policyLines(en, f.policies) : [],
  };
}

function chainOut(c: Chain): Record<string, unknown> {
  return {
    title: c.title ? phraseText(en, c.title) : undefined,
    object: c.link ? linkOut(c.link) : undefined,
    findings: c.findings.map(findingOut),
    chains: c.chains.map(chainOut),
    stopped: c.stopped,
  };
}

export function DiagnoseWorker(props: WorkerProps) {
  const { request } = props;
  const args = request.args as unknown as Args;
  const kind = useMemo(() => rootKind(args.kind), [args.kind]);
  const certificates = args.checkCertificates === true;
  const scope = useMemo(
    (): DiagnosisScope => ({ may: (k, ns) => canRead(request.reads, k, ns), certificates }),
    [request.reads, certificates],
  );
  const data = useDiagnosisData(request.clusterId, kind, args.namespace, args.name, null, scope);
  const served = servedPolicyKinds(useClusterKinds(request.clusterId));

  useAnswer(props, !data.loading, () => {
    if (!data.obj) throw new Error(`${kind.kind} ${args.namespace}/${args.name} was not found`);
    // Every namespace whose policies the engine may judge: the object's own and a route's backends'.
    const namespaces = diagnosedNamespaces(kind, data.obj, args.namespace);
    const chain = diagnose(kind, data.obj, restrictView(data.view, request.reads, namespaces, served, certificates));
    const broken = firstBroken(chain);
    return {
      status: chainStatus(chain),
      summary: broken ? phraseText(en, broken.text) : undefined,
      chain: chainOut(chain),
    };
  });
  return null;
}
