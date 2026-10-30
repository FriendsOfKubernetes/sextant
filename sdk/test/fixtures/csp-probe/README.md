# Extension isolation probe

Two folder extensions that check, in a real webview, what an extension's frame may reach (ADR-0048, issue #91): the
response CSP that names only the extension's own base URL, `connect-src 'none'`, the CSP `sandbox` directive and the
iframe's `sandbox` attribute (never `allow-same-origin`). Unit tests pin the headers; this probe shows what WebKitGTK
(Linux), WKWebView (macOS) and WebView2 (Windows) do with them.

- `b/` (**Probe B**) only serves files: a script, a stylesheet, an image, a font and a page.
- `a/` (**Probe A**) tries to load its own files and Probe B's, to fetch, to reach Sextant's window, storage and
  cookies, to frame Probe B's page and to open a window, and shows a table of what was expected and what happened.

## Run it

1. In a Sextant you can throw away the settings of (a separate user, or a copy of the settings directory), open
   Settings → Extensions → "Load unpacked folder…", load `sdk/test/fixtures/csp-probe/b`, then
   `sdk/test/fixtures/csp-probe/a`. They ask for no access to clusters.
2. Connect any cluster and open Workloads → **Probe A**.
3. The summary line says `All 17 checks passed in <user agent>`, or which checks failed; a failure is a red row.
4. Remove both extensions afterwards.

Expected: own script, stylesheet and image load; the frame's origin is `null`; every one of Probe B's files, Probe B's
page in a frame, every `fetch` (own files too), `parent.document`, `localStorage`, a cookie and `window.open` are
blocked.

A driven run gets the results too: Probe A posts `{ probeResult: { failed, results } }` to its parent window.

## Last results

| Webview | Result |
|---|---|
| WebKitGTK 2.50.4 (Linux) | all passed (0.26.4, 2026-10-30); also with the page in a frame without the `sandbox` attribute (origin `null`, Sextant's window and storage out of reach: the CSP's own `sandbox`) |
| WKWebView (macOS) | not run yet |
| WebView2 (Windows) | not run yet |
