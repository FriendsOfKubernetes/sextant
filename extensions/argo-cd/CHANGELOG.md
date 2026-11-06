# Changes of Argo CD

## 1.1.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4). Closer to Sextant's former built-in view, and nothing secret passes through the
extension any more.

- Sign-in in Sextant's own dialog: "User and password" or "API token", with "Remember for this cluster" (the system
  keychain, valid while the cluster's API server and CA are the same). The extension never sees what you type, and a
  remembered login is tried by itself before anything is asked. Sign out also forgets the remembered login.
- API token sign-in, sent by Sextant as the bearer of each request.
- Argo CD is reached by the label `app.kubernetes.io/name=argocd-server`, so a Helm release's
  `<release>-argocd-server` works too.
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
