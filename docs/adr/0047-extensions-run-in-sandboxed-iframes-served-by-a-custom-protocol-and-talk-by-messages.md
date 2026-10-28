# ADR-0047: Extensions run in sandboxed iframes served by a custom protocol and reach the app only through messages

## Context

The brief asked for a Lens-like extension system for the interface, with no backend extensions. An extension is third-party code that the user installs, and the main window has the whole Tauri command set: custom commands are not gated by capabilities, and Tauri counts any registered custom scheme as a local origin, so a frame served from it would have the same IPC access as the app. There was no iframe, `postMessage` or custom scheme in the app yet.

## Decision

Each view of an extension (page, details section or tab, action dialog, dock tab, settings section) is an `<iframe>` with `sandbox="allow-scripts allow-forms allow-popups-to-escape-sandbox"` and no `allow-same-origin`, so its origin is opaque: no access to the Sextant window, Tauri IPC or cookies. The files come from our own protocol `sextant-ext` (`sextant-ext://<id>/<path>`; on Windows `http://sextant-ext.localhost/<id>/<path>`), which serves only files inside the installed package (or the dev folder) of an enabled extension; any path that resolves outside it, and a disabled or unknown extension, is 404. The app's CSP gets a matching `frame-src`.

The frame talks to the host with JSON messages `{sextant: 1, doc, id, method, params}` and answers `{sextant: 1, doc, id, result | error}`; streams (`watch`) arrive as `{stream, event}`. Every message carries `doc`, a random 128-bit identifier the SDK makes once per document. The host accepts a message only if it comes from that frame's own `contentWindow` and carries that frame's `doc`; anything else is ignored. The host forwards cluster calls to the backend, which decides (ADR-0051).

## Why

- Running extension code inside the app window (as Lens does) was rejected: it would give an extension everything the window can do, which is the opposite of "an extension must not get more access than the user allowed".
- An iframe with `allow-same-origin` on a custom scheme was rejected: Tauri would treat it as a local origin with the full command set. Without `allow-same-origin` the frame sends `Origin: null`, which the IPC does not accept.
- Serving files from a loopback HTTP server on a random port was rejected: it avoids the "local origin" problem but contradicts the custom-protocol design, adds a listening port to the app and a port-specific `frame-src`.
- Checking the sender by `event.origin` was not possible: the origin of a sandboxed frame is opaque (`"null"`) and the same for every extension, so the check is `event.source === iframe.contentWindow`. `doc` is our addition (the materials do not spell out why): it ties a message to one document, so a frame that was navigated or replaced cannot answer or be answered as the previous document.
- One origin per extension through the host part of the URL was rejected as the isolation mechanism: on Windows a single `*.localhost` host cannot carry the id, so a path-based id would not isolate. The sandbox gives isolation on every OS.
- Backend (Rust/WASM) extensions were not built: the brief says there are none yet.

## Consequences

- An extension has no network (see ADR-0048) and no direct access to the cluster, only the methods of the Sextant API.
- Everything crossing the boundary is serialised JSON; an extension cannot pass functions or share objects with the host, so it cannot customise the host's rendering by code (ADR-0049).
- Extension frames stay mounted while hidden (a dock tab is not reloaded on a tab switch); the host limits watches per document and documents per frame.
- That Tauri's IPC refuses `Origin: null` was read from the Tauri sources and checked on Linux (WebKitGTK) only; macOS and Windows are covered by CI at best. The sandbox attribute is the control that must never be loosened.

Amended (v0.6.1): `doc` separates only well-behaved documents. Answers still on their way to a document that unloads can reach the next document in the same frame until the next `load` ends the old one, so `doc` is not a secret between the documents of one frame (no gain: the same extension with the same permissions). A frame that reaches its document limit ends its oldest document that is neither current nor kept, instead of ignoring the new one.

Amended (0.26.0, ADR-0131): an extension may also have a backend: a WebAssembly component run by wasmtime with no ambient access, called only by the extension's own frames and reaching clusters through the same guard. "No backend extensions" now means no native backend code. The frame and its sandbox are unchanged.
