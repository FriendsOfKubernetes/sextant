<!-- autopilot:glossary -->
# Sextant

A desktop Kubernetes client for your own clusters: a list of clusters from kubeconfig, resource tables, details, logs, shells into containers, port forwarding, metrics, Helm, Flux and Argo CD in one window.

## Language

**Cluster**:
One entry in the list on the left: one context from kubeconfig, not a separate Kubernetes server. Two contexts on the same server are two clusters.
_Avoid_: connection, server, profile

**Kubeconfig source**:
Where the app gets contexts from: the default path, the `KUBECONFIG` variable, an added file, pasted text or a cloud source. One source yields several clusters.
_Avoid_: config, kubeconfig file

**Failed source**:
A kubeconfig source that could not be read or parsed. Its clusters do not appear, the others keep working; the error is shown next to the source in the cluster rail and in Settings, not only on the "no clusters" screen.
_Avoid_: broken config, skipped file

**Cluster rail**:
The column on the left with the list of clusters: each has its own icon and a connection state dot. A button at the bottom expands the rail to show names next to the icons; the choice is remembered and applies in a narrow window too. While the MCP server is on, the rail also has a button for the agent activity log.
_Avoid_: rail, cluster sidebar, cluster panel

**Resource kind**:
A type of Kubernetes objects, for example Pods or Deployments, including types added through CRDs. A table is built from a kind.
_Avoid_: resource type, entity, kind (when talking to the user)

**Subscription**:
A live watch on a kind in the selected namespaces with selectors: first a snapshot, which is sent immediately, then changes in batches no more often than once per 250 ms. One of the kinds of stream. Tables, details and events are updated only through subscriptions.
_Avoid_: polling, refresh by button

**Stream**:
One live line of data from the core to the window: a subscription, pod logs, a shell into a container or a local terminal. The identifier (`streamId`) is created by the window, which listens to it before the start, so the beginning of the data is not lost. Streams are closed when a cluster is disconnected, when the window is closed and when the page is reloaded; a port forward is not called a stream.
_Avoid_: channel

**Per-cluster discovery**:
One walk of the cluster's API groups, from which all resource kinds are taken. The result is shared by all subscriptions; built-in kinds do not need it to start, and CRD columns are read separately when a kind is opened. It is reset without reconnecting when a CRD appears or disappears in the cluster.
_Avoid_: scanning, kind refresh

**Section**:
A group in the tree on the left: Workloads, Config, Network, Storage, Access Control and so on. A section combines kinds and pages.
_Avoid_: category, menu

**Page**:
The content of a tree item that is not a table of one kind: overview, events, Helm, Port Forwarding, settings, and the pages an extension adds.
_Avoid_: screen, tab

**Details panel**:
The panel that slides out on the right for the selected object: metadata, kind fields, events, YAML. Extensions can add sections to it, or tabs next to "Overview", which holds the built-in sections.
_Avoid_: inspector, side panel

**Dock**:
The bottom area with tabs: logs, a shell into a container, a local terminal, creating and editing YAML, and the tabs extensions open. A terminal is just one of the dock tab types.
_Avoid_: console, bottom panel, terminal

**Port forward**:
A local port on this machine connected to a pod or service port in the cluster. Bound to 127.0.0.1 only. Forwards started by an agent are listed with the user's own and closed with the cluster or the app.
_Avoid_: tunnel, proxy

**Current values source**:
Where the CPU and memory numbers in tables come from: metrics-server or the latest point from Prometheus. Charts always come from Prometheus, and that is a separate setting.
_Avoid_: metrics in general, monitor

**Release**:
A Helm chart installed in the cluster under its own name and with a revision history. It has nothing to do with a release on GitHub, which the app update comes from. A Flux HelmRelease is a Flux object that drives a Helm release; in this glossary it is not called a "release".
_Avoid_: deployment, installation, app

**Update**:
A new version of Sextant itself: the app checks `latest.json` in a GitHub release, shows the version and notes, and installs it on "Install and restart". Signed with the project's key, not with an OS signature. On Linux an AppImage updates itself, a `.deb` is updated through the package.
_Avoid_: upgrade, release (that word is taken by Helm)

**Hidden-values marker**:
The annotation `sextant.dev/values-hidden: "true"` on a Secret that reached the window: the `data` and `stringData` values in it are empty, the keys are in place. An object with the marker is not saved; a value is requested one key at a time, and editing a Secret loads the whole object.
_Avoid_: masking, masked Secret

