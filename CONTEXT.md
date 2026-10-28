<!-- autopilot:glossary -->
# Sextant

A desktop Kubernetes client for your own clusters: a list of clusters from kubeconfig, resource tables, details, logs, shells into containers, port forwarding, metrics, Helm, Flux and Argo CD in one window.

## Language

**Cluster**:
One entry in the list on the left: one context from kubeconfig, not a separate Kubernetes server. Two contexts on the same server are two clusters.
_Avoid_: connection, server, profile

**Kubeconfig source**:
Where the app gets contexts from: the default path, the `KUBECONFIG` variable, an added file, pasted text, a cloud source or the merged file. One source yields several clusters.
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

**Prometheus-compatible source**:
What charts, history, request metrics and the traffic graph are read from: Prometheus itself or VictoriaMetrics (single-node, or a cluster's vmselect under `/select/<tenant>/prometheus`), found automatically (every Prometheus first) or set as a manual address. Where the docs or the code say "Prometheus" about reading metrics, they mean this.
_Avoid_: TSDB, metrics backend

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

**Image files**:
The files of a container image as the merged tree of its layers, read straight from the registry named in the image reference (ADR-0103): nothing runs in a container and nothing is pulled on a node. A **layer index** is the list of one layer's entries, whiteouts and opaque folders; only indexes are cached, never layer content.
_Avoid_: image pull, container filesystem (that is a running container's files, copied with `kubectl cp`)

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
Sextant's session in the Argo CD HTTP API, needed for the diff. Credentials are looked up in order: saved login → `argocd-initial-admin-secret` (user `admin`) → a Secret labeled `app.kubernetes.io/part-of=argocd` with a `token` key → the login dialog (username/password or an API token). A candidate rejected by Argo CD is not tried again until its source changes, the user signs out or the cluster is closed. "Remember" saves the login in the OS keyring for the (cluster, Argo CD namespace) pair — the cluster is the UID of its `kube-system` Namespace, or the kubeconfig entry when that cannot be read, never the API server URL; the session token lives only in memory. A saved login is also bound to the API server it was saved for (its URL and certificate authority) and to the kubeconfig entry it was saved through, and is offered only to a connection where all of these match. SSO through the browser is not supported.
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

**Terminal tools**:
kubectl, Helm, k9s and kubectx/kubens that Sextant installs into its own folder from the projects' own release sources, after checking their published checksums. Only Sextant's terminals use them: a cluster's terminal gets the kubectl of that cluster's version. A cluster's terminal offers kubectl when it would have none, or one too far from the cluster's version.
_Avoid_: bundled tools, system install

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

**Extension catalog**:
The list of extensions published by others that Sextant offers under Settings → Extensions → Catalog. It is read from one file of a GitHub repository, where each extension was added after a review. The catalog says who publishes an extension and that the package is theirs; it does not vouch for the code. It can be turned off, and then Sextant asks for nothing.
_Avoid_: store, marketplace, registry

**Publisher key**:
The signing key of whoever publishes a catalog extension. Every package from the catalog must be signed with it, and an installed extension is tied to the key it was installed with: an update signed with another key is refused until the user installs the extension again.
_Avoid_: certificate, author key

**Extension backend**:
The part of an extension that runs outside the window: a WebAssembly program Sextant runs in a sandbox when one of the extension's own pages calls it. It reaches clusters only with the extension's permissions, the network only at the hosts the user agreed to, and the credentials the user entered for it; it has no files, no environment and nothing that keeps running between calls.
_Avoid_: plugin process, sidecar, server

**Extension credentials**:
Secrets (an API token, say) that a backend asks for and the user types into Sextant's own form. They stay in the system keyring; only that extension's backend reads them, and Sextant never shows them again.
_Avoid_: secrets (that word is the Kubernetes kind), keys

**Extension activity log**:
The record of everything extensions did through the Sextant API: time, extension, cluster, method, target, decision and result. It holds summaries, never values or YAML. Agents have their own log.
_Avoid_: audit, history

**Listener**:
One port and protocol (and optionally a hostname and a TLS certificate) that a Gateway accepts traffic on. A Gateway has one or more; routes attach to listeners, not to the Gateway as a whole.
_Avoid_: port, endpoint, entry point

**Parent (of a route)**:
The Gateway, and optionally one of its listeners, that a route asks to be attached to. A route can have several parents and each has its own status.
_Avoid_: owner, gateway ref

**Attached / Not attached route**:
A route is attached to a listener when the Gateway's controller accepted it there: the listener allows its namespace and kind and the hostnames overlap. A route that is not attached serves no traffic through that listener, whatever its rules say.
_Avoid_: bound, linked, active

**ReferenceGrant**:
An object in the target's namespace that allows objects of another namespace to refer to it (a route to a Service, a Gateway to a Secret). Without one, a cross-namespace reference is refused.
_Avoid_: permission, allow rule

**Request check**:
A page that answers "where would this request go?" by following a made-up request (method, URL, headers) through listeners, routes, rules and backends from the cluster's own objects and showing why other candidates lost. It sends nothing to the cluster's traffic.
_Avoid_: simulator, test request, probe

**Problem**:
Something wrong with one object that Sextant's rules recognise: a crash-looping or pending pod, a NotReady node, a workload without its replicas or a stuck rollout, a failed Job, a pending claim, an expiring certificate, a failing Flux, Argo CD or Gateway API object, a Warning event. Some count only after a grace period, some stop counting after a while (a past restart). The same rules feed the "Problems" page, the counter on the Cluster section and the notifications.
_Avoid_: alert, issue, error (bare), incident

**Problems page**:
The page "Problems" in the Cluster section, after "Overview": the problems of the open cluster grouped by category and namespace, each a link to its object, with "Only new since…" and the cluster's recent notifications below (every cluster's under "All clusters"). The counter on the section header counts only problems that would notify.
_Avoid_: dashboard, health page, alerts

**Notification**:
A desktop message from the operating system's notification service about a problem that began while Sextant runs, in a connected cluster. Problems already there when the cluster connected are not told; one state is told once; many at once become one summary. Clicking it opens the object. Nothing leaves the machine.
_Avoid_: alert, toast, popup

**Notification category**:
One of the kinds of problems a notification can be about: Nodes, Pods, Workloads, Jobs, Volume claims, Certificates, Flux, Argo CD, Gateway API. Each can be turned off in Settings → General → Notifications. Warning events are a category of the Problems page but never notify.
_Avoid_: notification type, severity

**Mute**:
Stopping notifications without turning them off: "Mute for 1 hour" for all clusters, or a cluster unticked under Notifications, which never notifies. What is muted still goes to the notification history on the Problems page. Turning notifications off is the global switch.
_Avoid_: snooze, silence, do not disturb (that is the system's own)

**Command palette**:
The search box opened with Ctrl+K (Cmd+K on macOS; with Shift inside a text field, terminal or editor): go to a section, a page, a Settings tab or a cluster, find an object of the open cluster by name and open it or run one of its actions.
_Avoid_: spotlight, quick open, global search (bare)

**Merged logs**:
One logs tab with the lines of several pods' containers, each line prefixed with its pod in a stable colour: all pods of a workload, a Service or a label selector (pods appearing later are picked up), or the pods selected in a table. At most 20 streams run at once; the others wait.
_Avoid_: multi-logs, stern, aggregated logs

**Revision (of a workload)**:
One pod template a Deployment, StatefulSet or DaemonSet has run, numbered by Kubernetes and kept in a ReplicaSet or ControllerRevision. The History tab lists them and compares two. Not a Helm release revision.
_Avoid_: version, history entry

**Roll back (a workload)**:
Putting an earlier revision's pod template back, exactly as `kubectl rollout undo` does; the pods are then replaced as for any update, and the result gets a new revision number. A paused Deployment is not rolled back. Helm has its own Roll back for releases.
_Avoid_: revert, undo deployment

**Debug container**:
An extra container started next to a pod's own to look inside it, with an image that has a shell and tools (busybox, netshoot), optionally seeing the processes of one of the pod's containers. It is either an ephemeral container or runs in a debug copy.
_Avoid_: sidecar, debug pod (when an ephemeral container is meant)

**Ephemeral container**:
A debug container added to the running pod itself. Kubernetes never removes one: after its shell ends it stays in the pod, stopped, until the pod is deleted, so each new one is another entry.
_Avoid_: temporary container, sidecar

**Debug copy**:
A copy of a pod, named `<pod>-debug-<random>`, with a debug container and optionally a changed command (to keep a crashing container alive), made without the original's labels so no Service sends it traffic. Sextant deletes it when the tab, the cluster or the app closes; agents cannot run commands in it.
_Avoid_: clone, debug pod, test pod

**File copy**:
Downloading a file or folder from a running container, or uploading one file into it, through `tar` in the container, as `kubectl cp` does. A file arrives as itself, a folder as a `.tar.gz`; the local file appears only when the download is complete. An upload asks first.
_Avoid_: sync, mount, file browser

**Request metrics**:
A workload's or pod's request rate, error rate and latency (p50/p95/p99) over the last 5 minutes and the last hour, from a request-metric source Prometheus has: Istio, Linkerd, ingress-nginx, Grafana Beyla or Cilium Hubble. Each source says what it saw (the ingress only what came through the ingress); an error is HTTP 5xx or a non-OK gRPC status (Linkerd: its own failure classification). Shown in the "Requests" details section with CPU throttling per container.
_Avoid_: golden signals, SLIs, APM

**Request-metric source**:
Something that exports request metrics of workloads to Prometheus, found by asking Prometheus which of a fixed list of metric names it has. Sextant reads what is there; it installs or enables none of them.
_Avoid_: provider, integration, exporter

**Traffic graph**:
The "Traffic" mode of the map: calls between workloads (and Services, and unknown ends) with an end in the chosen namespaces, each line one caller → callee pair with its rate, error rate and latency over the last 5 minutes or hour, from the request-metric sources whose metrics name both ends. An end the source cannot name is an "unknown" node (outside the mesh or unlabelled), never left out. A call a source sees at both ends (Hubble, Beyla) counts once, from the callee's report where there is one; a line carries the busiest source's requests per second, never the sum of two sources seeing the same calls.
_Avoid_: service map, topology, dependency graph

**Right-sizing**:
Comparing each container's requests and limits with what it really used over the last day or 7 days (from Prometheus), with a recommendation and findings per container of a workload. The page is in the Workloads section; Deployments, StatefulSets, DaemonSets and pods have the same rows in their details. Nothing is changed in the cluster: the recommendation is a `resources:` snippet to copy.
_Avoid_: autoscaling, VPA, optimization

**Recommendation (right-sizing)**:
Requests and limits computed from a container's usage history by fixed rules: CPU from the 95th percentile, memory from the peak, each with headroom. Given only with at least 6 hours of history, marked when it rests on less than the window or on history of unknown length; a current value from metrics-server never gives one.
_Avoid_: suggestion, target, optimal size

**Waste**:
How much a container's request is above its recommendation, in CPU and memory; the right-sizing page sorts by it and totals it per namespace.
_Avoid_: idle, unused (usage below the request is not all waste: the recommendation keeps headroom)

**TLS certificate (of a Secret)**:
What the certificate in a Secret's `tls.crt` (and `ca.crt`) says — names, issuer, validity, key, chain, fingerprint — read by the backend, which returns only these fields and never the Secret's values. Shown in the "Certificate" section of the Secret's details and on the "TLS certificates" page of the Config section, only when opened.
_Avoid_: TLS Secret (the object), cert-manager Certificate (a different kind)

**Expiry warning**:
How many days before its expiry a certificate counts as expiring (`notifications.certExpiryDays`, 14 by default), set in Settings → General → Notifications or on the TLS certificates page. The same number decides for cert-manager Certificates on the problems screen and in notifications and for TLS Secrets where they are shown.
_Avoid_: renewal time (that is cert-manager's own `renewBefore`)

**Issuance chain**:
The cert-manager objects of one certificate's issuance, newest first: Certificate → CertificateRequest → Order → Challenge, linked by owner references, shown in the details of each with the step that failed.
_Avoid_: certificate chain (that is the certificates in `tls.crt`)

**Resource map**:
The page "Map" of the Cluster section: the objects of one to three namespaces drawn in columns from the way in (Ingresses, Gateways, routes) to pods, configuration and claims, coloured by the problems screen's rules, with big groups collapsed.
_Avoid_: topology (the Gateway API section's per-Gateway view), graph

**Related objects**:
The "Related" tab of every object's details: the objects it names and the objects that name or select it, one hop both ways and expandable hop by hop, found among the objects Sextant watches for that view.
_Avoid_: dependencies, links (the links inside details are references)

**Deletion impact**:
The "If it is deleted" lines of the Related tab: what deleting the object would delete with it (by owner references), what would recreate it, and what would fail (pods that mount or read it, routes that send traffic to it, pods it schedules or protects), counted from the watched objects.
_Avoid_: blast radius, dry run (nothing is sent to the cluster)

**Permissions (RBAC)**:
The page of the Access Control section that answers who can do what: a subject's effective permissions as a verbs × resources matrix, "Who can" a verb on a resource, and "Can I" for the current user. The first two are computed from Roles, ClusterRoles and their bindings; "Can I" is the API server's own answer.
_Avoid_: roles page, access matrix (the matrix is one part)

**Subject (RBAC)**:
Who a binding grants a role to: a User, a Group or a ServiceAccount. Users and groups are not Kubernetes objects: the page knows those named in bindings, and a user's groups are typed in.
_Avoid_: principal, identity, account

**Can I**:
Asking the API server whether the current user may do something (SelfSubjectAccessReview) or what they may do in a namespace (SelfSubjectRulesReview). The answer takes every authorizer of the cluster into account and is authoritative; asking changes nothing.
_Avoid_: test permissions, dry run

**UI language**:
The language of the window, the tray menu and desktop notifications: "System" (the default, the operating system's language when Sextant has it, otherwise English) or one chosen in Settings → General → Appearance → Language. Kubernetes kinds and API terms stay in English in every language.
_Avoid_: locale (dates and numbers follow the UI language, not a separate locale setting)

**Change preview**:
What the API server would store if a change were sent, next to the live object: shown before the editor's Save, an apply in "Create resource", and a Helm upgrade or install. It comes from a server-side dry run (`dryRun=All`), so defaulting, admission webhooks and validation are included; nothing is changed. Secrets are shown without values; which of their keys would change is named.
_Avoid_: diff (alone), plan, simulation

**Preview changes before applying**:
The per-cluster setting (cluster settings → "Change preview") that makes the change preview a step of every save, apply and Helm upgrade or install on that cluster. When the user has not chosen, it is on for clusters whose name, context or kubeconfig cluster name contains "prod" or "production" as a word.
_Avoid_: safe mode, production mode

**Dry run (agent)**:
An `apply_yaml` or `patch_resource` call with `dryRun: true`: checked against the agent's access rules like the change itself but never confirmed in the window, sent with `dryRun=All`, journaled as "(dry run)". Touching a Secret needs "Secret values", and the answer never says whether a Secret value differs.
_Avoid_: test run, simulation

**Upgrade readiness**:
The page of the Cluster section that lists, for a chosen target Kubernetes version, the deprecated or removed API versions still in use (with where each use comes from: the object itself, a Helm release, Argo CD, Flux), the deprecated versions the cluster still serves, and version skew problems. Read-only.
_Avoid_: upgrade check, preflight

**Deprecation table**:
The list of deprecated and removed Kubernetes API versions built into Sextant (`src/features/upgrade/deprecations.json`), copied from the Kubernetes deprecation guide and reviewed for every Kubernetes release. The page says up to which version it covers.
_Avoid_: deprecation feed, database

**Trace of an old write**:
An API version a live object names only in its last-applied annotation or its field managers while the cluster no longer serves it: the object was once written in that version, which breaks nothing now. Hidden unless "Show traces of old writes" is on.
_Avoid_: stale usage, false positive

**Version skew**:
How far apart the versions of the control-plane components and of the nodes' kubelet and kube-proxy are, judged by the Kubernetes version skew policy now and for the target version.
_Avoid_: version drift, mismatch

**Security posture**:
How workloads measure against the Pod Security Standards: the "Security" page of the Cluster section and the "Security" tab of a workload's or Pod's details, with findings per field, a suggested fix to copy, and what each namespace's Pod Security labels would do. Read-only.
_Avoid_: security score, compliance

**Pod Security Standards (Baseline, Restricted)**:
The Kubernetes policies Sextant checks workloads against, as Pod Security Admission reads them: Baseline forbids known privilege escalations, Restricted adds hardening. A workload "meets Restricted", "meets Baseline" or "violates Baseline".
_Avoid_: PSP (PodSecurityPolicy was removed), security policy

**Hardening hint**:
Good practice that is not part of the Pod Security Standards (a read-only root filesystem, requests and limits, a pinned image, no mounted service account token): shown with the findings, never counted as a violation.
_Avoid_: warning, violation

**Added at admission**:
A violation a running Pod has but its owner's pod template does not, because an admission webhook or policy changed the Pod when it was created (an injected sidecar or init container). Reported on the owner, without a fix.
_Avoid_: drift, injected violation

**Trivy reports**:
The vulnerability, configuration audit, exposed secret, RBAC and other reports Trivy Operator stores in the cluster, shown in the Trivy section and in a workload's "Image scans (Trivy)" details. Sextant only reads them; it neither installs Trivy nor starts a scan.
_Avoid_: scan results (Sextant does not scan), CVE list

**Opt-in category**:
A problem category that is off until the user turns it on (now only "Security": Baseline violations), in one setting shared by the problems screen ("Security findings") and Settings → Notifications. While off, nothing is watched for it.
_Avoid_: hidden category, beta category

**All clusters**:
The overview of several clusters, opened from the top of the cluster rail: a health card per selected cluster, Pods, workloads and Warning events across them, and "Find by name". It connects a cluster only when the user clicks "Connect" or "Connect all selected".
_Avoid_: fleet (the code's name, not the interface's), dashboard, multi-cluster view

**Selected clusters (All clusters)**:
The clusters the overview shows, at most 10, kept in the settings. Selecting a cluster does not connect it.
_Avoid_: favourite clusters, pinned clusters

**Change timeline**:
What changed in a cluster, when and by whom: the page "Timeline" of the Cluster section and the "Changes" tab of an object's details. Sextant records changes of the objects its open views already watch while it is connected; it never opens a watch only to record. Read-only.
_Avoid_: audit log (Sextant does not read the API server's audit log), history, event log

**Recorded change**:
One entry of the change timeline: an object created, changed (with the fields that changed, values clipped) or deleted, as Sextant saw it. A Secret's change names its keys, never values.
_Avoid_: event (an Event is a Kubernetes object), diff (alone)

**Seen later**:
A recorded change of an object nothing watched for a while: Sextant noticed it when the object was listed again, so it was made at some time before.
_Avoid_: late event, delayed change

**History before Sextant (partial)**:
What the cluster itself keeps from before Sextant was running: the last change of each field manager of each object, rollout revisions and Helm release revisions. Marked "Partial": earlier changes by the same manager, and anything else, are not known.
_Avoid_: full history, audit

**Changed by (field manager)**:
Who made a recorded change, named by the field managers whose time moved; "Probably by" when none moved and the most recent writer is named instead. A field manager is a program name (`kubectl-client-side-apply`, `helm`, `sextant`), not a person.
_Avoid_: author, user

**Keep between restarts (timeline)**:
The setting (`timeline.persist`, off by default) that saves each cluster's recorded changes in a file on this computer and loads them at the next start. Turning it off removes the files.
_Avoid_: timeline sync, export

**Autoscaling insights**:
Why something did or did not scale, in details sections: an HPA's scaling decision, the workload an HPA or ScaledObject scales, a Pending Pod's "Why the Pod is not scheduled", and what KEDA, Karpenter and Cluster Autoscaler decided. Read-only.
_Avoid_: autoscaling advisor, recommendations (that is right-sizing)

**Scaling decision (estimate)**:
The replicas an HPA's metrics ask for, computed with the HPA controller's formulas (ratio to target, tolerance, the largest proposal, min/max, the behavior's step limits). An estimate: the controller also counts only ready pods and stabilizes over a history Sextant does not see.
_Avoid_: prediction, simulation

**Tolerance (HPA)**:
How far a metric may be from its target before an HPA changes the replica count: 10 % by default, or the behavior's own tolerance where the cluster supports it.
_Avoid_: threshold, deadband

**Why the Pod is not scheduled**:
A Pending Pod's details section: the scheduler's FailedScheduling message as reasons with node counts, a check of the pod against the nodes filter by filter (what it does not check is listed), and what Karpenter or Cluster Autoscaler did about it.
_Avoid_: scheduling simulation

**Cleanup**:
The page of the Cluster section with objects that look unused or left over, each with the reason and what deleting it would touch, and a bulk deletion that checks each object again right before deleting it.
_Avoid_: hygiene (the code's name, not the interface's), garbage collection, prune

**Cleanup candidate**:
An object the Cleanup page offers for deletion: every list that could name it was read in full, nothing names it, it is old enough for its rule, and no tool manages it. When in doubt, an object is not a candidate.
_Avoid_: orphan, garbage, unused (alone)

**Not offered (managed, kept on purpose)**:
Objects that look unused but are shown without a checkbox: those Helm, Flux, Argo CD or another `app.kubernetes.io/managed-by` tool manages ("remove them through the tool"), and Released volumes with reclaim policy Retain.
_Avoid_: ignored, whitelisted

**Namespace sample**:
A metadata-only look at every kind a namespace holds (at most 5 names per served kind), taken when the Cleanup page opens or on "Check again". A namespace whose sample shows an object of a custom kind the page does not read is "blocked": its ConfigMaps, Secrets and claims are not judged, since that object may name them.
_Avoid_: scan, inventory

**Connectivity check**:
"Can this source reach this destination on this port?" answered from the policy objects in the cluster (NetworkPolicy, and Cilium and Calico policies as far as they map to L3/L4 rules) on the page "Connectivity" of the Network section: Allowed, Denied or Unknown, with the policies that decide for each side. Not a test of live traffic.
_Avoid_: ping, probe, reachability test

**Unknown (connectivity)**:
The answer when the objects cannot decide: an unreadable list, an `ipBlock` holding a pod IP, a feature Sextant does not model (L7, FQDN, tiers), or a policy kind it does not evaluate. Never rounded up to "Allowed".
_Avoid_: maybe allowed, partial

**Isolated (for ingress / egress)**:
A pod some policy of that direction selects: only what such a policy allows may reach it (or leave it). A pod no policy selects is not isolated and allows everything in that direction.
_Avoid_: protected, locked down

**Unevaluated policy kind**:
A policy kind the cluster serves that the connectivity check does not evaluate (AdminNetworkPolicy, BaselineAdminNetworkPolicy, ClusterNetworkPolicy, Antrea, OVN-Kubernetes, GKE FQDN policies). Its objects make answers in their namespace, or everywhere when cluster-wide, "Unknown".
_Avoid_: unsupported CNI, ignored policy

**Saved view**:
A resource table saved under a name: its kind, namespaces, search text, "Only problems", label selector, sort and visible columns, for one cluster or for all clusters. Opened from the sidebar, the command palette or a pin. Kept in the settings.
_Avoid_: filter, bookmark, query

**Pin (favourite)**:
One object or one saved view put on the "Favourites" strip above the sidebar of a cluster. Pinning changes nothing in the cluster.
_Avoid_: bookmark, star

**Workspace**:
A named set of clusters ("prod", "staging"). The active workspace filters the cluster rail and the views and pins offered; switching never connects or disconnects a cluster. Not a Kubernetes namespace and not a kubeconfig.
_Avoid_: project, environment, profile

**Export file (views)**:
A JSON file (`sextant-workspace`, version 1) with views, pins, workspaces and clusters by reference (kubeconfig source path and context name) plus their shareable settings; agent access rules only when ticked. It never carries kubeconfig contents, credentials, tokens or extensions. Importing it shows a preview first.
_Avoid_: backup, settings dump

**Exact match / name match (import)**:
How an imported cluster is found on this computer: exact — the same id, or the same kubeconfig path and context; name — only the context name is the same, so it may be another cluster. Agent access rules are applied only on an exact match.
_Avoid_: same cluster

**Writable source**:
A kubeconfig source Sextant may change: its own files (pasted, cloud, merged) always, any other file only after "Allow Sextant to edit" in Settings → Clusters (off by default). Enforced by the backend.
_Avoid_: editable config, managed kubeconfig

**Kubeconfig edit**:
A change Sextant makes to a kubeconfig file: rename a context, set its default namespace, duplicate it with another namespace, delete it, or merge files. Always previewed, confirmed, backed up and written atomically; refused with "conflict" when the file changed after the preview.
_Avoid_: kubeconfig sync, config update

**Merged file**:
Sextant's own kubeconfig file `merged.yaml` in its data directory, into which chosen kubeconfig files are copied (taken names get `-2`, `-3`; relative paths made absolute). The chosen files are not changed.
_Avoid_: combined kubeconfig, flattened config

**Kubeconfig backup**:
The copy `<file>.bak-<UTC time>` made before every kubeconfig edit, next to the real file (after symlinks), mode 0600. Sextant keeps its newest five per file and never touches other files.
_Avoid_: snapshot, history

**Credential expiry**:
When a context's credentials stop working, as far as the kubeconfig tells without running anything: a client certificate's end date, a JWT token's or an OIDC id-token's `exp`. For exec plugins and auth providers only the program is named. Shown as a badge on the rail; notifications only through the opt-in "Credentials" category.
_Avoid_: session timeout, login expiry

**Kubeconfig check**:
The offline check of a kubeconfig being added, per context: YAML, references, server URL, certificates, named files, the exec program in `PATH`, expired credentials. The server is contacted only on "Check connection".
_Avoid_: lint, connection test

**Schema (editor)**:
The cluster's own description of a kind's fields (from its OpenAPI v3), used by the YAML editor for completion, problems, hover and Explain. Sextant reads it from the cluster, keeps a compact form, and sends the editor only the one kind it edits. Without it the editor is the plain editor.
_Avoid_: OpenAPI spec, swagger, validation rules

**Explain**:
The editor's panel with the documentation of the field at the cursor and its child fields, like `kubectl explain`; opened with F1 or the "Explain" button of the hover.
_Avoid_: help, docs panel

**Problem (editor)**:
An editor marking where the text disagrees with the schema: an unknown field, a wrong type, a missing required field, a value not allowed, a YAML error. Advice only; the cluster's answer decides.
_Avoid_: error, lint, validation failure

**Volume usage**:
How full a PersistentVolumeClaim is: used = capacity − available (blocks reserved by the file system count as used), and likewise for inodes. Read from the kubelets through the API server, or from Prometheus when that is not allowed.
_Avoid_: disk usage, PV usage, fill rate

**Disk almost full**:
The opt-in problems category for claims at or over the warning (85 %) or critical (95 %) level of bytes or inodes; the levels are set in Settings → Notifications.
_Avoid_: low disk, storage alert

**Volume snapshot**:
A VolumeSnapshot object: a point-in-time copy of a claim made by the CSI driver. "Restore to a new PVC" always creates a new claim; an existing claim is never overwritten.
_Avoid_: backup, PV snapshot

**Velero backup / restore**:
Velero's Backup and Restore objects. Sextant creates one only from its form after a confirmation and only as a new object; it never runs the `velero` program.
_Avoid_: snapshot, dump

**Create-only**:
A change that only makes a new object and fails with "already exists" if one of that name is there, so nothing existing is modified (unlike Apply). Used by the storage actions.
_Avoid_: apply, upsert

**Cost (OpenCost / Kubecost)**:
What a namespace, workload, Pod, node or label value cost over the last 24 hours, 7 or 30 days, as the cluster's OpenCost or Kubecost computes it, split by CPU, memory, storage, network, GPU and other. Sextant only reads it; it never installs either.
_Avoid_: billing, spend, invoice

**Alert**:
A firing or pending alert of the cluster's alerting rules, read from its Prometheus-compatible source (vmalert for VictoriaMetrics) and its Alertmanager, never evaluated by Sextant. Its state is firing, pending (Prometheus only), silenced or inhibited (Alertmanager only); it is shown on the object its labels name (ADR-0119).
_Avoid_: notification (that is Sextant's own desktop message), problem (an alert becomes one only in the opt-in `alerts` category)

**Silence**:
An Alertmanager rule that mutes alerts matching its matchers for a time. Sextant lists active and pending ones and never creates or expires one.
_Avoid_: mute (Sextant's own "Mute for 1 hour" is for notifications)

**Idle cost**:
The cost of node capacity no workload used. It belongs to the whole cluster, also when namespaces are filtered.
_Avoid_: waste, unallocated

**Monthly estimate / estimated savings**:
A workload's cost over the time it ran in the last 7 days scaled to 30 days; and what lowering its requests to the right-sizing recommendation would save at its own unit prices. Both are estimates.
_Avoid_: forecast, budget

**Pane**:
One of the split parts of a terminal tab, with its own shell session (local, container, node or debug). At most 8 per tab.
_Avoid_: split, window, sub-tab

**Snippet**:
A saved command with a name, typed into the focused pane by "Insert" (without Enter) or "Run" (with Enter). Saved in the settings and exported with views unless left out.
_Avoid_: macro, alias, script

**Placeholder (snippet)**:
`{{namespace}}`, `{{pod}}`, `{{container}}`, `{{cluster}}` or `{{context}}` in a snippet, filled from the focused pane and quoted for its shell. A snippet whose placeholder the pane cannot fill or quote safely is not available there.
_Avoid_: variable, parameter

**Broadcast input**:
Typing into several chosen panes at once. Off by default, needs at least two panes, asks for a confirmation on the first keystroke and drops what was typed before it; ends when any of its panes closes.
_Avoid_: sync panes, multi-exec

**Service mesh (Istio / Linkerd)**:
The "Istio" and "Linkerd" sidebar sections, shown when the cluster serves their kinds, and the "Service mesh" section of a Pod or workload. Sextant only reads the objects; it never asks istiod or a proxy.
_Avoid_: mesh dashboard, Kiali

**In the mesh (membership)**:
Whether a Pod runs a mesh proxy (an Istio sidecar or native sidecar, Istio ambient mode, a Linkerd proxy), which revision, and whether injection is on for it or its namespace. "Restart needed" means injection is on but the running Pod has no proxy.
_Avoid_: injected (alone), meshed

**Request routing (mesh)**:
The page that explains, from VirtualServices, Gateways and DestinationRules, where one request (URL, method, headers, from a workload or through a Gateway) would go: the matched route, the weighted destinations and their pods. An answer from objects, not from the proxies.
_Avoid_: traffic trace, live routing

**Who may call this workload?**:
The answer of Istio AuthorizationPolicies for one caller (namespace, service account, method, path, port, IP): allowed, denied, up to the external authorizer, or "Cannot tell" when a condition cannot be evaluated. Never "allowed" when unsure.
_Avoid_: access check, RBAC

**Dry-run policy**:
An AuthorizationPolicy annotated `istio.io/dry-run: "true"`: shown with what it would do, but not counted in the answer, as Istio does not enforce it.
_Avoid_: disabled policy

**mTLS mode**:
STRICT, PERMISSIVE or DISABLE for a workload (and per port), from PeerAuthentications: the workload's own, else its namespace's, else the mesh-wide one in `istio-system`, else PERMISSIVE.
_Avoid_: TLS setting, encryption

**Compare with…**:
Putting an object next to another object of its kind (another cluster or namespace, or another name), its last-applied configuration, or its Helm release's manifest, after removing what the server writes. Read-only; a cluster that is not connected is connected only by the user's click.
_Avoid_: diff (alone), sync

**Compare namespaces**:
Two (cluster, namespace) sides compared kind by kind: only on the left, only on the right, different, same.
_Avoid_: namespace sync, mirror

**Drift**:
A field that the desired side (last-applied configuration or Helm manifest) sets and the live object has otherwise. Fields the server or controllers add are not drift.
_Avoid_: difference (for drift), out of sync (that is GitOps)

**Ignored path**:
A field path, per kind, left out of every comparison (`/spec/replicas`, `/metadata/annotations/*`). Saved in the settings.
_Avoid_: exclude, filter

**Same value / different value (Secret)**:
How two Secret keys compare when their values are hashed inside Sextant; neither values nor hashes reach the window until "Show values".
_Avoid_: equal hash, decrypted

**List in parts**:
A table's first list shown page by page while the API server is still sending it ("Loading… N so far").
_Avoid_: lazy loading, pagination

**Table limit (20 000 objects)**:
The most objects one table keeps; the rest are counted, and the table says "Showing the first N of M" and how to narrow the list.
_Avoid_: truncation, page size

**Large list warning**:
The question a table asks before listing more than 10 000 objects of a kind in all namespaces; "Show anyway" is remembered until restart.
_Avoid_: count guard (in the interface), limit

**Server-side filter**:
Label terms (`app=web`) and supported field terms (`status.phase=Running`) of a table's search, sent to the API server as selectors so only matching objects are listed.
_Avoid_: query, server search

**Shared watch**:
One watch of a cluster, kind, namespaces and selectors that every view showing that list uses at the same time.
_Avoid_: cache, duplicate watch

**Modal stack**:
The open dialogs in the order they opened; only the top one takes the keyboard. The agent and extension confirmation stays on top while shown.
_Avoid_: dialog queue, popup layer

**Approval delay**:
The moment after an agent or extension confirmation appears during which "Allow" ignores the keyboard (1 s) and clicks (300 ms), so a keystroke meant for something else cannot approve it. "Deny" works at once.
_Avoid_: cooldown, lockout

**Leave the terminal (Ctrl+Shift+E)**:
The one key a terminal never takes: it moves the focus to the terminal's dock tab, so keyboard users can get out of a shell.
_Avoid_: escape key, focus trap

**Claim / composite resource / managed resource (Crossplane)**:
A claim is the namespaced request a team writes; Crossplane binds it to a composite resource (`resourceRef`), whose Composition creates managed resources (`resourceRefs`), each one object of a cloud API. Their kinds are defined at run time: claims and composites by the XRDs, managed resources by the providers. "Synced" says Crossplane can reconcile it; "Ready" says the thing exists and works.
_Avoid_: instance, XR request

**Policy result (Kyverno)**:
One rule of one policy judged against one object: pass, fail, warn, error or skip, as written in the object's PolicyReport. A failing result is a problem only in the opt-in category `policies`; an `error` result (the rule could not be evaluated) is listed there too, never notified.
_Avoid_: violation event, audit log

**Promote / abort / retry (Argo Rollouts)**:
What `kubectl argo rollouts` does to a paused or failing Rollout, by patching its spec and status: promote moves it past its pause to the next step (fully: skips every remaining step and analysis), abort sends all traffic back to the stable ReplicaSet and leaves it Degraded, retry starts an aborted update again.
_Avoid_: resume, rollback, undo (that is `kubectl rollout undo`, ADR-0068)

**Workflow node (Argo Workflows)**:
One step of a Workflow as its status records it (`status.nodes`): a pod, a container of a container set, a DAG task group, a steps group, a retry or a skipped step. Pod nodes run in pods named by the Workflow's pod-name format; the failed step is the first pod node that failed.
_Avoid_: task (only DAG nodes are tasks), job

**Mirror (Reflector)**:
A Secret or ConfigMap that emberstack Reflector keeps as a copy of another one, its source, named by the annotation `reflector.v1.k8s.emberstack.com/reflects` (`namespace/name`). Automatic when Reflector created it (`auto-reflects`), manual when someone did. In sync when its `reflected-version` is the source's resourceVersion; stale when not; Sextant never compares values (ADR-0110).
_Avoid_: replica, clone, synced copy

**Management cluster / workload cluster (Cluster API)**:
The management cluster holds the Cluster API objects (Cluster, Machine, …) that describe and build other clusters; a workload cluster is one of those built clusters, reached at the Cluster's `spec.controlPlaneEndpoint`. A Machine's `nodeRef` names a Node of the workload cluster, not of the cluster Sextant is looking at. Sextant opens the workload cluster only when a configured cluster's server is that endpoint, and only on a click (ADR-0113).
_Avoid_: child cluster, target cluster, managed cluster (that is a Crossplane/Argo CD word)

**Stuck machine (Cluster API)**:
A Machine still Pending, Provisioning or Provisioned 30 minutes after its phase last changed (`status.lastUpdated`): a problem of the `clusterApi` category, explained by its first unmet condition (BootstrapConfigReady, InfrastructureReady, NodeReady). Not the same as a MachineHealthCheck's verdict, which follows its own timeouts.
_Avoid_: hung machine, failed machine (Failed is a terminal failure the controllers report)

**Head / worker (KubeRay)**:
The two kinds of pod of a RayCluster: one head (the GCS, the dashboard, the job submission endpoint) and the workers of its worker groups, each group with its own replicas and bounds. Told apart by the pod label `ray.io/node-type`, grouped by `ray.io/group`. The words stay as Ray writes them.
_Avoid_: master, driver (a driver is the process of a Ray job)

**Submitter Job (KubeRay)**:
The batch Job KubeRay creates, with the RayJob's own name, to run `ray job submit` against the RayCluster in the default `K8sJobMode`; other submission modes have none.
_Avoid_: runner, launcher

**Serving runtime choice (KServe)**:
The ServingRuntime or ClusterServingRuntime KServe uses for an InferenceService's predictor: the one named in `model.runtime`, else the first that fits the model's format and protocol, namespace runtimes before cluster runtimes, ordered as KServe orders them (ADR-0115).
_Avoid_: server, backend, engine

**Update mode (VPA)**:
When a VerticalPodAutoscaler's recommendation reaches pods (`spec.updatePolicy.updateMode`, `Recreate` when unset): `Off` only recommends, `Initial` sets resources when a pod is created, `Recreate` (and its deprecated name `Auto`) also lets the updater evict running pods far from the recommendation, `InPlaceOrRecreate` and `InPlace` resize running pods in place. The request a new pod gets is the recommendation's target; its limit keeps the template's ratio of limit to request unless `controlledValues` is `RequestsOnly`.
_Avoid_: policy (that is `resourcePolicy`, per container), auto mode (deprecated)

**VPA–HPA conflict**:
A VPA that changes running pods and an HPA that scales the same workload on a CPU or memory metric the VPA controls: raising the request lowers the HPA's utilization, so the two fight. Judged from the two objects; a VPA on one resource beside an HPA on the other is no conflict.
_Avoid_: overlap, double scaling

**Workload (Kueue)**:
Kueue's record of one job's claim on quota: the pod sets and their requests, the LocalQueue it was submitted to and, once admitted, the ClusterQueue and flavors it got. Kueue makes one per job (labelled with the job's uid) and the job runs only while its Workload is admitted. Not a Kubernetes workload (a Deployment, StatefulSet, …): Sextant writes "Workload" with a capital W for Kueue's kind.
_Avoid_: job (that is the owner), task

**Quota reservation / admission (Kueue)**:
Two steps of a Workload: quota is reserved in a ClusterQueue (QuotaReserved), then, when its admission checks pass, it is admitted (Admitted) and the job is unsuspended. A Workload waiting for quota is pending; one whose LocalQueue or ClusterQueue is missing is inadmissible; an evicted one gave its quota back and waits again (ADR-0114).
_Avoid_: scheduled (that is the kube-scheduler placing pods), approved

**Replicated job (JobSet)**:
One entry of a JobSet's `spec.replicatedJobs`: a Job template and how many Jobs of it (`replicas`) the JobSet keeps, named `<jobset>-<replicated job>-<index>`. The JobSet's success and failure policies count these Jobs; a restart recreates them (`restart-attempt` label).
_Avoid_: job group, replica set

**Resource claim / allocation (DRA)**:
A ResourceClaim asks for devices (GPUs, NICs, accelerators) by device class and CEL selectors; a pod names it, or a template from which the resource claim controller makes one per pod. Allocation is the scheduler picking devices of ResourceSlices for it (`status.allocation`), done when it places the first pod that uses the claim; reservation (`status.reservedFor`) is the pods allowed to use them. A pending claim is one with no allocation yet (ADR-0116).
_Avoid_: device request (a request is one entry of a claim), binding (a binding condition is a later, driver-side step)

**Resource slice / pool (DRA)**:
What a driver publishes about its devices: a ResourceSlice lists devices with attributes and capacity, reachable from one node, every node or a node selector; the slices of one driver and pool together describe the pool. A device is named `driver/pool/device` across slices and claims.
_Avoid_: inventory, node devices

**Component (NVIDIA GPU Operator)**:
One operand the ClusterPolicy deploys as a DaemonSet in the operand namespace: the driver, the container toolkit, the device plugin, DCGM and its exporter, GPU Feature Discovery, the MIG manager, the node status exporter, the validator and the sandbox ones. Enabled by its spec block (else the operator's default); rolled out when every scheduled pod of its DaemonSet is ready and updated (ADR-0116).
_Avoid_: plugin (the device plugin is one component), addon

**MIG configuration (NVIDIA GPU Operator)**:
How a node's GPUs are partitioned into MIG instances: the profile set named by the node label `nvidia.com/mig.config`, applied by the MIG manager, which writes the outcome to `nvidia.com/mig.config.state` (pending, rebooting, success, failed). The MIG strategy (`spec.mig.strategy`: none, single, mixed) decides whether the instances show as `nvidia.com/gpu` or as `nvidia.com/mig-<profile>` resources.
_Avoid_: MIG mode (the GPU's own switch), partition layout

**Link template (Grafana and traces)**:
A URL per cluster and target (workload, pod, node, namespace, traffic edge, trace search) with `{variable}` placeholders filled from the object at the click, under the cluster's Grafana or traces base URL and never leaving its origin. Sextant only opens the result in the browser (ADR-0117).
_Avoid_: integration, data source (Sextant reads nothing from Grafana)

**Lines from Loki**:
Log lines of a container read from the cluster's Grafana Loki instead of the kubelet: for a pod that is gone, or for runs older than the one the live view shows. They end where the shown run began, carry a "Loki" mark and are read only by the stream selector Sextant builds (ADR-0118).
_Avoid_: history, archived logs (Loki keeps what its retention keeps, nothing more)
