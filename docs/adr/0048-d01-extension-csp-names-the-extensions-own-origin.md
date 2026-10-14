# ADR-0048 (D01): The CSP of an extension's files names the extension's own address, not `'self'`

## Context

The plan assumed that the response header `default-src 'none'; script-src 'self'; style-src 'self' …` on `sextant-ext` files lets an extension load its own files and only them. The code showed otherwise (issues #95, #91): in an iframe without `allow-same-origin` the origin is opaque. On WebKitGTK `'self'` then matches nothing, so the extension's external scripts and styles were blocked. On Windows `'self'` is the shared `http://sextant-ext.localhost`, which is the files of every extension, not one.

## Decision

The CSP is built for every response from the extension's own base address (`sextant-ext://<id>/` or the Windows form), without `'self'`: `default-src 'none'; script-src <base> 'unsafe-inline'; style-src <base> 'unsafe-inline'; img-src <base> data:; font-src <base> data:; connect-src 'none'; form-action 'none'; sandbox allow-scripts allow-forms allow-popups-to-escape-sandbox`. The same `sandbox` directive is in the header, so a document opened outside our iframe is sandboxed too. Error responses carry `default-src 'none'; sandbox`. Responses also carry `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

## Why

- Keeping `'self'` was rejected: it fails on one platform (nothing loads) and over-allows on another (files of all extensions).
- Dropping the source list and allowing `sextant-ext:` as a scheme was rejected: it would let one extension load another's files.
- Inline scripts and styles stay allowed: the template and examples are plain HTML and a CSP that refuses inline code would break the simplest extension. `connect-src 'none'` and `form-action 'none'` keep the data from leaving.
- A `sandbox` directive in the header was added because the iframe attribute protects only the frame; the header protects the file if it is navigated to directly.

## Consequences

- The header depends on the platform-specific base URL, so the Rust code has one place (`base_url(id)`) that every URL and every CSP goes through.
- A view an extension opens with `window.open` (allowed by `allow-popups-to-escape-sandbox`) is not sandboxed by our attribute; that is intended for links, and the CSP keeps no network for our files.
- The rule was checked on Linux (WebKitGTK); behaviour on WebView2 and WKWebView is expected from the same logic and is covered only by CI.
