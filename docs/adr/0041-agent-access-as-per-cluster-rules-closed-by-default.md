# ADR-0041: Agent access is a set of rules per cluster, closed by default, with Secret values as a separate action

## Context

The user wants to decide, for each cluster, which namespaces, which kinds of resources (including CRDs, Flux, Argo CD and Helm releases) and which actions the agent may use, with one rule set per cluster for all agents. The decision is made on every tool call and has to be explainable to the user and to the agent.

## Decision

The policy is a pure module of the core (`access`) with no input or output. A rule is namespaces (all, or a list) times kinds (all, or a list) times actions (Read, Modify, Delete, Logs, Exec, Port forward, Secret values) plus "Ask before running". A call is allowed if at least one rule covers (namespace, kind, action); otherwise it is denied. A confirmation is needed if any covering rule asks. Access is Off by default, and a stored value that is not recognised (for example an unknown action in a rule) is read as Off. The presets (Read-only, Read + write without delete, Full) are functions that produce rules, remembered in `preset` only for display; a preset other than Custom acts with its own rules and ignores the stored ones, and choosing Custom copies the preset's rules for editing. The frontend takes preset rules from the core through one command and does not duplicate them. Rules live in `settings.json` under `clusters[id].agentAccess` as a frontend field, and the server reads fresh settings on every call, so a change applies to the next call without restarting.

Resources without a namespace (Node, Namespace, PersistentVolume, CRD, ClusterRole) are covered only by a rule with "All namespaces". The guard passes no namespace for such a kind whatever the agent sent. A Helm release is a pseudo-kind `helm.sh/Release`, so the same rules cover it. "Secret values" is its own action: no preset includes it, only an explicit rule. Without it a Secret is returned without values, `get_secret_value` is denied, and Helm values and manifests are not returned.

## Why

- Open by default was rejected: an agent that was never configured must not reach a cluster. Treating an unreadable value as Off keeps a damaged file from widening access.
- One global rule set was rejected: the briefing asks for access per cluster, and the namespaces and CRDs differ between clusters.
- Rules per client or per token were rejected: the briefing says one set per cluster for all agents, and nothing in the materials needs more.
- Presets only, without rules, were rejected: the user must be able to allow one namespace or one kind.
- A preset as a separate evaluation mode was rejected: two ways to decide would have to agree. Presets that generate rules keep one `decide`.
- Matching a cluster-scoped kind against a named namespace was rejected: a rule "team-a, all kinds, Delete" would then permit deleting a Node when the agent passes `namespace: team-a`.
- Including Secret values in Read was rejected: the app already hides values everywhere (ADR-0014); the agent gets them only by an explicit decision. Helm values and manifests are treated the same because they can hold secrets.
- Hiding secrets inside CRDs and ConfigMaps is out of scope; the rule for the agent is the same as in the app, where only core Secret values are hidden.

## Consequences

- A preset cannot be changed in place; the user switches to Custom, which starts from a copy.
- A rule that covers a kind says nothing about secrets stored in other kinds (ExternalSecret, SealedSecret, ConfigMap); granting Read on them exposes their content.
- Because a call is allowed when any rule covers it, there are no deny rules; narrowing means deleting or editing a rule.
- Tools that touch several objects (`apply_yaml`, `drain_node`) must check every object before sending anything, so the tool-to-permission table is part of the contract.
- A new field in the rules must be tolerated by old settings files (`#[serde(default)]`), and an unknown value becomes Off rather than an error.
