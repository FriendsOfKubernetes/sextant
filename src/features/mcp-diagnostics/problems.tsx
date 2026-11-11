// `get_problems`: the problems screen's findings (ADR-0066), by the same rules (`resolve`, the providers' engines) and
// the same opt-in rule (`useCategoriesOn`), from only what the agent may read (ADR-0094):
// - a kind the agent may read in every namespace comes from the problems store's shared, cluster-wide source (the
//   screen's own watch); a kind it may read only in some namespaces is watched there only (the asked namespace, else
//   the namespaces its rules name) and judged here; a cluster-scoped kind (Nodes) only with Read on it;
// - the categories judged across objects are computed on what the agent may read: best practices by the shared
//   category only with Read on every input everywhere, else by `useAgentPractices`;
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
import {
  extensionJudgedKinds,
  extensionSourcesFor,
  isExtensionCategory,
  requestScopes,
  scopesKnown,
  useExtensionCategories,
  useExtensionProblemsVersion,
} from "../problems/extensionCategories";
import { isActive, NODE, PROBLEM_CATEGORIES, PVC, resolve, startedAt, type Problem, type ProblemCategory } from "../problems/model";
import { useSharedWatches } from "../resource-map/watches";
import { en, iso, list } from "./english";
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
  /** Best practices per namespace (`useAgentPractices`) in these namespaces; `null`: not that way. */
  practices: string[] | null;
  /** The namespaces the rules name (where a kind is watched that the agent may not read everywhere). */
  ruled: string[];
  /** Categories nothing could be looked at for. */
  notChecked: ProblemCategory[];
  /**
   * Extension categories some of whose judged problems were left out (ADR-0168): filled when the problems are told,
   * by what each rests on.
   */
  notJudged: ProblemCategory[];
  /** The rules name more namespaces than are watched. */
  truncated: boolean;
}

function clusterScoped(def: SourceDef, kinds: ResourceKind[] | null | undefined): boolean {
  if (def.kind.group === NODE.group && def.kind.kind === NODE.kind) return true;
  return def.discovered && !!kinds && findKind(kinds, def.kind)?.namespaced === false;
}

/**
 * The lists an extension's problem says a name is absent from (`lookups`), as refs the agent must be able to read;
 * for a problem a judge decided (ADR-0168), what its fact says it rests on (`needs`: objects, or a kind's objects in a
 * namespace or in all of them), else every kind the judge read in every namespace its source watched (one ref of no
 * namespace when it watched every namespace).
 */
export function lookupRefs(p: Pick<Problem, "lookups" | "object">, kinds: ResourceKind[] | null | undefined): ListRef[] {
  return (p.lookups ?? []).flatMap((lookup): ListRef[] => {
    // `served` (ADR-0169) reads no object: discovery says.
    if (lookup.served) return [];
    if (lookup.judged?.needs) {
      return lookup.judged.needs.map(({ group, kind, namespace, name }): ListRef => {
        const namespaced = kinds ? findKind(kinds, { group, kind })?.namespaced !== false : true;
        return { group, kind, namespace: namespaced ? (namespace ?? null) : null, ...(name !== undefined ? { name } : {}) };
      });
    }
    if (lookup.judged) {
      return (lookup.judged.reads ?? []).flatMap(({ group, kind, namespaces }): ListRef[] =>
        namespaces === null ? [{ group, kind, namespace: null }] : namespaces.map((namespace) => ({ group, kind, namespace })),
      );
    }
    // Who selects it (`selectedByNone`, `selectsNone.selectedBy`, ADR-0169): every object of their kinds, in every
    // namespace, and the Namespaces' labels.
    const selecting = lookup.selectedBy ?? lookup.selects?.by;
    const everywhere: ListRef[] = selecting
      ? [...selecting.kinds, { group: "", kind: "Namespace" }].map(({ group, kind }): ListRef => ({ group, kind, namespace: null }))
      : [];
    if (lookup.selectedBy) return everywhere;
    // A `missing` with `alsoKinds` (ADR-0169) rests on each of its kinds.
    return [
      ...[lookup, ...(lookup.also ?? [])].map(({ group, kind }): ListRef => {
        const namespaced = kinds ? findKind(kinds, { group, kind })?.namespaced !== false : true;
        return { group, kind, namespace: namespaced ? (p.object.namespace ?? null) : null };
      }),
      ...everywhere,
    ];
  });
}

/** Whether an extension's problem was decided by one of its judges (ADR-0168). */
const judgedProblem = (p: Pick<Problem, "lookups">): boolean => (p.lookups ?? []).some((lookup) => lookup.judged !== undefined);

/**
 * The plan of `categories` (served ones, as `sourcesFor` gives them) for an agent that may read `reads`; `extensions`:
 * the extension categories asked for and their sources (`extensionSourcesFor`), which the problems store judges as it
 * does for the screen — kept where the agent may read their kind somewhere, each problem checked again when it is
 * told.
 */
