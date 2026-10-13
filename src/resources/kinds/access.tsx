// Access Control: ServiceAccounts, ClusterRoles, Roles, ClusterRoleBindings, RoleBindings.
import { column, standardColumns } from "../columns";
import { registerResource } from "../registry";
import { arr, get, str } from "../status";

/** Subjects of a binding: "User alice, ServiceAccount ns/limited". */
function bindings(o: unknown): string {
  return arr(get(o, "subjects"))
    .map((s) => {
      const ns = str(get(s, "namespace"));
      return `${str(get(s, "kind")) ?? ""} ${ns ? `${ns}/` : ""}${str(get(s, "name")) ?? ""}`;
    })
    .join(", ");
}

const bindingsColumn = column("bindings", bindings, { width: "minmax(200px, 3fr)" });
const RBAC = "rbac.authorization.k8s.io";

registerResource({
  kind: { group: "", version: "v1", kind: "ServiceAccount" },
  sidebar: { section: "accessControl", order: 10, labelKey: "resources:kinds.serviceaccounts", icon: "serviceAccount" },
  columns: standardColumns(true),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: RBAC, version: "v1", kind: "ClusterRole" },
  sidebar: { section: "accessControl", order: 20, labelKey: "resources:kinds.clusterroles", icon: "clusterRole" },
  namespaced: false,
  columns: standardColumns(false),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: RBAC, version: "v1", kind: "Role" },
  sidebar: { section: "accessControl", order: 30, labelKey: "resources:kinds.roles", icon: "role" },
  columns: standardColumns(true),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: RBAC, version: "v1", kind: "ClusterRoleBinding" },
  sidebar: { section: "accessControl", order: 40, labelKey: "resources:kinds.clusterrolebindings", icon: "clusterRoleBinding" },
  namespaced: false,
  columns: standardColumns(false, bindingsColumn),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: RBAC, version: "v1", kind: "RoleBinding" },
  sidebar: { section: "accessControl", order: 50, labelKey: "resources:kinds.rolebindings", icon: "roleBinding" },
  columns: standardColumns(true, bindingsColumn),
  actions: ["edit", "delete"],
});
