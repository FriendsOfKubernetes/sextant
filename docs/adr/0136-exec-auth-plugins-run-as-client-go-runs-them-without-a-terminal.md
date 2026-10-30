# ADR-0136: Exec auth plugins run as client-go runs them without a terminal

## Context

kube-client 4.2 (`client/auth/mod.rs`, `auth_exec`) runs a kubeconfig's exec auth plugin interactively unless the
kubeconfig says `interactiveMode: Never`: it inherits stdin and stderr and tells the plugin `interactive: true`. In a
desktop app that has no terminal this helps nobody: a prompt goes to Sextant's own stderr (Linux, macOS) or to a
console window the plugin gets for itself (Windows, #288, where every token refresh flashed one, as Helm did in
#286), and the plugin's stderr never reaches `CoreError.pluginOutput` (#256), so a failed sign-in shows no reason.
kube-client starts plugins without a console window only with `KUBE_RS_UNSTABLE_CREATE_NO_WINDOW=1`, and warns that
this breaks interactive plugins (kube-rs/kube#1901).

client-go (`plugin/pkg/client/auth/exec/exec.go`, `isInteractive`), which kubectl uses, decides by the mode and by
whether standard input is a terminal: `Never` and — without a terminal — `IfAvailable` (the default) run without
stdin; `Always` without a terminal is an error ("standard input is not a terminal").

## Decision

- Sextant's connections (`cluster::open_checked_client`, and the eviction client of a drain) pass their one-context
  kubeconfig through `kubeconfig::exec_mode::without_terminal` first: every exec plugin gets `interactiveMode: Never`,
  a plugin with `Always` is refused before it runs, with an `authPlugin` error that names its command (never its
  arguments or env) and says what to do (set `IfAvailable`, or use the context from a terminal) — what kubectl does
  without a terminal.
- On Windows `main` sets `KUBE_RS_UNSTABLE_CREATE_NO_WINDOW=1` before any thread starts, unless the user set it
  (`exec_mode::hide_plugin_consoles`): with no interactive plugin left nothing needs a console.
- Kubeconfig files are not changed; Sextant's terminals run kubectl on the file itself, with a terminal, so a plugin
  there may still be interactive.

## Consequences

- A plugin's stderr is captured on every OS, so a failed sign-in shows the plugin's own words in the window
  (masked, `pluginOutput`). A plugin that needs input fails at once with its message instead of waiting on a prompt
  nobody sees.
- A context with `interactiveMode: Always` no longer connects in Sextant (it may have worked on Windows through the
  plugin's console window); the error tells the user to change the mode or use a terminal.
- No Windows console window per token refresh. Checked by unit and connection tests on Linux (`exec_mode` tests,
  `cluster::tests::exec_plugins_run_without_a_terminal_and_always_is_refused`); the Windows flag is checked only by
  its use there.
