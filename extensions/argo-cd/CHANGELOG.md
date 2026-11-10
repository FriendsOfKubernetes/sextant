# Changes of Argo CD

## 1.4.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4) with `service.forget({saved: true})` (ADR-0167, #401). The rules and services
are unchanged; the agents' tools are new.

- **"Forget saved login"** in the diff's session bar while the login is saved for the cluster: Sextant forgets the
  remembered login only, this run stays signed in, as the built-in view's button did.
- **Tools for AI agents** (#402): Sync, Refresh and Hard refresh (`sync`, `refresh`, `hard-refresh`), answered by
  the extension's new backend, as Sextant's former MCP tool `gitops_action` did. Updating asks for consent to the tools; agents get them only once you turn the extension's
  tools on in Settings → AI agents (MCP).
- **The tables of Resources, Sync history, sources and destinations** resize their columns and Sextant remembers the
  widths, as the built-in view's did (#417); widths set in the built-in view carry over.

## 1.3.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4) with its newest extension API. What still differed from Sextant's former built-in
view (#384):

- The Diff's session bar tells a login of Sextant's dialog remembered for the cluster ("with the saved login") from
  one typed for this run only ("until Sextant is closed"), in the built-in view's words in every language. Sextant
  says which (`service.signInState`), never a value; "with your sign-in" stays when it cannot say.

No new permissions: an update asks for no consent.

## 1.2.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4) with its newest extension API. What still differed from Sextant's former built-in
view (#376):

- The Diff signs in with API tokens from Secrets again: after the remembered login and the admin Secret, it tries the
  `token` of each Secret labelled `app.kubernetes.io/part-of=argocd`, by name, and keeps the first Argo CD accepts.
  Sextant sends the token itself; the extension learns only the Secrets' names and still needs no "Secret values".
- A wrong admin password (or token, or login) is no longer tried from every Diff window: Sextant does not send
  credentials Argo CD refused again in this run, and the sign-in says the admin password was refused, as before.
- The session bar says how the Diff signed in: with the standard Argo CD secret, with the API token from a named
  Secret, or with your sign-in.
- Refresh and Hard refresh are one click again: no window and no question, on one or several Applications.
- Sync… and Terminate… are no longer confirmed a second time: their windows are the question, as in the built-in view.

An update asks for consent again: the Modify rule on Applications no longer confirms (`confirm: false`), and the two
token services may receive the `token` key of Secrets labelled `app.kubernetes.io/part-of=argocd`.

## 1.1.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4). Closer to Sextant's former built-in view, and nothing secret passes through the
extension any more.

- Sign-in in Sextant's own dialog: "User and password" or "API token", with "Remember for this cluster" (the system
  keychain, valid while the cluster's API server and CA are the same). The extension never sees what you type, and a
  remembered login is tried by itself before anything is asked. Sign out also forgets the remembered login.
- API token sign-in, sent by Sextant as the bearer of each request.
- Argo CD is reached by the label `app.kubernetes.io/name=argocd-server`, so a Helm release's
  `<release>-argocd-server` works too.
- Requests to Argo CD's API (the diff, sign-in) and "Open Argo CD UI" are no longer confirmed each time: the
  Port forward rule on Services has `confirm: false`, as Sextant's former built-in view never asked.
- The admin password of `argocd-initial-admin-secret` is a key the services declare: the extension no longer asks for
  "Secret values" on Secrets in `argocd`, and signs in by itself in any namespace.
- The section "Argo CD" has its icon and sits after Velero, where the built-in one was; the palette searches
  Applications by default and knows `app` and `apps`.
- The tables leave out the CRDs' printer columns and place each column by id; "Syncing" is a warning in every
  language.
- Refresh and Hard refresh of several Applications ask once for all of them.
- The Resources and Sync history sections hide while an Application has none; the details use Sextant's UI kit.
- Fixed: the folded unchanged lines of the diff said how many.

An update asks for consent again: the services changed (two new ones for API tokens, a label instead of a name,
the admin Secret's key, the sign-in fields) and the "Secret values" rule is gone.

## 1.0.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's built-in Argo CD view as an extension.

- Applications, ApplicationSets and AppProjects in a sidebar section "Argo CD" of their own, with Sextant's tables,
  the columns Project, Sync, Health, Revision, Destination and Target namespace, and a counter of Applications with a
  problem.
- Details: the fields of each kind, an Application's resources with what they own and their health (computed as
  Argo CD does where Argo CD 3.x keeps it only in its API), and its sync history.
- Sync…, Refresh, Hard refresh and Terminate…, each confirmed by Sextant; Sync only while no operation runs,
  Terminate only while one does.
- Diff of desired and live states through Argo CD's API, signing in by itself with `argocd-initial-admin-secret`
  (whose password only Sextant sees) or with a typed user and password for the session.
- Open Argo CD UI through a port forward, after you agree to open the address.
- Problems: Degraded and SyncFailed Applications.
- Not as in the built-in view: a typed sign-in is not remembered across runs, there is no API token sign-in, and the
  diff reaches only a Service named `argocd-server`.