**Drain preview**:
The list of a node's pods before the node is drained: which will be evicted, which have no controller, which use emptyDir, which belong to a DaemonSet. Pods with no controller and with emptyDir are touched only when the "force" and "delete emptyDir data" boxes are checked.
_Avoid_: node check, dry-run

**Editor scheme**:
A set of YAML highlighting colors: Auto, One Dark, GitHub Dark, GitHub Light, Dracula, Nord, Solarized Dark, Solarized Light. Auto takes One Dark in the app's dark theme and GitHub Light in the light one. The choice is shared by all YAML editors and viewers and is stored in settings.
_Avoid_: editor theme (a theme is the light or dark look of the whole app)

**Unreadable settings**:
A settings file that could not be read or parsed, or that cannot be written (for example it belongs to root or is read-only). An unreadable file is copied to `settings.json.bak-<time>` and the app starts with defaults; when writing is not possible, changes live only until the window is closed. The window shows a banner with the path and the reason.
_Avoid_: settings reset

**Layer**:
A stage of the feature set, not an architectural layer: layer 1 is the core of the functionality, layer 2 is metrics, port-forward and Helm. Both layers are in the build.
_Avoid_: level, phase, iteration

**Core**:
The part of the app that knows everything about clusters and nothing about the window. Not to be confused with the word "core" in "layer 1 — the core of the functionality".
_Avoid_: backend, service

**GitOps section**:
The "Flux" or "Argo CD" section in the tree on the left. It appears only if the tool is found by CRDs in discovery: for Flux, at least one `*.toolkit.fluxcd.io` group; for Argo CD, the Application from `argoproj.io`. Kinds that are not in the cluster are not in the section; the section also appears without reconnecting if the tool was installed while the connection was open, including by Sextant's own GitOps install. Without the tool the section stays hidden; the offer to install lives in the cluster's menu and settings.
_Avoid_: plugin, integration, module

**Flux source**:
An object from which a Kustomization or HelmRelease takes its sources: GitRepository, HelmRepository, HelmChart, OCIRepository, Bucket. The details of a dependent object link to the source, the details of a source list those that refer to it. Not to be confused with a "kubeconfig source" and a "current values source".
_Avoid_: repository, source (bare)

**Inventory**:
The list of resources that a Kustomization created (`status.inventory`); shown as links in the details. A HelmRelease has no equivalent: its resources are found by the labels `helm.toolkit.fluxcd.io/name` and `namespace`.
_Avoid_: list of created resources, contents

**Reconcile**:
A Flux action: ask the controller to check the object against its source right away (the annotation `reconcile.fluxcd.io/requestedAt` with the current time). "Reconcile with source" first asks the source to be reconciled, then the object itself. It belongs to Flux; in Argo CD the same thing is called Sync and Refresh.
_Avoid_: sync (for Flux), refresh

**Application**:
An Argo CD object that keeps an application in the cluster in line with Git. In the details: Sync and Health, the source (repo, path, targetRevision), destination, conditions, the resource tree and the sync history. The bare word "app" is taken by Sextant itself.
_Avoid_: app, deployment

**Resource tree**:
The resources of an Application: the managed ones (`status.resources`, with Sync and Health) and their descendants by `ownerReferences` (ReplicaSet → Pod, Job → Pod); nodes open as links. It is built in the window, not taken from the Argo CD API.
_Avoid_: topology, graph

**Argo CD installation**:
Argo CD found in the cluster by the ClusterRoleBinding `argocd-application-controller` or `argocd-server` (and `<release>-…` for Helm): the namespace is taken from the binding's ServiceAccount and narrowed to namespaces that have `argocd-cm`. Without a binding (a namespaced installation, no permissions), candidates are looked up by `argocd-cm` and `argocd-initial-admin-secret`: the only one, or `argocd`, otherwise an error with a list, and nothing is opened. The `argocd-server` service is looked up only in the namespace found; the port forward for login, diff and "Open Argo CD UI" goes through it. Looking the service up by label across all namespaces is not used: a foreign Service could intercept the password.
_Avoid_: instance, Argo server

**Argo CD login**:
Sextant's session in the Argo CD HTTP API, needed for the diff. Credentials are looked up in order: saved login → `argocd-initial-admin-secret` (user `admin`) → a Secret labeled `app.kubernetes.io/part-of=argocd` with a `token` key → the login dialog (username/password or an API token). A candidate rejected by Argo CD is not tried again until its source changes, the user signs out or the cluster is closed. "Remember" saves the login in the OS keyring for the (cluster, Argo CD namespace) pair — the cluster is the UID of its `kube-system` Namespace, or the kubeconfig entry when that cannot be read, never the API server URL; the session token lives only in memory. A saved login is also bound to the API server it was saved for (its URL and certificate authority) and is offered only to a connection with the same binding. SSO through the browser is not supported.
_Avoid_: authorization, sign-in, connection to Argo CD

