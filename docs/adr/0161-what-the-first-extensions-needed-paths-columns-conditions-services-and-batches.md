# ADR-0161: What the first extensions needed: paths, columns, conditions, services and batches

## Context

The Flux, Argo CD and Argo Rollouts extensions (built on ADR-0152–0160) met gaps that made them differ from the
built-in views (#359–#366).

## Decision

- **Printer columns (#359).** `contributes.kinds[i].printerColumns: false` leaves the CRD's printer columns out of a
  listed kind's table (`KindPlacement.printerColumns`, `getResourceDef`).
- **Field paths (#360).** The grammar of ADR-0099 gains `[field="value"]`: the first list item whose `field` is the
  string `value` (`PathStep::Match`; `{field, value}` in the window and the SDK).
  - It is read alike everywhere: rules, columns, conditions, placeholders, custom columns, the MCP projection and the
    session capture.
  - The secret checks take it as a list item (it matches `*` only).
- **Columns (#361).**
  - `cases[].tone` tones a case's own (translated) text.
  - `afterColumn` places a column after a column id: Sextant's (`name`, `namespace`, `age`) or one of the extension's
    own manifest ids, the same in every language.
- **Conditions (#362).** `{"type": "same", "path", "otherPath"}` holds when both are the same scalar; two missing
  fields are not the same. A list read where a number is wanted counts as its length.
- **Batches (#363).** `resources.patchMany({clusterId, items})`, 1–50 items:
  - every item's shape is checked before the cluster is touched;
  - every item is decided, and one confirmation lists them all;
  - the items are sent in order, and the first failure stops the rest;
  - the answer gives each sent object, the error that stopped, and `sent`;
  - the journal keeps one entry for the call, naming the objects.
- **Notification groups (#364).** A problem rule's `group` replaces its id as the problem's group: rules of one group
  notify once per object (ADR-0067).
- **Services (#365).**
  - A service is named by `name` or `labelSelector`: exactly one Service it picks in the namespace (none is not found,
    more is a conflict).
  - `secrets: [{name, key}]` lists the Secret keys it may receive in `{{secret:…}}`, agreed to with it. They need no
    namespace-wide "Secret values".
  - `auth: "signIn:<field>"` sends that sign-in field as the bearer token.
- **Hiding sections (#366).** `ui.setHidden({hidden})` hides a details section, title included, while it has nothing
  to show. The frame keeps running, and tabs ignore it.

Every new manifest field is in `sextantApi` 4 and checked alike in Rust and the SDK (manifest-cases.json).

## Consequences

The three extensions can show the same columns, messages, buttons and notifications as the built-in views, reach a
Helm-installed Argo CD, and sign in with an admin password or an API token without the extension seeing either.
