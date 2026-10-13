// Requests and limits of a pod, read from its spec: what the containers asked for and may use at most, summed over the
// pod. CPU in millicores, memory in bytes. Init containers are not summed: they do not run next to the others.
import { parseQuantity } from "./format";

/** One resource of a pod: the sums and on how many of its containers the request and the limit are set. */
export interface ResourceAmounts {
  /** Sum of the requests that are set; `undefined` if no container sets one. */
  request?: number;
  /** Sum of the limits that are set; `undefined` if no container sets one. */
  limit?: number;
  requestSetOn: number;
  limitSetOn: number;
  /** Containers of the pod (`spec.containers`). */
  containers: number;
}

export interface ContainerAmounts {
  cpu: { request?: number; limit?: number };
  memory: { request?: number; limit?: number };
}

export interface PodResourceAmounts {
  cpu: ResourceAmounts;
  memory: ResourceAmounts;
  /** By container name. */
  byContainer: Map<string, ContainerAmounts>;
}

type Resource = "cpu" | "memory";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The quantity at `resources.<kind>.<resource>` of a container in the unit of the resource, if it parses. */
function amountOf(container: unknown, kind: "requests" | "limits", resource: Resource): number | undefined {
  if (!isRecord(container) || !isRecord(container.resources)) return undefined;
  const group = container.resources[kind];
  if (!isRecord(group)) return undefined;
  const value = parseQuantity(group[resource]);
  if (value === undefined) return undefined;
  // Millicores, without the float noise of 0.1 * 1000.
  return resource === "cpu" ? Math.round(value * 1e6) / 1e3 : value;
}

function sum(values: Array<number | undefined>): {
  total?: number;
  setOn: number;
} {
  const set = values.filter((v): v is number => v !== undefined);
  return {
    total: set.length > 0 ? set.reduce((a, b) => a + b, 0) : undefined,
    setOn: set.length,
  };
}

export function podResourceAmounts(pod: unknown): PodResourceAmounts {
  const spec = isRecord(pod) ? pod.spec : undefined;
  const list = isRecord(spec) && Array.isArray(spec.containers) ? spec.containers : [];
  const byContainer = new Map<string, ContainerAmounts>();
  const of = (resource: Resource): ResourceAmounts => {
    const requests = sum(list.map((c) => amountOf(c, "requests", resource)));
    const limits = sum(list.map((c) => amountOf(c, "limits", resource)));
    return {
      request: requests.total,
      limit: limits.total,
      requestSetOn: requests.setOn,
      limitSetOn: limits.setOn,
      containers: list.length,
    };
  };
  for (const c of list) {
    const name = isRecord(c) && typeof c.name === "string" ? c.name : "";
    const each = (resource: Resource) => {
      const entry: { request?: number; limit?: number } = {};
      const request = amountOf(c, "requests", resource);
      const limit = amountOf(c, "limits", resource);
      if (request !== undefined) entry.request = request;
      if (limit !== undefined) entry.limit = limit;
      return entry;
    };
    byContainer.set(name, { cpu: each("cpu"), memory: each("memory") });
  }
  return { cpu: of("cpu"), memory: of("memory"), byContainer };
}
