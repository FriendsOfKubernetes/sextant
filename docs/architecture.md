# Sextant architecture

Three layers, dependencies only point downward: `src/` (React) → `src-tauri/` (the `sextant` crate) → `crates/sextant-core/`.
For why things are the way they are, see `docs/adr/`; for what the words mean, see `CONTEXT.md`.

## Data flow

```
kubeconfig ──► KubeconfigRegistry ──► ClusterManager ──► kube::Client (retries, timeouts)
                                          │                  │
                           ConnectionState (broadcast)       ├─ resources::watch  ─► Stream<WatchUpdate>   (batches, at most 1 per 250 ms)
                                          │                  ├─ logs::stream_logs ─► Stream<LogUpdate>     (100 ms batches)
                                          │                  ├─ exec::exec_shell  ─► ExecSession
                                          │                  ├─ PortForwarder     ─► broadcast<Vec<ForwardInfo>>
                                          ▼                  └─ get / mutate / metrics / helm (request-response)
                        src-tauri: commands (invoke) and events (emit)
                                          │
                        src/api: invoke / listen / openStream (transport.ts), mockBackend for tests
                                          │
                        hooks (useWatch, useClusters, …) ─► zustand store + registries ─► components
```

- Request-response: component → `api.<group>.<method>` → `invoke("<command>")` → a thin command in `src-tauri/src/commands/<feature>.rs` → a core function → `Result<T, CoreError>`.
- Live data (watch, logs, terminal): the frontend creates the stream id (`newStreamId()`), `openStream` (`src/api/stream.ts`) attaches `listen("<prefix>:<id>")` and only then calls `*_start(…, streamId)`; the backend forwards the core stream as the events `watch:<id>`, `logs:<id>`, `term:<id>`. A single `openStream` keeps the order id → listen → start → unlisten → stop. Closing at any point leaves nothing behind: a start that has not answered yet is stopped when it does.
- `streams_reset` (`resetStreams()` in `src/api/stream.ts`) is called once when the page loads, before the first stream: it stops the subscriptions and terminals left over from the window's previous page; connections and port forwards are not touched. A start that began before the reset is rejected (`AppState::undo_if_reset`).
- Watch: one set of watchers per subscription (one per namespace); the frontend receives `Snapshot`, then `Delta { upserted, deleted(uid) }`, `Reconnecting`, `Forbidden { namespaces }` (some namespaces are inaccessible, the rest carry on), `Error` (cannot start). `managedFields` is stripped in the core. `useWatch` puts objects into a `Map<uid, obj>`. With `WatchSpec.metadataOnly`, objects arrive only as `{apiVersion, kind, metadata}`.
- Events without an id: `cluster-state` (`{ clusterId, state }`) and `portforwards` (`ForwardInfo[]`).
- Subscriptions, streams and sessions live in `AppState` (`subscriptions`, `sessions`); they are closed by `*_stop`, `streams_reset`, window close (`window::on_run_event` → `close_all`) and `AppState::close_cluster` (disconnecting a cluster also closes its port forwards and its local terminals).

### Discovery

There is one discovery per cluster: `ClusterManager::kinds` hands the shared result to everyone waiting and stops when nobody is left waiting; it is reset on (re)connect and disconnect. Aggregated discovery comes first (two requests), otherwise it goes group version by group version. `ResourceKind.printerColumns` is empty in it: the frontend reads CRD columns lazily, one CRD at a time, when the kind is opened (`useCrdPrinterColumns`, `src/resources/crdColumns.ts`). Built-in kinds are described in the core (`BUILT_IN_KINDS` in `crates/sextant-core/src/resources/get.rs`), and their watch does not wait for discovery. The sidebar takes CRDs from discovery (`customResourceKinds` in `src/resources/useKinds.ts`). Decision: ADR-0015.

### GitOps: Flux and Argo CD

Flux and Argo CD are ordinary CRDs, so everything goes through the Kubernetes API with no CLI of these tools (ADR-0024). Their kinds (`src/features/flux/`, `src/features/argocd/`) are registered in the kind registry under the `flux` and `argocd` sidebar sections; a section is shown only if its kinds are in discovery (ADR-0031). Actions (reconcile, suspend/resume, sync, refresh, terminate) are object patches through the shared `resource_patch` command (ADR-0025). The core picks the kind version through `resolve_kind`: get/watch/patch use the version from discovery, while `replace`/`apply` use the document's version (ADR-0030).

