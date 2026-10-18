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

Amended (v0.11.0, #141, #169): what an agent can and cannot learn about a Secret's values from writing it.
- A dry run (`dryRun: true` of `patch_resource` or `apply_yaml`) that touches a core Secret — the patched object, or any
  applied document or `List` item of kind Secret — needs "Secret values", whatever the patch. Its result does not
  depend on whether a named value equals the live one: a Secret is `create`, `write` or `refused`, its `data` and
  `stringData` are left out of the field changes, and `writtenKeys` lists the keys the call names. This is defence in
  depth, not a secret kept: an agent with "Secret values" can read the values anyway.
- A real write of a Secret by an agent without "Secret values" is blind (`SecretWrites::Blind` in the core): a
  server-side apply is sent with `force`, so a field owned by another manager is taken over instead of answering a
  wrong guess with a conflict that names it; a change that names `data`/`stringData` of an immutable Secret is refused
  before it is sent, with one fixed text, whether or not the values match; any refusal of the API server comes back
  with its code and a fixed text, never the server's message. The window and extensions write as before.
- Not hidden: the API server's 1 MiB limit on a Secret refuses a write that makes it too large, which tells roughly
  how large the other values are; a write of a value equal to the live one is a no-op (its `resourceVersion` and
  `managedFields` stay), so an agent that may read the Secret's metadata can tell a right guess from a wrong one by
  writing it — a wrong guess overwrites the value, so this is destructive, and it needs Modify on Secrets, which is a
  grant to write them; an admission webhook that decides by the values can still refuse one value and not another.
