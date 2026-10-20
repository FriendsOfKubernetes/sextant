// The single checks of `service.ts`, each one finding.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { POD as PROBLEM_POD, detect } from "../problems/model";
import type { ServiceInfo } from "../netpol/model";
import { phrase, type Finding, type Phrase } from "./model";
import {
  isDnsName,
  isIpAddress,
  linkOf,
  loadBalancerAddresses,
  minutesSince,
  POD,
  portLabel,
  sliceEndpoints,
} from "./objects";

const { arr, get, labelsOf, num, str } = status;

/** A load balancer still without an address this long counts as broken, not as on its way. */
export const LB_GRACE_MINUTES = 5;
/** Pods a finding links to at most. */
export const LINKED_PODS = 5;

const selectorText = (info: ServiceInfo) =>
  info.selector.type === "terms" ? info.selector.matchLabels.map(([k, v]) => `${k}=${v}`).join(", ") : "";

export function externalNameFinding(svc: KubeObject): Finding {
  const id = "service.externalName";
  const name = str(get(svc, "spec", "externalName")) ?? "";
  if (!name) return { id, status: "broken", text: phrase("service.externalNameEmpty") };
  if (isIpAddress(name)) return { id, status: "warn", text: phrase("service.externalNameIp", { name }) };
  if (!isDnsName(name)) return { id, status: "broken", text: phrase("service.externalNameInvalid", { name }) };
  return { id, status: "ok", text: phrase("service.externalName", { name }), notes: [phrase("service.externalNameNote")] };
}

/** Pods that match every label of the selector but one: the usual typo. */
function nearMisses(info: ServiceInfo, pods: readonly KubeObject[]): Phrase[] {
  if (info.selector.type !== "terms" || info.selector.matchLabels.length < 2) return [];
  const byKey = new Map<string, number>();
  for (const pod of pods) {
    if (pod.metadata?.namespace !== info.namespace) continue;
    const labels = labelsOf(pod);
    const missed = info.selector.matchLabels.filter(([k, v]) => labels[k] !== v);
    if (missed.length === 1) byKey.set(missed[0]![0], (byKey.get(missed[0]![0]) ?? 0) + 1);
  }
  return [...byKey.entries()].map(([key, count]) => {
    const expected = info.selector.type === "terms" ? (info.selector.matchLabels.find(([k]) => k === key)?.[1] ?? "") : "";
    return phrase("service.nearMiss", { count, label: `${key}=${expected}` });
  });
}

export function selectorFinding(info: ServiceInfo, selected: readonly KubeObject[], all: readonly KubeObject[]): Finding {
  const id = "service.selector";
  const selector = selectorText(info);
  if (selected.length === 0) {
    return { id, status: "broken", text: phrase("service.noPods", { selector, namespace: info.namespace }), notes: nearMisses(info, all) };
  }
  return {
    id,
    status: "ok",
    text: phrase("service.pods", { count: selected.length, selector }),
    links: selected.slice(0, LINKED_PODS).map((p) => linkOf(POD, p)),
  };
}

/** Why pods are not Ready, as the problems screen names it ("CrashLoopBackOff: 2 pods"). */
function notReadyReasons(pods: readonly KubeObject[]): Phrase[] {
  const counts = new Map<string, number>();
  for (const pod of pods) {
    const reason = detect(PROBLEM_POD, pod)[0]?.reason ?? "NotReady";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => phrase("service.notReadyReason", { reason, count }));
}

export function readyFinding(live: readonly KubeObject[], ready: readonly KubeObject[], publish: boolean): Finding {
  const id = "service.ready";
  if (live.length === 0) return { id, status: "broken", text: phrase("service.allTerminating") };
  const notReady = live.filter((p) => !ready.includes(p));
  const links = notReady.slice(0, LINKED_PODS).map((p) => linkOf(POD, p));
  const notes = notReadyReasons(notReady);
  if (ready.length === 0) {
    return publish
      ? { id, status: "warn", text: phrase("service.noneReadyPublished", { count: live.length }), notes, links }
      : { id, status: "broken", text: phrase("service.noneReady", { count: live.length }), notes, links };
  }
  if (notReady.length > 0) {
    return { id, status: "warn", text: phrase("service.someReady", { count: ready.length, total: live.length }), notes, links };
  }
  return { id, status: "ok", text: phrase("service.allReady", { count: ready.length }) };
}

