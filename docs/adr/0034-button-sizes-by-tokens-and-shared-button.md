# ADR-0034: Button sizes — tokens in one place and a shared Button component

## Context

`.btn` had no height, no `white-space` and no `flex`: buttons were about 26 px and of different heights, and "Hide" next to a long Secret value broke into "Hi / de". Button sizes were overridden in four places in the feature styles: `.btn.btn--small` in the Helm styles (the rule is global and affected all `btn--small`), `.btn--small` in the port-forward styles, `.dt-actions .btn` and `.dt-secret-value .btn` in details. They have the same specificity, and the outcome depended on the CSS load order. The briefing with the user: the standard is 32 px, in table rows and dense lists 28 px.

## Decision

Sizes live as tokens in `:root` of the shared styles: control height 32 px, compact 28 px, font 13 px, icon 16 px. The `.btn` class sets the height, `inline-flex`, `nowrap` and `flex: none`; the variants are primary, danger, compact, icon. The `.btn--small` class and all local size overrides were removed. The shared `Button` component assembles these classes; an icon button requires a label, which goes to `aria-label` and `title`. Old places with `className="btn"` remain and get the same sizes. The compact variant is only the "⋮" button of a table row, the buttons of port-forward rows and Helm repositories, rollback in the Helm history and closing a dock tab; everything else is standard.

## Why

- Keeping the local overrides and fixing each one was rejected: that is what produced the inconsistency, and the Helm rule affected the whole app regardless of where the button was.
- A CSS class alone without a component was rejected as sufficient: the label of an icon button (`aria-label`, on which vitest and e2e rely) must be demanded by types, otherwise a button without text stays nameless. So both a component and a class are needed: moving all places to the component is not mandatory.
- A single 28 px size everywhere was not considered in the materials; 28 px in rows was introduced for dense tables and lists, and the reason for the split is not spelled out directly in the briefing.
- Sizes as tokens rather than numbers in rules: shared by both themes and changed in one place.

## Consequences

- Buttons are larger than before (about 26 px → 32 px), and the details panel and dialogs take more space.
- `nowrap` and `flex: none` on any `.btn`: a long label no longer wraps or shrinks but overflows the container; in narrow places the buttons themselves must wrap (the action bar wraps buttons whole).
- Two ways to get a button: `Button` and a raw `<button className="btn">`. New code must take `Button`; raw markup stays in old places and also gets the sizes.
- There are four or five compact places, and the list in the specification is closed: a new dense row does not become compact by itself.
- The eslint rule on string literals in JSX had to be relaxed for the attributes `variant`, `size`, `icon`, `on*`.
- `global.css` loads last and beats feature styles at equal specificity; a local button size edit in a feature will again produce inconsistency, and `npm run check` will not catch it.