**Discovery reset.** The Flux and Argo CD CRDs show up after the connection is made, so the frontend watches CRDs (`watchCrdChanges`, `src/resources/useKinds.ts`) and calls `cluster_kinds_refresh` when one is added or removed: `ClusterManager::refresh_kinds` resets the cluster's shared discovery without reconnecting (ADR-0026).

**Argo CD: login and diff.** The core (`crates/sextant-core/src/argocd.rs`) finds the Argo CD installation (ADR-0032) and talks to its API through a port-forward to `argocd-server`; TLS verification is disabled only for `127.0.0.1` (ADR-0027). Sessions live in `ArgoSessions` (`src-tauri/src/commands/argocd.rs`, field `AppState.argocd`) and are closed together with the cluster; the commands are in `src-tauri/src/commands/argocd.rs`. The login sources and their order are in ADR-0028, the saved login in the OS keyring is in ADR-0029. Argo passwords and tokens stay in the backend. The diff (`argocd_diff`) returns the managed resources with their desired and live state, with Secret values stripped; the login dialog and the diff view built on `@codemirror/merge` are in `src/features/argocd/diff/`, and the `argoDiff` action is attached by a separate feature, `src/features/argocd-diff/`.

### Cluster client: retries and timeouts

`kube::Client` is built in `cluster.rs` with its own retry layer (`RetryPolicy`: 429/503/504, at most 3 times and 5 s, **only GET and HEAD** — a change may have been applied already, so it is never repeated; its 504 becomes `ErrorCode::Timeout` with the text `CHANGE_TIMED_OUT`); the connection uses `CONNECT_TIMEOUT`. Commands that change the cluster are wrapped in `error::with_timeout` (`CHANGE_TIMEOUT` in `src-tauri/src/commands/actions.rs`) and yield `ErrorCode::Timeout`; drain and multi-document apply limit each request (`resources::STEP_TIMEOUT`); Helm calls have time limits and are killed on drop. Decisions: ADR-0016, ADR-0023, ADR-0055.

### Secrets

The core does not hand Kubernetes Secret values to the frontend: `resources::get::to_json` for `core/v1 Secret` replaces the `data`/`stringData` values with `""`, sets the `sextant.dev/values-hidden` annotation and removes `last-applied-configuration` — this applies to both watch and `resource_get`. The value of a single key is `secret_value`; the whole object is `resource_get_full`, for editing only. The core rejects saving an object that carries the `values-hidden` marker (`ensure_values_present`). Decision: ADR-0014.

### MCP server for AI agents

Sextant can serve MCP to local agents (Claude Code, Claude Desktop, Cursor). It is optional, off by default (`AppSettings.mcp.enabled`), lives in the app process under `src-tauri/src/mcp/` and stops with the app (ADR-0038). Data flow of one call:

```
MCP client ──► 127.0.0.1:<port>/mcp ──► http.rs: Host / Origin / Bearer / 4 MB body ──► rmcp tool (tools_read / tools_write)
                                                                                              │
   audit.rs (ring of 2000 + mcp-audit.jsonl, event mcp-audit) ◄── result ◄── core call ◄── Guard::check ──► access::decide
                                                                                              │ needs "ask"
                                                                       event mcp-confirm ◄────┘ ──► window dialog ──► command mcp_confirm_answer(id, approved)
```

