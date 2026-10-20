// `get_permissions`: the RBAC engine of the Permissions page (`permissionsOf`, `whoCan`, ADR-0071) over the RBAC lists
// the agent may read; a list it may not read is not watched and is named as unreadable (unknown, not empty). Always a
// computed answer; the access reviews stay in the window.
import { useMemo } from "react";
import type { ClusterId, ReadRule } from "../../api";
import { useClusterKinds } from "../../resources";
import { buildIndex, permissionsOf, whoCan, type RbacRef, type Subject, type SubjectKind, type WhoCanQuery } from "../rbac/engine";
import { CLUSTER_ROLE, CLUSTER_ROLE_BINDING, RBAC_LISTS, ROLE, ROLE_BINDING, useRbacData, type RbacList, type RbacNeeds } from "../rbac/hooks";
import { clusterScopedOf, resolveResource } from "../rbac/query";
import { canRead } from "./scope";
import { useAnswer, type WorkerProps } from "./worker";

interface Args {
  namespace: string | null;
  subject?: { kind: SubjectKind; name: string; namespace: string | null; groups: string[] };
  whoCan?: {
    verb: string;
    resource: string | null;
    subresource: string | null;
    group: string | null;
    name: string | null;
    nonResourceUrl: string | null;
  };
}

const LIST_NAMES: Record<RbacList, string> = {
  roles: "Roles",
  clusterRoles: "ClusterRoles",
  roleBindings: "RoleBindings",
  clusterRoleBindings: "ClusterRoleBindings",
};

/** The RBAC lists to watch: only those the agent may read, namespaced ones in `namespace` (or everywhere). */
export function rbacNeeds(reads: readonly ReadRule[], namespace: string | null): RbacNeeds {
  return {
    roles: canRead(reads, ROLE, namespace),
    roleBindings: canRead(reads, ROLE_BINDING, namespace),
    clusterRoles: canRead(reads, CLUSTER_ROLE, null),
    clusterRoleBindings: canRead(reads, CLUSTER_ROLE_BINDING, null),
    namespaces: namespace ? [namespace] : null,
  };
}

const refOut = (r: RbacRef) => ({ kind: r.kind, name: r.name, namespace: r.namespace ?? undefined });

function useWorkerData(clusterId: ClusterId, reads: readonly ReadRule[], namespace: string | null) {
  const needs = useMemo(() => rbacNeeds(reads, namespace), [reads, namespace]);
  const rbac = useRbacData(clusterId, needs);
  const kinds = useClusterKinds(clusterId);
  const discovered = kinds.kinds !== null || kinds.error !== null;
  return { needs, rbac, kinds, ready: discovered && !rbac.loading };
}

export function PermissionsWorker(props: WorkerProps) {
  const { request } = props;
  const args = request.args as unknown as Args;
  const { needs, rbac, kinds, ready } = useWorkerData(request.clusterId, request.reads, args.namespace);

  useAnswer(props, ready, () => {
    const index = buildIndex(rbac.data);
    const scoped = clusterScopedOf(kinds.kinds);
    const unreadable = RBAC_LISTS.filter((l) => !needs[l] || rbac.unavailable.includes(l)).map((l) => LIST_NAMES[l]);
    const partial = rbac.partialNamespaces.length > 0;
    const missingRoles = (warnings: { binding: RbacRef; role: RbacRef }[]) =>
      warnings.map((w) => ({ binding: refOut(w.binding), role: refOut(w.role) }));
    if (args.subject) {
      const s = args.subject;
      const subject: Subject = { kind: s.kind, name: s.name, ...(s.namespace ? { namespace: s.namespace } : {}), groups: s.groups };
      const result = permissionsOf(index, subject, args.namespace, scoped);
      return {
        grants: result.grants.map((g) => ({
          rule: g.rule,
          role: refOut(g.role),
          binding: refOut(g.binding),
          scope: g.scope ?? undefined,
          via: g.via,
          pending: g.pending === true,
        })),
        missingRoles: missingRoles(result.warnings),
        unreadable,
        truncated: partial,
      };
    }
    const w = args.whoCan!;
    let query: WhoCanQuery;
    if (w.nonResourceUrl) {
      query = { verb: w.verb, nonResourceURL: w.nonResourceUrl };
    } else {
      const text = w.group ? `${w.resource ?? ""}.${w.group}` : (w.resource ?? "");
      const resolved = resolveResource(text, w.subresource ?? "", kinds.kinds);
      if (!resolved) throw new Error("no resource to ask about");
      query = {
        verb: w.verb,
        group: resolved.group,
        resource: resolved.resource,
        subresource: resolved.subresource,
        name: w.name ?? undefined,
        namespace: args.namespace,
        clusterScoped: resolved.clusterScoped,
      };
    }
    const result = whoCan(index, query);
    return {
      answers: result.answers.map((a) => ({
        subject: { kind: a.subject.kind, name: a.subject.name, namespace: a.subject.namespace },
        rule: a.rule,
        role: refOut(a.role),
        binding: refOut(a.binding),
        scope: a.scope ?? undefined,
        onlyNames: a.onlyNames ?? [],
      })),
      missingRoles: missingRoles(result.warnings),
      unreadable,
      truncated: result.truncated || partial,
    };
  });
  return null;
}
