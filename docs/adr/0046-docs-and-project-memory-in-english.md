# ADR-0046: Project documentation, glossary and memory for AI sessions are in English

## Context

Until this build the documentation (`docs/architecture.md`, ADR), the glossary (`CONTEXT.md`) and the memory for AI sessions (`AGENTS.md`) were in Russian, while issues, commits, the interface, the wiki and the README were already in English. The repository is public, and new team members read English.

## Decision

`docs/architecture.md` and all ADR were translated into English with English file names (transliteration replaced by English words; references from `AGENTS.md`, `docs/`, the code and the wiki updated). `CONTEXT.md` and `AGENTS.md`, including its Autopilot section, are in English. New ADR and glossary entries are written in English at once, and later builds and ordinary sessions keep them in English (recorded in `PROGRESS.md`). The conversation with the user stays in Russian.

## Why

- Keeping Russian was rejected: the rest of the public repository is already in English.
- Keeping two copies (Russian and English) was rejected: they would drift apart with every change.
- Translating only the new files was rejected: the decisions that matter most are in the old ADR.

## Consequences

- A translation can lose nuance. The sections were kept as Context / Decision / Why / Consequences so the meaning stays checkable.
- File names that were links changed; a link missed in an old note now points nowhere.
- Contributors and build tooling that default to Russian have to be told to write these files in English.