- The server is a field of `AppState` (`AppState.mcp`); `settings_update` calls `apply_settings` after saving, `close_all` calls `stop`. The state is announced by the event `mcp-status`; the commands are `mcp_status`, `mcp_token`, `mcp_regenerate_token`, `mcp_audit_list`, `mcp_audit_clear`, `mcp_confirm_answer`, `mcp_binary_path`.
- The token is the file `mcp-token` (0600) in the settings directory, shared with `sextant mcp`; the directories are computed without Tauri (`mcp/paths.rs`, ADR-0039).
- Tools do no cluster logic: they call the core (`resources::list/events/resolve`, `logs::tail`, `exec::run_command`, the existing mutate, Helm and port-forward functions). Every tool states the permissions it needs as `(namespace, kind, action)` triples and calls `Guard::check` right before each side effect; the results are truncated and Secret values are cut out unless the Secret values action is granted. A call that needs confirmation waits at most 120 s for the window; without an answer, without a window, or after a stop it is refused.
- Every call, allowed or not, is one record in the activity log (summaries only, no values, YAML or output; ADR-0042). The frontend (`src/features/mcp/`) shows the Settings section and the log; the confirmation dialog is shared with extensions and is mounted once in `AppShell`.
- The confirmation map, the journals and the node-shell refusals are not MCP-specific: they live in `src-tauri/src/access_guard/` (`confirm.rs`, `audit.rs`, `mod.rs`) and are used by both the MCP guard and the extension API; `mcp/confirm.rs` and `mcp/audit.rs` only re-export them (ADR-0051).
- **`sextant mcp`** is the same binary started with the first argument `mcp`: `main.rs` runs `mcp_proxy::run()` without Tauri and bridges stdin/stdout JSON-RPC lines to the running server, reading the port from `settings.json` and the token from `mcp-token`. It starts no cluster work of its own and never creates the token (ADR-0040).

### Agent access model

Policy is a pure module of the core, `crates/sextant-core/src/access.rs`: per cluster, `ClusterSettings.agent_access` holds a preset (Off, Read-only, Read + write, Full, Custom) and rules `namespaces × kinds × actions (+ "ask")`; the actions are Read, Modify, Delete, Logs, Exec, Port forward and Secret values. A call is allowed if some rule covers `(namespace, kind, action)`; there are no deny rules. Off is the default, and a value that does not parse is read as Off. A preset other than Custom is a function producing rules (`preset_rules`, the only source: the frontend asks for them with `access_preset_rules`); Custom uses the stored rules. Kinds without a namespace are checked with namespace `None`; a Helm release is the pseudo-kind `helm.sh/Release`. The rules are in `settings.json`, written by the frontend (`src/features/agent-access/`), and the server re-reads them on every call. Denials use `ErrorCode::Denied`. Decision: ADR-0041; the JSON patch limit on Secrets is ADR-0043.

### Cloud cluster sources

"Add cluster → From cloud" finds EKS, GKE and AKS clusters through the user's installed CLIs (`aws`, `gcloud`, `az`), run by `crates/sextant-core/src/cloud.rs` without a shell, with a cleaned environment and a 60 s timeout, behind the `desktop` feature. The chosen clusters are written to `kubeconfigs/cloud-<provider>.yaml` in the app data directory (0600) with an exec-based authentication that calls the CLI again at each connection; the file is registered as an ordinary kubeconfig source. Sextant never performs a login and never touches `~/.kube/config`; an expired login yields a message with the login command, which the UI can put into a terminal without running it. Commands: `src-tauri/src/commands/cloud.rs`; UI: `src/features/clusters/CloudClusters.tsx`. Decision: ADR-0044.

### Node shell

A shell on a node is the existing pod exec into a temporary pod `sextant-node-shell-<node>-<rand>` in `kube-system` (privileged, `hostPID`, `hostNetwork`, `nodeName`, `activeDeadlineSeconds` 8 h; image from `AppSettings.node_shell_image`), running `nsenter` into the host (`crates/sextant-core/src/node_shell.rs`, `start_node_shell` in `src-tauri/src/commands/terminal.rs`). The session is registered in `AppState` before the pod is created; the pod is deleted when the tab closes, the cluster is disconnected or the app exits. On connect the core removes only leftovers of the same owner (label `sextant.dev/owner`, a hash of the OS user and machine) and any labelled pod older than 8 h. The user confirms in a dialog first; the MCP server has no tool for it. Node-shell pods are recognised by name or by label (`node_shell::is_node_shell_object`) and are unreachable for agents and extensions, failing closed when the pod cannot be read: no `exec_command`, patch, apply or delete, a drain skips them, and an agent's port forward never reaches them or `hostNetwork` pods: a Pod target is refused, a Service forward skips such pods whenever it picks one and is refused when it has no other (checks in `access_guard/mod.rs`, `mcp/tools_write.rs` and `PodFilter::NoNodeAccess` in `portforward.rs`). Decisions: ADR-0045, ADR-0056.

