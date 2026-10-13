# ADR-0020: Installing a chart saves only the changed values, comparison by YAML 1.1 rules

## Context

Installing a chart through `helm` (ADR-0005) saved as user values the whole file of default values that the user saw in the editor. The core uses `serde_yaml` for YAML (YAML 1.2 rules), while `helm` reads values as YAML 1.1 (go-yaml v2).

## Decision

Before installing, `cli::install_chart` runs `helm show values` and passes to `helm` only what `cli::changed_values(defaults, edited)` found changed: with no edits the new release gets empty user values, and if one key was changed, only that key. `changed_values` and `values_to_yaml` follow YAML 1.1 as in go-yaml v2, checked against helm v4.3: typing of plain scalars, merge keys `<<` (on a repeat the later key of the document wins, in a list of maps the earlier map wins), escaping of U+2028, U+2029 and U+0085. `changed_values` emits the result in flow style.

## Why

- Saving the whole file (the previous behavior) was rejected: user values pin the old defaults, and when the chart is upgraded its new default values stop taking effect.
- Comparison by YAML 1.2 was rejected: `helm` and `serde_yaml` type the same text differently (`yes`, `on` are booleans in YAML 1.1 and strings in 1.2; merge keys too), and the difference in parsing would give a wrong "changed / not changed" conclusion.

## Consequences

- Every install makes an extra `helm show values` call: it needs an accessible repository and time.
- The YAML 1.1 rules were checked against one version of `helm`; divergence from other versions was not checked in the materials.
- The core reproduces the YAML 1.1 parsing rules itself, so a divergence from `helm` in an edge case is caught only by checking against a real `helm`.
- In the saved release the user values look like flow YAML (`{a: {b: 1}}`), not like the familiar block file.
- `values_to_yaml` belongs here too: any other code that turns values into YAML for `helm` must go through it.
