// The best-practice checks (#207) of one workload against what surrounds it, pure. Conservative on purpose: a check
// that needs something unknown (the HPAs, the PodDisruptionBudgets, the LimitRanges, the live pods, the right-sizing
// history) is skipped rather than guessed, and common valid setups are left alone:
//
// - probes: only long-running pods (Deployments, StatefulSets; DaemonSets for readiness only — node agents are often
//   watched by other means, and a liveness restart loop there hits a whole node; Jobs and CronJobs never); one probe of
//   a kind anywhere in the pod is enough (a sidecar needs none of its own); a readiness probe is asked for only when a
//   container declares a port (a worker that serves nothing is never routed to); init containers are skipped;
// - images: a digest pins the image (`@sha256:…`); `imagePullPolicy: Always` is flagged only on a digest;
// - one replica: Deployments and StatefulSets with `spec.replicas: 1` (0 is a scaled-down workload; a Deployment with
//   the `Recreate` strategy runs one pod at a time on purpose); an HPA whose minimum is 1 counts as one replica;
// - PodDisruptionBudgets: missing only with more than one replica; blocking when `maxUnavailable` is 0 or
//   `minAvailable` leaves no pod to evict at the current replicas (the HPA's scale) and the PDB's expected pods;
// - one node: two or more live replicas on one node, without topology spread or pod anti-affinity, in a cluster with
//   at least two schedulable nodes;
// - requests: CPU and memory requests (a limit set alone is also the request); a LimitRange default of the namespace
//   counts as set. Limits: only a memory limit is asked for (a CPU limit throttles and is often left out on purpose);
// - limits far above the right-sizing recommendation (#137): only from Prometheus history, never a snapshot.
import type { Recommendation } from "../rightsizing/recommend";
import { cpuQuantity, memoryQuantity } from "../rightsizing/units";
import { imageRepository, imageTag } from "../security/pss";
import { matches } from "../resource-map/selectors";
import {
  cpuMillicores,
  memoryBytes,
  workloadKey,
  type ContainerInfo,
  type HpaInfo,
  type LimitDefaults,
  type PdbInfo,
  type Placement,
  type PracticeFinding,
  type WorkloadInfo,
} from "./model";

/** A limit at least this many times the recommendation is far above it… */
export const LIMIT_FACTOR = 2;
/** …when the difference is at least this much. */
export const LIMIT_MIN_CPU = 100;
export const LIMIT_MIN_MEMORY = 128 * 2 ** 20;

/** What surrounds the workloads; `undefined` fields are unknown, and the checks that need them are skipped. */
export interface Context {
  hpas?: readonly HpaInfo[];
  pdbs?: readonly PdbInfo[];
  /** LimitRange defaults of the namespaces looked at (a namespace without any is absent). */
  limits?: ReadonlyMap<string, LimitDefaults>;
  /** Nodes of the live pods, by workload key (`workloadKey`). */
  nodes?: ReadonlyMap<string, readonly string[]>;
  schedulableNodes?: number;
  /** Right-sizing recommendations from history, by workload key and container. */
  recommendations?: ReadonlyMap<string, ReadonlyMap<string, Recommendation>>;
}

/** The LimitRange defaults of every namespace, merged. */
export function indexLimits(rows: Iterable<LimitDefaults>): Map<string, LimitDefaults> {
  const out = new Map<string, LimitDefaults>();
  for (const r of rows) {
    const seen = out.get(r.namespace);
    out.set(
      r.namespace,
      seen
        ? {
            namespace: r.namespace,
            cpuRequest: seen.cpuRequest || r.cpuRequest,
            memoryRequest: seen.memoryRequest || r.memoryRequest,
            memoryLimit: seen.memoryLimit || r.memoryLimit,
          }
        : r,
    );
  }
  return out;
}

/** Nodes of the live pods by workload. */
export function indexPlacements(rows: Iterable<Placement | null>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of rows) {
    if (!p) continue;
    const list = out.get(p.workload);
    if (list) list.push(p.node);
    else out.set(p.workload, [p.node]);
  }
  return out;
}

const LONG_RUNNING = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const REPLICATED = new Set(["Deployment", "StatefulSet"]);

/** Builds paths and fixes under a workload's pod template. */
class At {
  readonly root: string;
  constructor(private readonly w: WorkloadInfo) {
    this.root = `${w.prefix.join(".")}.`;
  }
  wrap(fragment: Record<string, unknown>): Record<string, unknown> {
    let out = fragment;
    for (const key of [...this.w.prefix].reverse()) out = { [key]: out };
    return out;
  }
  container(c: ContainerInfo, field: string): string {
    return `${this.root}spec.${c.list}[${c.index}].${field}`;
  }
  containerFix(c: ContainerInfo, fields: Record<string, unknown>): Record<string, unknown> {
    return this.wrap({ spec: { [c.list]: [{ name: c.name, ...fields }] } });
  }
}

