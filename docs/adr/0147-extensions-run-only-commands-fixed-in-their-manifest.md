# ADR-0147: Extensions run only commands fixed in their manifest

## Context

Extensions could not run anything in a container. Rook Ceph 1.1.0 (#327, ADR-0141) therefore leaves CRUSH moves,
reweights, `ceph osd out/in` and every other `ceph` command to the toolbox shell, and other candidates (#320) would
hit the same wall: `pg_isready` for CloudNativePG, `kafka-topics` for Strimzi. #335 asks for commands, built like the
metric queries (ADR-0138).

## Decision

- **Commands are fixed in the manifest.** `contributes.commands` (`sextantApi` 3), at most 20. Each command has:
  - an `id` and a `title`;
  - a `target`: a label selector of `key=value` pairs and a container name;
  - `argv`;
  - typed `params`, at most 5:
    - `int` within optional `min`/`max`;
    - `enum` with its `values`;
    - `name` (a DNS-1123 subdomain);
  - `changes` (default `false`);
  - `timeoutSeconds` (1–60, default 30).

  `check_commands` (Rust) and `checkCommands` (SDK) check alike, with cases in `manifest-cases.json`:
  - the program is a word, never a parameter;
  - every other argument is a word without control characters or braces, or exactly `{{name}}` of a declared
    parameter;
  - every parameter is used;
  - an `enum` has values and only an `enum` has them;
  - only an `int` has `min` and `max`.

  The title is translatable (`commands.<id>.title`).
- **The extension sends an id and values, never words of its own.** `exec.run({ id, namespace, params })` takes the
  command from `InstalledExtension.grantedCommands`, never from the manifest on disk. An id not agreed to is denied.
  `commands::fill` puts each value in as one whole argument after checking it against its type: a value with spaces
  or `;` is refused, never split. There is no shell, and nothing else of the call reaches the argv.
- **Where it runs.** The newest ready, running, not deleting pod of `namespace` with the target's labels, in the
  target's container. A node-shell pod and a debug copy are never chosen (`is_node_shell_object`,
  `is_debug_copy_object`). Finding the pod needs Read on Pods in that namespace under the extension's own rules,
  decided as every call is. The run is `exec::run_command`, the agents' path: no TTY, no stdin, the command's timeout,
  and stdout and stderr each cut at 256 KiB (`truncated`).
- **Consent and confirmation.**
  - At install the consent screen (`CommandsConsent.tsx`) lists each command word for word (placeholders as written),
    where it runs and whether it changes something.
  - Agreeing grants exactly these commands, and an update that adds or changes one asks again (`commands_within` in
    `asks_within`, now taking the grants as `Granted`).
  - A command with `changes: true` asks the user every time it runs, through Sextant's own confirmation, with the
    filled words shown (`check_asking`). Without a window it is declined.
- **The journal.** Each run is one entry in `extensions-audit.jsonl`: the command's title, namespace and filled words,
  never its output.
- **Who may call it.** The extension's own frames and its own backend (`sextant.exec.run`, `host.exec.run`). It is no
  MCP tool, and agents never reach it.

## Consequences

- Rook Ceph can run `ceph status`/`ceph osd tree`, and `ceph osd out/in` and `reweight` once the user confirms, as a
  follow-up release of the extension. Other operator views get the same.
- What an extension can run is exactly what the user read at install. The values can only be what their types allow.
- The output of a command is the extension's to show, so it is not filtered: a command that prints secrets prints them
  to the extension. The consent says so, and the author's command list is what the user agrees to.
- A live test on the kind cluster (`a_declared_command_runs_in_its_pod_and_nothing_else_does`) runs a declared
  command and is refused:
  - a value of the wrong type;
  - an undeclared id;
  - words of the extension's own;
  - a changing command with no window to ask;
  - a namespace the extension may not read.
