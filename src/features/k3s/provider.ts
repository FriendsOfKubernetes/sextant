// The problems category "k3s / RKE2" (#270, ADR-0123), on by default (a cluster has a few dozen HelmCharts at most,
// their Jobs, and kube-system's Deployments). Three problems:
//   - HelmChartFailed: a HelmChart whose install Job failed — the Job's Failed condition (it ended after
//     `backOffLimit` failed pods) or helm-controller's own `Failed` condition — counted from the Job's failure for
//     `FAILED_FOR_MS` (a day); with only the condition (no time on it) while the condition holds;
//   - HelmChartRetrying: its Job still runs after `RETRY_ATTEMPTS` failed pods (helm-controller's default
//     `backOffLimit` is 1000, so a broken chart may never end Failed), counted `RETRY_GRACE_MS` after first seen;
//   - ComponentUnavailable: a known bundled component's Deployment in kube-system (k3s's coredns, traefik,
//     local-path-provisioner, metrics-server; the workloads of RKE2's `rke2-*` charts, `COMPONENTS` in model.ts) not
//     available, counted `UNAVAILABLE_GRACE_MS` after its Available condition went False (else after first seen).
// Held only where the cluster serves HelmCharts; the components are judged only where it serves k3s Addons as well
// (a k3s or RKE2 server). The watches, all shared (`acquireWatch`): HelmCharts (≤ `MAX_CHARTS`), the Jobs labelled
// `helmcharts.helm.cattle.io/chart` (a label selector on the API server, ≤ `MAX_JOBS`) and kube-system's Deployments
// (≤ `MAX_DEPLOYMENTS`). The values of a chart never reach a problem. Agents get none of it (NEVER_FOR_AGENTS).
// A user who may not list Namespaces (#285) watches the HelmCharts and Jobs of the accessible namespaces
// (`restrictedScope`) instead of cluster-wide; when that scope moves, the problems store starts its sources again.
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { restrictedScope } from "../namespaces/accessStore";
import type { Problem } from "../problems/model";
import { registerProblemProvider, type ProvidedProblems } from "../problems/store";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import {
  ADDON,
  CHART_LABEL,
  chartFailureOf,
  componentOfDeployment,
  DEPLOYMENT,
  HELM_CHART,
  helmConditionOf,
  jobInfoOf,
  jobOfChart,
  KUBE_SYSTEM,
  workloadStateOf,
} from "./model";

export const MAX_CHARTS = 500;
export const MAX_JOBS = 1000;
export const MAX_DEPLOYMENTS = 1000;
export const FAILED_FOR_MS = 24 * 3600_000;
export const RETRY_ATTEMPTS = 3;
export const RETRY_GRACE_MS = 5 * 60_000;
export const UNAVAILABLE_GRACE_MS = 10 * 60_000;
export const LOOK_DELAY_MS = 200;

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

const uidOf = (obj: KubeObject) => obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
const deleting = (obj: KubeObject) => Boolean((obj.metadata as { deletionTimestamp?: string } | undefined)?.deletionTimestamp);

export interface Inputs {
  charts: Iterable<KubeObject>;
  /** The Jobs labelled for charts; `undefined` when not read in full (a chart's own condition still counts). */
  jobs: readonly KubeObject[] | undefined;
  /** kube-system's Deployments; `undefined`: not judged (not a k3s/RKE2 server, or not read in full). */
  deployments: Iterable<KubeObject> | undefined;
}

/** When each problem was first seen. */
export type Seen = Map<string, number>;

