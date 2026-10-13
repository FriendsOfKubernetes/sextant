# ADR-0043: A JSON patch on a Secret, without the Secret values permission, may only add, replace or remove

## Context

The agent may patch resources (`patch_resource`, merge or JSON). A Secret reaches the agent without values and the core already rejects any patch that names the hidden-values marker. A JSON patch has more operations than a write: `test`, `copy`, `move`.

## Decision

For core Secrets, when the agent does not hold the Secret values action, a JSON patch may contain only `add`, `replace` and `remove`. The path (and `from`) of every operation is checked for all kinds: they must be strings that start with `/`. Helm names, namespace, chart and version are validated in the same way before the guard is consulted.

## Why

- Allowing every JSON patch operation was rejected: `test` answers whether a value equals a guess, which discloses it one comparison at a time, and `copy` or `move` can place a value under a key the agent can read. (This is our reading of why the rule exists; the materials give only the rule.)
- Refusing every patch on a Secret was rejected: adding, replacing or removing a key is a normal change that needs only the Modify action, not the values.
- Relying on the marker check alone was rejected: it stops saving a hidden object but does not stop an operation that derives a value from the stored one.

## Consequences

- An agent without Secret values cannot use `test` as a precondition in a JSON patch on a Secret; it has to use a merge patch or read the object first.
- The rule covers only core Secrets, like the hiding itself; other kinds that hold secrets are not restricted this way.
- With the Secret values action the restriction is lifted: the permission already allows reading the values.
