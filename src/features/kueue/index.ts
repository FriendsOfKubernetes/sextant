// Kueue (#246): the discovered sidebar section "Kueue" — ClusterQueues, LocalQueues, Workloads, ResourceFlavors,
// Cohorts, AdmissionChecks and WorkloadPriorityClasses. A ClusterQueue's details compare its quota with what is
// reserved and in use per flavor and resource and list the Workloads waiting in its LocalQueues with the reason each
// waits; a Workload's tell why it waits or was evicted and which job it belongs to; a job Kueue queues gets a "Queue"
// section with its Workload. Inactive queues feed the problems screen (category `kueue`); Workloads waiting too long or
// evicted repeatedly too, when the opt-in category `kueueWorkloads` is on. Read-only (ADR-0114).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useKueueProblemCount } from "./badge";
import "./kueue.css";
import "./register";

registerSectionBadge("kueue", useKueueProblemCount, { tone: "danger", labelKey: "kueue:badge" });

export * from "./model";
