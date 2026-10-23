// Vertical Pod Autoscaler (#242): the discovered sidebar section "Vertical Pod Autoscaler" — VerticalPodAutoscalers
// (autoscaling.k8s.io) with their state from the recommender's conditions, the update mode in words, and the
// recommendation per container against the target template's requests and limits with what the admission controller
// would set on a pod created now (limits scaled as it scales them); their checkpoints; the recommender, updater and
// admission controller found in the cluster, and what a missing one means. Workloads a VPA targets show it next to
// right-sizing. Configurations the recommender cannot use, VPAs that match no pod and VPAs that fight an HPA over the
// same resource feed the problems screen (category `vpa`) and the section counter. Read-only (ADR-0111).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useVpaProblemCount } from "./badge";
import "./provider";
import "./register";
import "./vpa.css";

registerSectionBadge("vpa", useVpaProblemCount, { tone: "danger", labelKey: "vpa:badge" });

export * from "./model";
