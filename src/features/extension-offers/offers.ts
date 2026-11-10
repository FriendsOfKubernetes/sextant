// Sextant's own extensions offered where a cluster runs their tool (ADR-0162): Flux, Argo CD and Argo Rollouts were
// views of Sextant until 0.30 and are now extensions in the catalog. When the active cluster serves a tool's kinds and
// its extension is not installed, the sidebar offers it ("Install", "Not now" for this run, "Don't offer again" kept in
// `extensionCatalog.declinedOffers`). Pure: which offers show.
import type { KindRef } from "../../api";

export interface ExtensionOffer {
  /** The extension's id in the catalog. */
  id: string;
  /** The tool's name (a product name, the same in every language). */
  tool: string;
  /** Whether a kind the cluster serves is the tool's. */
  matches: (kind: Pick<KindRef, "group" | "kind">) => boolean;
}

const fluxGroup = /^[a-z0-9-]+\.toolkit\.fluxcd\.io$/;

export const OFFERS: readonly ExtensionOffer[] = [
  { id: "sextant.flux", tool: "Flux", matches: (k) => fluxGroup.test(k.group) },
  // Argo CD, Argo Rollouts and Argo Workflows share `argoproj.io`: by kind too.
  { id: "sextant.argo-cd", tool: "Argo CD", matches: (k) => k.group === "argoproj.io" && k.kind === "Application" },
  { id: "sextant.argo-rollouts", tool: "Argo Rollouts", matches: (k) => k.group === "argoproj.io" && k.kind === "Rollout" },
  { id: "sextant.argo-workflows", tool: "Argo Workflows", matches: (k) => k.group === "argoproj.io" && k.kind === "Workflow" },
  // cert-manager: by its kinds (`cert-manager.io`; Orders and Challenges are `acme.cert-manager.io`).
  { id: "sextant.cert-manager", tool: "cert-manager", matches: (k) => k.group === "cert-manager.io" },
  // Trivy Operator: by its report kinds (`aquasecurity.github.io`).
  { id: "sextant.trivy", tool: "Trivy", matches: (k) => k.group === "aquasecurity.github.io" },
  { id: "sextant.keda", tool: "KEDA", matches: (k) => k.group === "keda.sh" },
  { id: "sextant.karpenter", tool: "Karpenter", matches: (k) => k.group === "karpenter.sh" },
  { id: "sextant.vpa", tool: "Vertical Pod Autoscaler", matches: (k) => k.group === "autoscaling.k8s.io" && k.kind === "VerticalPodAutoscaler" },
  { id: "sextant.velero", tool: "Velero", matches: (k) => k.group === "velero.io" },
  // Traefik: by its kinds of `traefik.io` or, on an older Traefik, `traefik.containo.us`.
  { id: "sextant.traefik", tool: "Traefik", matches: (k) => k.group === "traefik.io" || k.group === "traefik.containo.us" },
  { id: "sextant.contour", tool: "Contour", matches: (k) => k.group === "projectcontour.io" },
  { id: "sextant.knative", tool: "Knative", matches: (k) => k.group === "serving.knative.dev" || k.group === "eventing.knative.dev" },
  { id: "sextant.kyverno", tool: "Kyverno", matches: (k) => k.group === "kyverno.io" },
  { id: "sextant.external-secrets", tool: "External Secrets", matches: (k) => k.group === "external-secrets.io" },
  { id: "sextant.sealed-secrets", tool: "Sealed Secrets", matches: (k) => k.group === "bitnami.com" && k.kind === "SealedSecret" },
  { id: "sextant.prometheus-operator", tool: "Prometheus Operator", matches: (k) => k.group === "monitoring.coreos.com" },
  { id: "sextant.cluster-api", tool: "Cluster API", matches: (k) => k.group === "cluster.x-k8s.io" },
  // k3s / RKE2: its own kinds (`k3s.cattle.io`) or helm-controller's (`helm.cattle.io`).
  { id: "sextant.k3s", tool: "k3s / RKE2", matches: (k) => k.group === "k3s.cattle.io" || k.group === "helm.cattle.io" },
  { id: "sextant.cnpg", tool: "CloudNativePG", matches: (k) => k.group === "postgresql.cnpg.io" },
  { id: "sextant.strimzi", tool: "Strimzi", matches: (k) => k.group === "kafka.strimzi.io" },
  { id: "sextant.dra", tool: "Dynamic Resource Allocation", matches: (k) => k.group === "resource.k8s.io" },
  { id: "sextant.gpu-operator", tool: "NVIDIA GPU Operator", matches: (k) => k.group === "nvidia.com" && k.kind === "ClusterPolicy" },
  { id: "sextant.kueue", tool: "Kueue", matches: (k) => k.group === "kueue.x-k8s.io" },
  { id: "sextant.jobset", tool: "JobSet", matches: (k) => k.group === "jobset.x-k8s.io" },
  { id: "sextant.kuberay", tool: "KubeRay", matches: (k) => k.group === "ray.io" },
  { id: "sextant.kserve", tool: "KServe", matches: (k) => k.group === "serving.kserve.io" },
  // OLM v0 (`operators.coreos.com`) or v1 (`olm.operatorframework.io`).
  {
    id: "sextant.olm",
    tool: "Operator Lifecycle Manager",
    matches: (k) => (k.group === "operators.coreos.com" && k.kind === "Subscription") || k.group === "olm.operatorframework.io",
  },
  // OpenShift: by its Routes or DeploymentConfigs (its other groups come with them).
  { id: "sextant.openshift", tool: "OpenShift", matches: (k) => k.group === "route.openshift.io" || k.group === "apps.openshift.io" },
];

/** The offers for a cluster serving `kinds`: its tool is there, the extension is not installed, nor declined. */
export function offersFor(
  kinds: readonly Pick<KindRef, "group" | "kind">[],
  installed: ReadonlySet<string>,
  declined: readonly string[],
  notNow: ReadonlySet<string>,
): ExtensionOffer[] {
  return OFFERS.filter(
    (offer) => !installed.has(offer.id) && !declined.includes(offer.id) && !notNow.has(offer.id) && kinds.some(offer.matches),
  );
}

/** The offer of an extension by id. */
export const offerOf = (id: string): ExtensionOffer | undefined => OFFERS.find((o) => o.id === id);
