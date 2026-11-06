# Changes of Argo CD

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
