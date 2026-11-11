# ADR-0169: Extension API 5 — what the moved views still lacked after 0.30.0

## Status

Accepted (Sextant 0.30.1)

## Context

Sextant 0.30.0 moved every built-in tool view into Sextant's own extensions (ADR-0162). Each extension's README lists
under "Requirements and limits" where it still differs from the former built-in view because the extension API could
not say it; #417 gathers them. The user asked to close those gaps and ship them in 0.30.1.

A new manifest field needs a new `sextantApi` (ADR-0142): a manifest that names 4 and uses a field 0.30.0 does not know
would install on 0.30.1 and be refused by 0.30.0, and the catalog offers releases by their API (ADR-0149; the bug of
#420). So every addition below is accepted only from `sextantApi` 5 (`PARITY_API` in Rust and the SDK), and Sextant
0.30.1 supports 1 to 5. An extension that uses them is released with `sextantApi` 5; the catalog keeps offering its
API-4 release to 0.30.0 through `earlier`.

## Decision

Each addition is checked alike in Rust and the SDK (`sdk/scripts/manifest.mjs`), with cases in
`sdk/test/fixtures/manifest-cases.json`, evaluated by the window only, and documented in the wiki page "Writing
extensions". "Cannot tell" is never a problem (ADR-0144).

## Consequences

- Sextant's own extensions that use these additions need Sextant 0.30.1; on 0.30.0 they stay at their API-4 releases.
