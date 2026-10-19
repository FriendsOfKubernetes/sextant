// The kinds a namespace comparison offers, all checked by default. The version is a hint: the backend reads the kind in
// the version the cluster serves.
import type { KindRef } from "../../api";

export const COMPARE_KINDS: readonly KindRef[] = [
  { group: "apps", version: "v1", kind: "Deployment" },
  { group: "apps", version: "v1", kind: "StatefulSet" },
  { group: "apps", version: "v1", kind: "DaemonSet" },
  { group: "", version: "v1", kind: "Service" },
  { group: "", version: "v1", kind: "ConfigMap" },
  { group: "", version: "v1", kind: "Secret" },
  { group: "networking.k8s.io", version: "v1", kind: "Ingress" },
  { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" },
  { group: "policy", version: "v1", kind: "PodDisruptionBudget" },
  { group: "batch", version: "v1", kind: "CronJob" },
  { group: "", version: "v1", kind: "ServiceAccount" },
  { group: "rbac.authorization.k8s.io", version: "v1", kind: "Role" },
  { group: "rbac.authorization.k8s.io", version: "v1", kind: "RoleBinding" },
];

/** Objects listed per kind and side, at most (the backend's cap). */
export const COMPARE_LIMIT = 500;
