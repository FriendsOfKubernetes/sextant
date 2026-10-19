# ADR-0088: Terminal panes are separate sessions, snippet values are quoted per shell, and broadcast never sends unconfirmed input

## Context

#154 asked for split panes in a terminal tab, saved command snippets with placeholders (namespace, pod, container, cluster, context), and broadcast input — typing into several shells at once, as tmux `synchronize-panes` does. Each of these can run a command the user did not mean: a pod or namespace name pasted unquoted into a shell, a snippet that hides a control character or a text-direction mark, a broadcast that reaches a production cluster's shell because a pane of another cluster was in the set, or keystrokes typed before the user noticed broadcast was on.

## Decision

- **A pane is a session.** Every terminal dock tab ("exec", "terminal") is a `PaneLayout` over a layout tree (`layout.ts`, at most 8 panes). Each pane is its own backend session started by the same commands as a tab (local, container, node, debug — node and debug panes ask the same confirmations, ADR-0045/ADR-0064), so flow control, caps, `AppState` ownership and cleanup on close apply per pane. Splitting or closing never remounts the other panes' terminals. No backend command was added.
- **Snippets are settings, read strictly.** `AppSettings.snippets` is frontend-written (≤ 500, names ≤ 120 and commands ≤ 4096 characters, read entry by entry in `settings/snippets.rs`). A snippet may not contain control, zero-width or text-direction characters.
- **Placeholders are quoted for the focused pane's shell.** `{{namespace}}`, `{{pod}}`, `{{container}}`, `{{cluster}}`, `{{context}}` are filled from the focused pane: POSIX shells (sh, bash, zsh, fish) get a value of only safe characters as it is and anything else in `'…'` with `'` as `'\''`; PowerShell (the local shell on Windows) always gets `'…'` with ASCII and typographic single quotes doubled; a shell not known yet gets `'…'` and refuses values containing quotes. Nothing inside single quotes is special (`$()`, backticks, `$VAR`, `;`). Backslashes (fish reads `\'` inside single quotes) and control, invisible and text-direction characters in a value are refused everywhere, and the snippet is shown as unavailable in that pane rather than sent half-quoted. A placeholder the pane cannot fill makes the snippet unavailable too.
- **Insert types, Run presses Enter, focused pane only.** The text is typed on one line; only "Run" adds Enter, and snippets go only into the focused pane, also while broadcast is on.
- **Broadcast is explicit and confirmed.** It is off by default. The user picks at least two target panes; panes of other clusters are listed apart and never preselected. Every target shows a banner naming the clusters. The first keystroke of each activation opens a confirmation that takes the keyboard focus, and everything typed before confirming is dropped — never sent to any pane. Broadcast ends when turned off, when the confirmation is refused, or when any target pane closes (the user chose that set, not what is left of it).
- **Export carries snippets as written.** Views export version 2 (ADR-0083, amended) has a `snippets` section, included by default with a warning not to keep secrets in snippets; import previews each added or changed command with whitespace and hidden characters visible and refuses snippets with control, invisible or text-direction characters.
- **Not for agents or extensions.** Panes, snippets and broadcast are window features; MCP agents and extensions get nothing new.

## Why

- Substituting values verbatim (as many terminal tools do) was rejected: Kubernetes names are safe, but cluster and context names from kubeconfig are free text.
- Broadcasting without a confirmation, or replaying the keystrokes typed before it, was rejected: the first keys typed after turning broadcast on are exactly the ones the user may not have meant for every pane.
- Sharing one session between panes was rejected: a closed pane must end its own process, and caps and flow control are per session.

## Consequences

- A snippet using a cluster or context name with a backslash or a quote (in an unknown shell) cannot be used in that pane.
- Up to 8 shells per tab means up to 8 backend sessions; closing the tab closes all of them.
- A node or debug pane asks the same confirmation as a node or debug tab, once per pane.
