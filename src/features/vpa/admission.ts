// What the VPA admission controller would set on a pod created now from the target's pod template, computed as it
// computes it (kubernetes/autoscaler, vertical-pod-autoscaler):
//   - pkg/admission-controller/resource/pod/recommendation/recommendation_provider.go `GetContainersResources`: the
//     request is the recommendation's target; with `RequestsAndLimits` the limit is `GetProportionalLimit`;
//   - pkg/utils/vpa/capping.go `getCappedRecommendationForContainer`: the target is kept within the policy's
//     `minAllowed`/`maxAllowed` (`applyVPAPolicy`) and, with `RequestsOnly`, at most the container's current limit
//     (`capRecommendationToContainerLimit`);
//   - pkg/utils/vpa/limit_and_request_scaling.go `getProportionalResourceLimit`: no limit stays no limit; a limit equal
//     to the request (or without a request) becomes the new request; otherwise limit × new request ÷ old request, in
//     whole millicores for CPU and whole bytes for memory, rounded down (`noRounding`).
// Not modelled, and said so in the view: a LimitRange of the namespace (its default limit and min/max), containers
// added by other admission webhooks (sidecars), and the startup CPU boost.
import { status } from "../../resources";
import { parseQuantity } from "../metrics/format";
import {
  controlledValuesFor,
  controls,
  policyFor,
  type ContainerPolicy,
  type ContainerRecommendation,
} from "./model";

const { arr, get, record, str } = status;

/** Millicores of a CPU quantity, rounded up as `Quantity.MilliValue()` does; `undefined` when unset or unreadable. */
export function milliOf(value: string | undefined): number | undefined {
  const n = parseQuantity(value);
  return n === undefined ? undefined : Math.ceil(n * 1000 - 1e-9);
}

/** Whole units of a quantity, rounded up as `Quantity.Value()` does. */
export function unitsOf(value: string | undefined): number | undefined {
  const n = parseQuantity(value);
  return n === undefined ? undefined : Math.ceil(n - 1e-9);
}

/** The amount the VPA compares and writes: millicores for CPU, whole units (bytes) for anything else. */
const amountOf = (resource: string, value: string | undefined) => (resource === "cpu" ? milliOf(value) : unitsOf(value));

/** An amount back in base units (cores, bytes). */
export const baseUnits = (resource: string, amount: number): number => (resource === "cpu" ? amount / 1000 : amount);

/** `scaleQuantityProportionally{CPU,Mem}` with `noRounding`: `value × to ÷ from`, the remainder dropped. */
function scale(value: number, from: number, to: number): number {
  return Number((BigInt(value) * BigInt(to)) / BigInt(from));
}

/**
 * `getProportionalResourceLimit` without a LimitRange default: the new limit in amounts (millicores or bytes), or
 * `undefined` when the admission controller sets none (the old limit stays as it is).
 */
export function proportionalLimit(resource: string, limit: number | undefined, request: number | undefined, recommended: number | undefined): number | undefined {
  if (limit === undefined || limit === 0) return undefined;
  if (recommended === undefined || recommended === 0) return undefined;
  if (request === undefined || request === 0) return recommended;
  if (request === limit) return recommended;
  return resource === "cpu" || resource === "memory" ? scale(limit, request, recommended) : undefined;
}

export interface ResourceChange {
  resource: string;
  /** In amounts: millicores for CPU, bytes otherwise. */
  request?: number;
  limit?: number;
  target?: number;
  lowerBound?: number;
  upperBound?: number;
  uncappedTarget?: number;
  /** What a pod created now would get; `undefined` where the value stays as it is. */
  newRequest?: number;
  newLimit?: number;
  /** How the target was adjusted before it was set. */
  capped?: "minAllowed" | "maxAllowed" | "limit";
}

export interface ContainerChange {
  container: string;
  /** The VPA does not scale this container (its policy is `Off`), or has no recommendation for it yet. */
  state: "scaled" | "off" | "noRecommendation";
  controlledValues: string;
  resources: ResourceChange[];
}

