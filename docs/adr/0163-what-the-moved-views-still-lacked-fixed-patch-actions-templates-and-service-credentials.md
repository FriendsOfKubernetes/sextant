# ADR-0163: What the moved views still lacked: fixed-patch actions, field values in texts, service credentials

## Context

After Flux, Argo CD and Argo Rollouts moved into Sextant's own extensions (ADR-0162), a side-by-side look against the
built-in views left differences a user would notice (#367–#377):

- Reconcile, Resume and Refresh were one click; in the extensions each opened the extension's window and then Sextant's
  confirmation on top.
- Flux's Source column showed only a name, and its problems the rule's title instead of Flux's reason.
- A problem message cut a controller's condition message at 100 characters.
- Argo Rollouts' Step was blank until the controller wrote the index, and "the controller has not seen the newest spec"
  could not be said: `status.observedGeneration` is a string, `metadata.generation` a number.
- On Argo Rollouts v0.9, which has no status subresource, Promote asked twice.
- Argo CD could not sign in with the API token Secrets `argocd account generate-token` leaves, labelled
  `app.kubernetes.io/part-of=argocd` with generated names, and a wrong admin password was sent again from every window
  until Argo CD locked the account.

`sextantApi` 4 is not released yet, so these are additions to it, not a new version (ADR-0142 freezes released ones).

## Decision

- **Fixed-patch actions** (#367). `contributes.actions[].patch` is a merge patch in the manifest whose only placeholder
  is a whole string value `{{now}}` (RFC 3339); at most 4 KiB, no key with `{{`, never `sextant.dev/values-hidden`
  (`check_action_patch` = `checkActionPatch`). The window sends it itself (`src/extensions/patchAction.tsx`): no frame
  opens and no extension code runs. It goes as `resources.patchMany` in the extension's name, in batches of 50, so Rust
  decides it against the grant, asks where a rule says `confirm` and journals it like any patch of the extension.
  `ask` (title, text, button) is Sextant's own question before it, listing the objects; `done` a notice after. Both are
  translated; neither has placeholders. A declined confirmation says nothing; a failure says which object stopped it.
- **Field values in texts** (#368, #370). A computed column's `cases[].text` may hold up to 5 `{{<field path>}}`
  placeholders (200 characters), checked as a problem message's are (no secret path); a case whose placeholder has no
  scalar value does not hold, so a list of cases can try reference places in turn. A problem rule's `reason` is such a
  template too (200 characters, not translated: it is a code), cut to 100 characters when shown; empty, the rule's
  title stays the reason. Translations of a case text keep exactly the English placeholders (`Text::Template`).
- **Numbers written as text** (#369). `same` holds for the same scalar, or for a number and a string that reads as
  that number (`"3"` and `3`); two strings still compare as text (`"07"` is not `"7"`). A `ratio` column reads a
  missing part as 0 when the whole is there, as Kubernetes leaves zero counts out (`readyReplicas`,
  `currentStepIndex`).
- **More columns.** A manifest may contribute 100 columns (was 50): Flux gives 13 kinds the built-in tables' four or five
  columns each (54).
- **Longer values** (#373). A placeholder keeps 1000 characters (was 100) and a message 1200 (was 300); notifications
  (`clip`, ADR-0067) and agents (`MAX_EXTENSION_MESSAGE_CHARS` = 300) keep their own limits.
- **No status subresource** (#374). Discovery records whether a kind serves `<plural>/status`
  (`ResourceKind.status_subresource`, kept in the backend, never sent to the window); `patch_custom_status` and an
  extension's planned status patch are `notFound` before anyone is asked. An extension that then sends the patch the
  older controller needs asks once.
- **Labelled service Secrets** (#371). A service's `secrets` entry names a Secret by `name` or by `labelSelector`, with
  a key, agreed to at consent like a named one (`[selector]/key` on the consent screen). `service.secrets` lists the
  names of the namespace's Secrets the selectors pick that hold the key — names only, from a list without values,
  after Read on Services there. A `{{secret:<name>/<key>}}` body value or the new `auth: "secret:<name>/<key>"` (the
  value as the bearer token) needs no "Secret values" when the Secret is named by an entry or picked by its selector
  in that namespace; any other still does.
- **A refused sign-in is not repeated** (#372). When a service answers 401 to a request that carried credentials (a
  Secret value, a sign-in value, or such a bearer), Sextant keeps a salted digest of those credentials for the run
  (`ServiceSessions::remember_refused`, ≤ 16 per service). A request carrying the same ones gets
  `{status: 401, body: {message}, notSent: true}` without being sent, until they change, the user signs in through
  `ui.signIn`, or `service.forget`. The values themselves are never kept for it.

## Consequences

- Flux 1.2.0, Argo CD 1.2.0 and Argo Rollouts 1.2.0 use them; their action rules no longer ask Sextant's confirmation
  on top of their own windows (`confirm: false` on Modify of their kinds), so the update asks the user to agree again.
- What stays different, on purpose: Argo Rollouts' Weight column shows the weight the traffic router reports (as
  `kubectl argo rollouts get` with traffic routing); the set weight the built-in column computed from the steps is in
  the details. A column computed by extension code would be a larger API than one column is worth.
- Saved Argo CD logins of the built-in view are still not carried over (ADR-0162): one sign-in after the update.
