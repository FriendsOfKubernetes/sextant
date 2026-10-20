// The path through an Ingress: its IngressClass resolves and a controller runs for it, the controller published an
// address, the TLS Secrets hold certificates that cover the hosts, then each host and path (and the default backend)
// leads to an existing Service and port — and on into the Service's own checks, with the controller's pods as the
// source of traffic for the network policy check when they are known (and the controller is an in-cluster proxy). An
// Ingress no IngressClass decides for, but with an address, was claimed by some controller: a warning, and the walk goes
// on to the backends.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { podInfo } from "../netpol/model";
import { controllerOf, isOutsideProxy, resolveClass } from "./controllers";
import { phrase, Walk, type Chain, type ClusterView, type Finding, type Phrase, type TrafficSource } from "./model";
import { INGRESS, INGRESS_CLASS, isReady, linkOf, loadBalancerAddresses, namespaceOf, nameOf, SERVICE } from "./objects";
import { diagnoseService } from "./service";
import { tlsFindings } from "./tls";

const { arr, get, num, str } = status;

/** Host/path chains an Ingress diagnosis follows at most. */
export const MAX_PATHS = 30;

/**
 * The class step. `claimed`: no IngressClass decides, but the Ingress has an address, so some controller took it
 * (ingress-nginx with `--watch-ingress-without-class`, Traefik, a controller that ignores classes): which one, and its
 * pods, cannot be told.
 */
function classFinding(ingress: KubeObject, view: ClusterView, hasAddress: boolean): { finding: Finding; controller?: string; claimed?: boolean } {
  const id = "ingress.class";
  const classes = view.ingressClasses;
  if (classes === undefined) return { finding: { id, status: "unknown", text: phrase("ingress.classUnknown") } };
  const resolved = resolveClass(ingress, classes ?? []);
  switch (resolved.type) {
    case "named": {
      const cls = resolved.ingressClass;
      const links = cls ? [linkOf(INGRESS_CLASS, cls)] : undefined;
      if (resolved.via === "annotation") {
        const key = cls ? "ingress.classAnnotation" : "ingress.classAnnotationNoObject";
        return { finding: { id, status: "warn", text: phrase(key, { name: resolved.name }), links }, controller: controllerOf(cls) };
      }
      if (!cls) {
        if (hasAddress) return { finding: { id, status: "warn", text: phrase("ingress.classMissingClaimed", { name: resolved.name }) }, claimed: true };
        return { finding: { id, status: "broken", text: phrase("ingress.classMissing", { name: resolved.name }) } };
      }
      const controller = controllerOf(cls);
      return { finding: { id, status: "ok", text: phrase("ingress.class", { name: resolved.name, controller: controller ?? "" }), links }, controller };
    }
    case "default": {
      const controller = controllerOf(resolved.ingressClass);
      const text = phrase("ingress.classDefault", { name: nameOf(resolved.ingressClass), controller: controller ?? "" });
      return { finding: { id, status: "ok", text, links: [linkOf(INGRESS_CLASS, resolved.ingressClass)] }, controller };
    }
    case "manyDefaults":
      return { finding: { id, status: "warn", text: phrase("ingress.classManyDefaults", { names: resolved.names }) } };
    case "none":
      if (hasAddress) return { finding: { id, status: "warn", text: phrase("ingress.classNoneClaimed") }, claimed: true };
      return { finding: { id, status: "broken", text: phrase("ingress.classNone") } };
  }
}

/** Whether the controller runs; the source of traffic for the policy check when its pods are known. */
function controllerFinding(controller: string | undefined, hasAddress: boolean, view: ClusterView): { finding: Finding; source: TrafficSource } {
  const id = "ingress.controller";
  const outside: TrafficSource = { type: "outside" };
  if (!controller) return { finding: { id, status: "unknown", text: phrase("ingress.controllerUnnamed") }, source: outside };
  const found = view.controllerPods(controller);
  if (found === null) {
    const key = hasAddress ? "ingress.controllerByAddress" : "ingress.controllerUnknown";
    return { finding: { id, status: hasAddress ? "ok" : "unknown", text: phrase(key, { controller }) }, source: outside };
  }
  if (found === undefined) return { finding: { id, status: "unknown", text: phrase("ingress.controllerUnread", { controller }) }, source: outside };
  const ready = found.pods.filter(isReady);
  // A controller that provisions a load balancer outside the cluster (AWS ALB) only configures it: traffic comes
  // from that load balancer, not from the controller's pods.
  const outsideProxy = isOutsideProxy(controller);
  const source: TrafficSource = outsideProxy ? outside : { type: "controller", controller, pods: (ready.length > 0 ? ready : found.pods).map(podInfo) };
  const notes = outsideProxy ? [phrase("ingress.controllerOutside", { controller })] : undefined;
  if (ready.length > 0) return { finding: { id, status: "ok", text: phrase("ingress.controllerPods", { controller, count: ready.length }), notes }, source };
  if (found.pods.length > 0) {
    return { finding: { id, status: "broken", text: phrase("ingress.controllerNotReady", { controller, count: found.pods.length }), notes }, source };
  }
  const key = hasAddress ? "ingress.controllerNotFound" : "ingress.controllerNone";
  return { finding: { id, status: hasAddress ? "warn" : "broken", text: phrase(key, { controller, selector: found.selector }) }, source: outside };
}

