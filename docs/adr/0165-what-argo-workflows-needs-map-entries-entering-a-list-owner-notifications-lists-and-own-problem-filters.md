# ADR-0165: What Argo Workflows needs: map entries, entering a list, owner notifications, lists, a kind's own filter

## Context

Argo Workflows is the last built-in view of the `argoproj.io` group (ADR-0097). Comparing it with extension API 4
(#391) found five things an extension could not say (#392–#396). `sextantApi` 4 is still unreleased, so they are
additions to it (ADR-0142).

## Decision

- **Map entries by their fields** (#392). The path step `[field="value",…]` takes up to four pairs, all of which must
  match, and picks among a map's values in key order (byte order of the keys, as Rust sorts them) as well as a list's
  items: `.status.nodes[type="Suspend",phase="Running"]`. One grammar in Rust (`PathStep::Match { pairs }`,
  `PathStep::pick`/`pick_mut` — custom columns, problem rules, the MCP projection, a service answer's `capture`), the
  window (`parseFieldPath`, `pickItem`) and the SDK. The secret checks read the step as `*`: a map's value may sit under
  any key.
- **Entering a narrowed list** (#393). `{"type": "enteredWithin", "minutes": N}` (≤ a week) holds for N minutes from when
  the problems store saw the object enter its rule's label-selected source — never for objects already there when the
  list was first read. Only problem rules whose `source` has a `labelSelector` may use it (not actions or column cases).
  The store keeps, per label-selected source, the objects in it and when later ones arrived (`Entry.arrivals`), across a
  reconnect, dropped with the source; the time reaches the rule through `RuleContext.enteredAt`. A rule
  `any[not olderThan(creationTimestamp, 1440), enteredWithin(1440)]` is the built-in "a day from failing, else from
  creation".
- **Owner notifications** (#394). A rule's `notifyAs` names a field path; when the object has a value there the
  notification identity is `<group>/<kind>/<namespace>/<value>` instead of the object: the runs of one CronWorkflow
  notify once. Checked like any rule path (metadata only for a metadata-only source).
- **Lists in cells** (#395). `format: "list"`: a list's scalars joined in the UI language (`formatList`), clipped as any
  cell; anything else in it is left out.
- **A kind's own "Only problems"** (#396). `contributes.kinds[i].problemWhen`: a condition without `missing` that decides
  the filter for that kind instead of the rules' active problems.

## Consequences

- The Argo Workflows extension (#397) can show what the built-in view showed; what stays different is the generic
  section badge text, the progress fallback of controllers before 3.0, and the failed step when several pod nodes
  failed (the first by node id, not by finish time).
- `enteredWithin` cannot be judged by "Only problems" without `problemWhen` (the filter has no store context).
