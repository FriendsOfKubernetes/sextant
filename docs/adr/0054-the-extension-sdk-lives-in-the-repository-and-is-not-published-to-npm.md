# ADR-0054: The extension SDK lives in the repository and is not published to npm; one JSON schema describes the manifest

## Context

An author needs typed API calls, the host's theme tokens, a template, examples and a way to pack the folder. The brief said: SDK in the repository, no npm, no catalog. The manifest is validated by Rust at install time, and an author's packer runs in JavaScript.

## Decision

`sdk/` holds `@sextant/extension-sdk` (private; used by `file:` reference): manifest and API types, a client library for the frame (`connect()`, resource calls, watches, `ui.*`, `storage.*`, context, theme helper), a template, two examples (`hello-page`, `crd-view`) and a packer that builds `.sextant-ext` and validates the manifest. The manifest rules live in a JSON schema in the core; the packer and the Rust tests both check against it, and a test keeps the SDK types in step with the generated ones. The SDK has its own `sdk:check` inside `npm run check`, and the examples must build and pass tests.

## Why

- Publishing to npm was rejected by the brief; it would also make the SDK's version a public promise independent of the app's `sextantApi`.
- A Rust CLI packer was rejected: authors of UI extensions have Node, not necessarily a Rust toolchain, and the app is not a command-line tool.
- A second hand-written validator in JavaScript was rejected: the schema is the one place for the rules, and Rust and the packer cannot drift apart without a test failing.
- SDK types may be generated or hand-kept; either way a test compares them with the types generated from Rust, so they cannot drift silently.

## Consequences

- An author gets the SDK by copying or linking from a Sextant checkout, not by `npm install`; documentation (wiki) has to say so.
- A change to the manifest or the API is a change in four places (Rust, schema, SDK types, wiki), and `npm run check` catches the first three.
- The SDK ships with the app's version, so `sextantApi` is the compatibility contract; an incompatible API is an install refusal.
