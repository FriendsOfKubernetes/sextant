// Right-sizing rules (#137), pure: what one container requests and is limited to, against what it used, gives a
// recommendation, flags and the waste. Inputs in millicores and bytes.
//
//   CPU request     = p95 of the CPU rate × CPU_REQUEST_HEADROOM, rounded up to 10m
//   memory request  = peak working set × MEMORY_REQUEST_HEADROOM, rounded up to 16Mi
//   memory limit    = peak × MEMORY_LIMIT_HEADROOM (after a recent OOMKill at least the current limit × OOM_LIMIT_RAISE:
//                     the peak was cut off by the limit, so the real need is unknown)
//   CPU limit       = only when one is set now: p95 × CPU_LIMIT_HEADROOM, at least the request (when throttled, at
//                     least the current limit × THROTTLED_LIMIT_RAISE)
//
// A recommendation needs history: a metrics-server snapshot is one point and gives none, and less than
// MIN_HISTORY_SECS of samples gives none either. Between that and FULL_HISTORY_SHARE of the window it is given but
// marked as based on partial history. When Prometheus could not say since when there are samples, the coverage is
// unknown: the recommendation is given and marked so.
import type { ContainerAmounts } from "../metrics/requests";
import { MI, roundCpuUp, roundMemoryUp } from "./units";

export const CPU_REQUEST_HEADROOM = 1.15;
export const CPU_LIMIT_HEADROOM = 2;
export const MEMORY_REQUEST_HEADROOM = 1.15;
export const MEMORY_LIMIT_HEADROOM = 1.3;
export const OOM_LIMIT_RAISE = 1.25;
export const THROTTLED_LIMIT_RAISE = 1.5;
/** Less history than this: no recommendation. */
export const MIN_HISTORY_SECS = 6 * 3600;
/** History covering at least this share of the window counts as full. */
export const FULL_HISTORY_SHARE = 0.9;
/** A request at least this many times the recommendation is over-provisioned… */
export const OVER_PROVISIONED_FACTOR = 2;
/** …when the difference is at least this much (small containers are not worth a flag). */
export const OVER_PROVISIONED_MIN_CPU = 50;
export const OVER_PROVISIONED_MIN_MEMORY = 64 * MI;
/** Memory at or above this share of the limit is at risk. */
export const NEAR_LIMIT_SHARE = 0.9;
/** At or above this share of CFS periods throttled, CPU is throttled. */
export const THROTTLED_SHARE = 0.25;

/** What a container used: from Prometheus history, or a metrics-server snapshot (one point). */
export type UsageStats =
  | {
      kind: "history";
      cpuP95?: number;
      memoryMax?: number;
      throttledRatio?: number;
      /** Seconds of samples inside the window; `undefined` when Prometheus could not say. */
      coverageSecs?: number;
      windowSecs: number;
    }
  | { kind: "snapshot"; cpuNow?: number; memoryNow?: number };

export interface Recommendation {
  cpuRequest: number;
  memoryRequest: number;
  memoryLimit: number;
  /** Only when the container has a CPU limit now. */
  cpuLimit?: number;
}

/**
 * `history`: enough history; `partialHistory`: a recommendation from less than the window; `insufficientHistory`:
 * too little history to recommend; `unknownHistory`: a recommendation from history of unknown length; `snapshot`: only
 * the current value; `noData`: no usage at all.
 */
export type Confidence = "history" | "partialHistory" | "insufficientHistory" | "unknownHistory" | "snapshot" | "noData";

export type Flag =
  | "noCpuRequest"
  | "noMemoryRequest"
  | "noCpuLimit"
  | "noMemoryLimit"
  | "cpuOverProvisioned"
  | "memoryOverProvisioned"
  | "cpuUnderRequested"
  | "memoryUnderRequested"
  | "memoryNearLimit"
  | "oomKilled"
  | "cpuThrottled";

export type FlagSeverity = "risk" | "waste" | "missing" | "info";

export const FLAG_SEVERITY: Record<Flag, FlagSeverity> = {
  oomKilled: "risk",
  memoryNearLimit: "risk",
  cpuThrottled: "risk",
  memoryUnderRequested: "risk",
  cpuOverProvisioned: "waste",
  memoryOverProvisioned: "waste",
  noCpuRequest: "missing",
  noMemoryRequest: "missing",
  noMemoryLimit: "missing",
  noCpuLimit: "info",
  cpuUnderRequested: "info",
};

const SEVERITY_ORDER: FlagSeverity[] = ["risk", "waste", "missing", "info"];

export interface Assessment {
  confidence: Confidence;
  recommendation?: Recommendation;
  /** Most severe first. */
  flags: Flag[];
  /** Request above the recommendation, per pod (0 when not above or not set); `null` without a recommendation. */
  waste: { cpu: number; memory: number } | null;
}

export interface AssessInput {
  amounts: ContainerAmounts;
  usage?: UsageStats;
  /** The container was OOMKilled recently. */
  oomKilled: boolean;
}

/** The confidences a recommendation is given at. */
export const RECOMMENDING: ReadonlySet<Confidence> = new Set<Confidence>(["history", "partialHistory", "unknownHistory"]);

