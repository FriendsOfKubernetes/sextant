// Who manages an object, from the marks the tools leave on it. Deleting such an object is pointless (the tool puts it
// back on its next sync, or the release goes out of step), so the page flags it with its manager instead of offering
// it for deletion.
//
//   Helm      label app.kubernetes.io/managed-by=Helm, annotations meta.helm.sh/release-name|namespace, helm.sh/hook
//   Flux      labels kustomize.toolkit.fluxcd.io/name|namespace, helm.toolkit.fluxcd.io/name|namespace
//   Argo CD   label argocd.argoproj.io/instance, annotation argocd.argoproj.io/tracking-id
//   other     any other value of app.kubernetes.io/managed-by (an operator, a deployment tool)
import type { KubeObject } from "../../api";
import { status } from "../../resources";

const { labelsOf, record, str } = status;

export type ManagerTool = "helm" | "flux" | "argocd" | "other";

export interface Manager {
  tool: ManagerTool;
  /** The release, the Flux object (`namespace/name`), the Argo CD application or the managed-by value. */
  name: string;
}

const MANAGED_BY = "app.kubernetes.io/managed-by";

function annotationsOf(obj: KubeObject): Record<string, string> {
  return record(obj.metadata?.annotations) as Record<string, string>;
}

const joined = (namespace: string | undefined, name: string) => (namespace ? `${namespace}/${name}` : name);

export function managerOf(obj: KubeObject): Manager | undefined {
  const labels = labelsOf(obj);
  const annotations = annotationsOf(obj);

  const fluxKs = str(labels["kustomize.toolkit.fluxcd.io/name"]);
  if (fluxKs) return { tool: "flux", name: joined(str(labels["kustomize.toolkit.fluxcd.io/namespace"]), fluxKs) };
  const fluxHr = str(labels["helm.toolkit.fluxcd.io/name"]);
  if (fluxHr) return { tool: "flux", name: joined(str(labels["helm.toolkit.fluxcd.io/namespace"]), fluxHr) };

  const argoApp = str(labels["argocd.argoproj.io/instance"]);
  if (argoApp) return { tool: "argocd", name: argoApp };
  const tracking = str(annotations["argocd.argoproj.io/tracking-id"]);
  // `<application>:<group>/<kind>:<namespace>/<name>`; the application may carry its namespace (`ns_app`).
  if (tracking) return { tool: "argocd", name: tracking.split(":")[0] || tracking };

  const release = str(annotations["meta.helm.sh/release-name"]);
  if (release) return { tool: "helm", name: joined(str(annotations["meta.helm.sh/release-namespace"]), release) };
  const managedBy = str(labels[MANAGED_BY]);
  if (managedBy?.toLowerCase() === "helm") {
    return { tool: "helm", name: str(labels["helm.sh/chart"]) ?? str(labels["app.kubernetes.io/instance"]) ?? managedBy };
  }
  if (str(annotations["helm.sh/hook"])) return { tool: "helm", name: str(labels["app.kubernetes.io/instance"]) ?? "" };

  if (managedBy) return { tool: "other", name: managedBy };
  return undefined;
}
