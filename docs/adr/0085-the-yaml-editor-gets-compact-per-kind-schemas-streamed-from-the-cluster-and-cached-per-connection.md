# ADR-0085: The YAML editor gets compact per-kind schemas, stream-parsed from the cluster's OpenAPI v3 and cached per connection

## Context

#151 asked for a schema-aware YAML editor: completion of fields and enum values, validation (unknown fields, wrong types, missing required fields), documentation on hover and a `kubectl explain`-like panel, for built-in kinds and CRDs alike. The source of truth is the cluster's own OpenAPI v3 (`/openapi/v3`), since CRDs and versions differ per cluster. Its group/version documents are large: `api/v1` is about 17 MiB of JSON and, parsed into a generic value, about 118 MiB of memory; a WebView that receives whole documents for every open editor would hold several of them, and a slow or hostile server could send arbitrarily much.

## Decision

- **Only the core reads OpenAPI.** `crates/sextant-core/src/openapi.rs` reads the index and then only the one group/version document of the asked kind (`api/v1`, `apis/<group>/<version>`; the index's `serverRelativeURL` is followed only when it names that same document), with 30 s per request, 1 MiB for the index and 16 MiB per document.
- **Stream-parse, never whole.** `openapi/stream.rs` reads the document off the async runtime and walks it as a stream: everything but `components.schemas` is skipped, and each schema is parsed, reduced to a compact `SchemaNode` (`openapi/compact.rs`: type list including `oneOf`/`anyOf` and int-or-string/quantity, format, enum, default, required, properties, items, additionalProperties, `preserveUnknown`, nullable, descriptions clipped to 2 KB, nesting cut at depth 40 and 200 000 nodes, marked `truncated`) and dropped before the next one. Peak memory is the compact size (`tests/openapi_memory.rs`).
- **Only one kind reaches the window.** `openapi_kind_schema` returns a `KindSchema`: the kind's root and only the definitions reachable from it (at most 600), references kept by name. A whole document never crosses into the WebView (a Pod is about 240 KB).
- **Caches on both sides, tied to the connection.** `SchemaCache` (owned by `ClusterManager`) keeps the compact form of the last 12 group/versions of the last 4 clusters, keyed by `ClusterManager::connection`, dropped on `refresh_kinds` and `disconnect` (a per-cluster generation stops an older fetch from storing), one fetch at a time per cluster. The frontend's `schemaSourceFor` is shared by all editors of a cluster (≤ 16 kinds × 4 clusters), asks only for kinds discovery serves (a half-typed kind is neither fetched nor remembered), re-asks a missing schema and refreshes a kept one when discovery changes, and retries a failure after 30 s.
- **Offline and without a schema the editor is the plain editor.** A kept schema stays usable while the cluster is disconnected; a server without `/openapi/v3`, an unserved kind or a failed read only turn the schema features off (a short note says the cluster publishes no schema for the kind). Nothing blocks typing, saving or applying.
- **Scope.** Only the "edit" and "create" (Apply YAML) tabs get a schema; Helm values editors and extensions' editors do not. The validation is advice: the API server's answer (and the dry run, ADR-0074) stays authoritative; `status` at the root is not checked. It is read-only; MCP agents and extensions get no new tool or method (a test in `src-tauri/src/commands/openapi.rs`).

## Why

- Sending documents to the window and parsing them there was rejected: memory in the WebView per editor and per cluster, and the window is the less trusted side (ADR-0047).
- Bundling schemas of Kubernetes versions was rejected: CRDs and the cluster's own version are what users edit.
- Parsing into `serde_json::Value` first was measured at ~118 MiB for `api/v1`; the streaming reader keeps only compact nodes.

## Consequences

- The first completion of a group/version waits for one document read (a few seconds on a slow API server); later ones are local.
- Path detection works on half-typed text (indentation-based), so it can be wrong on unusual flow-style YAML; such places just get no suggestion.
- Older clusters without OpenAPI v3 (before 1.24 by default) get no schema features.
