# ADR-0153: Extension columns computed from field paths

## Context

`contributes.columns` took one JSONPath and showed plain text. The built-in GitOps columns are computed (#345):
- Flux's Revision is the first of several status fields, and its Ready is a colored word with a tooltip.
- Argo Rollouts shows "step i/n" and weights.
- Argo CD shows "Syncing" while an operation runs.
- Argo Workflows shows a duration.

## Decision

- **Fields (`sextantApi` 4).** A column has either `jsonPath` (as before) or `paths`: up to 8 field paths, where the
  first with a value gives the cell. With `paths` it may also have:
  - `format`: `text` (default), `number`, `age` (a time drawn as an age), `duration` (from the time to `endPaths`,
    or now), or `ratio` (`value/totalPaths`);
  - `tones`: a shown value mapped to `ok`, `warning`, `error` or `neutral`, at most 20, drawn as Sextant's status
    text;
  - `tooltipPaths`;
  - `cases`: at most 10 `{when, text}`. The first `when` that holds now replaces the value with its translatable
    `text`. `when` is a problem rule's condition without `missing`.
- **Checks.** These fields go only with `paths`. `endPaths` goes only with `duration`, and `totalPaths` only and
  always with `ratio`. No path may read a Secret's values or an inline secret (`check_path`). Rust (`check_columns`)
  and the SDK check alike.
- **In the window.** `computedColumn` (`src/extensions/columns.tsx`) gives the column a sort value, search text and
  table-filter type that follow the format. Cells are clipped at 200 characters. No extension code runs.

## Consequences

- The GitOps columns can be written declaratively. Sorting, search and filters work as for Sextant's own columns.
- A column cannot run code. What it can show is bounded by the path grammar and the formats.
