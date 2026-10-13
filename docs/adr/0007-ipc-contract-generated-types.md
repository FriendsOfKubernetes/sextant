# ADR-0007: The contract between Rust and the UI — the single `src/api` bridge and types generated from Rust

## Context

The project is run by several parallel executors, and by requirement R01 the UI must not reach Kubernetes bypassing Rust commands.

## Decision

IPC types are generated from Rust through `ts-rs` into `src/api/generated/` and committed; they are not edited by hand. Components call the backend only through `src/api/`, and importing `@tauri-apps/api` directly is forbidden. All serializable types use `camelCase`.

## Why

- Hand-written TypeScript types were rejected: they can silently drift from Rust. Generation and the check in `npm run check` make a mismatch visible.
- A single bridge makes it possible to replace the backend in Vitest (`mockBackend`) and reduces checking R01 to searching for direct calls.

## Consequences

- Every type crossing the boundary must carry `serde` with `camelCase` and the `ts-rs` derives. Types are collected from two crates (`sextant-core` and `sextant`), and `npm run gen:types` must run after every change.
- Generated code cannot be fixed by editing it: the Rust source must be changed.
- Generation covers types but not command and event names. They are set by a table in `interfaces.md` and by hand in `src/api`, and a typo in them is caught only by a test or at runtime.
- Because of zone restrictions, the cluster hooks live not in `src/api` but in `src/features/clusters` (ADR-0011), so the "single bridge" in practice allows exceptions.