**GitOps install**:
Putting Flux or Argo CD into a connected cluster that lacks it, from the tool's official install file, through the Kubernetes API, with a version choice, a preview and a confirmation. Only the user's click in the window starts it; an agent or an extension cannot. Flux goes into `flux-system` as `flux install` does by default (no image automation), Argo CD into `argocd` as its standard cluster-wide install. Sextant offers no uninstall and no "upgrade" action. Not to be confused with an app "update" or with a Helm "release".
_Avoid_: deploy, setup, add-on install

**Install preview**:
The screen before anything is sent: version, where the file comes from, its SHA-256 (checked against the project's checksums for Flux, only shown for Argo CD), the namespace, the objects by kind with the cluster-wide ones marked, a cluster-admin warning, whether the user's rights look sufficient and which objects already exist and will be overwritten. The Install button stays even when a warning is shown; the user decides.
_Avoid_: dry run, summary

**Partly installed**:
The state of a GitOps tool whose CRDs are in the cluster but whose key controllers are not, for example after an install that stopped halfway. It is offered for installation again, which updates the objects it finds. A tool without its optional parts (Argo CD without Dex or notifications, Flux without the helm or notification controllers) counts as installed.
_Avoid_: broken, half-installed (in the interface)

**Tray icon**:
Sextant's icon in the notification area (Windows), the menu bar (macOS) or a StatusNotifier host (Linux), with the menu Show/Hide, About Sextant and Quit. On a Linux desktop without a host there is no icon, and the app behaves as if the tray did not exist.
_Avoid_: taskbar icon, system tray (in the interface)

**Keep in tray**:
The option "Closing the window keeps Sextant in the tray", off by default. With it, closing the window only hides it: connections, port forwards, terminals and the MCP server keep running, and a confirmation question from an agent or an extension brings the window back. Only Quit in the tray menu ends the app. Unavailable, with an explanation, when there is no tray icon.
_Avoid_: minimize to tray, background mode

**About Sextant**:
The dialog in the main window with the version, how this copy was installed (AppImage, deb, rpm, dmg, msi, NSIS, "development build" or "not installed from a release package"), the licence, links, the update check and "Copy version info" for a bug report. It opens from the tray menu and from Settings.
_Avoid_: about window, info page

**Desired ↔ live diff**:
Two columns with differences highlighted for an Application resource: what Argo CD is about to apply and what is in the cluster now (predicted versus normalized live, as in Argo CD). Available after logging in to Argo CD; Secret values are hidden, as everywhere.
_Avoid_: comparison, differences

**Cluster icon**:
The cluster's picture in the rail: an image loaded from disk, or a color with one or two characters or an emoji. Without a user choice it is a color with the name's initials; "Reset icon" brings back such an icon, and the color stays.
_Avoid_: avatar, cluster logo

**Action bar**:
A row of buttons at the top of an object's details panel: Logs, Shell, Port forward, Edit, Delete and the kind's actions. Each button has an icon and a label; when space runs out, buttons wrap whole.
_Avoid_: toolbar, action menu (that is the name of the context menu of a table row)

**Compact button**:
A button of smaller height (28 px instead of 32 px) for table rows and dense lists: the row's "⋮", the port-forward and Helm row buttons, closing a dock tab. Everywhere else it is a standard-size button.
_Avoid_: small button, mini button

**Container tabs**:
The switcher for a pod's containers when there are two or more (init ones included): one container is visible, init containers come first and are marked. The selected tab is not reset by an update of the same pod.
_Avoid_: container list, accordion

**Pod requests and limits**:
How many resources a pod asks for and how many it is allowed, shown next to its consumption. The request is the sum of those set on containers, with a note if it is not set on all of them; the limit is shown only if it is set on every container, otherwise "no limit". Init containers are not summed.
_Avoid_: quota, pod limits (when the sum is meant)

**MCP server**:
A server inside the app that lets an AI agent (Claude Code, Claude Desktop, Cursor) read and change clusters through tools. Off by default; it listens on this machine only, needs the MCP token, and runs only while Sextant is open.
_Avoid_: agent API, AI integration, plugin

**MCP token**:
The secret the agent's client sends to the MCP server. It is created on first enable, hidden in Settings, and can be shown, copied or regenerated; regenerating cuts all connected clients off at once.
_Avoid_: API key, password

**Stdio bridge**:
The command `sextant mcp`, for clients that can only start a program and talk over stdin and stdout. It forwards the client's messages to the running app and does no work itself; without a running app with the server on, it reports that and exits.
_Avoid_: CLI mode, second server

**Agent access**:
What the agent may do in one cluster. Off by default: a cluster the user never opened to agents refuses every call. Set per cluster and shared by all agents. Rules this version does not understand are kept as they are, act as Off, and are shown with a notice and "Reset to Off".
_Avoid_: permissions (bare), AI mode

**Access preset**:
A ready set of rules for agent access: Read-only, Read + write (no delete), Full, or Custom for the user's own rules. Choosing Custom starts from a copy of the preset's rules; the user's own rules are kept when another preset is chosen and come back with Custom.
_Avoid_: role, profile

**Access rule**:
Namespaces, kinds (CRDs and Helm releases included) and actions that a part of agent access or of an extension's permissions covers. A call is allowed if any rule covers it. Resources with no namespace, such as Nodes, are covered only by a rule for all namespaces.
_Avoid_: policy, permission

**Ask before running**:
A switch on an access rule: the agent's modify, delete, exec and port-forward calls (an extension's modify and delete calls) wait for the user to Allow or Deny in the Sextant window, which says who is asking. No answer in 120 s counts as a refusal.
_Avoid_: confirmation mode, approval

