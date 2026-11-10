# ADR-0144: Extension problem rules across objects

## Context

An extension's problem rules (ADR-0137) judge one object at a time, by its own fields. Several built-in views that
could move into extensions (#320) judge across objects:

- a reference to an object that is not there: a Kueue LocalQueue whose ClusterQueue is missing, a Traefik route
  naming a Middleware or Service that does not exist;
- a problem told through another object: an owned Knative object through its owner, an orphaned Contour proxy
  through the invalid root above it;
- only the newest of a series: the latest failed OpenShift Build of a BuildConfig.

#332 asks for these, still evaluated by the window and never by extension code.

## Decision

Three additions of `sextantApi` 3, checked alike by `check_problems` (Rust) and `checkProblems` (SDK), with cases in
`manifest-cases.json`:

- **The condition `missing`.**
  - Its shape is `{ "type": "missing", "path": ".spec.clusterQueue", "kind": { "group", "kind" } }`. It holds when the
    text at `path` names no object of `kind`: in the object's namespace, or in the cluster for a kind without
    namespaces.
  - Nothing named (no text there) is nothing missing.
  - It may stand alone or inside `all`, never inside `any`, where a list not read would make the whole `any` unknown.
  - It never names a core Secret: Secrets are not listed for rules.
  - Its kind counts among the rules' 10 kinds and joins the kinds the user agrees to (`problem_kinds`,
    `grantedProblems`). The consent screen lists it apart: "To tell whether an object a rule names exists, Sextant also
    lists objects of these kinds".
- **`toldThroughOwner: true` on a rule.** The problem is not told while the object's controller (the owner reference
  with `controller: true`) has a problem of the extension's rules, counted or still in its grace.
- **`newestPer: "<label key>"` on a rule.** Among the objects of one namespace with the same value of that label, only
  the newest, by `creationTimestamp` and then by name, can have the problem. An object without the label is judged
  alone.

**How the window judges.** The object-by-object verdict (`problemRules.ts`) stays as it was. It now also records the
objects a `missing` names (`Detected.lookups`) and, for `toldThroughOwner`, the controller's uid (`ownerUid`). A
source of a kind with such rules, or of a kind a `missing` looks up, gets `SourceDef.judge`:
- The problems store keeps a row tap of its objects while it lives: namespace, name, creation time and the labels
  `newestPer` names.
- Every problem list goes through `judgeAcross` (`src/extensions/problemsAcross.ts`), which reads:
  - those rows;
  - the rows of the category's source of each looked-up kind (the same source key the extension's rules would use, so
    there is never a second watch of a kind);
  - which objects of the category have problems.
- A source of the category that publishes makes the others judged with it look again.

Looked-up kinds get a source of their own even without rules of their own, within the namespaces Rust allows for
them (`extension_problem_scopes`).

**What cannot be told is no problem.** This is the opposite of `across`, which shows every problem until its rows are
read. A `missing` is no problem when the looked-up list:
- is loading, failed or capped;
- is of a kind the cluster does not serve;
- is of a kind the extension may not read there;
- does not cover the object's namespace.

`newestPer` is no problem until its own rows are read. As ADR-0082 says, "unknown" never rounds up.

## Consequences

- Kueue's queue checks, Traefik's and Contour's references, Knative's owned objects and OpenShift's builds can be
  written as rules. A check that needs more than these (Contour's include tree, Istio routing) stays in Sextant until
  a further ADR.
- A rule's problem may appear later than the object, once the lists it reads are in. It may also disappear while they
  reconnect from an error, but not while they only reconnect.
- The looked-up kinds are watched in full (capped at `MAX_SOURCE_OBJECTS`), within the extension's read scope, and only
  while the problems store holds the category's sources.

## Amendment: rules of kinds read from definitions

A rule may take its kinds from definitions (`kindsFrom`, ADR-0137 amendment); such a rule judges each object by its own
fields, so none of this ADR's conditions or rule fields goes with it, and the definitions' source is judged across
objects only to follow what they define.