### Extensions

UI extensions (Lens-style: pages and sidebar sections, details sections, actions, table columns, dock buttons, a settings section) are packages with a manifest `sextant-extension.json`; there are no backend extensions. Each runs in a sandboxed iframe and reaches clusters only through the host's API (ADR-0047, ADR-0049, ADR-0050). Data flow of one call:

```
extension frame ──postMessage {sextant:1, doc, id, method}──► src/extensions/bridge.ts (checks the frame window and `doc`)
   local methods (ui.*, context.get, resources.unwatch) answered in the window
   REMOTE_METHODS ──► api.extensions.call ──► extension_call (src-tauri/src/extensions/api.rs)
        installed + enabled? ─► cluster in `granted.clusters`? ─► decide_extension per (namespace, kind, action)
        ─► node-shell refusal ─► confirmation if needed (mcp-confirm, source "extension") ─► core call ─► extensions-audit.jsonl (ext-audit)
   resources.watch ──► events ext-watch:<streamId> ──► bridge ──► {stream, event} back to the frame
```

- **Package and permissions (core)**, `crates/sextant-core/src/extensions/`: `manifest.rs` parses strictly (unknown field → error with its path) and is checked against `manifest.schema.json` (the SDK validates with the same rules; the cases both must agree on are `sdk/test/fixtures/manifest-cases.json`, read by a Rust test too); `permissions.rs` reuses the agent access model (clusters by context name × namespaces × kinds × read/modify/delete/logs/secretValues, `decide_extension`); `package.rs` inspects a zip or folder under limits and installs atomically to `<data>/extensions/<id>/<version>/`; `resolve_package_file` opens a requested file without following links or leaving the package. `AppSettings.extensions` (installed list, source, enabled, **granted** permissions) is owned by the backend (ADR-0052).
- **Serving and managing (Tauri)**, `src-tauri/src/extensions/`: `protocol.rs` serves `sextant-ext://<id>/<file>` (Windows: `http://sextant-ext.localhost/<id>/<file>`) from the installed version or the dev folder; every answer carries a CSP built from that extension's base URL (never `'self'`, ADR-0048), `nosniff` and `no-store`; a disabled or unknown extension is 404. `manage.rs` inspects a file, a folder or a GitHub Release URL into a pending install (token, 10 min), installs it only after the user's consent click, and enables, disables, removes and reloads; `dev.rs` polls a dev folder every second (`extension-files-changed`). Installing is from a folder, a `.zip`/`.sextant-ext` or a GitHub Release link; there is no catalog and no signing (ADR-0053). Storage (`storage.*`) is one JSON file per extension in `<data>/extensions-data/`.
- **Host (frontend)**, `src/extensions/`: `protocol.ts` is the single source of the wire protocol (the SDK keeps a test-checked copy); `bridge.ts` routes messages; `ExtensionFrame.tsx` draws the iframe (sandbox without `allow-same-origin`, theme, language and context pushed in, auto-height for details sections, "Extension failed" with Reload); `contributions.tsx` registers what manifests declare into the registries below with ids `ext:<extId>:<id>` and removes them with `unregisterExtension`; `ExtensionsHost.tsx` mounts it. The manager (list, consent, permissions, activity, dev reload) is `src/features/extensions/`, a Settings section.
- **SDK**, `sdk/`: types, the frame client (`connect()`, `api.*`, `ui.*`, `storage.*`), `sdk/scripts/{build,pack,check,sync-types}.mjs` (the `sdk:*` npm scripts), `sdk/template/`, and two examples. It is in the repository and not on npm (ADR-0054).

### Application updates

Checking and installing go through the Tauri `updater` and `process` plugins, wrapped in `src/api/updater.ts` (`api.updates`, transport in `src/api/transport.ts`, replaced by `mockBackend` in tests). State is in `src/features/updates/store.ts`; the UI is `UpdateNotice` (the check at startup, mounted from `SettingsButton`) and `UpdatesPanel` (the Settings section). The updater plugin is registered in `src-tauri/src/lib.rs` only when `plugins.updater.pubkey` and an endpoint are set in `src-tauri/tauri.conf.json` (`updater_configured`); the window permissions are in `src-tauri/capabilities/updates.json`. The release, the signature and `latest.json` are in `.github/workflows/release.yml`, ADR-0022.

