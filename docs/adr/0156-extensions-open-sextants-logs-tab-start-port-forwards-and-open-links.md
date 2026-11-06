# ADR-0156: Extensions open Sextant's logs tab, start port forwards and open links

## Context

Three small gaps (#349, #350):
- Argo Workflows' "Logs" button opens Sextant's logs tab.
- Argo CD's "Open Argo CD UI" starts a port forward to `argocd-server` and opens the browser.
- An extension had only `logs.tail` into its own frame, no port forward and no way to open a URL.

## Decision

- **`ui.openLogs`** is a window method. It takes `{namespace, pod, container?}` or `{namespace, labelSelector}`.
  - The window first asks the backend's `logs.open`, which decides Logs on Pods there, journals it, reads nothing and
    is the window's own (a backend may not call it).
  - Then the window opens Sextant's logs tab: one pod (`openLogsTab`, now taking a container), or the merged logs of
    a selector.
  - Nothing of the log goes back to the frame.
- **`portForward` is an extension action (`sextantApi` 4).** `portForward.start({namespace, kind: Pod|Service,
  name, port, localPort?})`, `portForward.list` and `portForward.stop` work only on the extension's own forwards
  (`ExtensionForwards`).
  - They appear on the port-forward page as "Extension" (`ForwardSource::Extension`), where the user can stop them.
  - The agents' refusals hold: no node shell, no pod on the node's network (`PodFilter::NoNodeAccess`).
  - At most 8 per extension.
  - They end when the extension is disabled, removed or granted anything else (the host's events).
- **`ui.openUrl({url})`** opens an http(s) address with no user or password in it, at most 2048 characters.
  - It opens only after the user says so in Sextant's own dialog, which shows the whole address, every time.
  - One question per extension at a time. The answer is `{opened}`.

## Consequences

- Argo CD's "Open Argo CD UI" and Workflows' "Logs" can live in extensions.
- A port forward an extension starts is visible and stoppable like the user's own.
- A link opens only with the user's click.
