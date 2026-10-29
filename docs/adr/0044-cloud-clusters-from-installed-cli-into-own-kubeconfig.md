# ADR-0044: Cloud clusters are found through the installed cloud CLIs and written to Sextant's own kubeconfig; Sextant never logs in

## Context

Users of EKS, GKE, AKS and Yandex Cloud Managed Service for Kubernetes reach their clusters through `aws`, `gcloud`, `az` and `yc`. The usual way to get them into a kubeconfig is `aws eks update-kubeconfig` or `gcloud container clusters get-credentials`, and both write into `~/.kube/config`. The app lists clusters from kubeconfig sources (a failed source does not stop the others).

## Decision

"Add cluster → From cloud" detects the installed CLIs, lets the user pick a profile and regions (AWS), a project (GCP) or a subscription (Azure), and lists the clusters the CLI reports. The chosen clusters are written to a file of our own, `kubeconfigs/cloud-<provider>.yaml` (app data directory, mode 0600), built from the cluster description (endpoint, CA) without calling `update-kubeconfig` or `get-credentials`. Authentication is exec-based and goes through the user's CLI: `aws eks get-token`, `gke-gcloud-auth-plugin`, `kubelogin get-token --login azurecli`. The file is registered as an ordinary kubeconfig source, survives a restart and is removed like any source. `~/.kube/config` is never changed. The CLI processes are started through one function that clears `KUBECONFIG` from the environment, behind the `desktop` feature of the core like `helm`.

Sextant does not perform the login. When the CLI is missing, the user is told how to install it; when the session has expired (an `authPlugin` error on connect or a CLI error while searching), the message carries the login command (`aws sso login --profile …`, `gcloud auth login`, `az login`) and "Open terminal" puts that command in a local terminal without running it.

For Yandex Cloud, the user chooses a yc profile, a cloud and a folder, then finds the clusters in that folder. The active profile and its configured cloud/folder are initial choices; yc profiles are never activated or changed. Selecting a folder or API address loads clusters automatically; manually entered folder IDs use a 300 ms delay. Refresh reloads the current scope without losing the folder choice. The list uses status dots with accessible labels, warning-colored unavailable metadata and a local added marker; successful rows keep a disabled checked box and are excluded from subsequent imports. Every call and the imported `yc managed-kubernetes create-token` exec specify the chosen profile. YC launches remove the inherited `YC_IAM_TOKEN`, which overrides profile credentials; the persisted exec masks it with an empty environment value. The user's environment and yc configuration are unchanged. The external or internal IPv4 endpoint is selected explicitly, without falling back to the other address. A cluster whose chosen endpoint or CA is unavailable remains visible but cannot be selected for import.

Clouds and folders are listed only for the chosen scope. A denied list is shown as a partial problem, not an empty inventory or an expired login; a known folder ID can still be entered. The imported clusters go to `cloud-yandex.yaml`, use stable `yc-<cluster-id>` contexts and remain tied to their original profile when yc's active profile changes.

## Why

- `update-kubeconfig` and `get-credentials` were rejected: they write into the user's `~/.kube/config`, which Sextant treats as the user's file, and they hide the cluster's endpoint and CA behind a side effect the app cannot undo as a source.
- The cloud SDKs were rejected: they would bring three large dependency trees and their own credential chains, while the user's CLI already holds the login and the profile. (This is our reasoning; the materials name only "through the installed CLI".)
- Running the login for the user was rejected: it opens a browser or asks for secrets in a flow the app should not mediate; the user starts it in a terminal.
- Mixing the clusters into an existing source was rejected: a separate file per provider lets the user remove a provider's clusters as one source.

## Consequences

- Sextant depends on the user's CLI versions and on `gke-gcloud-auth-plugin` and `kubelogin` being installed; the app only explains how to install them.
- Tokens come from the CLI at each connection, so an expired login shows up as a connection error, not at the time of adding.
- Live runs against real accounts were not part of the build; the tests use fake CLIs (scripts in `PATH` that answer with the real JSON shape) on Linux, and the parsers are unit-tested. The first real use is the user's.
- The cloud kubeconfig file holds endpoints and CA data, not tokens.
