// Kind-specific views of the details panel's "fields" section, by `group/Kind`. Kinds without one (and custom
// resources) show metadata and conditions only.
import type { ComponentType } from "react";
import type { ClusterId, KindRef, KubeObject, ObjectRef } from "../../../api";
import { kindKey } from "../../../resources";
import { RoleBindingDetails, RoleDetails, ServiceAccountDetails } from "./access";
import { NamespaceDetails, NodeDetails } from "./cluster";
import { ConfigMapDetails, SecretDetails } from "./config";
import { EndpointsDetails, IngressDetails, ServiceDetails } from "./network";
import { PodDetails } from "./pods";
import { PvcDetails, PvDetails, StorageClassDetails } from "./storage";
import { CronJobDetails, DaemonSetDetails, JobDetails, ReplicatedDetails } from "./workloads";

export interface KindViewProps {
  obj: KubeObject;
  clusterId: ClusterId;
  objectRef: ObjectRef;
}

const views: Record<string, ComponentType<KindViewProps>> = {
  "/Pod": PodDetails,
  "apps/Deployment": ReplicatedDetails,
  "apps/StatefulSet": ReplicatedDetails,
  "apps/ReplicaSet": ReplicatedDetails,
  "apps/DaemonSet": DaemonSetDetails,
  "batch/Job": JobDetails,
  "batch/CronJob": CronJobDetails,
  "/Service": ServiceDetails,
  "/Endpoints": EndpointsDetails,
  "networking.k8s.io/Ingress": IngressDetails,
  "/ConfigMap": ConfigMapDetails,
  "/Secret": SecretDetails,
  "/PersistentVolumeClaim": PvcDetails,
  "/PersistentVolume": PvDetails,
  "storage.k8s.io/StorageClass": StorageClassDetails,
  "/Node": NodeDetails,
  "/Namespace": NamespaceDetails,
  "/ServiceAccount": ServiceAccountDetails,
  "rbac.authorization.k8s.io/Role": RoleDetails,
  "rbac.authorization.k8s.io/ClusterRole": RoleDetails,
  "rbac.authorization.k8s.io/RoleBinding": RoleBindingDetails,
  "rbac.authorization.k8s.io/ClusterRoleBinding": RoleBindingDetails,
};

/** The view of a kind's own fields, if this feature has one. */
export function kindView(kind: Pick<KindRef, "group" | "kind">): ComponentType<KindViewProps> | undefined {
  return views[kindKey(kind)];
}
