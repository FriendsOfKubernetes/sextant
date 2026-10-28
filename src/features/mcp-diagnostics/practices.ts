// The "Best practices" problems for an agent (`get_problems`, ADR-0094). The checks judge a workload against what
// surrounds it — its namespace's HPAs, PodDisruptionBudgets and LimitRanges, its live pods and the cluster's Nodes —
// and every one of them is skipped when its input is unknown (`practices/checks.ts`). With Read on every input in all
// namespaces the agent gets the problems store's shared category (the screen's own provider); otherwise the checks run
// here per namespace, on watches of only the namespaces the agent may read, each input known only where it may read
// it (the Nodes only with Read on Nodes), so no finding rests on something the agent may not read. Each finding also
// says what it rests on (`practiceRefs`), and the backend checks that again.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useSettings, type ClusterId, type KindRef, type KubeObject, type ReadRule, type WatchSpec, type WatchState } from "../../api";
import { CRONJOB, DAEMONSET, DEPLOYMENT, JOB, NODE, POD, STATEFULSET, type Problem } from "../problems/model";
import { sourceKey } from "../problems/sources";
import { acquireRows, epochOf, getRows, sourcesVersion, subscribeSources, type RowTap } from "../problems/store";
import { evaluateAll } from "../practices/checks";
import { practicesConfigOf } from "../practices/config";
import { contextFrom, HPA, LIMIT_RANGE, PDB } from "../practices/hooks";
import { workloadInfo, type CheckId, type PracticeFinding, type WorkloadInfo } from "../practices/model";
import { practiceProblems } from "../practices/problems";
import { NODE_SOURCE, NODE_TAP_DEF, type SchedulingNode } from "../practices/taps";
import { useSharedWatches } from "../resource-map/watches";
import { canRead, failuresOf, type FailedList, type ListRef } from "./scope";

const WORKLOAD_KINDS: readonly KindRef[] = [DEPLOYMENT, STATEFULSET, DAEMONSET, JOB, CRONJOB];
/** The workload kinds the checks judge. */
export const WORKLOAD_INPUTS = WORKLOAD_KINDS;
/** Every list the checks read. */
export const PRACTICE_INPUTS: readonly KindRef[] = [...WORKLOAD_KINDS, HPA, PDB, LIMIT_RANGE, POD, NODE];

/** Whether the agent may read every input of the checks in all namespaces (then the shared category serves it). */
export const readsAllPracticeInputs = (reads: readonly ReadRule[]) => PRACTICE_INPUTS.every((k) => canRead(reads, k, null));

const ref = (kind: KindRef, namespace: string | null): ListRef => ({ group: kind.group, kind: kind.kind, namespace });

/** What a check's finding about a workload in `namespace` rests on. */
export function practiceRefs(check: string, namespace: string): ListRef[] {
  switch (check as CheckId) {
    case "singleReplica":
    case "hpaMinEqualsMax":
      return [ref(HPA, namespace)];
    case "noPdb":
    case "pdbBlocksDisruption":
      return [ref(PDB, namespace)];
    case "sameNode":
      return [ref(POD, namespace), ref(NODE, null)];
    case "noRequests":
    case "noMemoryLimit":
      return [ref(LIMIT_RANGE, namespace)];
    default:
      return [];
  }
}

/** The objects a watch read in `namespace`; `undefined` when it did not read that namespace in full. */
function readIn(state: WatchState | undefined, watched: readonly string[], namespace: string): KubeObject[] | undefined {
  if (!state || state.status !== "ready" || !watched.includes(namespace) || (state.forbidden ?? []).includes(namespace)) return undefined;
  return [...state.items.values()].filter((o) => o.metadata?.namespace === namespace);
}

/** The nodes that take pods, from the problems store's shared Node tap, only while `enabled`. */
function useNodes(clusterId: ClusterId, enabled: boolean): { loading: boolean; nodes: SchedulingNode[] | undefined } {
  const version = useSyncExternalStore(subscribeSources, sourcesVersion, sourcesVersion);
  const epoch = epochOf(clusterId);
  useEffect(() => (enabled ? acquireRows(clusterId, NODE_SOURCE, NODE_TAP_DEF as RowTap) : undefined), [clusterId, epoch, enabled]);
  return useMemo(() => {
    void version;
    if (!enabled) return { loading: false, nodes: undefined };
    const state = getRows(sourceKey(clusterId, NODE_SOURCE), NODE_TAP_DEF.id);
    if (!state || state.status === "loading") return { loading: true, nodes: undefined };
    if (state.status === "error" || state.truncated) return { loading: false, nodes: undefined };
    return { loading: false, nodes: [...state.rows.values()].filter((n): n is SchedulingNode => n !== null) };
  }, [clusterId, version, epoch, enabled]);
}

export interface AgentPractices {
  loading: boolean;
  /** The findings as problems (computed when called); `truncated`: workloads were left out. */
  problems: () => { problems: Problem[]; truncated: boolean };
  /** The lists that could not be read. */
  failed: () => FailedList[];
}

/**
 * The best-practice problems in `namespaces` (each list only where the agent may read it) while `enabled`, from the
 * shared watches.
 */
export function useAgentPractices(
  clusterId: ClusterId,
  reads: readonly ReadRule[],
  namespaces: readonly string[],
  enabled: boolean,
): AgentPractices {
  const settings = useSettings().settings;
  const kinds: KindRef[] = [...WORKLOAD_KINDS, HPA, PDB, LIMIT_RANGE, POD];
  const where = kinds.map((k) => (enabled ? namespaces.filter((ns) => canRead(reads, k, ns)) : []));
  const plan = kinds.map((_, i) => i).filter((i) => where[i]!.length > 0);
  const specs: WatchSpec[] = plan.map((i) => ({ kind: kinds[i]!, namespaces: where[i]!, labelSelector: null, fieldSelector: null }));
  const states = useSharedWatches(clusterId, specs);
  const nodes = useNodes(clusterId, enabled && canRead(reads, NODE, null));
  const listIn = (i: number, ns: string) => {
    const at = plan.indexOf(i);
    return at < 0 ? undefined : readIn(states[at], where[i]!, ns);
  };
  const loading = enabled && (states.some((s) => s.status === "loading") || nodes.loading);
  const problems = () => {
    const workloads: WorkloadInfo[] = [];
    const findings = new Map<string, PracticeFinding[]>();
    for (const ns of namespaces) {
      const here: WorkloadInfo[] = [];
      WORKLOAD_KINDS.forEach((kind, i) => {
        for (const obj of listIn(i, ns) ?? []) {
          const info = workloadInfo(kind.kind, obj);
          if (info) here.push(info);
        }
      });
      if (here.length === 0) continue;
      const base = WORKLOAD_KINDS.length;
      const ctx = contextFrom({
        hpas: listIn(base, ns),
        pdbs: listIn(base + 1, ns),
        limitRanges: listIn(base + 2, ns),
        pods: listIn(base + 3, ns),
        schedulableNodes: nodes.nodes,
      });
      for (const [uid, list] of evaluateAll(here, ctx)) findings.set(uid, list);
      workloads.push(...here);
    }
    return practiceProblems(workloads, findings, practicesConfigOf(settings), new Map(), Date.now());
  };
  const failed = (): FailedList[] => plan.flatMap((i, at) => failuresOf("practices", kinds[i]!, states[at]));
  return { loading, problems, failed };
}
