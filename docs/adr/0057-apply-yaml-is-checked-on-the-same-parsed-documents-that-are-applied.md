# ADR-0057: Applying YAML is checked on the same parsed documents that are applied

## Context

The MCP `apply_yaml` tool read the permissions from its own parse of the YAML, while the core parsed it again when applying. Two parsers can disagree on a document (issue #43), so the object whose rights were checked could differ from the object that changed.

## Decision

The core exposes one parse, `parse_documents`, with a plan of targets (`plan_apply`, `ApplyTarget`) and a step that applies exactly the planned targets (`apply_planned`). The MCP server and the extension API check rights on each target's object and then apply those same targets. A document with the hidden-values marker is refused before any confirmation. A node-shell pod among the targets is refused (ADR-0056).

## Why

- Keeping a parser in each caller was rejected: it is the bug.
- Re-checking after the apply was rejected: the change has already happened.
- Having the core check rights itself was rejected: rights belong to the guard (ADR-0051), which differs for agents and extensions; the core only has to give both the same list of targets.

## Consequences

- Every caller of apply has to go through the plan; a new tool or API method that parses YAML separately brings the bug back.
- The check happens on every target before the first request, so a multi-document apply is refused as a whole rather than half-done.