export function planProblems(
  categories: readonly ProblemCategory[],
  kinds: ResourceKind[] | null | undefined,
  reads: readonly ReadRule[],
  asked: string | null,
  extensions: {
    categories: readonly ProblemCategory[];
    defs: readonly SourceDef[];
    /** The kinds a category's problem judges read (ADR-0168). */
    judged?: (category: ProblemCategory) => readonly { group: string; kind: string }[];
  } = { categories: [], defs: [] },
): ProblemPlan {
  const { namespaces: ruled, truncated } = ruleNamespaces(reads);
  const may = (kind: Pick<KindRef, "group" | "kind">, ns: string | null) => canRead(reads, kind, ns);
  const plan: ProblemPlan = { shared: [], watched: [], practices: null, ruled, notChecked: [], notJudged: [], truncated };
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
  for (const category of extensions.categories) {
    const defs = extensions.defs.filter((d) => d.category === category);
    const readable = defs.filter((def) =>
      clusterScoped(def, kinds) ? !asked && may(def.kind, null) : may(def.kind, null) || scope.some((ns) => may(def.kind, ns)),
    );
    if (readable.length === 0) {
      if (defs.length > 0) plan.notChecked.push(category);
      continue;
    }
    // A kind a judge reads that the agent may not read anywhere is still held: the judge needs every kind it reads to
    // tell anything, and the problems it decides are told only when the agent may read what each rests on (its
    // `needs`, else every kind the judge read) — nothing of that kind reaches the agent otherwise (ADR-0168).
    const judged = extensions.judged?.(category) ?? [];
    const same = (a: { group: string; kind: string }, b: { group: string; kind: string }) =>
      a.group.toLowerCase() === b.group.toLowerCase() && a.kind.toLowerCase() === b.kind.toLowerCase();
    const judgeInputs = defs.filter((def) => !readable.includes(def) && judged.some((k) => same(k, def.kind)));
    plan.shared.push(...readable, ...judgeInputs);
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
  const builtIn = useCategoriesOn(asked);
  // An extension's category Rust let through (ADR-0146): only while the extension is active and has rules.
  const registered = useExtensionCategories();
  const extensions = useMemo(
    () => registered.filter((c) => args.categories.includes(c)),
    [registered, args.categories],
  );
  const categories = useMemo(() => [...builtIn, ...extensions], [builtIn, extensions]);
  useEffect(() => requestScopes(request.clusterId, extensions), [request.clusterId, extensions]);
  const scopesVersion = useExtensionProblemsVersion();
  const extensionScopes = useMemo(() => {
    void scopesVersion;
    return scopesKnown(request.clusterId, extensions);
  }, [scopesVersion, request.clusterId, extensions]);
  // The plan waits for discovery when a tool's kinds are asked for.
  const discovery = useClusterKinds(needsDiscovery(categories) ? request.clusterId : null);
  const kinds = discovery.kinds ?? (discovery.error ? null : undefined);
  const settled = (!needsDiscovery(categories) || kinds !== undefined) && (extensions.length === 0 || (kinds !== undefined && extensionScopes));
  const plan = useMemo(() => {
    void scopesVersion;
    if (!settled) return null;
    const extensionDefs = extensionSourcesFor(extensions, request.clusterId, kinds);
    return planProblems(builtIn, kinds, request.reads, args.namespace, { categories: extensions, defs: extensionDefs, judged: extensionJudgedKinds });
  }, [settled, builtIn, extensions, kinds, request.reads, args.namespace, request.clusterId, scopesVersion]);
  const shared = useStoreSources(request.clusterId, plan?.shared ?? EMPTY);
  const watched = plan?.watched ?? EMPTY;
  const watchedStates = useSharedWatches(
    request.clusterId,
    watched.map((w) => w.spec),
  );
  const practices = useAgentPractices(request.clusterId, request.reads, plan?.practices ?? EMPTY, !!plan?.practices);

  const sharedLoading = shared.filter((s) => s.status === "loading");
  const watchedLoading = watchedStates.map((s, i) => (s.status === "loading" ? watched[i]!.def.category : null)).filter((c) => c !== null);
  const ready =
    plan !== null &&
    shared.length >= plan.shared.length &&
    sharedLoading.length === 0 &&
    watchedLoading.length === 0 &&
    !practices.loading;

  useAnswer(props, ready, () => {
    if (!plan) return { problems: [], categories, loading: categories, truncated: false, notChecked: [], failed: [] };
    const now = Date.now();
    const out: Record<string, unknown>[] = [];
    // Categories whose problems decided by an extension's backend were left out (ADR-0168): the agent may not read
    // every kind the judge read where it read them.
    const notJudged = new Set<string>(plan.notJudged);
    const push = (p: Problem, source: Pick<KindRef, "group" | "kind">, refs: ListRef[]) => {
      const ns = p.object.namespace ?? null;
      if (!isActive(p, now)) return;
      if (args.namespace && ns !== args.namespace) return;
      if (!canRead(request.reads, source, ns) || !canRead(request.reads, p.object.kind, ns)) return;
      if (judgedProblem(p) && !refs.every((r) => canRead(request.reads, r, r.namespace))) {
        notJudged.add(p.category);
        return;
      }
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
    const refsOf = (p: Problem): ListRef[] => {
      if (p.category === "practices") return practiceRefs(String(p.messageParams?.check ?? ""), p.object.namespace ?? "");
      // An extension's `missing` (ADR-0144) says a name is absent from a list: the agent must be able to read it.
      if (isExtensionCategory(p.category)) return lookupRefs(p, kinds);
      return [];
    };
    for (const source of shared) for (const p of source.problems) push(p, source.def.kind, refsOf(p));
    watched.forEach(({ def }, i) => {
      const state = watchedStates[i];
      if (!state || state.status !== "ready") return;
      for (const obj of state.items.values()) for (const p of resolve(def.kind, obj, now, undefined, def.category)) push(p, def.kind, []);
    });
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
      ...(plan.practices ? practices.failed() : []),
    ];
    const loading = new Set<string>([...sharedLoading.map((s) => s.category), ...watchedLoading]);
    if (practices.loading) loading.add("practices");
    return {
      problems: out,
      categories,
      loading: [...loading],
      truncated: plan.truncated || practicesTruncated || shared.some((s) => s.truncated),
      notChecked: plan.notChecked,
      ...(notJudged.size > 0 ? { notJudged: [...notJudged] } : {}),
      failed,
    };
  });
  return null;
}
