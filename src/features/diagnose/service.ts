// The checks of a Service, in the order traffic depends on them: what kind of Service it is, which pods it selects,
// how many are Ready, whether the target ports exist on them, whether the EndpointSlices agree, network policies in
// front of the pods, and how it is exposed (node ports, load balancer address, session affinity). The Ingress and
// route checks continue here with the one port they name (`focus`).
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { indexPods, selectPods } from "../resource-map/selectors";
import { podInfo, resolveTargetPort, serviceInfo, type ServiceInfo, type ServicePort } from "../netpol/model";
import { phrase, Walk, type Chain, type ClusterView, type Phrase, type TrafficSource } from "./model";
import { exposureFindings, externalNameFinding, readyFinding, selectorFinding, slicesFinding } from "./serviceSteps";
import { findServicePort, isReady, isTerminating, linkOf, portLabel, SERVICE } from "./objects";
import { policyFinding, type BackendTraffic } from "./policies";

const { get } = status;

export interface ServiceOptions {
  /** The Service port the path uses (an Ingress's `port.number`/`port.name`, a route's `port`); all when absent. */
  focus?: number | string;
  source: TrafficSource;
  /** The title of the chain (an Ingress rule, a route backend). */
  title?: Phrase;
}

/** The ports to check: the focused one, or all of them. */
function portsOf(info: ServiceInfo, focus: number | string | undefined): ServicePort[] | undefined {
  if (focus === undefined) return info.ports;
  const found = findServicePort(info.ports, focus);
  return found ? [found] : undefined;
}

export function diagnoseService(svc: KubeObject, view: ClusterView, options: ServiceOptions): Chain {
  const link = linkOf(SERVICE, svc);
  const walk = new Walk(options.title, link);
  const info = serviceInfo(svc);
  const namespace = info.namespace;
  const viaPath = options.focus !== undefined;

  if (info.type === "ExternalName") {
    walk.add(externalNameFinding(svc));
    return walk.chain;
  }
  const ports = portsOf(info, options.focus);
  if (!ports) {
    const available = info.ports.map(portLabel);
    walk.add({ id: "service.port", status: "broken", text: phrase("service.portMissing", { port: String(options.focus), name: info.name, ports: available }), links: [link] });
    return walk.chain;
  }
  const headless = get(svc, "spec", "clusterIP") === "None";
  // A headless Service with a selector needs no ports: its DNS name returns the pods' addresses, on any port.
  if (ports.length === 0 && !(headless && info.hasSelector)) {
    walk.add({ id: "service.port", status: "broken", text: phrase("service.noPorts", { name: info.name }), links: [link] });
    return walk.chain;
  }
  if (headless) {
    const notes = ports.length === 0 ? [phrase("service.headlessNoPorts")] : undefined;
    walk.add({ id: "service.headless", status: "ok", text: phrase("service.headless"), notes });
  }

  if (!info.hasSelector) {
    // Endpoints written by hand (or by another controller): only the EndpointSlices can say where traffic goes.
    walk.add({ id: "service.selector", status: "ok", text: phrase("service.manual", { name: info.name }) });
    walk.add(slicesFinding(view.endpointSlices(namespace), info, undefined, true));
    for (const f of exposureFindings(svc, info, view.now, viaPath)) if (!walk.add(f)) break;
    return walk.chain;
  }

  const all = view.pods(namespace);
  if (!all) {
    walk.add({ id: "service.selector", status: "unknown", text: phrase("service.podsUnknown", { namespace }) });
  } else {
    const index = indexPods(all);
    const selected = selectPods(index, namespace, info.selector);
    if (!walk.add(selectorFinding(info, selected, all))) return walk.chain;
    const live = selected.filter((p) => !isTerminating(p));
    const ready = live.filter(isReady);
    const publish = get(svc, "spec", "publishNotReadyAddresses") === true;
    if (!walk.add(readyFinding(live, ready, publish))) return walk.chain;
    // With publishNotReadyAddresses every live pod gets traffic; otherwise only the Ready ones.
    const backends = publish ? live : ready;
    for (const [i, port] of ports.entries()) if (!walk.add(targetPortFinding(port, backends, i))) return walk.chain;
    // A pod gets an endpoint only once it has an IP: a published pod still waiting for one is not expected yet.
    const expected = publish ? live.filter((p) => Boolean(get(p, "status", "podIP"))).length : ready.length;
    if (!walk.add(slicesFinding(view.endpointSlices(namespace), info, expected, false))) return walk.chain;
    const traffic: BackendTraffic[] = ready.flatMap((pod) => {
      const p = podInfo(pod);
      return ports.flatMap((port) => {
        const target = resolveTargetPort(port, p);
        return target === null ? [] : [{ pod: p, traffic: { protocol: port.protocol, port: target } }];
      });
    });
    const policies = policyFinding(traffic, options.source, view.world, namespace);
    if (policies && !walk.add(policies)) return walk.chain;
  }
  for (const f of exposureFindings(svc, info, view.now, viaPath)) if (!walk.add(f)) break;
  return walk.chain;
}

/** Whether the Service port's target port exists on the backend pods, with the right protocol. */
export function targetPortFinding(port: ServicePort, pods: readonly KubeObject[], index: number) {
  const id = `service.targetPort.${index}`;
  const label = portLabel(port);
  const infos = pods.map(podInfo);
  const total = infos.length;
  const named = typeof port.targetPort === "string" && !/^\d+$/.test(port.targetPort);
  if (named) {
    const name = String(port.targetPort);
    const resolved = infos.map((p) => resolveTargetPort(port, p)).filter((n): n is number => n !== null);
    if (resolved.length === 0) {
      const otherProtocol = infos.some((p) => p.ports.some((c) => c.name === name));
      const key = otherProtocol ? "service.namedPortProtocol" : "service.namedPortMissing";
      return { id, status: "broken" as const, text: phrase(key, { port: label, name, protocol: port.protocol }) };
    }
    const numbers = [...new Set(resolved)].map(String);
    if (resolved.length < total) {
      return { id, status: "warn" as const, text: phrase("service.namedPortSome", { port: label, name, count: resolved.length, total }) };
    }
    return { id, status: "ok" as const, text: phrase("service.namedPort", { port: label, name, targets: numbers }) };
  }
  const target = Number(port.targetPort);
  const declared = infos.filter((p) => p.ports.some((c) => c.port === target && c.protocol === port.protocol));
  if (declared.length > 0 || total === 0) {
    return { id, status: "ok" as const, text: phrase("service.targetPort", { port: label, target }) };
  }
  const otherProtocol = infos.flatMap((p) => p.ports.filter((c) => c.port === target)).map((c) => c.protocol);
  if (otherProtocol.length > 0) {
    return {
      id,
      status: "warn" as const,
      text: phrase("service.protocolMismatch", { port: label, target, protocol: port.protocol, declared: [...new Set(otherProtocol)] }),
    };
  }
  return { id, status: "warn" as const, text: phrase("service.portNotDeclared", { port: label, target }) };
}
