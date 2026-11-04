# ADR-0143: Extensions count their problems on their own sidebar sections

## Context

Many built-in views put a counter of their problems on their sidebar section's header (`registerSectionBadge`,
ADR-0063): CloudNativePG, Strimzi, Kueue, Crossplane, KubeRay, JobSet, the GPU Operator, Cluster API and others.
Moving one of them into an extension (#320) would lose the counter: an extension's own sidebar section had none. #331
asks for it.

An extension already reports problems through declarative rules that the window evaluates (ADR-0137). Each rule runs
only for the kinds the user agreed to (`grantedProblems`) and the namespaces Rust allows (`extension_problem_scopes`),
under the category `ext:<id>`.

## Decision

- **A manifest field of API 3.** `contributes.sectionBadges` (`sextantApi` 3) lists counters as
  `{ section, rules? }`.
  - `section` must be a section of the extension's own: one of its pages with that `section` gives a `sectionTitle`.
  - `rules` names ids of its `contributes.problems`. Left out, it counts every rule.
  - There are at most 10 counters, one per section.
  - A manifest with counters needs `contributes.problems`.

  `check_section_badges` (Rust) and `checkSectionBadges` (SDK) check this alike, with cases in `manifest-cases.json`.
  An older Sextant refuses the manifest by its API version (ADR-0142). `SUPPORTED_API` is now 3.
- **The window counts; the extension's code does not.**
  - `contributions.tsx` registers a counter with `registerSectionBadge`. It counts the objects (by uid) with active
    problems of the extension's category, of the named rules only (`useExtensionSectionCount`; a problem's `group` is its
    rule's id). The problems come from the problems store's own watches, as on the Problems page. Nothing new is watched,
    and no frame or backend is asked.
  - It has the built-in counters' look (`danger`) and a host text ("N objects need attention") in every language.
- **Never on someone else's section.**
  - A counter on one of Sextant's own sections (`SIDEBAR_SECTIONS`) is ignored, even though a manifest cannot be
    refused for it: a section of Sextant's stays Sextant's.
  - So is a counter on a section another extension already counts: the first registered keeps it.
  - It goes with the extension, as its other contributions do.
- **The example.** The crd-view example (1.1.0, API 3) gets a "Widgets" page in its own "Demo widgets" section, with a
  counter of its problem rule.

## Consequences

- An operator view moved into an extension keeps its counter with no code of its own. The counter is computed from
  the same rules as its problems, so the two never disagree.
- The counter can say only what the rules say. A count that needs other objects waits for rules across objects (#332).
- Agents do not get extension problems (ADR-0137; #333 decides whether they will). The counter changes nothing there.
