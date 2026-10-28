// `get_problems`: the problems screen's findings (ADR-0066), by the same rules (`resolve`, the providers' engines) and
// the same opt-in rule (`useCategoriesOn`), from only what the agent may read (ADR-0094):
// - a kind the agent may read in every namespace comes from the problems store's shared, cluster-wide source (the
//   screen's own watch); a kind it may read only in some namespaces is watched there only (the asked namespace, else
//   the namespaces its rules name) and judged here; a cluster-scoped kind (Nodes) only with Read on it;
// - the categories judged across objects are computed on what the agent may read: Service mesh by `useAgentMesh`,
//   best practices by the shared category only with Read on every input everywhere, else by `useAgentPractices`;
//   disk usage (the kubelets' stats of every node) only with Read on claims and Nodes in all namespaces;
// - what is still loading or was cut is told of the agent's own sources only, a category it cannot have looked at
//   is named in `notChecked`, and a list the API server refused (or that failed) in `failed` — its problems there
//   are unknown, not absent;
// - each finding says what it rests on (`refs`), which the backend checks again.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ClusterId, KindRef, ReadRule, ResourceKind, WatchSpec } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { useCategoriesOn } from "../problems/hooks";
import { needsDiscovery, sourceKey, sourcesFor, type SourceDef } from "../problems/sources";
import { acquireSource, epochOf, getSource, sourcesVersion, subscribeSources, type SourceState } from "../problems/store";
import { VIRTUAL_SERVICE } from "../mesh/kinds";
import { isActive, NODE, PROBLEM_CATEGORIES, PVC, resolve, startedAt, type Problem, type ProblemCategory } from "../problems/model";
import { useSharedWatches } from "../resource-map/watches";
import { en, iso, list } from "./english";
import { meshRefs, useAgentMesh } from "./mesh";
import { practiceRefs, readsAllPracticeInputs, useAgentPractices, WORKLOAD_INPUTS } from "./practices";
import { canRead, failuresOf, objectName, ruleNamespaces, watchedNamespaces, type FailedList, type ListRef } from "./scope";
import { useAnswer, type WorkerProps } from "./worker";

interface Args {
  namespace: string | null;
  categories: string[];
}

/** A problem's message in English: the cluster's own text, or Sextant's phrase. */
export function englishMessage(p: Pick<Problem, "message" | "messageKey" | "messageParams" | "messageLists">): string | undefined {
  if (p.message) return p.message;
  if (!p.messageKey) return undefined;
  const lists = Object.fromEntries(Object.entries(p.messageLists ?? {}).map(([key, items]) => [key, list(items)]));
  return en(`problems:${p.messageKey}`, { ...p.messageParams, ...lists });
}

/** How `get_problems` looks at each category for an agent. */
export interface ProblemPlan {
  /** The problems store's cluster-wide sources: the agent may read their kind in every namespace. */
  shared: SourceDef[];
  /** Sources judged here, watched only in the namespaces the agent may read. */
  watched: { def: SourceDef; spec: WatchSpec }[];
  /** Service mesh findings on what the agent may read (`useAgentMesh`). */
  mesh: boolean;
  /** Best practices per namespace (`useAgentPractices`) in these namespaces; `null`: not that way. */
  practices: string[] | null;
  /** The namespaces the rules name (where a kind is watched that the agent may not read everywhere). */
  ruled: string[];
  /** Categories nothing could be looked at for. */
  notChecked: ProblemCategory[];
  /** The rules name more namespaces than are watched. */
  truncated: boolean;
}

function clusterScoped(def: SourceDef, kinds: ResourceKind[] | null | undefined): boolean {
  if (def.kind.group === NODE.group && def.kind.kind === NODE.kind) return true;
  return def.discovered && !!kinds && findKind(kinds, def.kind)?.namespaced === false;
}