/** The category's problems; `seen` keeps when each was first seen. */
export function toProblems(input: Inputs, seen: Seen, now: number): Problem[] {
  const keys = new Set<string>();
  const out: Problem[] = [];
  const add = (obj: KubeObject, kind: typeof HELM_CHART, reason: string, extra: Omit<Partial<Problem>, "activeAt"> & { activeAt: (first: number) => number }) => {
    const uid = uidOf(obj);
    const key = `${uid}|${reason}`;
    keys.add(key);
    const first = seen.get(key) ?? now;
    seen.set(key, first);
    const { activeAt, ...rest } = extra;
    out.push({
      key,
      notifyKey: key,
      category: "k3s",
      uid,
      object: { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" },
      reason,
      group: reason,
      notify: true,
      firstSeen: first,
      activeAt: activeAt(first),
      ...rest,
    });
  };
  for (const chart of input.charts) {
    if (deleting(chart)) continue;
    const job = input.jobs ? jobOfChart(chart, input.jobs) : undefined;
    const info = job ? jobInfoOf(job) : undefined;
    const conditionFailed = helmConditionOf(chart, "Failed")?.status === "True";
    if (info?.state === "failed" || conditionFailed) {
      const failedAt = info?.state === "failed" ? time(info.failedAt) : undefined;
      const message = chartFailureOf(chart, job);
      add(chart, HELM_CHART, "HelmChartFailed", {
        ...(message ? { message } : { messageKey: "messages.k3sHelmChartFailed", messageParams: { job: info?.name ?? "" } }),
        ...(info?.failedAt ? { since: info.failedAt } : {}),
        ...(failedAt !== undefined ? { until: failedAt + FAILED_FOR_MS } : {}),
        activeAt: (first) => failedAt ?? first,
      });
      continue;
    }
    if (info?.state === "running" && info.failed >= RETRY_ATTEMPTS) {
      add(chart, HELM_CHART, "HelmChartRetrying", {
        messageKey: "messages.k3sHelmChartRetrying",
        messageParams: { job: info.name, failed: info.failed },
        activeAt: (first) => first + RETRY_GRACE_MS,
      });
    }
  }
  for (const deployment of input.deployments ?? []) {
    if (deleting(deployment)) continue;
    const def = componentOfDeployment(deployment);
    if (!def) continue;
    const state = workloadStateOf("Deployment", deployment);
    if (state.ready) continue;
    const since = time(state.unavailableSince);
    add(deployment, DEPLOYMENT, "ComponentUnavailable", {
      messageKey: "messages.k3sComponentUnavailable",
      messageParams: { deployment: state.name, available: state.available, desired: state.desired },
      ...(state.unavailableSince ? { since: state.unavailableSince } : {}),
      activeAt: (first) => (since ?? first) + UNAVAILABLE_GRACE_MS,
    });
  }
  for (const key of [...seen.keys()]) if (!keys.has(key)) seen.delete(key);
  return out;
}

/** The objects of a watch read in full; else `undefined`. */
export function readInFull(state: WatchState | undefined): KubeObject[] | undefined {
  if (!state || state.status !== "ready" || isCapped(state) || (state.forbidden ?? []).length > 0) return undefined;
  return [...state.items.values()];
}

export const JOBS_SELECTOR = CHART_LABEL;

/** Provides the category's problems of one cluster through `set`; returns the function that stops it. */
export function provideK3s(clusterId: ClusterId, set: (update: ProvidedProblems) => void): () => void {
  const seen: Seen = new Map();
  const held = new Map<string, () => void>();
  let epoch = epochOf(clusterId);
  let last: unknown[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hold = (wanted: { spec: WatchSpec; cap: number }[]) => {
    const keys = new Set(wanted.map((w) => specKey(clusterId, w.spec)));
    for (const [key, release] of [...held]) {
      if (keys.has(key)) continue;
      release();
      held.delete(key);
    }
    for (const { spec, cap } of wanted) {
      const key = specKey(clusterId, spec);
      if (!held.has(key)) held.set(key, acquireWatch(clusterId, spec, cap));
    }
  };

  const look = () => {
    if (epochOf(clusterId) !== epoch) {
      hold([]);
      epoch = epochOf(clusterId);
      last = undefined;
    }
    const kinds = knownClusterKinds(clusterId);
    const chartKind = kinds ? findKind(kinds, HELM_CHART)?.kindRef : undefined;
    if (!chartKind) {
      hold([]);
      if (last?.[0] !== "none") set({ status: kinds ? "ready" : "loading", problems: [] });
      last = ["none"];
      return;
    }
    const server = Boolean(findKind(kinds!, ADDON));
    const scope = restrictedScope(clusterId);
    const chartSpec: WatchSpec = { kind: chartKind, namespaces: scope, labelSelector: null, fieldSelector: null };
    const jobSpec: WatchSpec = { kind: { group: "batch", version: "v1", kind: "Job" }, namespaces: scope, labelSelector: JOBS_SELECTOR, fieldSelector: null };
    const deploymentSpec: WatchSpec = { kind: DEPLOYMENT, namespaces: [KUBE_SYSTEM], labelSelector: null, fieldSelector: null };
    hold([
      { spec: chartSpec, cap: MAX_CHARTS },
      { spec: jobSpec, cap: MAX_JOBS },
      ...(server ? [{ spec: deploymentSpec, cap: MAX_DEPLOYMENTS }] : []),
    ]);
    const charts = watchState(clusterId, chartSpec);
    const jobs = watchState(clusterId, jobSpec);
    const deployments = server ? watchState(clusterId, deploymentSpec) : undefined;
    const inputs = [charts, jobs, deployments];
    if (last && last.length === inputs.length && inputs.every((x, i) => last![i] === x)) return;
    last = inputs;
    if (inputs.some((s) => s?.status === "loading")) {
      set({ status: "loading", problems: [] });
      return;
    }
    if (charts.status === "error") {
      set({ status: "error", error: charts.error, problems: [] });
      return;
    }
    set({
      status: "ready",
      problems: toProblems({ charts: charts.items.values(), jobs: readInFull(jobs), deployments: readInFull(deployments) }, seen, Date.now()),
      truncated: isCapped(charts) || isCapped(jobs) || (deployments !== undefined && isCapped(deployments)),
    });
  };

  const unsubscribe = subscribeSharedWatches(() => {
    timer ??= setTimeout(() => {
      timer = undefined;
      look();
    }, LOOK_DELAY_MS);
  });
  look();
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    hold([]);
  };
}

registerProblemProvider("k3s", provideK3s);
