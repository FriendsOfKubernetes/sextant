# ADR-0164: The last differences: question placeholders, headless actions, case tooltips, limits, sign-in state

## Context

After ADR-0163 the Flux, Argo CD and Argo Rollouts extensions still differed from the built-in views in five places a
user notices (#378–#382):

- Flux's Suspend asked "Suspend this object?": an action's `ask` could not name its object.
- "Reconcile with source" reads the object to find its source, so it cannot be a fixed patch; its window flashed up
  while it sent, where the built-in action was one click.
- A computed column's hover came from `tooltipPaths` whatever case held; the built-in Rollout status explained "the
  controller has not seen the latest spec yet" there.
- Argo Rollouts' Degraded had to be two rules: "the controller has seen the spec" (the same number, or v0.9's hash)
  needs a fourth level of `all`/`any`/`not`, and the rule already used the 20 conditions allowed.
- The Argo CD session bar could not tell a sign-in saved in the keyring from one typed for this run.

`sextantApi` 4 is still unreleased, so these are additions to it (ADR-0142).

## Decision

- **Placeholders in the question** (#378). `ask.title`, `ask.text` and `ask.confirm` may hold `{{count}}`, and on an
  action that is not `multiple` `{{kind}}`, `{{namespace}}` and `{{name}}` of the object; nothing else
  (`check_ask_text` = `checkAskText`). The window fills them (`fillAsk` in `src/extensions/patchAction.tsx`) and still
  lists the objects under the text. Translations keep the same placeholders (`Text::Template`, the title included).
- **Actions without a window** (#379). `contributes.actions[].headless: true` (not with `patch`): the window loads the
  action's frame out of sight (`src/extensions/headless.tsx`, `.ext-headless`), with the context a window's frame gets
  — the same bridge, Rust's decisions and Sextant's confirmations. The frame ends the run with `ui.close`; `ui.notify`
  is how it talks to the user; a reported error or a frame that does not load ends the run with a notice of the
  extension's, and so does a run past `HEADLESS_LIMIT_MS` (2 minutes). Disabling or removing the extension ends its
  runs. This is also what Argo Workflows' actions will need (a patch with a re-read `resourceVersion`).
- **A case's tooltip** (#380). `cases[].tooltip` (300 characters, the text's placeholder grammar, translated with the
  same placeholders) is shown on hover while the case holds; one whose placeholder has no value leaves the column's own
  `tooltipPaths`.
- **Limits by API version** (#381). From `sextantApi` 4 a condition (of a rule, an action or a column case) nests 4
  deep and a rule holds 30 conditions (`condition_limits` = `conditionLimits`); older manifests keep 3 and 20, since an
  older Sextant reads only those. `of` stays at most 10 items.
- **Sign-in state** (#382). `service.signInState` answers `saved` (a sign-in in the keyring for this cluster's API
  server and CA), `session` (typed for this run only) or `none`, after Read on the Service; never a value. A sign-in
  read back from the keyring keeps a refusal remembered for it (`restore_sign_in`), unlike one the user types.

## Consequences

- Flux, Argo CD and Argo Rollouts 1.3.0 use them; the differences left are those ADR-0163 names (Rollouts' Weight, old
  Argo CD keyring logins).
- A headless frame is still extension code: it gets nothing a visible window would not, and the user sees every
  confirmation Sextant asks for it.

## Amendment: the set weight (#386, #387)

The built-in Argo Rollouts Weight column showed the set weight (`GetCurrentSetWeight`): 0 after an abort, the maximum
once every step is done, else the `setWeight` of the current step or the nearest earlier one, written "25%". Two
generic additions to `sextantApi` 4 let a manifest say it:

- **`atLeast`** `{path, otherPath}`: both read as numbers (a number, a string that reads as one, a list as its length);
  holds when the first is at least the second, never when either is not a number. Checked like `same` (no secret path).
  It also lets "observed" read `observedGeneration` ≥ `generation`, as the built-in view did.
- **A column's `lookup`** `{list, index, field, nearestBefore?, orElse?}`: `field` (a path inside an item) of the item of
  `list` that `index` names — 0 when the object leaves the index out —, with `nearestBefore` else the nearest earlier
  item's, else `orElse`; it comes before `paths`. A column needs `jsonPath`, `paths` or a `lookup`; the field is
  checked where it is read (`<list>[0]<field>`). **`valueText`** writes a `text` or `number` value with the one
  placeholder `{{value}}` (`{{value}}%`, `{{value}} %` in French), translated with the same placeholder.

With these, Argo Rollouts' Weight is the built-in column; the weight the router reports stays in the details.
