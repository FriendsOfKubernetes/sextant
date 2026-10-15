# ADR-0050: Extension permissions use the agent-access model, and the user consents to them at install

## Context

The user must be sure that an extension cannot get more access to clusters than they allowed. Agent access already has a model for this: rules of namespaces, kinds and actions, "ask before running", Secret values as a separate action, and a pure decision function. It has no cluster dimension (the cluster is the outer key in settings) and no deny rules.

## Decision

An extension declares `permissions` in the manifest: `clusters` (all, or a list of context names) and `rules[]` of the same shape as access rules (namespaces, kinds, actions, `confirm`), with the actions limited to read, modify, delete, logs and secretValues. Exec, port forward and Helm are not available to extensions. Decisions reuse `access::decide` for each cluster. Resources with no namespace are covered only by a rule for all namespaces. `confirm` defaults to true for modify and delete, and then the user is asked to Allow (120 s, then refused). `resources.get/list/watch` never return Secret values; `secret.value` needs the `secretValues` action.

At install the user sees the extension's name, author, version, source, contributions and the permissions in plain language ("Read Pods, Deployments in all namespaces of all clusters; Modify ConfigMaps in team-a - asks before running"); Secret values get a warning. Nothing is granted before "Install". What is granted is stored with the extension; an update that asks for more needs consent again, and a dev folder whose manifest widens its permissions is suspended until it is reviewed.

## Why

- A new permission vocabulary was rejected: users already learned this one for agents, the rules editor and the decision function exist and are tested, and "closed by default, Secret values separate" is the property we want.
- Coarse capabilities such as "can read the cluster" were rejected: they do not express "modify ConfigMaps in team-a only".
- Trusting the manifest without consent was rejected: a package from a file or a link is third-party code.
- Signed packages as a trust root were left out: there is no key infrastructure; consent on the shown permissions is the control.

## Consequences

- Permissions are given by context name, so they also cover a same-named context from another kubeconfig source. The consent screen and the wiki have to say so.
- There are no deny rules: a broad rule cannot be narrowed except by editing the grant and re-installing.
- The consent screen has to stay readable for large rule sets; an extension that asks for everything is shown as it is, and the user decides.
- The manifest parser is strict (an unknown field or value is an install error with the field path), which keeps the grant unambiguous but means a newer manifest does not install on an older Sextant.

Amended (v0.6.1): a dev folder whose manifest now asks for less than was granted (within the grant, not equal) is granted only what it asks for, without a dialog; its watch streams opened under the wider grant stop, and asking for the wider permissions again needs consent again.
