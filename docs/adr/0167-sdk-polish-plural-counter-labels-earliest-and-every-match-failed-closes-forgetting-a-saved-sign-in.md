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

## Amendment: more rules and kinds from `sextantApi` 4

Moving the built-in tool modules into extensions needs more than 20 rules over 10 kinds (Knative's two groups,
Crossplane's chain). From `sextantApi` 4 an extension may have 30 problem rules judging 20 kinds (`rule_limits` =
`ruleLimits`); older manifests keep 20 and 10, so an older Sextant never meets a manifest it would refuse.

## Amendment: details sections by condition (#408)

`contributes.detailsSections[].when` (`sextantApi` 4) shows a section only for objects for which the condition holds,
checked as an action's `when` (`check_details_sections` = `checkDetailsSections`, no `missing`) and evaluated by the
window (`DetailsSectionDef.appliesToObject`); while the object loads the section is left out. A GPU block goes only on
GPU nodes, a devices block only on pods that claim devices.

## Amendment: problem categories of an extension's own (#410)

`contributes.problemCategories` (`sextantApi` 4, at most 5: `{id, title, optIn}`) and a rule's `category`
(`check_problem_categories` = `checkProblemCategories`; titles translatable as `problemCategories.<id>.title`). The
window registers each as `ext:<extension id>:<category id>` beside the main `ext:<extension id>`; an opt-in one is off
until turned on (`isOptIn` asks the registry through `setExtensionOptIn`), shown with the opt-in toggles on the Problems
page, and counted on the extension's section only while on. Agents never get these categories: Rust takes only
`ext:<id>` (`category_for_agents`). A columns' `muted` tone came with it (#403).

## Amendment: a details section on every kind (#411)

A details section whose `kinds` is `[{"group": "*", "kind": "*"}]` alone (`sextantApi` 4, no `when`) shows on every
kind: Kyverno's policy results belong to whatever object a report names. The frame hides itself (`ui.setHidden`) where
it has nothing to show. Elsewhere `*` is no wildcard: a permission's or an action's kind `*` matches no kind.

## Amendment: opening a workload cluster (#413)

`ui.openCluster({host, port, node?})` (frames only, a window method like `ui.openUrl`): Sextant lists the configured
clusters whose kubeconfig server is that endpoint (`serverIs`, the default port by scheme) in its own dialog and opens
the one the user picks — connected first if it is not, with `node` that Node's details — every time. The extension
learns only `{opened}`, or `{opened: false, found: 0}` without a question; never the user's clusters or contexts.
