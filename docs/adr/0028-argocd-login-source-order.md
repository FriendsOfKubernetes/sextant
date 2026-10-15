# ADR-0028: Argo CD login tries the standard sources first, the login dialog is last

## Context

The diff requires logging in to the Argo CD API (ADR-0027). The user required: before offering to enter a username/password or a token, try to get them from the standard Argo CD secrets (G05). The login can be saved (ADR-0029). SSO through the browser is not part of the build.

## Decision

If there is no session, `argocd_diff` goes through the sources in order: (1) the saved login; (2) the Secret `argocd-initial-admin-secret`, key `password`, user `admin` — if `admin.enabled` in `argocd-cm` is not equal to `"false"`; (3) a Secret labeled `app.kubernetes.io/part-of=argocd` with a `token` key — as an API token. If none fit, the command answers with the error `unauthorized`, and the window shows a login form: username/password or an API token. In the core: `standard_credentials(..) -> Vec<Credentials>`, `sign_in(&ArgoClient, Vec<(CredentialSource, Credentials)>)`, `login_options(..) -> LoginOptions { local_users, sso }` (for a clear error on an SSO-only server). The login source is `CredentialSource`: `"secret" | "saved" | "manual"`, visible in `argocd_status`. A password and token from secrets are not shown in the window and not logged; `SecretString` prints as `<hidden>`. Refusals are remembered: `standard_credentials_with_origin(..)` returns candidates with an origin `ns/name@resourceVersion`, and `is_refusal(&CoreError)` tells an Argo CD refusal from other errors. A candidate rejected by Argo CD is not tried again in this app session until its source changes: the secret's `resourceVersion`, a new save or a new input. Server unavailability is not remembered.

## Why

- Showing the login dialog right away was rejected by the user's requirement: a standard installation provides the data anyway.
- `argocd-secret` does not fit: it holds only the bcrypt hash of the password, not the password itself.
- The `admin.enabled` check is needed so as not to try to log in to a disabled admin account; the reason is not named directly in the materials.
- Why the saved login comes first and not the secrets is not named in the materials.
- SSO through the browser was rejected as out of scope: only username/password and a token.
- Repeating a rejected candidate on every request was rejected: a stale admin password accumulated failed login attempts and could lock admin out in Argo CD. The memory is tied to `resourceVersion`, so a corrected secret is tried again immediately.
- Remembering server unavailability was rejected too: it is not a refusal of the credentials, and after connectivity is restored the same candidate should work.

## Consequences

- The value of `argocd-initial-admin-secret` is read by the core and is not given to the window. This is a second path for reading a Secret value alongside `secret_value` (ADR-0014); how exactly it reads is not described in the materials. The purpose of ADR-0014 — that the value does not reach the window — is preserved.
- If an administrator disabled `admin` or deleted the secret, what remains is the saved login, the token secret and the dialog.
- Source (3) is any Secret with this label and a `token` key; how one is chosen among several is not described in the materials (the function returns a list).
- On an SSO-only server with no local users, login is impossible altogether; the error says so in words (story 13).
- The memory of refusals lives until the app is closed and is cleared only by a change of the candidate's source. A password corrected in Argo CD itself while the secret in the cluster is unchanged will not be tried until Sextant restarts, a new save or an input. For an expired token the scenario "log in again with the saved one" remains; the `expired` flag is in `argocd_status`.
- While a session exists in memory, the sources are not tried.

> Amended (v0.6.1): refusals are remembered per cluster connection and forgotten on "Sign out" and when the cluster is closed, so a password changed in Argo CD while `argocd-initial-admin-secret` stays the same is tried again after either, not only after a restart. `argocd_status.refused` names what the last automatic sign-in had refused (`typed`, `saved`, `adminSecret`, `tokenSecret`), and the login dialog says so, e.g. that the admin password from the secret may have been changed and the current one should be typed in (#57).
