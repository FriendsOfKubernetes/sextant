# ADR-0167: SDK polish: plural counter labels, the earliest and every match, failed closes, forgetting a saved sign-in

## Context

After Argo Workflows moved (ADR-0165), four differences from the built-in views were left that extension API 4 could
not express (#398–#401). `sextantApi` 4 is still unreleased, so they are additions to it (ADR-0142).

## Decision

- **A counter's own label** (#398). `contributes.sectionBadges[].label` gives the tooltip and accessible label by CLDR
  plural form (`zero`, `one`, `two`, `few`, `many`, `other`; `other` required), each text with `{{count}}` once and no
  other placeholder, ≤ 80 characters (`check_label_forms` = `checkLabelForms`). Translations key every form a language
  needs as `sectionBadges.<section>.label.<form>`; when a language translates any form the window uses its forms only,
  else the English ones. The window picks the form with `Intl.PluralRules` in the UI language, `other` when that form is
  not given, and writes the count with `formatNumber` (`src/extensions/pluralLabel.ts`).
- **The earliest match and every match** (#399). A match step ends in `<field` — of the matches, the one whose `field`
  sorts first (RFC 3339 times sort as text; one without it last) — or `*` — every match, as a list, only in the last step:
  `.status.nodes[type="Pod",phase="Failed",<finishedAt].message`, `.status.nodes[type="Pod",*]`. One grammar in Rust
  (`PathStep::Match { pairs, pick: MatchPick }`), the window and the SDK. Where one value is needed and a list cannot be
  (the MCP projection, a service answer's `capture`) `*` is refused.
- **A failed close** (#400). `ui.close({failed: "…"})` ends an action window or a headless action as failed: Sextant
  shows its own failure dialog for the action with the text (≤ 1000 characters), as for a built-in action
  (`reportActionFailure`). Without `failed` a close is a plain close, as before.
- **Forgetting only a saved sign-in** (#401). `service.forget({…, saved: true})` removes only the sign-in remembered in
  the keyring and keeps this run's session and tokens; journaled as "saved sign-in of service …".

## Consequences

- Argo CD offers "Forget saved login" without signing the user out of the running session; Argo Workflows counts with
  "N workflows failed recently" and names the step that failed first; Flux's and Argo Workflows' headless actions end
  with Sextant's failure dialog instead of a notice.
- A `*` path yields a list: a column formats it with `format: "list"`, a rule compares it as a list (`same`, lists
  counted as lengths).
