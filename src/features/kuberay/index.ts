// KubeRay (#248): the discovered sidebar section "KubeRay" — RayClusters, RayJobs and RayServices (ray.io/v1). A
// RayCluster's details tell its state from the conditions (or the deprecated `status.state`), the head pod with its
// logs, IP and Service, the worker groups' replicas, bounds and ready pods; a RayJob's job and deployment statuses,
// entrypoint, RayCluster and submitter Job; a RayService's readiness, Serve applications of the active and pending
// clusters and its serve config. Failed RayClusters or ones whose head is not ready, failed RayJobs and RayServices
// not ready feed the problems screen (category `kuberay`) and the section counter. Read-only (ADR-0115).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useKubeRayProblemCount } from "./badge";
import "./kuberay.css";
import "./register";

registerSectionBadge("kuberay", useKubeRayProblemCount, { tone: "danger", labelKey: "kuberay:badge" });

export * from "./model";
