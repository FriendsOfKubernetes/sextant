// The three VPA components found among the cluster's Deployments, by the names and labels of the project's own install
// manifests and charts:
//   - vertical-pod-autoscaler/deploy/{recommender,updater,admission-controller}-deployment.yaml (hack/vpa-up.sh):
//     Deployments `vpa-recommender`, `vpa-updater`, `vpa-admission-controller` in kube-system, no labels on the
//     Deployments themselves;
//   - the project's chart vertical-pod-autoscaler/charts/vertical-pod-autoscaler (templates/_helpers.tpl): labels
//     `app.kubernetes.io/name: vertical-pod-autoscaler` (the chart name, or `nameOverride`) and
//     `app.kubernetes.io/component: recommender | updater | admission-controller`, in the release's namespace;
//   - Fairwinds' chart stable/vpa (templates/*-deployment.yaml): `app.kubernetes.io/name: vpa` and the same
//     component values.
// Where VPA is a managed add-on (GKE), the components run outside the cluster and none is found; a recommendation in
// a VPA's status then still shows that a recommender works. Pure functions; the watches are in hooks.ts.
import type { KubeObject } from "../../api";
import { status } from "../../resources";

const { get, num, str } = status;

export const COMPONENTS = ["recommender", "updater", "admission-controller"] as const;
export type Component = (typeof COMPONENTS)[number];

export const MANIFEST_NAMESPACE = "kube-system";
/** The manifests' Deployment names. */
export const MANIFEST_NAMES: Record<Component, string> = {
  recommender: "vpa-recommender",
  updater: "vpa-updater",
  "admission-controller": "vpa-admission-controller",
};
/** The charts' `app.kubernetes.io/name` values, as one label selector. */
export const CHART_SELECTOR = "app.kubernetes.io/name in (vertical-pod-autoscaler,vpa)";
const COMPONENT_LABEL = "app.kubernetes.io/component";

/** Which component a found Deployment is, by its chart label or the manifests' name. */
export function componentOf(deployment: KubeObject): Component | undefined {
  const label = str(get(deployment, "metadata", "labels", COMPONENT_LABEL));
  if (label && (COMPONENTS as readonly string[]).includes(label)) return label as Component;
  const name = deployment.metadata?.name ?? "";
  return COMPONENTS.find((c) => name === MANIFEST_NAMES[c]);
}

export interface FoundComponent {
  name: string;
  namespace: string;
  ready: number;
  desired: number;
}

export function foundOf(deployment: KubeObject): FoundComponent {
  return {
    name: deployment.metadata?.name ?? "",
    namespace: deployment.metadata?.namespace ?? "",
    ready: num(get(deployment, "status", "readyReplicas")) ?? 0,
    desired: num(get(deployment, "spec", "replicas")) ?? 1,
  };
}

/** The Deployments found for each component, sorted by namespace and name. */
export function groupComponents(deployments: Iterable<KubeObject>): Record<Component, FoundComponent[]> {
  const out: Record<Component, FoundComponent[]> = { recommender: [], updater: [], "admission-controller": [] };
  const seen = new Set<string>();
  for (const d of deployments) {
    const key = d.metadata?.uid ?? `${d.metadata?.namespace}/${d.metadata?.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const c = componentOf(d);
    if (c) out[c].push(foundOf(d));
  }
  for (const list of Object.values(out)) list.sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
  return out;
}

/**
 * What a missing component means for this VPA's mode, under `vpa:components.missing`: without the recommender there
 * are no recommendations; without the admission controller new pods keep the template's values (`Initial` does
 * nothing, and the updater's evictions bring pods back unchanged); without the updater running pods are never
 * changed (`Recreate`, `Auto`, `InPlaceOrRecreate`, `InPlace` act only on new pods).
 */
export function missingMeaning(component: Component, mode: string): string | undefined {
  if (component === "recommender") return "recommender";
  if (mode === "Off") return undefined;
  if (component === "admission-controller") return mode === "Initial" ? "admissionInitial" : "admission";
  return mode === "Initial" ? undefined : "updater";
}
