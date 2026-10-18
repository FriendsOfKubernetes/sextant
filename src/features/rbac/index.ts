// RBAC: who can do what (#140). Read-only. The "Permissions" page of the Access Control section (a subject's effective
// permissions as a verbs × resources matrix, "who can …", and "Can I …" answered by the API server), and details
// sections of Roles, ClusterRoles, their bindings and ServiceAccounts. The engine (`engine.ts`) computes permissions
// from the watched RBAC objects; `api.rbac` asks the API server for the current user (SelfSubjectAccessReview and
// SelfSubjectRulesReview, which change nothing). Neither agents (MCP) nor extensions get a new call from it.
import { registerDetailsSection } from "../../layout/details/registry";
import { BindingAccessSection, RoleAccessSection, ServiceAccountAccessSection } from "./details";
import { RBAC_GROUP } from "./engine";
import "./rbac.css";
import "./RbacPage";

// After the kind's own fields (20) and the conditions (30), before port forwarding and metrics (40+).
registerDetailsSection({
  id: "rbacRole",
  order: 32,
  appliesTo: (kind) => kind.group === RBAC_GROUP && (kind.kind === "Role" || kind.kind === "ClusterRole"),
  Component: RoleAccessSection,
});
registerDetailsSection({
  id: "rbacBinding",
  order: 32,
  appliesTo: (kind) => kind.group === RBAC_GROUP && (kind.kind === "RoleBinding" || kind.kind === "ClusterRoleBinding"),
  Component: BindingAccessSection,
});
registerDetailsSection({
  id: "rbacServiceAccount",
  order: 32,
  appliesTo: (kind) => kind.group === "" && kind.kind === "ServiceAccount",
  Component: ServiceAccountAccessSection,
});

export { openRbacPage, RBAC_PAGE } from "./state";