/** The containers that run as long as the pod: the regular ones and the native sidecars. */
const running = (w: WorkloadInfo) => w.containers.filter((c) => c.list === "containers" || c.sidecar);

function probes(w: WorkloadInfo, at: At, out: PracticeFinding[]): void {
  if (!LONG_RUNNING.has(w.kind)) return;
  const live = running(w);
  const mains = live.filter((c) => c.list === "containers");
  if (mains.length === 0) return;
  const served = mains.find((c) => c.port !== undefined);
  if (served && !live.some((c) => c.readiness)) {
    out.push({
      check: "readinessProbe",
      severity: "medium",
      path: at.container(served, "readinessProbe"),
      container: served.name,
      fixType: "patch",
      fix: at.containerFix(served, { readinessProbe: { tcpSocket: { port: served.port }, periodSeconds: 10 } }),
      params: { port: served.port! },
    });
  }
  if (w.kind !== "DaemonSet" && !live.some((c) => c.liveness)) {
    const main = served ?? mains[0]!;
    const probe = main.port !== undefined ? { tcpSocket: { port: main.port } } : { exec: { command: ["<command>"] } };
    out.push({
      check: "livenessProbe",
      severity: "low",
      path: at.container(main, "livenessProbe"),
      container: main.name,
      fixType: "patch",
      fix: at.containerFix(main, { livenessProbe: { ...probe, periodSeconds: 10, failureThreshold: 3 } }),
    });
  }
}

function images(w: WorkloadInfo, at: At, out: PracticeFinding[]): void {
  for (const c of w.containers) {
    if (!c.image) continue;
    const digest = c.image.includes("@");
    const tag = imageTag(c.image);
    if (!digest && (tag === undefined || tag === "latest")) {
      out.push({
        check: "mutableImage",
        severity: "medium",
        path: at.container(c, "image"),
        value: c.image,
        container: c.name,
        fixType: "patch",
        fix: at.containerFix(c, { image: `${imageRepository(c.image)}:<version>` }),
      });
    }
    if (digest && c.pullPolicy === "Always") {
      out.push({
        check: "pullAlwaysDigest",
        severity: "low",
        path: at.container(c, "imagePullPolicy"),
        value: c.pullPolicy,
        container: c.name,
        fixType: "patch",
        fix: at.containerFix(c, { imagePullPolicy: "IfNotPresent" }),
      });
    }
  }
}

/** The HPA that scales the workload, if any (the first by name when several do). */
export function hpaOf(w: Pick<WorkloadInfo, "namespace" | "kind" | "name">, hpas: readonly HpaInfo[] | undefined): HpaInfo | undefined {
  return hpas
    ?.filter((h) => h.namespace === w.namespace && h.targetKind === w.kind && h.targetName === w.name)
    .sort((a, b) => a.name.localeCompare(b.name))[0];
}

function replicas(w: WorkloadInfo, hpa: HpaInfo | undefined, out: PracticeFinding[]): void {
  if (!REPLICATED.has(w.kind) || w.replicas === undefined || w.replicas === 0) return;
  if (hpa && hpa.min <= 1 && !w.recreate) {
    out.push({
      check: "singleReplica",
      severity: "low",
      path: "spec.minReplicas",
      value: String(hpa.min),
      on: { kind: "HorizontalPodAutoscaler", name: hpa.name },
      fixType: "patch",
      fix: { spec: { minReplicas: 2 } },
      params: { hpa: hpa.name },
    });
  } else if (!hpa && w.replicas === 1 && !w.recreate) {
    out.push({
      check: "singleReplica",
      severity: w.kind === "Deployment" ? "medium" : "low",
      path: "spec.replicas",
      value: "1",
      fixType: "patch",
      fix: { spec: { replicas: 2 } },
    });
  }
  if (hpa && hpa.max !== undefined && hpa.min === hpa.max) {
    out.push({
      check: "hpaMinEqualsMax",
      severity: "low",
      path: "spec.maxReplicas",
      value: String(hpa.max),
      on: { kind: "HorizontalPodAutoscaler", name: hpa.name },
      fixType: "patch",
      fix: { spec: { maxReplicas: Math.max(hpa.min * 2, hpa.min + 1) } },
      params: { hpa: hpa.name, min: hpa.min },
    });
  }
}

