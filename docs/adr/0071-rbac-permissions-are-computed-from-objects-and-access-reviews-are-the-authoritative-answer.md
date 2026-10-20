# ADR-0071: RBAC permissions are computed from the objects, and access reviews are the authoritative answer

## Context

"What can this service account do?", "who can delete Secrets in `prod`?" and "can I exec into this pod?" are answered today by reading Roles, ClusterRoles and their bindings by hand, or with `kubectl auth can-i` and plugins (#140). The cluster stores the RBAC objects, so permissions can be computed for any subject; but the API server decides with every configured authorizer (RBAC, Node, webhooks, ABAC) and lets the group `system:masters` bypass RBAC, and users and their groups are not Kubernetes objects at all. A computed answer can therefore be wrong in both directions, while the server's own answer exists only for the user asking.

## Decision

- **Two kinds of answer, labelled as such.** The "Permissions" page (Access Control section) has three tabs. **Subject** and **Who can** are computed in the frontend from the watched RBAC objects and say so ("Computed from Roles, ClusterRoles and their bindings…", naming what is left out). **Can I** asks the API server for the current user — SelfSubjectRulesReview per namespace ("List my permissions") and SelfSubjectAccessReview per question ("Ask") — and is presented as authoritative.
- **The engine mirrors the RBAC authorizer** (`src/features/rbac/engine.ts`, pure functions): verbs, API groups and resources match by `*` or exactly; `*` in resources covers every subresource, `*/scale` the subresource of any resource, while `pods` does not cover `pods/exec`; a rule with `resourceNames` allows only requests that name one of them (never `list`, `watch`, `create` or `deletecollection` without a name); a ClusterRoleBinding grants everywhere, including cluster-scoped resources and non-resource URLs; **a RoleBinding grants its Role, or the ClusterRole it references, only in its own namespace and never on cluster-scoped resources or non-resource URLs**; a ServiceAccount is also `system:serviceaccount:<ns>:<name>` in `system:serviceaccounts`, `system:serviceaccounts:<ns>` and `system:authenticated`; an aggregated ClusterRole holds its stored rules plus any rule of a matched ClusterRole not stored yet (shown as pending), so it is right before and after the controller runs. A user's groups are typed by the user, since Kubernetes does not store them. Every allowed cell names the binding, the role, the rule and what its wildcards mean; escalating verbs (`escalate`, `bind`, `impersonate`) are pointed out.
- **What cannot be read is unknown, not empty.** A list the user may not read (`forbidden`) or that failed is reported by name, and the views say which permissions are missing because of it.
- **Bounded.** Roles, ClusterRoles and bindings are watched only while a view needs them, shared between the page and the details sections (one watch per list, reference-counted), namespaced lists only in the namespaces of the filter; the matrix shows at most 500 resources and "Who can" at most 1000 grants; one `rbac_can_i` call takes at most 64 questions, 8 at a time, each under `STEP_TIMEOUT`. Reviews are sent only when the user asks.
- **Details sections** of Roles, ClusterRoles, RoleBindings, ClusterRoleBindings and ServiceAccounts explain the rules, who a role is bound to, what a binding grants (or that its role is missing) and what a ServiceAccount can do, and open the page on a subject.
- **Read-only and window only.** The reviews are `create` calls of review objects that the server evaluates and discards; nothing in the cluster changes. Neither agents nor extensions get `rbac_can_i` or `rbac_rules_review` (a test in `src-tauri/src/commands/rbac.rs`).

## Why

- Only access reviews were rejected: SubjectAccessReview for other subjects needs a permission most users lack, the reviews answer one question at a time, and SelfSubjectRulesReview is documented as possibly incomplete; the questions "what can this service account do" and "who can do X" need the objects.
- Only the computation was rejected: it ignores the Node authorizer, webhooks and `system:masters`, so for the user's own requests it can be wrong where the server's answer cannot.
- Computing in Rust was rejected: the inputs are watched objects the window already has, the views need them live, and the results are only displayed.
- Offering the reviews to agents was rejected: they describe the app user's own credentials, which an agent or an extension has no business probing, and ADR-0041 grants nothing new without a decision.

## Consequences

- A cluster with a webhook authorizer or users in `system:masters` shows computed permissions that differ from reality; the note on the page and the **Can I** tab are the remedy.
- Subjects are only those named in bindings, or typed; there is no list of "all users".
- Tests: `engine.test.ts` (matching, scopes, aggregation, service accounts), `rbac.test.tsx`, and the Rust tests of `sextant_core::rbac`.

Amended (v0.16.0): the computed views (Subject, Who can) reach AI agents through the read-only MCP tool `get_permissions` (#210, ADR-0094), always labelled as computed and over the RBAC lists the agent may read; the access reviews stay window-only.