/** The plan of `categories` (served ones, as `sourcesFor` gives them) for an agent that may read `reads`. */
export function planProblems(
  categories: readonly ProblemCategory[],
  kinds: ResourceKind[] | null | undefined,
  reads: readonly ReadRule[],
  asked: string | null,
): ProblemPlan {
  const { namespaces: ruled, truncated } = ruleNamespaces(reads);
  const may = (kind: Pick<KindRef, "group" | "kind">, ns: string | null) => canRead(reads, kind, ns);
  const plan: ProblemPlan = { shared: [], watched: [], mesh: false, practices: null, ruled, notChecked: [], truncated };
  const scope = asked ? [asked] : ruled;
  for (const category of categories) {
    const defs = sourcesFor([category], kinds);
    if (defs.length === 0) continue;
    let planned = false;
    if (category === "disk") {
      // Polls the kubelets' stats of every node: only for an agent that may read every claim and node.
      if (may(PVC, null) && may(NODE, null)) {
        plan.shared.push(...defs);
        planned = true;
      }
    } else if (category === "mesh") {
      plan.mesh = may(VIRTUAL_SERVICE, null) || ruled.some((ns) => may(VIRTUAL_SERVICE, ns));
      planned = plan.mesh;
    } else if (category === "practices") {
      if (readsAllPracticeInputs(reads)) {
        plan.shared.push(...defs);
        planned = true;
      } else if (scope.some((ns) => WORKLOAD_INPUTS.some((k) => may(k, ns)))) {
        plan.practices = scope;
        planned = true;
      }
    } else {
      for (const def of defs) {
        if (clusterScoped(def, kinds)) {
          // A namespace's problems hold no cluster-scoped object: nothing to look at then.
          if (asked) planned = true;
          else if (may(def.kind, null)) {
            plan.shared.push(def);
            planned = true;
          }
          continue;
        }
        const namespaces = watchedNamespaces(reads, def.kind, null, scope);
        if (namespaces === null) {
          plan.shared.push(def);
          planned = true;
        } else if (namespaces.length > 0) {
          plan.watched.push({ def, spec: { kind: def.kind, namespaces, labelSelector: null, fieldSelector: def.fieldSelector } });
          planned = true;
        }
      }
    }
    if (!planned) plan.notChecked.push(category);
  }
  return plan;
}

/** Holds the problems store's sources `defs` while mounted (shared with the screen); their states. */
function useStoreSources(clusterId: ClusterId, defs: readonly SourceDef[]): SourceState[] {
  const keys = JSON.stringify(defs.map((d) => sourceKey(clusterId, d)));
  const version = useSyncExternalStore(subscribeSources, sourcesVersion, sourcesVersion);
  // A new connection (or its loss) dropped the cluster's sources: acquire them again.
  const epoch = epochOf(clusterId);
  useEffect(() => {
    const releases = defs.map((def) => acquireSource(clusterId, def));
    return () => {
      for (const release of releases) release();
    };
    // `keys` stands for `defs`.
  }, [clusterId, keys, epoch]);
  return useMemo(
    () => {
      void version;
      return (JSON.parse(keys) as string[]).map((key) => getSource(key)).filter((s): s is SourceState => s !== undefined);
    },
    [keys, version],
  );
}

const EMPTY: never[] = [];