## Module boundaries

- **`sextant-core`** owns everything about clusters: kubeconfig, connection and discovery, watch, actions on resources, logs, exec, port-forward, metrics (metrics-server and Prometheus), Helm, settings on disk. It hides `kube-rs`, reflectors, Helm secret parsing, Prometheus auto-detection; it also owns the extension manifest, permissions and package format (`extensions/`). It does not depend on `tauri` or `portable-pty`; everything that launches OS processes (the `helm` binary) sits behind the `desktop` feature (in default). `scripts/check-core-deps.mjs` verifies this.
- **`sextant`** (`src-tauri/`) owns `AppState`, commands, events, the local PTY (`pty.rs`), the window geometry (`window.rs`), the MCP server (`mcp/`), what MCP and extensions share (`access_guard/`), the extension host (`extensions/`) and the `sextant mcp` bridge (`mcp_proxy.rs`); `rmcp` and `axum` are its dependencies only. A command contains no cluster logic — it calls the core. A new kind of subscription or session is registered in `AppState`, otherwise `close_cluster` will not close it.
- **`src/api/`** is the only place where `invoke` / `listen` are called and `@tauri-apps/api` is imported (eslint forbids it everywhere else). An exception under ADR-0011: the cluster hooks live in `src/features/clusters`.
- **`src/features/<name>/`** are vertical features. A directory with `index.ts` is picked up automatically (`import.meta.glob` in `src/app/features.ts`); a feature wires itself in through registrations, without editing other people's files.
- **`src/layout/`** is the shell (`AppShell`: cluster rail, sidebar, `MainView`, details panel, dock). It knows nothing about specific resource kinds.
- **`src/resources/`** is the kind registry (`ResourceDef`: columns, details, actions); for CRDs the columns come from the CRD's own `printerColumns`, read lazily (`crdColumns.ts`).
- **`src/components/`** are shared components with no knowledge of Kubernetes kinds: `Button` (`variant`, `size`, `icon`, `iconOnly` + a required `label`), `Checkbox` and `Radio` (the app has no native checkboxes or radio buttons), `Tabs` (a `tablist` with the ←/→/Home/End keys), `icons.tsx` (`Icon`, `IconName`, `renderIcon`), `LoadingIndicator` (with a hint if the wait is long), `Dialog`, `ConfirmDialog`, `ErrorState`, `EmptyState`, `Badge`, `Age`, `usePopup`; the resource table is in `src/components/Table/` (`ResourceTable`, `LoadingTable`). Exports are in `src/components/index.ts`; features import from there, not from one another.
- **`src/features/flux/`, `src/features/argocd/`, `src/features/argocd-diff/`** are GitOps (see "GitOps: Flux and Argo CD"); they work only through the api and registries, and the core needs only `resource_patch`, `cluster_kinds_refresh` and the `argocd` module for them.
- **`src/features/mcp/`, `src/features/agent-access/`** are the agent features (see "MCP server for AI agents", "Agent access model"); the first embeds into Settings and the cluster rail (`railFooter`), the second into cluster settings (`registerClusterSettingsSection`).
- **`src/extensions/`** is the extension host, part of the shell (not a feature folder); **`src/features/extensions/`** is its Settings UI. Extension contributions reach the app only through the registries (see "Extension points"). **`sdk/`** is a separate npm package used by extension authors; the app does not import it.
- **`src/features/updates/`** are the application updates and its version (see "Application updates"); it does not hook into the registries, and its components are embedded by `src/features/settings`.

## Buttons, icons, tabs