/** A percentage (`"25%"`) as a number; `undefined` for anything else. */
function percent(value: string): number | undefined {
  const m = /^(\d+)%$/.exec(value.trim());
  return m ? Number(m[1]) : undefined;
}

/**
 * Whether the budget lets no pod be evicted out of `expected` (rounded up like the disruption controller); `undefined`
 * when a value does not read.
 */
export function allowsNoDisruption(pdb: Pick<PdbInfo, "minAvailable" | "maxUnavailable">, expected: number): boolean | undefined {
  if (expected <= 0) return false;
  const scaled = (v: number | string): number | undefined => {
    if (typeof v === "number") return v;
    const p = percent(v);
    return p === undefined ? undefined : Math.ceil((p * expected) / 100);
  };
  if (pdb.maxUnavailable !== undefined) {
    const n = scaled(pdb.maxUnavailable);
    return n === undefined ? undefined : n <= 0;
  }
  if (pdb.minAvailable !== undefined) {
    const n = scaled(pdb.minAvailable);
    return n === undefined ? undefined : n >= expected;
  }
  return undefined;
}

/** The budgets that select the workload's pods (by its template's labels). */
export function pdbsOf(w: Pick<WorkloadInfo, "namespace" | "templateLabels">, pdbs: readonly PdbInfo[]): PdbInfo[] {
  return pdbs.filter((p) => p.namespace === w.namespace && matches(p.selector, w.templateLabels));
}

/** How many pods each budget expects: its own count or the replicas of the workloads it selects, whichever is more. */
export function expectedPods(pdbs: readonly PdbInfo[], workloads: readonly WorkloadInfo[]): Map<PdbInfo, number> {
  const out = new Map<PdbInfo, number>();
  for (const pdb of pdbs) out.set(pdb, pdb.expectedPods ?? 0);
  const sums = new Map<PdbInfo, number>();
  for (const w of workloads) {
    if (!REPLICATED.has(w.kind) || !w.replicas) continue;
    for (const pdb of pdbsOf(w, pdbs)) sums.set(pdb, (sums.get(pdb) ?? 0) + w.replicas);
  }
  for (const [pdb, sum] of sums) out.set(pdb, Math.max(out.get(pdb) ?? 0, sum));
  return out;
}

function budgets(w: WorkloadInfo, ctx: Context, hpa: HpaInfo | undefined, expected: Map<PdbInfo, number>, out: PracticeFinding[]): void {
  if (!REPLICATED.has(w.kind) || !ctx.pdbs || w.replicas === undefined) return;
  const mine = pdbsOf(w, ctx.pdbs);
  const wanted = Math.max(w.replicas, hpa?.min ?? 0);
  if (mine.length === 0 && w.replicas > 0 && wanted > 1) {
    out.push({
      check: "noPdb",
      severity: "medium",
      path: "spec.replicas",
      value: String(w.replicas),
      fixType: "create",
      fix: {
        apiVersion: "policy/v1",
        kind: "PodDisruptionBudget",
        metadata: { name: w.name, namespace: w.namespace },
        spec: { maxUnavailable: 1, selector: w.selector ?? { matchLabels: w.templateLabels } },
      },
    });
  }
  for (const pdb of mine) {
    const count = Math.max(expected.get(pdb) ?? 0, w.replicas);
    if (allowsNoDisruption(pdb, count) !== true) continue;
    const byMax = pdb.maxUnavailable !== undefined;
    out.push({
      check: "pdbBlocksDisruption",
      severity: "high",
      path: byMax ? "spec.maxUnavailable" : "spec.minAvailable",
      value: String(byMax ? pdb.maxUnavailable : pdb.minAvailable),
      on: { kind: "PodDisruptionBudget", name: pdb.name },
      fixType: "patch",
      fix: { spec: byMax ? { maxUnavailable: 1 } : { minAvailable: null, maxUnavailable: 1 } },
      params: { pdb: pdb.name, pods: count },
    });
  }
}

function placement(w: WorkloadInfo, ctx: Context, at: At, out: PracticeFinding[]): void {
  if (!REPLICATED.has(w.kind) || w.spread || (w.replicas ?? 0) < 2) return;
  if (!ctx.nodes || ctx.schedulableNodes === undefined || ctx.schedulableNodes < 2) return;
  const nodes = ctx.nodes.get(workloadKey(w.namespace, w.kind, w.name)) ?? [];
  if (nodes.length < 2 || new Set(nodes).size !== 1) return;
  const matchLabels = w.selector?.matchLabels;
  const labelSelector =
    matchLabels && typeof matchLabels === "object" && Object.keys(matchLabels).length > 0 ? { matchLabels } : { matchLabels: w.templateLabels };
  out.push({
    check: "sameNode",
    severity: "medium",
    path: `${at.root}spec.topologySpreadConstraints`,
    fixType: "patch",
    fix: at.wrap({
      spec: {
        topologySpreadConstraints: [
          { maxSkew: 1, topologyKey: "kubernetes.io/hostname", whenUnsatisfiable: "ScheduleAnyway", labelSelector },
        ],
      },
    }),
    params: { node: nodes[0]!, count: nodes.length },
  });
}

