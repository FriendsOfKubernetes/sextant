# ADR-0142: Older extensions keep working with every newer Sextant and SDK

## Context

0.29.0 grows the extension API (#331–#335). Extensions are already published:
- the SDK examples in the catalog;
- Rook Ceph 1.0.0, 1.1.0 and 1.1.1;
- possibly third-party ones in folders and files.

A package carries the SDK it was built with: `sdk:build` inlines it into `index.html`, and a backend links the WIT of its
time. An installed extension therefore speaks the protocol of its build for as long as it is installed, whatever
Sextant the user updates to. It is never rebuilt.

Until now compatibility held by habit:
- Sextant read manifests of `sextantApi` 1 to 2;
- every message still carried protocol version 1;
- the WIT package was `sextant:extension@1.0.0`.

None of this was written down as a rule, and no test proved that an extension built earlier still worked.

## Decision

Sextant keeps every extension it once accepted working unchanged. #336 tracks this.

- **The manifest.**
  - A new manifest field is gated by a new `sextantApi` version (the 0.29.0 work by 3). A manifest of an older version
    means exactly what it meant.
  - The SDK (`sdk/scripts/manifest.mjs`) and Rust refuse a field above the manifest's version with an error naming the
    version needed.
  - `MIN_API` stays 1. Retiring a version needs all of these:
    - its own ADR;
    - one release that warns about the version first, in the extension manager and on catalog cards;
    - a note in the release.

  An extension that needs a newer API than this Sextant has is refused at install by its `sextantApi`, and its catalog
  card says so (#324). A newer extension therefore never meets an older Sextant mid-way, and the protocol needs no
  per-method feature detection.
- **The window protocol.** Changes to `src/extensions/protocol.ts` and `sdk/src/protocol.ts` are additive only.
  - `PROTOCOL_VERSION`, the `sextant` value of every message, stays 1. It versions the message format, not the API
    (`sextantApi` does that).
  - New methods, context fields and answer fields may be added. No method, message type, view, theme token, context
    field, answer field, error code or watch update type is removed, renamed or given another type.
  - Limits (notice length, watches per document, documents per frame, frame height) are only raised.
  - The host never requires a field an older SDK does not send.
  - A new kind of update is sent only to extensions whose API version knows it. The window-only `snapshotPart`,
    `snapshotEnd` and `capped` updates stay window-only (ADR-0091).
- **Changed behaviour behind an existing method.** It must give an old frame the same answers and updates in the same
  order. For example, #334's shared watches keep "the first snapshot, then deltas".
- **Backends.**
  - The WIT package `sextant:extension@1.0.0` is never changed.
  - Additions go into a compatible minor version (`@1.x`), which the component model links for components built
    against 1.0.0.
  - A breaking change is a new major package, linked beside the old one for as long as `MIN_API` covers it.
- **Grants and settings.**
  - The `extensions` entries of `settings.json` written by an earlier Sextant are read as they were: new grant fields
    are optional and default to nothing.
  - Updating an extension asks for consent again only when the new version asks for more (ADR-0050, ADR-0053).
- **Old projects.** Today's SDK builds a project written for an older SDK without changes. Its types only grow, so old
  source type-checks.

### The proof: frozen packages

`sdk/test/fixtures/compat/` holds packages exactly as they were built, never rebuilt. Its `README.md` lists each
package's source and SHA-256.
- `sdk-0.6.0/` has the first SDK's examples: hello-page and crd-view, API 1.
- `sdk-0.26.0/` has the Rust backend example.
- `published/` has the catalog releases:
  - the examples 1.0.0;
  - Rook Ceph 1.0.0 and 1.1.1, API 2.
- `settings-<version>.json` holds `extensions` entries as those Sextants wrote them.
- `projects/hello-page-0.6.0/` is the old source of hello-page.

On every change, CI checks them:
- `crates/sextant-core/src/extensions/compat_tests.rs`:
  - every package is inspected and installed;
  - every stored entry is read, enabled and still covers its package (`asks_within`), so no consent is asked again.
- `crates/sextant-ext-runtime/tests/compat.rs`: the 0.26.0 Rust backend is compiled and called, with its host calls
  and request answered.
- `sdk/test/compat.test.ts`: each package's own inlined SDK runs in a frame against Sextant's real bridge
  (`src/extensions/bridge.ts`) with a mock backend. It must:
  - connect;
  - read, watch and draw;
  - follow a changed `resourceVersion`.

  Today's SDK builds the 0.6.0 project, and its page works too. Breaking the protocol, for example by changing the
  message version, fails these tests.
- `sdk/test/compat-protocol.test.ts`: the released protocol version 1 is frozen:
  - methods, views, tokens, the document pattern and the lower bounds of the limits at run time;
  - the context, references, kinds, metric answers, error codes and watch updates as types, which Sextant's own types
    must still fit.

A release that changes the extension API adds packages built by it (for a new API version, at least one example) to the
frozen set.

## Consequences

- A break shows up in CI before a release, not on a user's machine after an update.
- The protocol accumulates: nothing is removed while `MIN_API` covers the version that used it.
- The frozen packages are binary fixtures (about 360 KB). The TypeScript backend example (12 MB) is left out: its WIT
  world is the one the Rust backend proves.
- The stored entries were written to match the serialization of their versions, which this code still uses. A change
  to how `InstalledExtension` is written must keep reading them.