/**
 * Whether the EndpointSlices of the Service list what traffic can reach: `expected` ready pods (or, for a Service
 * without a selector, any ready endpoint at all).
 */
export function slicesFinding(slices: readonly KubeObject[] | undefined, info: ServiceInfo, expected: number | undefined, manual: boolean): Finding {
  const id = "service.slices";
  if (!slices) return { id, status: "unknown", text: phrase("service.slicesUnknown", { namespace: info.namespace }) };
  const e = sliceEndpoints(slices, info);
  const notes = e.terminatingServing > 0 ? [phrase("service.terminatingServing", { count: e.terminatingServing })] : undefined;
  if (manual) {
    if (e.slices === 0) return { id, status: "broken", text: phrase("service.manualNoSlices", { name: info.name }) };
    if (e.ready === 0) return { id, status: "broken", text: phrase("service.manualNoReady", { count: e.total }) };
    return { id, status: "ok", text: phrase("service.manualEndpoints", { count: e.ready }), notes };
  }
  if (e.slices === 0) return { id, status: "broken", text: phrase("service.noSlices") };
  if (e.ready === 0) return { id, status: "broken", text: phrase("service.slicesNoReady", { count: e.total }) };
  if (expected !== undefined && e.ready !== expected) {
    return { id, status: "warn", text: phrase("service.slicesDiffer", { count: e.ready, pods: expected }), notes };
  }
  return { id, status: "ok", text: phrase("service.slices", { count: e.ready }), notes };
}

/** How the Service is reached: cluster IP, node ports, load balancer address, external IPs, session affinity. */
export function exposureFindings(svc: KubeObject, info: ServiceInfo, now: number, viaPath: boolean): Finding[] {
  // Through an Ingress or a route the proxy sends to the endpoints: the Service's own exposure does not matter.
  if (viaPath) return [];
  const found: Finding[] = [];
  const { name, namespace, type } = info;
  if (type === "ClusterIP" && get(svc, "spec", "clusterIP") !== "None") {
    found.push({ id: "service.clusterIp", status: "ok", text: phrase("service.clusterIp", { name, namespace }) });
  }
  const nodePorts = info.ports.filter((p) => p.nodePort !== null).map((p) => `${p.nodePort}/${p.protocol}`);
  if ((type === "NodePort" || type === "LoadBalancer") && nodePorts.length > 0) {
    const notes = info.externalTrafficPolicy === "Local" ? [phrase("service.localPolicy")] : undefined;
    found.push({ id: "service.nodePorts", status: "ok", text: phrase("service.nodePorts", { ports: nodePorts }), notes });
  }
  if (type === "LoadBalancer") found.push(loadBalancerFinding(svc, now));
  const externalIps = arr(get(svc, "spec", "externalIPs")).map(String);
  if (externalIps.length > 0) {
    found.push({ id: "service.externalIps", status: "ok", text: phrase("service.externalIps", { addresses: externalIps, ports: info.ports.map(portLabel) }) });
  }
  if (str(get(svc, "spec", "sessionAffinity")) === "ClientIP") {
    const seconds = num(get(svc, "spec", "sessionAffinityConfig", "clientIP", "timeoutSeconds")) ?? 10800;
    found.push({ id: "service.affinity", status: "ok", text: phrase("service.affinity", { count: seconds }) });
  }
  return found;
}

function loadBalancerFinding(svc: KubeObject, now: number): Finding {
  const id = "service.loadBalancer";
  const addresses = loadBalancerAddresses(svc);
  const lbClass = str(get(svc, "spec", "loadBalancerClass"));
  const notes = lbClass ? [phrase("service.lbClass", { name: lbClass })] : undefined;
  if (addresses.length > 0) return { id, status: "ok", text: phrase("service.lbAddress", { addresses }), notes };
  const minutes = minutesSince(svc, now);
  if (minutes === undefined || minutes < LB_GRACE_MINUTES) return { id, status: "warn", text: phrase("service.lbPendingNew"), notes };
  const text = minutes >= 120 ? phrase("service.lbPendingHours", { count: Math.floor(minutes / 60) }) : phrase("service.lbPendingMinutes", { count: minutes });
  return { id, status: "broken", text, notes: [...(notes ?? []), phrase("service.lbPendingWhy")] };
}
