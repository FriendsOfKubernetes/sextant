# ADR-0158: Extensions send requests to Services inside a cluster

## Context

Argo CD's diff and sign-in live in Rust (ADR-0027 to ADR-0032):
- a port forward of Sextant's own to `argocd-server`;
- TLS whose certificate is skipped only on the loopback end;
- a session token in memory;
- automatic sign-in from `argocd-initial-admin-secret`;
- Secret values blanked in answers.

An extension backend may call only public HTTPS hosts it declares (ADR-0131), so none of this could move (#351).

## Decision

- **`contributes.services` (`sextantApi` 4).** Each Service is `{id, title, name, port (number or name), scheme:
  https|http}`, at most 10.
  - The user agrees to them word for word (`grantedServices`), and an update that changes one asks again
    (`services_within`).
  - The consent screen lists each one and what it takes (`ServicesConsent`).
- **`service.request({clusterId, namespace, service, method, path, query?, body?, auth?, capture?})`.** Open to the
  extension's frames and backend, never to agents directly.
  - **Requirements.** Read and Port forward on Services in that namespace under the extension's rules.
  - **Path, query and body.** The path is plain and absolute (no query, `#`, `\`, `.`/`..` segment or escaped
    separator, printable ASCII, at most 2048). Sextant encodes the query (at most 50 parameters). The body is JSON of
    at most 1 MiB.
  - **Reach.** This is what a port forward to that Service would let anyone send. The extension may already be
    granted that, and the Service was agreed to by name.
  - **Transport.** A forward of Sextant's own (`ForwardSource::ExtensionInternal`). It is internal on the
    port-forward page, never listed to the extension, and ended with the extension's grant.
    - `https` uses the TLS connector that skips the certificate only for 127.0.0.1, shared with Argo CD's client
      (`argocd::loopback_tls_connector`). It never falls back to plain HTTP.
    - `Host` is `<name>.<namespace>.svc`.
  - **Answers.** Up to 8 MiB within 30 s. Any status is an answer.
    - JSON is parsed, and Kubernetes objects anywhere in it, also inside JSON strings such as Argo CD's `liveState`,
      lose their Secret values (blanked, marked `sextant.dev/values-hidden`) and inline secrets (`strip_secrets`).
    - Other answers come back as text.
- **Secrets without the extension.** A body string value exactly `{{secret:<name>/<key>}}` is filled in by Sextant
  with that key of a Secret of the request's namespace, after "Secret values" on Secrets there. The journal names the
  Secret and key, never the value.
- **Sessions.**
  - `capture: "<field path>"` takes a non-empty string from a 2xx JSON answer, keeps it as the session of
    (extension, cluster, namespace, service), and the answer shows `<hidden>`.
  - `auth: "session"` adds it as a bearer token. A 401 drops it, and `service.forget` drops it on request.
  - The token lives in memory only, tied to the internal forward: a disconnect, a disable, any change of the grant or
    an exit ends it (`ServiceSessions`).
- **Journal.** Method, Service and path only, never the query, body or answer.

## Consequences

- Argo CD's diff and sign-in can be an extension's.
  - Automatic sign-in from the admin Secret never shows the password to the extension.
  - The session token never reaches it.
  - A password the user types into the extension's own sign-in form is seen by the extension: unlike Sextant's
    built-in diff, the form is the extension's.
- A typed sign-in is not remembered across runs (no keyring per cluster): a later version may add it.
- What a Service answers beyond Kubernetes objects (logs, metrics, anything the Service gives) reaches the extension.
  That is the Service's own contract with whoever may reach it.