/** What a path's `pathType` means for the requests it takes. */
function pathFinding(path: string | undefined, pathType: string | undefined, index: number): Finding {
  const id = `ingress.path.${index}`;
  const shown = path || "/";
  if (pathType !== "Exact" && pathType !== "Prefix") {
    return { id, status: "ok", text: phrase("ingress.pathImplementationSpecific", { path: shown }) };
  }
  if (path !== undefined && !path.startsWith("/")) return { id, status: "broken", text: phrase("ingress.pathInvalid", { path }) };
  if (pathType === "Exact") return { id, status: "ok", text: phrase("ingress.pathExact", { path: shown }) };
  if (/[*()$^[\]|+?\\]/.test(shown)) return { id, status: "warn", text: phrase("ingress.prefixRegex", { path: shown }) };
  return { id, status: "ok", text: phrase(shown === "/" ? "ingress.pathEverything" : "ingress.pathPrefix", { path: shown }) };
}

/** A backend (`service` or `resource`) → the Service's checks. */
function backendChain(backend: unknown, title: Phrase, first: Finding | undefined, ingress: KubeObject, view: ClusterView, source: TrafficSource): Chain {
  const walk = new Walk(title);
  if (first && !walk.add(first)) return walk.chain;
  const namespace = namespaceOf(ingress);
  const resource = get(backend, "resource");
  if (resource !== undefined) {
    walk.add({ id: "ingress.backend", status: "unknown", text: phrase("ingress.resourceBackend", { kind: str(get(resource, "kind")) ?? "", name: str(get(resource, "name")) ?? "" }) });
    return walk.chain;
  }
  const name = str(get(backend, "service", "name")) ?? "";
  const port = num(get(backend, "service", "port", "number")) ?? str(get(backend, "service", "port", "name"));
  if (port === undefined) {
    walk.add({ id: "ingress.backend", status: "broken", text: phrase("ingress.backendNoPort", { name }) });
    return walk.chain;
  }
  const services = view.services(namespace);
  if (!services) {
    walk.add({ id: "ingress.backend", status: "unknown", text: phrase("ingress.servicesUnknown", { namespace }) });
    return walk.chain;
  }
  const svc = services.find((s) => nameOf(s) === name);
  const link = { kind: SERVICE, namespace, name };
  if (!svc) {
    walk.add({ id: "ingress.backend", status: "broken", text: phrase("ingress.serviceMissing", { name, namespace }) });
    return walk.chain;
  }
  walk.add({ id: "ingress.backend", status: "ok", text: phrase("ingress.service", { name, port: String(port) }), links: [link] });
  for (const f of diagnoseService(svc, view, { focus: port, source }).findings) if (!walk.add(f)) break;
  return walk.chain;
}

export function diagnoseIngress(ingress: KubeObject, view: ClusterView): Chain {
  const walk = new Walk(undefined, linkOf(INGRESS, ingress));
  const addresses = loadBalancerAddresses(ingress);
  const { finding, controller, claimed } = classFinding(ingress, view, addresses.length > 0);
  if (!walk.add(finding)) return walk.chain;
  // A claimed Ingress has no controller to look for: the class step said so, and the source is someone outside.
  const control = claimed ? undefined : controllerFinding(controller, addresses.length > 0, view);
  if (control && !walk.add(control.finding)) return walk.chain;
  const source: TrafficSource = control?.source ?? { type: "outside" };
  const address: Finding =
    addresses.length > 0
      ? { id: "ingress.address", status: "ok", text: phrase("ingress.address", { addresses }) }
      : { id: "ingress.address", status: "warn", text: phrase("ingress.noAddress") };
  if (!walk.add(address)) return walk.chain;
  for (const f of tlsFindings(ingress, view)) if (!walk.add(f)) return walk.chain;

  const rules = arr(get(ingress, "spec", "rules"));
  const defaultBackend = get(ingress, "spec", "defaultBackend");
  if (rules.length === 0 && defaultBackend === undefined) {
    walk.add({ id: "ingress.rules", status: "broken", text: phrase("ingress.noRules") });
    return walk.chain;
  }
  let shown = 0;
  let index = 0;
  for (const rule of rules) {
    const host = str(get(rule, "host")) ?? "";
    const paths = arr(get(rule, "http", "paths"));
    if (paths.length === 0) {
      walk.add({ id: `ingress.rule.${index++}`, status: "warn", text: phrase("ingress.ruleNoPaths", { host: host || "*" }) });
      continue;
    }
    for (const p of paths) {
      const i = index++;
      if (shown++ >= MAX_PATHS) continue;
      const path = str(get(p, "path"));
      const title = phrase(host ? "ingress.ruleTitle" : "ingress.ruleTitleAnyHost", { host, path: path || "/" });
      walk.branch(backendChain(get(p, "backend"), title, pathFinding(path, str(get(p, "pathType")), i), ingress, view, source));
    }
  }
  if (shown > MAX_PATHS) walk.add({ id: "ingress.paths", status: "ok", text: phrase("ingress.morePaths", { count: shown - MAX_PATHS }) });
  if (defaultBackend !== undefined) {
    walk.branch(backendChain(defaultBackend, phrase("ingress.defaultBackend"), undefined, ingress, view, source));
  }
  return walk.chain;
}