- All icons come from the `lucide-react` set, imported only in `src/components/icons.tsx`: `IconName` holds the names from the set, `renderIcon(name)` draws an SVG (`aria-hidden`, no text and no `<title>`). Features import `Icon`/`renderIcon` from `src/components`, not `lucide-react` (ADR-0033). `icons.test.tsx` requires every name to be used.
- Sizes are `:root` tokens in `src/styles/global.css`: `--control-height` 32 px, `--control-height-compact` 28 px (the "⋮" button and table row buttons, closing a dock tab), `--control-font-size`, `--icon-size`; `.btn`, `.btn--compact`, `.btn--icon`, `.icon-btn` take their sizes from there (ADR-0034).
- A button with an icon instead of a label (`iconOnly`) keeps the former label in `aria-label` and `title`; vitest and e2e find buttons by these names.
- Icons in the registries: `ActionDef.icon: IconName` (`src/features/actions/registry.ts`, rendered in `ActionBar` and in the table's `ActionMenu`), `DockActionDef.icon?: IconName`, `SidebarEntry.icon?: IconName` and `SECTION_ICONS` (the icon of a section and of single pages, keyed by `SidebarSection | "settings"`) with the fallback `DEFAULT_ENTRY_ICON` — `src/resources/registry.ts`, `PageDef.icon?: IconName` — `src/layout/pages.ts`. A feature sets the icon with the `icon` field in its registration; the sidebar draws it to the left of the label.
- `Tabs` — the caller holds the selected-tab state; the pod's container tabs (`ContainerList`, `src/features/details/kinds/pods.tsx`) keep the selection by the object key `clusterId|namespace|name`, so a pod update does not reset it.
- Pod requests and limits are computed by the frontend: `podResourceAmounts` (`src/features/metrics/requests.ts`, CPU in millicores, memory in bytes) — they are visible even without metrics-server (ADR-0037).

## Cluster icon and rail

`ClusterSettings.icon` (Rust `ClusterIcon`: `Text { text }` or `Image { dataUrl }`) and `WindowLayout.railExpanded` live in `settings.json` and are written by the frontend (`settings_update`). `readIconImage` (`src/features/clusters/iconImage.ts`, input up to 5 MB) fits the image into a 96×96 PNG; `iconOf` (`clusterSettings.ts`) returns the image only if it is `data:image/png;base64,`, otherwise text (`icon.text` or the name's initials); the shared renderer is `ClusterAvatar`, used for the rail and the preview. `ClusterRail` (`src/layout/ClusterRail.tsx`) reads `railExpanded` from the store (`setRailExpanded`) and shows names when expanded; what expands is the narrow cluster rail, not the section menu (ADR-0035, ADR-0036).

## Extension points (registries)

| What is added | Function | Where the registry is |
|---|---|---|
| resource kind | `registerResource`, `extendColumns` | `src/resources/registry.ts` |
| action on an object | `registerAction(id, def)` | `src/features/actions/registry.ts` |
| dock tab / dock button | `registerDockTab`, `registerDockAction` | `src/layout/dock/registry.ts` |
| details panel section | `registerDetailsSection` | `src/layout/details/registry.ts` |
| sidebar page | `registerPage` | `src/layout/pages.ts` |
| slot (`clusterRail`, `railFooter`, `welcome`) | `registerSlot` | `src/layout/slots.ts` |
| cluster settings section | `registerClusterSettingsSection` | `src/features/clusters/settingsRegistry.ts` |

A new built-in action is also a new member of the `ActionId` union (`ext:${string}` is for extensions). The same registries take extension contributions: pages with a `label` and a free `section` (`registerPage`), `extendColumns` with a JSONPath, `extendActions(kind, ids)`, dock tabs `ext:${string}` and `registerDockAction`; each registry has a version hook so a late registration re-renders. The settings and updates pages do not use the registries: `src/features/settings` shows them itself (the `railFooter` slot is the Settings button).

## Conventions

- Names in code are English. Everything that goes to the frontend is `#[serde(rename_all = "camelCase")]` and `ts-rs`; TS types are generated into `src/api/generated/` (`npm run gen:types`), are not edited by hand, and the generated files are committed. Command and event names are not part of the generation: they are written by hand in `src/api/commands.ts`, `src/api/events.ts` and `src-tauri/src/lib.rs`, and a typo is caught only by a test or at runtime.
- Every UI string is an i18next key in `src/locales/<lang>/<namespace>.json`, one namespace per feature; the list of languages is built from the directories found. eslint forbids literals in JSX.
- One error for the whole core: `CoreError { code: ErrorCode, message }`. kube errors always go through `error::kube_error` (it strips exec-plugin secrets). In the frontend it is `ApiError { code, message }`, and the `ErrorCode` is translated by the key from `errorKey`.
- Secrets from kubeconfig are not logged and do not go to the frontend. Kubernetes Secret values go out only on explicit request (`secret_value`, `resource_get_full`); any new path by which a Secret object reaches the frontend must go through `resources::get::to_json`.
- The terminal and `helm` get a temporary single-context kubeconfig with mode 0600 (`write_temp_kubeconfig`, ADR-0010). The terminal's file belongs to the session (`TermSession.guard`) and is removed synchronously when it stops, its file is `sextant-kubeconfig-<pid>-*`, and leftovers are removed at startup only for dead PIDs (old names without a PID after 24 h; ADR-0019); the user's shell gets `KUBECONFIG` back after its rc (ADR-0018). `HELM_KUBE*`, `HELM_NAMESPACE`, `HELM_DRIVER`, `KUBECONFIG` are scrubbed from the environment of a `helm` call; the only launch point is `HelmCli::command()`.
- Mutating core calls are signed with the field manager `sextant`. A namespaced reference without a namespace yields `invalid` (`ObjectRef::required_namespace`). A YAML replace without `resourceVersion` is `invalid`.
- The streams rule: the frontend creates the id and attaches `listen` before `*_start(…, streamId)`, so the backend holds back output with neither pauses nor a buffer: watch delivers the first snapshot immediately and then no more than once per 250 ms (`resources::watch::BATCH_INTERVAL`), logs in 100 ms batches (`logs::BATCH_INTERVAL`), the terminal immediately. A stream is opened only through `openStream`; the id is checked by `check_stream_id` (`[A-Za-z0-9_-]`, ≤128, an id already in use is `invalid`), and the subscription is registered in `AppState` before the core starts working. Decision: ADR-0013.
- Settings: `settings_update` changes only the frontend's fields; the fields written by the backend (`kubeconfigSources`, window geometry, `extensions`) are kept as the backend wrote them. A new backend field must be added to the list of preserved ones in `update_settings`; `clusters[id].agentAccess`, `AppSettings.mcp` and `node_shell_image` are frontend fields. An unreadable `settings.json` is not overwritten (`settings_status`, ADR-0017).
- The application version is one across five manifests (`Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `package.json`, `package-lock.json`); `scripts/check-version.mjs` checks it (`npm run check:version`, in `npm run check` and in `release.yml`).
- Forwarded ports listen only on 127.0.0.1, and so does the MCP server. Secrets that guard agent access (the MCP token) are files with mode 0600 and are never printed.
- Docs, ADR, the glossary and `AGENTS.md` are written in English (ADR-0046).
- The word "Lens" is not used in the product; the product is Sextant (`dev.sextant.app`).

## Test seams

1. Core without a cluster: unit tests next to the code; those that need to see HTTP go to the fake API server `crates/sextant-core/src/fake_api.rs` (visible only under `cfg(test)`; the test sets the replies, every request is recorded).
2. Core against kind: `crates/sextant-core/tests/<feature>.rs` + `crates/sextant-core/tests/common/mod.rs`; the GitOps tests (`gitops*.rs`) additionally need `SEXTANT_TEST_GITOPS=1` and a cluster brought up with `up --gitops`, and are skipped without them; without `SEXTANT_TEST_KUBECONFIG` a test returns early and counts as passed. Heavy measurements (a big cluster) use the fixture `scripts/fixtures/load/load.sh`.
3. Commands: `src-tauri/tests/commands.rs` calls every command on the Tauri mock runtime, isolated from `KUBECONFIG` and `~/.kube/config` (`set_env`); a command that goes to the network or launches `helm` is replaced there.
4. Frontend: Vitest + Testing Library without Tauri, the backend is replaced by `mockBackend` from `src/api` (including updates and the application version).
5. SDK: `sdk/test/` (Vitest, `npm run sdk:check`) checks the manifest validator against `sdk/test/fixtures/manifest-cases.json`, the protocol copy against `src/extensions/protocol.ts`, `sdk/src/generated/` against `src/api/generated/`, building and packing. Extension calls in Rust: `src-tauri/src/extensions/api_tests.rs`, the protocol handler tests in `protocol.rs`.
6. The whole window: `e2e/` (WebdriverIO + `tauri-driver`) against kind, with its own XDG directories in a temporary folder.