function confidenceOf(usage: UsageStats | undefined): Confidence {
  if (!usage) return "noData";
  if (usage.kind === "snapshot")
    return usage.cpuNow === undefined && usage.memoryNow === undefined ? "noData" : "snapshot";
  if (usage.cpuP95 === undefined && usage.memoryMax === undefined) return "noData";
  if (usage.coverageSecs === undefined) return "unknownHistory";
  if (usage.coverageSecs < MIN_HISTORY_SECS) return "insufficientHistory";
  return usage.coverageSecs >= usage.windowSecs * FULL_HISTORY_SHARE ? "history" : "partialHistory";
}

/** The recommendation from history; `undefined` when CPU or memory is unknown. */
export function recommend(
  amounts: ContainerAmounts,
  usage: { cpuP95?: number; memoryMax?: number; throttledRatio?: number },
  oomKilled: boolean,
): Recommendation | undefined {
  const { cpuP95, memoryMax } = usage;
  if (cpuP95 === undefined || memoryMax === undefined) return undefined;
  const cpuRequest = roundCpuUp(cpuP95 * CPU_REQUEST_HEADROOM);
  const memoryRequest = roundMemoryUp(memoryMax * MEMORY_REQUEST_HEADROOM);
  let memoryLimit = roundMemoryUp(memoryMax * MEMORY_LIMIT_HEADROOM);
  const currentMemoryLimit = amounts.memory.limit;
  if (oomKilled && currentMemoryLimit !== undefined)
    memoryLimit = Math.max(memoryLimit, roundMemoryUp(currentMemoryLimit * OOM_LIMIT_RAISE));
  memoryLimit = Math.max(memoryLimit, memoryRequest);
  const result: Recommendation = { cpuRequest, memoryRequest, memoryLimit };
  const currentCpuLimit = amounts.cpu.limit;
  if (currentCpuLimit !== undefined) {
    let cpuLimit = Math.max(cpuRequest, roundCpuUp(cpuP95 * CPU_LIMIT_HEADROOM));
    if ((usage.throttledRatio ?? 0) >= THROTTLED_SHARE)
      cpuLimit = Math.max(cpuLimit, roundCpuUp(currentCpuLimit * THROTTLED_LIMIT_RAISE));
    result.cpuLimit = cpuLimit;
  }
  return result;
}

function overProvisioned(request: number | undefined, recommended: number, minDifference: number): boolean {
  return (
    request !== undefined &&
    request >= recommended * OVER_PROVISIONED_FACTOR &&
    request - recommended >= minDifference
  );
}

export function assess({ amounts, usage, oomKilled }: AssessInput): Assessment {
  const flags = new Set<Flag>();
  const { cpu, memory } = amounts;
  if (cpu.request === undefined) flags.add("noCpuRequest");
  if (memory.request === undefined) flags.add("noMemoryRequest");
  if (cpu.limit === undefined) flags.add("noCpuLimit");
  if (memory.limit === undefined) flags.add("noMemoryLimit");
  if (oomKilled) flags.add("oomKilled");

  const confidence = confidenceOf(usage);
  // The highest memory seen: the peak of the history, or the value now.
  const memoryPeak = usage?.kind === "history" ? usage.memoryMax : usage?.memoryNow;
  if (memoryPeak !== undefined && memory.limit !== undefined && memory.limit > 0 && memoryPeak >= memory.limit * NEAR_LIMIT_SHARE)
    flags.add("memoryNearLimit");
  if (usage?.kind === "history" && (usage.throttledRatio ?? 0) >= THROTTLED_SHARE) flags.add("cpuThrottled");

  let recommendation: Recommendation | undefined;
  let waste: Assessment["waste"] = null;
  if (usage?.kind === "history" && RECOMMENDING.has(confidence)) {
    recommendation = recommend(amounts, usage, oomKilled);
    if (usage.cpuP95 !== undefined && cpu.request !== undefined && cpu.request < usage.cpuP95) flags.add("cpuUnderRequested");
    if (usage.memoryMax !== undefined && memory.request !== undefined && memory.request < usage.memoryMax)
      flags.add("memoryUnderRequested");
  }
  if (recommendation) {
    if (overProvisioned(cpu.request, recommendation.cpuRequest, OVER_PROVISIONED_MIN_CPU)) flags.add("cpuOverProvisioned");
    if (overProvisioned(memory.request, recommendation.memoryRequest, OVER_PROVISIONED_MIN_MEMORY))
      flags.add("memoryOverProvisioned");
    waste = {
      cpu: cpu.request === undefined ? 0 : Math.max(0, cpu.request - recommendation.cpuRequest),
      memory: memory.request === undefined ? 0 : Math.max(0, memory.request - recommendation.memoryRequest),
    };
  }
  const ordered = [...flags].sort(
    (a, b) => SEVERITY_ORDER.indexOf(FLAG_SEVERITY[a]) - SEVERITY_ORDER.indexOf(FLAG_SEVERITY[b]),
  );
  return { confidence, recommendation, flags: ordered, waste };
}
