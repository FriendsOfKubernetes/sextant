# ADR-0032: The Argo CD installation is found by ClusterRoleBinding, ambiguity is an error

## Context

Sextant puts a password or token from secrets into the Argo CD login (ADR-0028) and sends them to `argocd-server` through a port forward (ADR-0027), where TLS verification is disabled. At first the installation namespace was looked up by the service: the label `app.kubernetes.io/name=argocd-server`, otherwise `argocd`. A review of the branch revealed a hole: in a multi-tenant cluster, anyone who can create objects in their own namespace could plant a Service with such a label, an `argocd-cm` or a Secret with a token, and Sextant would send the real password to a foreign namespace.

## Decision

The sign of an installation is a ClusterRoleBinding `argocd-application-controller` or `argocd-server` (and `<release>-…` for a Helm installation). The binding name and the ServiceAccount name are checked; the namespace is taken from the ServiceAccount and narrowed to namespaces that have `argocd-cm`. If there is no such sign (a namespaced installation or no permission on ClusterRoleBinding), candidates are looked up by `argocd-cm` and `argocd-initial-admin-secret`: the single candidate is taken, or `argocd`; otherwise `notFound` with the prefix `argocd::AMBIGUOUS_INSTALLATION` and a list of namespaces. On such an error the frontend (`isAmbiguousInstallation`, `ambiguousInstallationText`) opens and substitutes nothing. The `argocd-server` service is looked up only in the namespace found — both by the core (`find_server`) and by the "Open Argo CD UI" button: `argocdNamespace` is now equal to `api.argocd.status().namespace`.

## Why

- Looking up the service by label across all namespaces was rejected: a tenant could plant a Service, an `argocd-cm` or a token and intercept the password.
- The first alphabetically of those found was rejected: the same thing, the planter only needs to pick the namespace name.
- A cluster role binding was taken as the sign that a tenant, as a rule, cannot create without cluster permissions. This is an obvious consequence; the materials did not verify it directly.
- On ambiguity, an error rather than a guess: a wrong choice would send the password to the wrong place, whereas an error costs only the user's repeating the action.

## Consequences

- The main path needs permission to read ClusterRoleBindings. Without it (and in a namespaced installation) the fallback path by `argocd-cm` and `argocd-initial-admin-secret` remains, which is protected more weakly: a tenant can create such objects. Protection there rests on the rule "the single candidate, or `argocd`, otherwise an error". Whether `argocd` needs to be among several candidates is not clarified in the materials.
- With several Argo CD installations and no sign, the user gets an error with a list and cannot choose a namespace from the interface: there is no choice. Manual choice is not described in the materials.
- A Helm installation with a different release name is detected only by the form `<release>-…`; nonstandard binding names will not be found.
- The namespace found by the core determines everything: the login sources (ADR-0028), the keyring key (ADR-0029) and the port forward (ADR-0027). Changing the criterion will require cleaning saved logins only if the namespace turns out different.
- The former rule "service by label, otherwise `argocd`" (`ARGOCD_SERVER_SELECTOR`, `DEFAULT_ARGOCD_NAMESPACE`) now applies inside the namespace already found, not for choosing the namespace.

> Amended (v0.6.1): an ambiguous installation can now be resolved by hand (#55). The error still names the candidate namespaces; the diff dialog and "Open Argo CD UI" show them as a choice, and the choice is saved per cluster in the frontend-written setting `clusters[id].argocdNamespace`. The backend reads it on every Argo CD call (`chosen_namespace` in `src-tauri/src/commands/argocd.rs`) and passes it to `find_server` as `preferred`, which takes it only when it is one of the namespaces it would choose from — after the ClusterRoleBinding narrowing — so a choice cannot point the sign-in at a tenant's look-alike next to an installation a binding names, and a stale or edited value that is not a candidate is ignored. When the choice changes, the server is looked up again; if that gives another server, its forward, session, typed login and refusals end. The choice settles only between several: it is applied only when two or more candidates remain after the narrowing; with one (or none) the normal result wins.