/** The requests and limits of a template's container, as quantities. */
function resourcesOf(container: unknown): { requests: Record<string, string>; limits: Record<string, string> } {
  const read = (v: unknown) => Object.fromEntries(Object.entries(record(v)).filter(([, q]) => typeof q === "string" || typeof q === "number").map(([k, q]) => [k, String(q)]));
  return { requests: read(get(container, "resources", "requests")), limits: read(get(container, "resources", "limits")) };
}

/** Keeps `amount` within the policy's bounds for `resource` (`applyVPAPolicy`: min first, then max). */
function withinPolicy(resource: string, amount: number, policy: ContainerPolicy | undefined): { amount: number; capped?: "minAllowed" | "maxAllowed" } {
  if (!policy) return { amount };
  let out = amount;
  let capped: "minAllowed" | "maxAllowed" | undefined;
  const min = amountOf(resource, policy.minAllowed[resource]);
  if (min !== undefined && out < min) {
    out = min;
    capped = "minAllowed";
  }
  const max = amountOf(resource, policy.maxAllowed[resource]);
  if (max !== undefined && out > max) {
    out = max;
    capped = "maxAllowed";
  }
  return { amount: out, capped };
}

/**
 * The change for one container of the template: for each resource of the recommendation's target, the request a pod
 * created now would get and its limit. A container whose policy is `Off` gets nothing; one without a recommendation
 * (the recommender has not seen it yet) keeps its values.
 */
export function containerChange(
  container: unknown,
  policies: readonly ContainerPolicy[],
  recommendation: ContainerRecommendation | undefined,
): ContainerChange {
  const name = str(get(container, "name")) ?? "";
  const policy = policyFor(policies, name);
  const controlledValues = controlledValuesFor(policies, name);
  const { requests, limits } = resourcesOf(container);
  const off = policy?.mode === "Off";
  const resources: ResourceChange[] = [];
  const names = new Set([...Object.keys(recommendation?.target ?? {}), ...(off ? [] : ["cpu", "memory"].filter((r) => controls(policies, name, r)))]);
  for (const resource of [...names].sort()) {
    const request = amountOf(resource, requests[resource]);
    const limit = amountOf(resource, limits[resource]);
    const row: ResourceChange = {
      resource,
      request,
      limit,
      target: amountOf(resource, recommendation?.target[resource]),
      lowerBound: amountOf(resource, recommendation?.lowerBound[resource]),
      upperBound: amountOf(resource, recommendation?.upperBound[resource]),
      uncappedTarget: amountOf(resource, recommendation?.uncappedTarget[resource]),
    };
    if (!off && row.target !== undefined) {
      const kept = withinPolicy(resource, row.target, policy);
      let next = kept.amount;
      row.capped = kept.capped;
      if (controlledValues === "RequestsOnly" && limit !== undefined && next > limit) {
        next = limit;
        row.capped = "limit";
      }
      row.newRequest = next;
      if (controlledValues === "RequestsAndLimits") row.newLimit = proportionalLimit(resource, limit, request, next);
    }
    resources.push(row);
  }
  const state = off ? "off" : recommendation ? "scaled" : "noRecommendation";
  return { container: name, state, controlledValues, resources };
}

/** The containers of a workload's pod template (CronJob: its Job template's). */
export function templateContainers(target: unknown): unknown[] {
  const spec = get(target, "kind") === "CronJob" ? get(target, "spec", "jobTemplate", "spec", "template", "spec") : get(target, "spec", "template", "spec");
  return arr(get(spec, "containers"));
}

/** The changes for every container of `target`'s template, in the template's order. */
export function templateChanges(target: unknown, policies: readonly ContainerPolicy[], recommendations: readonly ContainerRecommendation[]): ContainerChange[] {
  return templateContainers(target).map((c) =>
    containerChange(
      c,
      policies,
      recommendations.find((r) => r.container === str(get(c, "name"))),
    ),
  );
}
