# ADR-0027: Argo CD API — through a port forward to `argocd-server`, TLS verification disabled only for 127.0.0.1

## Context

For the "desired ↔ live" diff, Sextant must log in to the Argo CD HTTP API and request managed-resources. In a standard installation `argocd-server` presents a self-signed certificate. It is reached through the core's port forward (`PortForwarder`), which listens only on 127.0.0.1.

## Decision

The HTTP client `ArgoClient` lives in the core (`crates/sextant-core/src/argocd.rs`) and goes to `https://127.0.0.1:<port>` of the port forward to the `argocd-server` service. Certificate verification is disabled only for the port forward's `127.0.0.1`; the client is not used for any other address. If the server has `server.insecure` enabled, the client goes over HTTP. The port forward belongs to `AppState.argocd` (`ArgoSessions`, its own `PortForwarder`) and is closed together with the cluster. "Open Argo CD UI" opens `https://localhost:<port>` (or `http` if the server has no TLS) in the system browser through `openInBrowser(forward, scheme)`.

## Why

- Certificate verification on was rejected: with a self-signed certificate login does not work in a standard installation (the specification's wording).
- The channel up to the server itself is already protected: the port forward goes over TLS to the Kubernetes API server, and disabling verification concerns only the last segment on this machine.
- Accepting a custom CA or pinning the certificate was not discussed in the materials.
- Why Argo CD sessions have their own `PortForwarder` rather than one shared with the Port Forwarding tab is not stated in the materials. The specification says "the same `PortForwarder`", meaning the type.

## Consequences

- The client that talks to Argo CD fundamentally does not verify the server's authenticity. Protection rests on the port forward listening only on `127.0.0.1`. How the code ensures that the exception will not apply to another address is not described in the materials.
- A browser opening the UI at `https://localhost:<port>` will see the same self-signed certificate. What the user does about it is not noted in the materials; it follows from the self-signing.
- A new kind of long-lived session is registered in `AppState` and closed with the cluster (ADR-0011, ADR-0012). The session token lives only in memory. Whether this port forward is visible in the Port Forwarding list is not described in the materials.
- URL schemes (`http`/`https`) are now supported by `urlOf(forward, scheme)` and `openInBrowser(forward, scheme = "http")`; the earlier call with `http` does not change.
