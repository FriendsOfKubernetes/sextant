// Live RBAC objects for the RBAC page and the details sections. Each list is watched only while a mounted view asks
// for it (`useSharedWatch`: views asking for the same list share one watch, which ends with the last of them),
// namespaced lists only in the namespaces asked for (`null` = all), and a list the user may not read is reported
// (`forbidden`) instead of read as empty: the engine then treats it as unknown.
import { useMemo } from "react";
import { type ClusterId, type KindRef, type KubeObject, type WatchSpec, type WatchState } from "../../api";
import type { RbacData } from "./engine";
import { useSharedWatch } from "./sharedWatch";

const RBAC = "rbac.authorization.k8s.io";
export const ROLE: KindRef = { group: RBAC, version: "v1", kind: "Role" };
export const CLUSTER_ROLE: KindRef = { group: RBAC, version: "v1", kind: "ClusterRole" };
export const ROLE_BINDING: KindRef = { group: RBAC, version: "v1", kind: "RoleBinding" };
export const CLUSTER_ROLE_BINDING: KindRef = { group: RBAC, version: "v1", kind: "ClusterRoleBinding" };

export type RbacList = "roles" | "clusterRoles" | "roleBindings" | "clusterRoleBindings";
export const RBAC_LISTS: readonly RbacList[] = ["clusterRoles", "roles", "clusterRoleBindings", "roleBindings"];

export type ListStatus = "off" | "loading" | "ready" | "partial" | "forbidden" | "error";

export interface RbacState {
  data: RbacData;
  status: Record<RbacList, ListStatus>;
  /** Some list is still loading. */
  loading: boolean;
  /** Lists that cannot be read at all (`status` says why); `partial` lists miss some namespaces. */
  unavailable: RbacList[];
  /** Namespaces some namespaced list could not read. */
  partialNamespaces: string[];
}

export interface RbacNeeds {
  roles?: boolean;
  clusterRoles?: boolean;
  roleBindings?: boolean;
  clusterRoleBindings?: boolean;
  /** Namespaces of the namespaced lists; `null` (default) = all namespaces. */
  namespaces?: readonly string[] | null;
}

function spec(kind: KindRef, on: boolean | undefined, namespaces: readonly string[] | null | undefined): WatchSpec | null {
  if (!on) return null;
  const ns = namespaces && namespaces.length > 0 ? [...new Set(namespaces)].sort() : null;
  return { kind, namespaces: ns, labelSelector: null, fieldSelector: null };
}

function statusOf(watch: WatchState, on: boolean | undefined): ListStatus {
  if (!on) return "off";
  if (watch.status === "error") return watch.error?.code === "forbidden" ? "forbidden" : "error";
  if (watch.status === "loading") return "loading";
  return watch.forbidden && watch.forbidden.length > 0 ? "partial" : "ready";
}

const listOf = (watch: WatchState, status: ListStatus): readonly KubeObject[] | undefined =>
  status === "ready" || status === "partial" ? [...watch.items.values()] : undefined;

/** Watches the RBAC lists `needs` names; the others stay closed. */
export function useRbacData(clusterId: ClusterId, needs: RbacNeeds): RbacState {
  const ns = needs.namespaces ?? null;
  // Always the same four hooks, in the same order; a list not needed watches nothing.
  const roles = useSharedWatch(clusterId, spec(ROLE, needs.roles, ns));
  const clusterRoles = useSharedWatch(clusterId, spec(CLUSTER_ROLE, needs.clusterRoles, null));
  const roleBindings = useSharedWatch(clusterId, spec(ROLE_BINDING, needs.roleBindings, ns));
  const clusterRoleBindings = useSharedWatch(clusterId, spec(CLUSTER_ROLE_BINDING, needs.clusterRoleBindings, null));
  return useMemo(() => {
    const status: Record<RbacList, ListStatus> = {
      roles: statusOf(roles, needs.roles),
      clusterRoles: statusOf(clusterRoles, needs.clusterRoles),
      roleBindings: statusOf(roleBindings, needs.roleBindings),
      clusterRoleBindings: statusOf(clusterRoleBindings, needs.clusterRoleBindings),
    };
    const data: RbacData = {
      roles: listOf(roles, status.roles),
      clusterRoles: listOf(clusterRoles, status.clusterRoles),
      roleBindings: listOf(roleBindings, status.roleBindings),
      clusterRoleBindings: listOf(clusterRoleBindings, status.clusterRoleBindings),
      rolesUnreadableIn: roles.forbidden ?? [],
    };
    return {
      data,
      status,
      loading: RBAC_LISTS.some((l) => status[l] === "loading"),
      unavailable: RBAC_LISTS.filter((l) => status[l] === "forbidden" || status[l] === "error"),
      partialNamespaces: [...new Set([...(roles.forbidden ?? []), ...(roleBindings.forbidden ?? [])])].sort(),
    };
  }, [roles, clusterRoles, roleBindings, clusterRoleBindings, needs.roles, needs.clusterRoles, needs.roleBindings, needs.clusterRoleBindings]);
}

/** Every list, for the page and the ServiceAccount section. */
export const ALL_LISTS: RbacNeeds = Object.freeze({ roles: true, clusterRoles: true, roleBindings: true, clusterRoleBindings: true });
