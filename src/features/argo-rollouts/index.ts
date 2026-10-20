// Argo Rollouts (#213): the sidebar section "Argo Rollouts" — Rollouts, AnalysisRuns, AnalysisTemplates,
// ClusterAnalysisTemplates and Experiments — shown only for the kinds the cluster serves. A Rollout's status reads as
// `kubectl argo rollouts get` reads it (Healthy, Progressing, Paused, Degraded), its details show the canary steps with
// the current one, the set and actual weight, the blue-green Services, its ReplicaSets by role and its analysis runs
// with the failing measurement. Degraded or aborted Rollouts and failed analyses feed the problems screen (category
// `rollouts`). Promote, Promote fully, Abort and Retry send exactly the plugin's patches after a confirmation that
// lists them (ADR-0097); agents and extensions get nothing new.
import { registerSectionBadge } from "../../layout/sectionBadges";
import "./actions";
import { useRolloutProblemCount } from "./problems";
import "./register";

registerSectionBadge("argoRollouts", useRolloutProblemCount, { tone: "danger", labelKey: "argorollouts:badge" });

export * from "./model";
