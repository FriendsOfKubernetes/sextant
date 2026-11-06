# ADR-0154: When an extension action applies, and where its button goes

## Context

An extension action applied to every object of its kinds and always sat in the "Actions" menu (#275). The built-in
GitOps actions decide per object: Promote only while a Rollout is paused, Terminate only while an operation runs.
Their main actions are buttons (#346).

## Decision

- **`when` (`sextantApi` 4).** A problem rule's condition without `missing`, evaluated by the window on the object it
  holds. A condition that holds only from or until a time counts within that window. Where it does not hold, the
  action is not offered.
- **`whyNot`.** A translatable sentence of at most 200 characters, allowed only with `when`. It is the action's
  `notApplicableReason`: the selection bar's "applies to N of M" dialog shows it (ADR-0126).
- **`placement`.** `primary` makes the action a button of the details bar, but only on kinds the extension lists in
  a section of its own (ADR-0152, `ActionDef.primaryOn`). On Sextant's own kinds and other extensions' kinds it stays
  in the "Actions" menu, so #275's rule holds there. `more` is the default.
- The condition only shows or hides the action. Every call the action's window then makes is still checked in Rust.

## Consequences

- Promote, Abort, Terminate and similar actions are offered only where they make sense, with the reason shown
  elsewhere.
- An extension's own views can have main buttons. Nobody else's bar gets crowded.
