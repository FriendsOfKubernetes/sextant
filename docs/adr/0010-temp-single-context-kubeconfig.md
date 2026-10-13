> Partially superseded by ADR-0018 (login shell and KUBECONFIG from the profile) and ADR-0019 (lifetime of the temporary file).

# ADR-0010: The terminal and `helm` get a temporary kubeconfig with a single context

## Context

Clusters come from several sources: several files in `KUBECONFIG`, added files and pasted text in the app's data directory. Several clusters are connected at the same time (R06i.5).

## Decision

For the local terminal and for `helm` calls, Sextant writes a temporary kubeconfig with the single selected context (which is also the current one), with mode 0600, and points `KUBECONFIG` or `--kubeconfig` at it. The user's files are not changed.

## Why

- Switching current-context in the user's kubeconfig was rejected: the materials do not discuss it directly, but it breaks with two simultaneous terminals on different clusters and modifies a file that belongs to the user. Pasted sources are held by the app anyway.
- Passing `--kube-context` with the original set of files was rejected: a context may be assembled from several files, and a single copy is simpler for the terminal and `helm` alike.
- `kubectl config current-context` in the terminal must show the selected cluster: this is acceptance criterion R11i.2.

## Consequences

- The cluster's credentials (certificates, tokens) are copied into a temporary file on disk. Protection rests on mode 0600, which does not work the same way on Windows, and how that is covered is not described in the materials.
- The file must live as long as the session and disappear after it. If the app crashes, it may be left behind.
- `kubectl config use-context` in the terminal changes only the temporary copy, so after the terminal is restarted the choice returns to the cluster from the rail.
- On Unix the shell is started as a login shell. If its profile overrides `KUBECONFIG` itself, the terminal will point at the wrong cluster. This was not checked in the materials.
- Any new feature that launches an external process against a cluster uses the same function rather than building its own kubeconfig.