**Secret values**:
The action that gives the values of Secrets (and, for the agent, of Helm releases: values and manifest). It is never part of a preset; without it an agent or an extension sees Secrets as the window does, with values hidden. On the install screen an extension that asks for it gets a warning.
_Avoid_: secret access, reveal

**Agent activity log**:
The record of everything agents did through the MCP server: time, client, cluster, tool, target, decision, result and duration. The last 2000 entries are kept between runs; it holds summaries, never values, YAML or command output.
_Avoid_: audit, history

**Node shell**:
A shell on a node, opened through a temporary privileged pod in `kube-system` that is deleted when the shell closes. Leftovers from earlier runs are removed on connect, but only the user's own. Neither the agent nor an extension has a node shell, and neither can run commands in, change or delete such a pod.
_Avoid_: SSH to a node, debug pod

**Cloud source**:
A kubeconfig source made by Sextant from the clusters found through the installed `aws`, `gcloud` or `az` CLI. It is kept in a file of the app's own, authenticates through the CLI, and never changes the user's `~/.kube/config`. Sextant does not sign in for the user; it shows the login command.
_Avoid_: cloud account, cloud connection

**Extension**:
A package of web pages and a manifest that adds its own pages, details sections, actions, table columns, dock buttons and a settings section to Sextant. It runs in an isolated frame, reaches clusters only through Sextant and only within the permissions the user accepted. It has no part that runs on this machine outside the frame.
_Avoid_: plugin (that word is taken by Tauri plugins), add-on, app

**Extension package**:
The folder or the `.sextant-ext` / `.zip` archive of an extension, with `sextant-extension.json` at its root. It is checked before the user is asked anything, and nothing is installed until the user agrees.
_Avoid_: bundle, plugin file

**Contribution**:
One thing an extension adds to the interface, written in its manifest: a page, a details section or tab, an action, a column, a dock button or a settings section. Sextant puts it in place without running the extension's code.
_Avoid_: hook, widget, extension point

**Extension frame**:
The isolated window inside Sextant in which a contribution's content is shown. It cannot touch the rest of the app or the network and talks to Sextant only by messages.
_Avoid_: iframe (to the user), webview, popup

**Extension permissions**:
What an extension asks for in its manifest and what is granted when the user presses Install: which clusters, and rules in the same form as agent access (namespaces, kinds, actions). Nothing outside the grant is possible; asking for more later needs a new agreement.
_Avoid_: scopes, capabilities, access (bare)

**Consent**:
The install screen where the user reads who made the extension, where it came from, what it adds and what it may do in plain words, and presses Install or Cancel. Updating to a version that asks for more brings the screen back.
_Avoid_: approval, confirmation (that is the Allow question while an action runs)

**Developer mode (extension)**:
Loading an unpacked folder: the extension runs straight from the folder, is marked "Development", and reloads when files change. If a change widens its permissions it is paused until the user reviews them.
_Avoid_: debug mode, symlink install

**Extension activity log**:
The record of everything extensions did through the Sextant API: time, extension, cluster, method, target, decision and result. It holds summaries, never values or YAML. Agents have their own log.
_Avoid_: audit, history

