// KServe (#249): the discovered sidebar section "KServe" — InferenceServices (serving.kserve.io/v1beta1),
// ServingRuntimes, ClusterServingRuntimes, InferenceGraphs and TrainedModels (v1alpha1). An InferenceService's
// details tell its state from its conditions and model status, its URL and address, each component's model format,
// runtime, storage URI (shown without credentials or a query), revisions and traffic split, the deployment mode and
// what KServe made for it (Knative Service, Deployment, Service), and the runtime KServe chooses for the predictor.
// InferenceServices not ready after a grace and models that failed to load feed the problems screen (category
// `kserve`) and the section counter. Read-only (ADR-0115).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useKServeProblemCount } from "./badge";
import "./kserve.css";
import "./register";

registerSectionBadge("kserve", useKServeProblemCount, { tone: "danger", labelKey: "kserve:badge" });

export * from "./model";
