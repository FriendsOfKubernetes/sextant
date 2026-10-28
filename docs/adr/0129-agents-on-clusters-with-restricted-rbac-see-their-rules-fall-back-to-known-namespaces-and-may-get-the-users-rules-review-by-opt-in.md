# ADR-0129: Agents on clusters with restricted RBAC see their rules, fall back to known namespaces, and may get the user's rules review by opt-in

## Context

Discussion #296: an agent on a cluster where the user's RBAC is namespace-scoped started with "give me an overview" and failed at every step:
- `get_problems` over all namespaces threw (`null.length` in the mesh step, #297);
- `list_resources`, `get_events` and `get_metrics` over "every namespace the agent may read" got a raw cluster-scope 403;
- `get_permissions` came back empty, because the user cannot read the RBAC objects it computes from;
- a namespace of full pods (130–230 KB) did not fit the client.

The agent ended up asking the user which namespaces to look at. Sextant already knew: in the cluster's agent access rules, the context's namespace and the known namespaces (ADR-0124). ADR-0071 and ADR-0094 had kept the access reviews window-only, because they describe the user's own credentials.

## Decision

- **Failed lists are told** (#297). `get_problems` names in `failed` every list it could not read: its category, kind and code, and the refused namespaces. These are re-checked in Rust by the agent's Read rules, so a namespace the agent may not read is never named. A problem there is unknown, not absent.
- **`get_access`** (#298). This read-only tool returns the rules in force: namespaces, kinds, actions, and whether the user is asked first. As hints, it also returns the context's namespace and the known namespaces, but only those the agent may read in. It reads Sextant's settings only: the cluster is not connected and nothing is sent to it. A cluster whose access is Off is refused, as every tool refuses it.
- **A fallback to known namespaces** (#299). When the API server refuses a list over all namespaces, `list_resources`, `get_events`, `get_metrics` (pods) and `helm_list_releases` list the context's namespace and the known namespaces one by one: those the agent may read, at most 20. The answer names them (`namespaces`), names those the cluster refused too (`refused`), and says it is partial. A namespace refused inside a list over the agent's own namespaces is reported instead of failing the call. A namespace the agent asked for by name is still the refusal. With nothing to fall back to, the refusal points at `get_access` and at the setting to add namespaces in.
- **The user's rules review, by opt-in** (#300). This amends ADR-0071 and ADR-0094. A per-cluster switch "Let agents see my effective permissions" (`clusters[id].agentAccessReviews`) is off by default and never exported. With it on, `get_permissions { mine: true }` sends `rbac::rules_review` for the asked namespace, or for the agent's readable namespaces: its rules' own, or the context's and the known ones under a rule for all namespaces, at most 10. The answer is cut to what the agent's rules cover:
  - only resources whose kind those rules cover there with some action;
  - a wildcard only under a rule for every kind;
  - each entry with Sextant's `agentActions` beside the cluster's `verbs`;
  - non-resource URLs are left out;
  - `incomplete` is passed on.

  The window's "Can I" commands stay window-only. The agent's path is the MCP tool behind the Guard, so the command tests still hold.
- **`fields` and `summary` on `list_resources`** (#301).
  - `fields`: at most 20 paths in the custom-column grammar (ADR-0099). A path into a Secret's `data`/`stringData` is refused.
  - `summary: true`: a fixed set of fields for common kinds; any other kind gets its conditions.
  - Both read the object after `compact`, so Secret values and inline secret fields are already gone.
  - A value past 2000 characters is cut and marked.

## Why

- The rules already decide every call. Telling the agent what they are widens nothing, and the agent stops guessing.
- Known namespaces are the user's own statement of where they work (ADR-0124). Using them for an agent is the same answer the window gives.
- An agent acts with the user's credentials and learns them from 403s anyway. Still, whether it may see the review is the user's call: hence an opt-in rather than a default. Cutting the review to the agent's rules keeps the answer to what the agent could act on.
- Projection after `compact` cannot reach anything a whole object would not show.

## Consequences

- The window's access check (ServiceAccount namespace, OpenShift projects) lives in its memory, so the MCP fallback uses only what Rust holds: the context's namespace and the saved known namespaces.
- A rules review lists ClusterRoleBinding rules in every namespace: the note says so.
- No new command. Only `ClusterSettings` gains a field (`agentAccessReviews`, frontend-written, read leniently: only `true` is on).
