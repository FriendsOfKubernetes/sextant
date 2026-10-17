# ADR-0064: A debug container is an ephemeral container or a labelled copy of the pod deleted with its session

## Context

Distroless and scratch images have no shell, and a container that crashes on start cannot be entered at all, so **Shell** does not help there (#132). `kubectl debug` solves both: it adds an ephemeral container to the running pod, or makes a copy of the pod with a debug container and, if needed, a changed command. Both create things in the user's cluster. An ephemeral container can never be removed from a pod, and a forgotten copy keeps a node's resources and may be found by a colleague. The node shell (ADR-0045) already showed the shape of the cleanup problem: a crash, a closed window and another person's live session.

## Decision

- **Two modes, as `kubectl debug`.** "In this pod" patches the `ephemeralcontainers` subresource (strategic merge, so earlier ones stay) with a container `debugger-<rand>` that has `stdin`, `stdinOnce`, `tty` and, when a container is chosen, `targetContainerName` (shared process namespace). "A copy of the pod" creates `<pod>-debug-<rand>` in the same namespace from the original's spec without `nodeName`, probes and ephemeral containers, with `shareProcessNamespace: true`, `activeDeadlineSeconds` at most 8 hours, the debug container added and optionally the target container's command replaced (its args dropped). Labels and owners of the original are not copied, so no Service routes to the copy and no controller adopts it; the copy carries `app.kubernetes.io/managed-by=sextant`, `sextant.dev/debug-copy=true`, `sextant.dev/debug-session` (this run) and `sextant.dev/debug-owner` (a hash of the OS user and machine).
- **The terminal attaches to the debug container's own process** (`exec::attach_terminal`, `kubectl attach -it`), not to a new exec. When the tab goes away Sextant sends Ctrl+C and Ctrl+D and closes stdin, so the ephemeral container's shell ends; the container itself stays in the pod spec, stopped, which the dialog says before anything is created.
- **The copy lives as long as its session.** `debug_start` registers a placeholder in `AppState.sessions` before anything is sent; closing the tab, disconnecting the cluster, a page reload or exit calls the start off or deletes the copy (exit waits a few seconds for the deletions). A create whose answer is lost is deleted by name while it may still appear. Starting a copy in a namespace first deletes this owner's copies of earlier runs and anyone's copies older than 8 hours there.
- **The image** is chosen per start (presets `busybox:stable` and `nicolaka/netshoot:latest`, or any name); "Use this image by default" stores it in `AppSettings.debug_image`.
- **The user's tool only.** There is no MCP tool and no extension method for it, and an agent's `exec_command` is refused in a debug copy (the pod is re-read right before the command; an unreadable pod refuses the call).

## Why

- Ephemeral containers only were rejected: a pod in CrashLoopBackOff gives a debug container nothing stable to share processes with, and its main container cannot be kept alive without a changed command, which only a copy can have.
- A copy that keeps the original's labels (as `kubectl debug --copy-to` does by default) was rejected: a Service would send real traffic to a pod being poked at, and a ReplicaSet could adopt or delete it.
- A sweep on every connect, as for node shells, was rejected: debug copies live in application namespaces, not in one known namespace, and listing every namespace on connect costs a request per namespace for a rare leftover; the sweep runs where the user is debugging, and the pod deadline ends what the sweep never visits.
- `exec` of a new shell into the ephemeral container was rejected: the container's own process already is the shell and keeps running after the tab closes unless its input is ended.
- Offering it to agents was rejected for the same reason as the node shell: it creates pods with a shared process namespace from a program; an agent already has `exec_command` under rules, and running commands inside the user's debug session would interfere with it.

## Consequences

- Every ephemeral debug session leaves a stopped container in the pod spec until the pod is deleted; reconnecting adds another one, and the dialog asks first.
- A copy needs permission to create pods in the namespace, an ephemeral container needs `pods/ephemeralcontainers`; a refusal, an image that does not pull or a container that does not run within 120 s gives a specific message, and a copy is deleted then.
- A colleague's live debug copy is never deleted by this user's sweep; a forgotten one stays at most 8 hours.
- The owner label identifies a user and machine hash, not a person, as for node shells.