function resources(w: WorkloadInfo, ctx: Context, at: At, out: PracticeFinding[]): void {
  if (!ctx.limits) return;
  const defaults = ctx.limits.get(w.namespace);
  for (const c of running(w)) {
    // A limit set alone is also the request (API defaulting); a LimitRange default fills what is left.
    const requests: Record<string, string> = {};
    if (!c.requests.cpu && !c.limits.cpu && !defaults?.cpuRequest) requests.cpu = "100m";
    if (!c.requests.memory && !c.limits.memory && !defaults?.memoryRequest) requests.memory = "128Mi";
    const missing = Object.keys(requests);
    if (missing.length > 0) {
      out.push({
        check: "noRequests",
        severity: "medium",
        path: at.container(c, "resources.requests"),
        value: missing.join(", "),
        container: c.name,
        fixType: "patch",
        fix: at.containerFix(c, { resources: { requests } }),
      });
    }
    if (!c.limits.memory && !defaults?.memoryLimit) {
      out.push({
        check: "noMemoryLimit",
        severity: "low",
        path: at.container(c, "resources.limits.memory"),
        container: c.name,
        fixType: "patch",
        fix: at.containerFix(c, { resources: { limits: { memory: c.requests.memory ?? "256Mi" } } }),
      });
    }
  }
}

function overLimits(w: WorkloadInfo, ctx: Context, at: At, out: PracticeFinding[]): void {
  if (!LONG_RUNNING.has(w.kind)) return;
  const recs = ctx.recommendations?.get(workloadKey(w.namespace, w.kind, w.name));
  if (!recs) return;
  for (const c of running(w)) {
    const rec = recs.get(c.name);
    if (!rec) continue;
    const memory = memoryBytes(c.limits.memory);
    if (memory !== undefined && memory >= rec.memoryLimit * LIMIT_FACTOR && memory - rec.memoryLimit >= LIMIT_MIN_MEMORY) {
      const recommended = memoryQuantity(rec.memoryLimit);
      out.push({
        check: "limitsAboveRecommendation",
        severity: "low",
        path: at.container(c, "resources.limits.memory"),
        value: c.limits.memory,
        container: c.name,
        fixType: "patch",
        fix: at.containerFix(c, { resources: { limits: { memory: recommended } } }),
        params: { recommended },
      });
    }
    const cpu = cpuMillicores(c.limits.cpu);
    if (cpu !== undefined && rec.cpuLimit !== undefined && cpu >= rec.cpuLimit * LIMIT_FACTOR && cpu - rec.cpuLimit >= LIMIT_MIN_CPU) {
      const recommended = cpuQuantity(rec.cpuLimit);
      out.push({
        check: "limitsAboveRecommendation",
        severity: "low",
        path: at.container(c, "resources.limits.cpu"),
        value: c.limits.cpu,
        container: c.name,
        fixType: "patch",
        fix: at.containerFix(c, { resources: { limits: { cpu: recommended } } }),
        params: { recommended },
      });
    }
  }
}

/**
 * Every finding of one workload. `expected`: what each budget expects across all the workloads looked at
 * (`expectedPods`); without it, only this workload's replicas and the budget's own count.
 */
export function evaluate(w: WorkloadInfo, ctx: Context, expected?: Map<PdbInfo, number>): PracticeFinding[] {
  const out: PracticeFinding[] = [];
  const at = new At(w);
  const hpa = hpaOf(w, ctx.hpas);
  probes(w, at, out);
  images(w, at, out);
  if (ctx.hpas) replicas(w, hpa, out);
  budgets(w, ctx, hpa, expected ?? expectedPods(ctx.pdbs ?? [], [w]), out);
  placement(w, ctx, at, out);
  resources(w, ctx, at, out);
  overLimits(w, ctx, at, out);
  return out;
}

/** The findings of every workload, by uid. */
export function evaluateAll(workloads: readonly WorkloadInfo[], ctx: Context): Map<string, PracticeFinding[]> {
  const expected = expectedPods(ctx.pdbs ?? [], workloads);
  return new Map(workloads.map((w) => [w.uid, evaluate(w, ctx, expected)]));
}
