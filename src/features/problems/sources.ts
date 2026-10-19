// Which kinds are watched for each category of problems. Built-in kinds are watched without discovery; the kinds of
// installed tools (cert-manager, Flux, Argo CD, Gateway API) only once discovery says the cluster serves them, at the
// version it serves.
import type { KindRef, ResourceKind } from "../../api";
import { findKind } from "../../resources";
import { APPLICATION } from "../argocd/model";
import { BUCKET, GIT_REPOSITORY, HELM_RELEASE, HELM_REPOSITORY, KUSTOMIZATION, OCI_REPOSITORY } from "../flux/model";
import { COUNTED_KINDS } from "../gateway-api/problems";
import {
  CERTIFICATE,
  CRONJOB,
  DAEMONSET,
  REPLICASET,
  DEPLOYMENT,
  EVENT,
  JOB,
  NODE,
  POD,
  PVC,
  STATEFULSET,
  type ProblemCategory,
} from "./model";

/** One watched kind of a category. */
export interface SourceDef {
  category: ProblemCategory;
  kind: KindRef;
  fieldSelector: string | null;
  /** The kind of an installed tool: watched only once discovery says the cluster serves it. */
  discovered: boolean;
  /**
   * Nothing is watched: the category's provider (`registerProblemProvider` in store.ts) hands in the problems — the
   * fill levels of volume claims ("disk almost full", #152), polled by features/storage while the source is held.
   */
  external?: boolean;
}

const builtIn = (category: ProblemCategory, kind: KindRef, fieldSelector: string | null = null): SourceDef => ({
  category,
  kind,
  fieldSelector,
  discovered: false,
});
const tool = (category: ProblemCategory, kind: KindRef): SourceDef => ({ category, kind, fieldSelector: null, discovered: true });

/** Flux kinds with a Ready condition worth watching: the sources and what applies them. */
const FLUX_WATCHED = [GIT_REPOSITORY, OCI_REPOSITORY, HELM_REPOSITORY, BUCKET, KUSTOMIZATION, HELM_RELEASE];

export const CATEGORY_SOURCES: Record<ProblemCategory, SourceDef[]> = {
  nodes: [builtIn("nodes", NODE)],
  pods: [builtIn("pods", POD)],
  workloads: [builtIn("workloads", DEPLOYMENT), builtIn("workloads", STATEFULSET), builtIn("workloads", DAEMONSET)],
  jobs: [builtIn("jobs", JOB)],
  volumes: [builtIn("volumes", PVC)],
  certificates: [tool("certificates", CERTIFICATE)],
  flux: FLUX_WATCHED.map((kind) => tool("flux", kind)),
  argocd: [tool("argocd", APPLICATION)],
  gateway: COUNTED_KINDS.map((kind) => tool("gateway", kind)),
  // Watches of their own (`sourceKey`): judged only while the opt-in category is on, kept apart from the problems of
  // pods and workloads (the map's colours, the cap of `MAX_PROBLEM_OBJECTS`).
  security: [POD, DEPLOYMENT, STATEFULSET, DAEMONSET, REPLICASET, JOB, CRONJOB].map((kind) => builtIn("security", kind)),
  // Expiring kubeconfig credentials (#150, opt-in) come from the kubeconfig, not from a watch: nothing is watched for
  // them (features/clusters/kubeconfig/CredentialsNotifier).
  credentials: [],
  // Claims almost full (#152, opt-in): from the kubelets' stats or Prometheus, polled while held (features/storage).
  disk: [{ category: "disk", kind: PVC, fieldSelector: null, discovered: false, external: true }],
  // Only Warning events are listed.
  events: [builtIn("events", EVENT, "type=Warning")],
};

/**
 * The sources of `categories` the cluster can be watched for: built-in kinds always, a tool's kinds at the version
 * discovery reports. `kinds` `undefined`: discovery has not come (a tool's kinds wait); `null`: it failed (they are
 * left out).
 */
export function sourcesFor(categories: readonly ProblemCategory[], kinds: ResourceKind[] | null | undefined): SourceDef[] {
  const out: SourceDef[] = [];
  // A kind two categories of the list share is watched once.
  const seen = new Set<string>();
  const add = (def: SourceDef) => {
    const key = sourceKey("", def);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(def);
  };
  for (const category of categories) {
    for (const def of CATEGORY_SOURCES[category]) {
      if (!def.discovered) {
        add(def);
        continue;
      }
      const served = kinds ? findKind(kinds, def.kind)?.kindRef : undefined;
      if (served) add({ ...def, kind: served });
    }
  }
  return out;
}

/** Whether `categories` need discovery to be watched. */
export function needsDiscovery(categories: readonly ProblemCategory[]): boolean {
  return categories.some((c) => CATEGORY_SOURCES[c].some((d) => d.discovered));
}

/** The store's key of a source in a cluster. */
export function sourceKey(clusterId: string, def: Pick<SourceDef, "kind" | "fieldSelector"> & { category?: ProblemCategory }): string {
  const { group, version, kind } = def.kind;
  const key = `${clusterId}|${group}/${version}/${kind}|${def.fieldSelector ?? ""}`;
  // A security source judges the same kinds as pods and workloads by other rules: a source of its own; so is the
  // provider's source of full claims, which watches nothing.
  return def.category === "security" || def.category === "disk" ? `${key}|${def.category}` : key;
}
