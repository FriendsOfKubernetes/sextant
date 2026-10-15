# ADR-0029: The saved Argo CD login is kept in the OS keyring (`keyring`) in the app

## Context

The Argo CD login can be saved (G04) so as not to enter it again. The data is secret: a password or an API token. The app's settings live in `settings.json` (ADR-0017), and the core does not depend on the OS under ADR-0002.

## Decision

Saving is done by the `keyring` crate (Keychain / Credential Manager / Secret Service) in the `src-tauri` app, not in the core. The entry: service `sextant`, user `argocd:<clusterId>:<namespace>` (the pair of cluster + Argo CD namespace), the value is JSON `{username,password}` or `{token}`. The entry is made by the "Remember" checkbox in the login dialog; "Forget" (`argocd_logout(clusterId, { forget })`) deletes it. Without "Remember" the login lives until the app is closed. The session token is in memory only (`AppState.argocd`). On Linux `keyring` works through libdbus, which `tao` already needs. A saved login is applied automatically (ADR-0028).

## Why

- We write nothing secret into `settings.json` (as the specification says); the option "store it there" was rejected, and a reason other than secrecy is not named in the materials.
- Storage in the core was rejected: the core has no OS dependencies (ADR-0002).
- Other options (an encrypted project file, a password only in memory) are not named in the materials.
- The specification names the key `sextant:argocd:<clusterId>:<namespace>`, whereas the contract and the outcome of task 04 say service `sextant` and user `argocd:<clusterId>:<namespace>`. The second was accepted: it is recorded as built.

## Consequences

- The password itself (`{username,password}`) is stored, not only a session token. A leak from the OS keyring reveals the password, not a short-lived token.
- On Linux a working Secret Service is needed; what happens without it is not described in the materials.
- The storage test runs on a stub backend; the real Keychain, Credential Manager and Secret Service on three OSes were not verified in the materials.
- The entry is tied to `clusterId` and the namespace: another installation or another cluster will require a new login. What happens to the entry of a deleted cluster is not described in the materials.
- A new dependency, `keyring`, in `src-tauri/Cargo.toml`; the build for three OSes must pull it in.

> Amended (v0.6.1): the entry is keyed by the Kubernetes API server, not by the context-derived `clusterId`: user `argocd:<namespace>@<apiServerUrl>` (the `server` of the kubeconfig cluster entry, trailing `/` removed), so the same Argo CD reached through another context finds the same login and another server behind a reused context name does not (#56). An entry under the old user `argocd:<clusterId>:<namespace>` is moved once, silently: when the new user has nothing, the old value is written under the new user and then deleted (it stays if the write fails); "Remember" and "Forget" also delete the old entry. The store is read once per entry and app run — the answer (also "none" or an unreadable store) is kept in `ArgoSessions` and updated by "Remember" and "Forget" — so `argocd_status` does not reach the keychain on every call (#60); a change made to the keychain outside Sextant is seen after a restart.