export function ProblemsWorker(props: WorkerProps) {
  const { request } = props;
  const args = request.args as unknown as Args;
  const asked = useMemo(
    () => PROBLEM_CATEGORIES.filter((c) => args.categories.includes(c)) as ProblemCategory[],
    [args.categories],
  );
  const categories = useCategoriesOn(asked);
  // The plan waits for discovery when a tool's kinds (or the mesh) are asked for.
  const discovery = useClusterKinds(needsDiscovery(categories) ? request.clusterId : null);
  const kinds = discovery.kinds ?? (discovery.error ? null : undefined);
  const settled = !needsDiscovery(categories) || kinds !== undefined;
  const plan = useMemo(
    () => (settled ? planProblems(categories, kinds, request.reads, args.namespace) : null),
    [settled, categories, kinds, request.reads, args.namespace],
  );
  const shared = useStoreSources(request.clusterId, plan?.shared ?? EMPTY);
  const watched = plan?.watched ?? EMPTY;
  const watchedStates = useSharedWatches(
    request.clusterId,
    watched.map((w) => w.spec),
  );
  const mesh = useAgentMesh(request.clusterId, request.reads, kinds, plan?.ruled ?? EMPTY, !!plan?.mesh);
  const practices = useAgentPractices(request.clusterId, request.reads, plan?.practices ?? EMPTY, !!plan?.practices);

  const sharedLoading = shared.filter((s) => s.status === "loading");
  const watchedLoading = watchedStates.map((s, i) => (s.status === "loading" ? watched[i]!.def.category : null)).filter((c) => c !== null);
  const ready =
    plan !== null &&
    shared.length >= plan.shared.length &&
    sharedLoading.length === 0 &&
    watchedLoading.length === 0 &&
    !mesh.loading &&
    !practices.loading;

  useAnswer(props, ready, () => {
    if (!plan) return { problems: [], categories, loading: categories, truncated: false, notChecked: [], failed: [] };
    const now = Date.now();
    const out: Record<string, unknown>[] = [];
    const push = (p: Problem, source: Pick<KindRef, "group" | "kind">, refs: ListRef[]) => {
      const ns = p.object.namespace ?? null;
      if (!isActive(p, now)) return;
      if (args.namespace && ns !== args.namespace) return;
      if (!canRead(request.reads, source, ns) || !canRead(request.reads, p.object.kind, ns)) return;
      out.push({
        category: p.category,
        reason: p.reason,
        message: englishMessage(p),
        object: objectName(p.object.kind, ns, p.object.name),
        source: { group: source.group, kind: source.kind },
        since: iso(startedAt(p)),
        needsAttention: p.notify,
        refs,
      });
    };
    const refsOf = (p: Problem): ListRef[] =>
      p.category === "practices" ? practiceRefs(String(p.messageParams?.check ?? ""), p.object.namespace ?? "") : [];
    for (const source of shared) for (const p of source.problems) push(p, source.def.kind, refsOf(p));
    watched.forEach(({ def }, i) => {
      const state = watchedStates[i];
      if (!state || state.status !== "ready") return;
      for (const obj of state.items.values()) for (const p of resolve(def.kind, obj, now, undefined, def.category)) push(p, def.kind, []);
    });
    for (const m of mesh.problems()) {
      const p: Problem = {
        key: `${m.uid}|${m.reason}`,
        notifyKey: `${m.uid}|${m.reason}`,
        category: "mesh",
        uid: m.uid,
        object: { kind: m.ref.kind, namespace: m.ref.namespace || null, name: m.ref.name },
        reason: m.reason,
        messageKey: `messages.mesh${m.reason}`,
        messageParams: m.params,
        notify: true,
        firstSeen: now,
        activeAt: now,
      };
      push(p, m.ref.kind, meshRefs(m));
    }
    let practicesTruncated = false;
    if (plan.practices) {
      const found = practices.problems();
      practicesTruncated = found.truncated;
      for (const p of found.problems) push(p, p.object.kind, refsOf(p));
    }
    const failed: FailedList[] = [
      ...shared
        .filter((s) => s.status === "error")
        .map((s) => ({ category: s.category, group: s.def.kind.group, kind: s.def.kind.kind, code: s.error?.code ?? "other" })),
      ...watched.flatMap(({ def }, i) => failuresOf(def.category, def.kind, watchedStates[i])),
      ...(plan.mesh ? mesh.failed() : []),
      ...(plan.practices ? practices.failed() : []),
    ];
    const loading = new Set<string>([...sharedLoading.map((s) => s.category), ...watchedLoading]);
    if (mesh.loading) loading.add("mesh");
    if (practices.loading) loading.add("practices");
    return {
      problems: out,
      categories,
      loading: [...loading],
      truncated: plan.truncated || practicesTruncated || shared.some((s) => s.truncated),
      notChecked: plan.notChecked,
      failed,
    };
  });
  return null;
}
