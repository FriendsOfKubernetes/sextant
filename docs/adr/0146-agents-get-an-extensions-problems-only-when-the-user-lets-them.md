# ADR-0146: Agents get an extension's problems only when the user lets them

## Context

Built-in problem categories reach AI agents through `get_problems` (ADR-0094), except those in `NEVER_FOR_AGENTS`.
Extension categories (`ext:<id>`) never did (ADR-0137). Moving a view out of the core (#320) would therefore take
its problems away from agents. #333 asks whether an extension's problems should reach agents at all, and how.

The user decided (2026-11-04): only when turned on per extension, off by default.

## Decision

- **A setting per extension.** `AppSettings.mcp.extensionProblems` lists the ids of the extensions whose problems
  agents may get. It is frontend-written, like the rest of `mcp`, and empty by default. Settings → AI agents (MCP) →
  "Problems of extensions for agents" lists the installed extensions that have problem rules, each with a checkbox.
  An id that is not an extension id is ignored.
- **Rust decides which categories an agent gets.** `agent_categories` adds `ext:<id>` for each id in the list to the
  opt-in categories that are on, and `category_for_agents` lets an `ext:` category through only when it is there.
  - `get_problems` accepts `ext:<id>` in `categories`; one not turned on goes to `off`, with the note naming where it
    is turned on.
  - Without `categories`, every turned-on extension category is asked for along with the built-in ones.
- **The window computes them as for the screen.** The problems store's sources of the category
  (`extensionSourcesFor`) are used: the extension's rules within the extension's own read scope, judged across
  objects as for the screen (ADR-0144).
  - A category whose kinds the agent may read nowhere is `notChecked`.
  - Each problem is told only when the agent may read its object and its source kind.
  - A `missing` problem also carries a ref to every list it says a name is absent from (`lookupRefs`): the object's
    namespace for a namespaced kind, every namespace for a cluster-scoped one.
- **Rust checks every answer again.** Rust re-checks every problem with `ReadFilter`: the object, the source kind and
  every ref. Then:
  - the reason and the message are cleaned again (control characters become spaces);
  - they are clipped to the window's 300 characters, since the text comes from templates the extension wrote, filled
    from the cluster;
  - the answer carries `dataNotice`, as every diagnostic answer does.
- **Only `get_problems`.** Extensions add nothing to `diagnose_service` or the other diagnostic tools.

## Consequences

- An operator view moved into an extension can keep giving agents its problems once the user turns that on. Moving
  views out no longer has to make agents see less, as long as the user agrees per extension.
- The point "AI agents never receive extension problems" of ADR-0137 now holds only by default.
- `toldThroughOwner` (ADR-0144) can hide a problem because of an owner the agent may not read. An agent may then miss
  a problem, but never learns more than it may read.

## Amendment (ADR-0168): what a judged problem rests on

A problem an extension's judge decided is told when the agent may read what its fact says it rests on (`needs`:
objects, or a kind in a namespace or everywhere; at most 20, only of kinds the judge reads), carried as the problem's
refs and re-checked in Rust as every ref; a fact without `needs` still needs Read on every kind the judge read where
it read them. The agent's worker holds the category's sources of a judge's kinds even where the agent may read them
nowhere, so the judge can tell; nothing of them reaches the agent but problems whose refs it may read.
