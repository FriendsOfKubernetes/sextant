# ADR-0152: Extensions list kinds in a section of their own, and narrow their problem rules

## Context

Moving the Flux, Argo CD and Argo Rollouts/Workflows views into extensions (#320) needs what the built-in views
have. Two gaps are about where objects are listed and how problems are found:

- **Lists.** A built-in view lists its kinds in a sidebar section of its own with Sextant's tables. An extension's
  CRDs show only under "Custom resources". A table the extension draws in a frame loses table filters, the selection
  bar, search over every column, saved views, custom columns, the keyboard model and the palette (#344).
- **Problems.** Flux reports Ready=False except for in-progress reasons, and Argo Workflows counts runs that failed
  within the last day from one metadata-only watch of failed runs. Extension rules (ADR-0137, ADR-0144) have no
  negation and always watch a whole kind cluster-wide (#348).

## Decision

- **`contributes.kinds` (`sextantApi` 4).**
  - Each entry has `group`, `kind`, `section`, and optionally `sectionTitle`, `title`, `icon`, `order`. The kind
    is listed in that section with Sextant's own table, details and actions instead of "Custom resources".
  - The section must be the extension's own: one of its kinds or pages with that section has a `sectionTitle`.
    `own_section` is shared with section badges (ADR-0143).
  - Only custom resources: the core group and wildcards are refused. Each kind is listed once.
  - The section is a discovered section. A kind not served is not listed, and the section's pages show only while one
    of its kinds is served (`placedSections` in the sidebar).
  - The table's title is the entry's `title`.
  - "Only problems" comes from the extension's rules for the kind. An object counts only when the rules' source
    selector picks it (`matchesSelector`, the window's Kubernetes selector matcher).
  - A kind Sextant describes itself (`registerResource`) keeps its own place. When several extensions list a kind,
    the one with the smallest id wins (`placeKind`).
  - Titles are translatable (`kinds.<index>.title`, `kinds.<index>.sectionTitle`).
- **`not` in problem rules (`sextantApi` 4).**
  - `{"type": "not", "of": <condition>}` counts toward the nesting and size limits.
  - It is never around `missing`: a list not read in full would make it unknown.
  - Around a condition that holds only from a time on (`olderThan`), it holds until that time. A verdict therefore
    carries `until`: `all` takes the earliest end, and `any` the branch that holds now for longest. "Failed within a
    day" thus stops by itself.
- **A rule's `source` (`sextantApi` 4).**
  - `labelSelector` is a Kubernetes selector: `key`, `!key`, `=`, `==`, `!=`, `in`, `notin`, at most 1000
    characters. It is checked by `is_set_selector` in Rust and `isSetSelector` in the SDK, and passed to the watch.
  - `metadataOnly`: every path of the rule (condition, `since`, message) must be under `.metadata`, and `condition`
    is refused.
  - Every rule of a kind has the same source, so one watch serves them. The window keys sources by it (`sourceKey`).

## Consequences

- An operator view moved into an extension keeps its sidebar section and Sextant's tables, with every table feature,
  without drawing a table of its own.
- Rules can say "not in progress" and "within a day", and an extension can watch a narrow list rather than every
  object of a kind.
- An extension cannot take a kind Sextant lists itself, nor a Kubernetes kind.
