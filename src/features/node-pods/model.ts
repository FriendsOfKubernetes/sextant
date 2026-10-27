// The pods of a node and what they ask of it (#279, #280): the watch of the node's pods and the "Allocated resources"
// of `kubectl describe node` — the requests and limits of its non-terminated pods summed and set against the node's
// allocatable. A pod's request and limit are read as everywhere else in Sextant (`podResourceAmounts`, ADR-0037: only
// `spec.containers`, a limit counts only when every container sets one), so the limit sum covers the pods with a whole
// limit and says how many have none — `kubectl` adds partial limits instead, which reads like a ceiling it is not.
import type { KubeObject, PodUsage, Usage, WatchSpec } from "../../api";
import { nodeAllocatable, parseQuantity } from "../metrics";
import { podResourceAmounts } from "../metrics/requests";

export const POD = { group: "", version: "v1", kind: "Pod" };
/** The node's pods are watched across namespaces by its name on the API server (`spec.nodeName` is a pod field). */
export const nodePodsSelector = (node: string) => `spec.nodeName=${node}`;

export function nodePodsSpec(node: string): WatchSpec {
  return { kind: POD, namespaces: null, labelSelector: null, fieldSelector: nodePodsSelector(node) };
}

/** Succeeded and Failed pods hold nothing on the node (`kubectl describe node` lists only the others). */
export function isTerminated(pod: KubeObject): boolean {
  const phase = (pod.status as { phase?: unknown } | undefined)?.phase;
  return phase === "Succeeded" || phase === "Failed";
}

/** One resource of a node: the sums of its pods, its allocatable and its usage. CPU in millicores, memory in bytes. */
export interface AllocatedResource {
  allocatable?: number;
  requests: number;
  /** The sum of the pods' whole limits (`podsWithoutLimit` pods are not in it). */
  limits: number;
  /** Non-terminated pods with containers whose limit is not set on every container. */
  podsWithoutLimit: number;
  /** The node's own usage (metrics), when known. */
  usage?: number;
}

export interface Allocated {
  cpu: AllocatedResource;
  memory: AllocatedResource;
  /** Non-terminated pods, and how many the node allows. */
  pods: { count: number; allocatable?: number };
}

/** "Allocated resources" of `node` from `pods` (its pods; the terminated ones are left out) and its `usage`. */
export function allocatedResources(node: KubeObject | null, pods: Iterable<KubeObject>, usage?: Usage): Allocated {
  const alloc = node ? nodeAllocatable(node) : {};
  const podsAllocatable = node ? parseQuantity((node.status as { allocatable?: Record<string, unknown> } | undefined)?.allocatable?.pods) : undefined;
  const cpu: AllocatedResource = { allocatable: alloc.cpu, requests: 0, limits: 0, podsWithoutLimit: 0, usage: usage?.cpuMillicores };
  const memory: AllocatedResource = {
    allocatable: alloc.memory,
    requests: 0,
    limits: 0,
    podsWithoutLimit: 0,
    usage: usage?.memoryBytes,
  };
  let count = 0;
  for (const pod of pods) {
    if (isTerminated(pod)) continue;
    count++;
    const amounts = podResourceAmounts(pod);
    for (const [total, own] of [
      [cpu, amounts.cpu],
      [memory, amounts.memory],
    ] as const) {
      total.requests += own.request ?? 0;
      if (own.containers > 0 && own.limitSetOn === own.containers) total.limits += own.limit ?? 0;
      else if (own.containers > 0) total.podsWithoutLimit++;
    }
  }
  return { cpu, memory, pods: { count, allocatable: podsAllocatable } };
}

/** The namespaces of `pods`, sorted — the pods' usage is asked for them (`usePodUsageOfMany`). */
export function namespacesOf(pods: Iterable<KubeObject>): string[] {
  const set = new Set<string>();
  for (const pod of pods) set.add(pod.metadata?.namespace ?? "");
  set.delete("");
  return [...set].sort();
}

/** A pod's usage in `usage` (by `namespace/name`). */
export function usageOf(usage: ReadonlyMap<string, PodUsage> | null, pod: KubeObject): Usage | undefined {
  return usage?.get(`${pod.metadata?.namespace ?? ""}/${pod.metadata?.name ?? ""}`)?.usage;
}
