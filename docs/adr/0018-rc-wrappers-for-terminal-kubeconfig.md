# ADR-0018: The terminal restores KUBECONFIG after the user's rc files through shell wrappers

## Context

The terminal got the temporary file's `KUBECONFIG` in its environment, but the shell started as a login shell and read `~/.zshrc` or `~/.bashrc`; an `export KUBECONFIG` from there overrode the selected cluster. The shell inherited the app's whole environment, including `HELM_*`, `KUBECONFIG` and the AppImage packaging variables.

## Decision

The app starts the shell so that `KUBECONFIG` is restored after the user's initialization. bash — `bash --posix -i` with `ENV=<temporary rc>`: the rc unsets `ENV`, leaves POSIX mode, turns off `inherit_errexit`, sources `/etc/profile` and sets `HISTFILE=~/.bash_history` if it is not set. zsh — the temporary directory holds only a `.zshenv` that restores the user's `ZDOTDIR`, and `KUBECONFIG` is restored by a one-shot `precmd` hook. fish — `--init-command`, the path is passed through `SEXTANT_KUBECONFIG`, which the init command unsets. Other shells and PowerShell get a visible notice in the tab: a private OSC 7719 in the output stream (`TerminalViewProps.kubeconfigNotice`). `HELM_KUBE*`, `HELM_NAMESPACE`, `HELM_DRIVER`, the app's `KUBECONFIG` and the AppImage variables are removed from the shell's environment.

Supersedes ADR-0010 in the part "the shell is started as a login shell, and the profile may override `KUBECONFIG`".

## Why

- Leaving it as it was got rejected: a silent `kubectl` against the wrong cluster is worse than any error, and `export KUBECONFIG` in working rc files is common.
- Editing the user's rc files was rejected by the principle of ADR-0010: the app does not change the user's files.
- The first variant for bash, `--rcfile <tmp> -i`, was replaced by `--posix` with `ENV`: the materials name its drawbacks — `logout` and `~/.bash_logout` did not work. There is no directly recorded reason for the replacement.
- For shells without a reliable way to do this, an honest notice was adopted instead of a promise: without it the user would assume there is a guarantee.

## Consequences

- Each shell has its own mechanism: there are three, plus the notice. For `sh`, `dash`, `nu` and PowerShell there is no guarantee, only a warning in the tab.
- The bash wrapper reproduces the initialization order by hand (`/etc/profile`, `HISTFILE`, `inherit_errexit` — traces of "repairs"), and divergences from the behavior of an ordinary login shell are possible. Whether `logout` and `~/.bash_logout` work now was not re-checked in the materials.
- The restoration in zsh is one-shot: if the user later changes `KUBECONFIG` in the session themselves, the hook will not put it back.
- The test for `export KUBECONFIG=/other` runs for bash and zsh if they are present in the system. macOS and Windows were not checked live.
- The temporary `sextant-shell-*` directories are not cleaned up at startup after a crash (ADR-0019).

> Clarification after the build (2026-10-12): bash is started as `--posix --rcfile <rc> -i` with `ENV=<rc>`. `/bin/bash` on macOS (bash 3.2 with Apple's patch) in `--posix -i` does not read `$ENV` but does read `--rcfile`; any other bash in POSIX mode ignores `--rcfile` and reads `ENV`.
