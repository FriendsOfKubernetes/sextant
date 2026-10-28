# ADR-0132: Terminal tools: kubectl for the cluster's version, helm, k9s and kubectx installed from fixed sources into Sextant's own folder

## Context

Issue #305. A cluster's terminal starts the user's shell with `KUBECONFIG` set to that cluster. When `kubectl` is not installed, the first command fails with "command not found", and Sextant does not help. When it is installed, it may be far from the server's version, outside the skew Kubernetes supports (one minor version either way). Different clusters may need different kubectl versions, and helm, k9s and kubectx/kubens are the other tools people reach for in such a terminal.

What Sextant already has:
- the download rules of `src-tauri/src/download.rs`: HTTPS only, redirects checked one by one, size and time limits, errors without the URL;
- allow-lists of exact URLs built by Sextant (`gitops_install/download.rs`);
- the server's version from a connection;
- `pty::shell_environment`, which builds a terminal's environment.

## Decision

### Which tools, and from where

Sextant offers four tools, each from one fixed source, with a URL Sextant builds from checked parts. Every download is checked against a published SHA-256 before it is kept.

| Tool | Version offered | Download | Checksum |
|---|---|---|---|
| kubectl | `https://dl.k8s.io/release/stable-<major>.<minor>.txt` for the cluster's minor version (the newest patch) | `https://dl.k8s.io/release/<v>/bin/<os>/<arch>/kubectl[.exe]` | the same URL with `.sha256` |
| helm | `https://get.helm.sh/helm-latest-version` | `https://get.helm.sh/helm-<v>-<os>-<arch>.tar.gz` (`.zip` on Windows) | the same URL with `.sha256sum` |
| k9s | the latest release of `derailed/k9s` (GitHub API) | its asset `k9s_<OS>_<arch>.tar.gz` (`.zip` on Windows) | its asset `checksums.sha256` |
| kubectx, kubens | the latest release of `ahmetb/kubectx` | its assets `kubectx_<v>_<os>_<arch>.tar.gz` and `kubens_…` (`.zip` on Windows) | its asset `checksums.txt` |

- **Versions.** A version is accepted only as `vX.Y.Z`. Platforms are Linux, macOS and Windows on x86-64 and arm64, mapped to each project's own names.
- **Redirects** are followed only to the GitHub asset hosts (for GitHub releases) and to `cdn.dl.k8s.io`.
- **Limits.** Each file is at most 200 MB, read in at most 5 minutes.
- **Archives.** From an archive only the tool's own binary is taken, by its exact name at the archive's top or in the project's one known folder (`<os>-<arch>/` for helm). A link, an absolute path or `..` is refused, as file copy refuses them (ADR-0065).
- **Trust.** The checksum of kubectl and helm comes from the same official host as the binary. For k9s and kubectx it is the file of the same GitHub release, which proves the download is what that release holds, as Flux's checksums do (ADR-0058).

### Where they go

- Tools go into `<app data>/tools/<tool>/<version>/`, through a temporary folder renamed into place. They are never installed system-wide, Sextant never asks for administrator rights, and it touches no file of the user's.
- On Unix the binary is made executable (0755). On macOS the quarantine attribute is not set, since Sextant downloaded the file itself.
- A cluster's terminal gets this folder in front of its `PATH`:
  - the kubectl matching that cluster's minor version, if one is installed;
  - otherwise the newest kubectl installed;
  - the current helm, k9s and kubectx/kubens.

  A local terminal (no cluster) gets the newest of each. A system binary is never shadowed by a missing one: only installed versions are added.
- Sextant's own Helm features use the installed helm when none is found in the system (`HelmCli`).

### When Sextant asks

- **When a cluster's terminal opens**, Sextant looks for `kubectl` in that terminal's `PATH`, Sextant's own tools included. When it finds none, or the version it reports (`kubectl version --client -o json`, run once per binary with a 5 s limit) is more than one minor version away from the server, the terminal shows a bar above it. The bar offers "Install kubectl vX.Y.Z for this cluster", "Not now" (for this session) and "Don't ask again" (the setting `AppSettings.terminalTools.offerKubectl`, on by default). The install runs in the background, and the bar says when the next terminal will have it.
- **The Helm section**, when Sextant finds no helm, offers "Install helm" next to its install instructions.
- **Settings → Terminal → Tools** lists the four tools: what is installed, which clusters a kubectl version serves, Install, "Update to vX" (checked only when the user opens the list or presses Check), and Remove.
- Nothing is downloaded or installed without a click. No background check runs at start or on a timer.
- **Window only.** The `tools_*` commands are not MCP tools or extension methods (a test keeps them out). An agent's `exec_command` runs in a container and never on the user's machine, so it never needs them.

## Why

- **Sextant's own folder, not the system.** Nothing outside Sextant changes, removing a tool is removing a folder, and different clusters get their own kubectl, which a single system binary cannot give. The user agreed to this placement.
- **No package managers.** Brew, apt, winget and Chocolatey differ per OS, need administrator rights or interaction, and give one system-wide version.
- **Fixed sources and published checksums.** These are the projects' own release channels, so Sextant ships nothing it did not get from the project. A URL never comes from the user, an agent or an extension. The rule of `download.rs` holds, with the tool sources as a new allow-list.
- **The kubectl matching the cluster's minor version.** It is inside the skew Kubernetes supports. The newest patch of that minor carries its fixes.
- **Asking only in the terminal, and only when kubectl is missing or out of skew.** That is where the user is about to need it. A general "you lack tools" notice elsewhere would be noise.

## Consequences

- A downloaded binary runs with the user's rights when they use it in a terminal, as one they installed themselves would. For k9s and kubectx the checksum proves only that the file is the release's. A compromised project release is out of Sextant's reach, as it would be for a manual install.
- Up to four tools and several kubectl versions take disk space, from about 50 MB each for kubectl and helm. The list in Settings shows the sizes, and Remove frees them.
- The GitHub API is asked without credentials (60 requests an hour). One list view asks at most twice, and an answer is kept for 10 minutes.
- New pieces:
  - core: version parsing, platform names, archive extraction and the PATH plan, without network;
  - Tauri: the sources, the download and the install (`src-tauri/src/tools.rs`, `AppState.tools`; one install at a time, written into a temporary folder renamed into place, so an install cut short by exit leaves only a temporary folder, removed at the next start); commands `tools_list`, `tools_latest`, `tools_install`, `tools_remove`, `tools_kubectl_offer`;
  - the setting `AppSettings.terminalTools`;
  - the terminal bar, the Settings section and the Helm section's button;
  - strings in every language.
