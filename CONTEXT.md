<!-- autopilot:glossary -->
# Sextant

A desktop Kubernetes client for your own clusters: a list of clusters from kubeconfig, resource tables, details, logs, shells into containers, port forwarding, metrics, Helm, Flux and Argo CD in one window.

## Language

**Cluster**:
One entry in the list on the left: one context from kubeconfig, not a separate Kubernetes server. Two contexts on the same server are two clusters.
_Avoid_: connection, server, profile

**Kubeconfig source**:
Where the app gets contexts from: the default path, the `KUBECONFIG` variable, an added file or pasted text. One source yields several clusters.
_Avoid_: config, kubeconfig file

**Failed source**:
A kubeconfig source that could not be read or parsed. Its clusters do not appear, the others keep working; the error is shown next to the source in the cluster rail and in Settings, not only on the "no clusters" screen.
_Avoid_: broken config, skipped file

**Cluster rail**:
The column on the left with the list of clusters: each has its own icon and a connection state dot. A button at the bottom expands the rail to show names next to the icons; the choice is remembered and applies in a narrow window too.
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
The content of a tree item that is not a table of one kind: overview, events, Helm, Port Forwarding, settings.
_Avoid_: screen, tab

**Details panel**:
The panel that slides out on the right for the selected object: metadata, kind fields, events, YAML.
_Avoid_: inspector, side panel

**Dock**:
The bottom area with tabs: logs, a shell into a container, a local terminal, creating and editing YAML. A terminal is just one of the dock tab types.
_Avoid_: console, bottom panel, terminal

**Port forward**:
A local port on this machine connected to a pod or service port in the cluster. Bound to 127.0.0.1 only.
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
A settings file that could not be read or parsed. The app copies it to `settings.json.bak-<time>` and starts with defaults; when access is denied, writing is disabled and the settings live until the window is closed. The window shows a banner with the path.
_Avoid_: settings reset

**Layer**:
A stage of the feature set, not an architectural layer: layer 1 is the core of the functionality, layer 2 is metrics, port-forward and Helm. Both layers are in the build.
_Avoid_: level, phase, iteration

**Core**:
The part of the app that knows everything about clusters and nothing about the window. Not to be confused with the word "core" in "layer 1 — the core of the functionality".
_Avoid_: backend, service

**GitOps section**:
The "Flux" or "Argo CD" section in the tree on the left. It appears only if the tool is found by CRDs in discovery: for Flux, at least one `*.toolkit.fluxcd.io` group; for Argo CD, the Application from `argoproj.io`. Kinds that are not in the cluster are not in the section; the section also appears without reconnecting if the tool was installed while the connection was open.
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
Sextant's session in the Argo CD HTTP API, needed for the diff. Credentials are looked up in order: saved login → `argocd-initial-admin-secret` (user `admin`) → a Secret labeled `app.kubernetes.io/part-of=argocd` with a `token` key → the login dialog (username/password or an API token). A candidate rejected by Argo CD is not tried again in this app session until its source changes. "Remember" saves the login in the OS keyring for the (cluster, Argo CD) pair; the session token lives only in memory. SSO through the browser is not supported.
_Avoid_: authorization, sign-in, connection to Argo CD

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
