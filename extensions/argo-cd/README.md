# Argo CD

[Argo CD](https://argo-cd.readthedocs.io) in Sextant, in every language Sextant has: Applications, ApplicationSets
and AppProjects in a sidebar section of their own with Sextant's tables, the resources each application manages with
their health, the sync history, Sync, Refresh, Terminate, the diff of desired and live states from Argo CD's API,
and the Argo CD UI. It does what Sextant's built-in Argo CD view did, through the public extension API only. Its id
is `sextant.argo-cd`. Why it is built this way: ADR-0024 to ADR-0032 (the built-in view it reproduces: changes
through the Kubernetes API only, the API reached through a port forward, sign-in from the admin Secret, the choice
of the installation), ADR-0139 (Sextant's own extensions), ADR-0140 (its translations), ADR-0152 to ADR-0154
(kinds, computed columns, action conditions), ADR-0156 (port forwards and links), ADR-0158 (requests to a Service,
sessions kept by Sextant), ADR-0160 (its own section, palette names, the UI kit, Sextant's sign-in dialog) and
ADR-0161 (columns by id and with a case's tone, Services by label, the Secret key a service receives, token sign-in,
several patches under one confirmation, hidden empty sections) and its amendments of 0.30 (fixed-patch actions, Secrets
a service receives by label, credentials a service refused not sent again).

## At a glance

| | |
|---|---|
| Id | `sextant.argo-cd` |
| Version | 1.2.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `argo-cd-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Argo CD |
| Checked against | The objects of Argo CD v3.5.5 (the fixtures of Sextant's built-in view, `fixtures/`) and Argo CD's API `/api/v1/session` and `/api/v1/applications/<name>/managed-resources` |

## What it adds

**A sidebar section "Argo CD"** (`argocd`), with Argo CD's icon, right after Sextant's Velero section (where the
built-in one was), shown while the cluster serves one of its kinds, with Sextant's own tables (filters, selection,
search, saved views, custom columns): **Applications**, **ApplicationSets** and **AppProjects** (`argoproj.io`). The
section's counter shows how many Applications have a problem of the rules below. The command palette searches
Applications without being asked and takes `app` and `apps` as their short names (`app guestbook`), as before.

**Columns:**
- Applications:
  - **Project** (`project`);
  - **Sync** (`sync`): Synced, OutOfSync or Unknown, coloured; "Syncing" while an operation runs, with the
    operation's message as a tooltip;
  - **Health** (`health`): Healthy, Progressing, Degraded, Suspended, Missing or Unknown, coloured, the health message
    as a tooltip;
  - **Revision** (`revision`): the synced revision (the first source's for a multi-source app);
  - **Destination** (`destination`): the destination cluster's name, `in-cluster` for Argo CD's own cluster, else
    its server address;
  - **Target namespace** (`target-namespace`).
- ApplicationSets: **Applications** (`applications`), how many it generated (`status.resourcesCount`, else its
  listed resources).
- AppProjects: **First destination** (`first-destination`, its namespace as a tooltip) and **First source**
  (`first-source`).

Each column follows the one it names by id (`afterColumn`), so the order is the same in every language. The CRDs' own
printer columns are left out of the three tables (`printerColumns: false`): these replace them, as the built-in
tables had them.

**Details**, after Sextant's generic metadata:
- **Argo CD** (`fields`, a section, on all three kinds):
  - an Application's project (a link), sync, synced revisions, health with its message, the last operation with its
    message and times, sources, destination (its namespace a link when it is this cluster), sync policy and options,
    when it was last compared;
  - an ApplicationSet's generators, health, project, sources, destination and the applications it generated
    (links);
  - an AppProject's description, source repositories, destinations and the allowed and denied resources and roles.
- **Resources** (`resources`, a section of Applications): every resource the application manages with its sync and
  health, and below each what it owns (Deployment → ReplicaSet → Pod, StatefulSet/DaemonSet/Job → Pod, CronJob →
  Job), found by owner references. Every row opens its object. Argo CD 3.x keeps a resource's health only in its own
  API, so for Deployments, StatefulSets, DaemonSets, ReplicaSets, Pods, Jobs, claims, Services and Ingresses the
  extension computes it from the live object the way Argo CD's built-in checks do (marked so in a tooltip). An app
  deploying to another cluster is listed without links or descendants.
- **Sync history** (`history`, a section of Applications): each sync's id, revision, time, who started it
  ("Automated" for the controller) and source.

The Resources and Sync history sections hide themselves, title included, while an Application has none (as the
built-in view showed nothing then). The blocks are drawn with the SDK's UI kit, so they look like Sextant's own
details.

**Actions on Applications:**
- **Sync…** (`sync`, a button): revision (the target revision by default; each source's own for a multi-source app),
  Prune, Dry run. Offered only while no operation runs.
- **Refresh** (`refresh`, a button) and **Hard refresh** (`hard-refresh`), on one or several selected Applications:
  one click, as in the built-in view. They open no window and ask nothing: the patch is fixed in the manifest, and
  Sextant sends it itself (up to 50 at a time).
- **Terminate…** (`terminate`): stops the running operation. Offered only while one runs.
- **Diff** (`diff`): desired (Git) ↔ live (cluster) of each resource, the differing ones first, line by line with the
  unchanged runs folded; a session bar with who is signed in and how (the standard admin Secret, an API token Secret
  by name, or your own sign-in in Sextant), Reload and Sign out. Before asking, it signs in, in the built-in view's
  order:
  1. with the login typed earlier or remembered for the cluster in Sextant's dialog (a user and password, or an API
     token);
  2. with the admin password of `argocd-initial-admin-secret`, unless `admin.enabled` is `"false"` in `argocd-cm`;
  3. with the `token` of each Secret labelled `app.kubernetes.io/part-of=argocd` in the installation's namespace, by
     name (the one that signed in last first), each checked with `GET /api/v1/session/userinfo`, which must answer
     `loggedIn: true`; the first Argo CD accepts is used for the rest of the window.

  Otherwise it offers "User and password" or "API token", each of which opens Sextant's own sign-in dialog (with
  "Remember for this cluster"), with a note when Argo CD refused the saved login, the admin password or the token
  Secrets. Sign out forgets the session and the remembered login.
- **Open Argo CD UI** (`open-ui`, also on ApplicationSets and AppProjects): the application's page, or the list of
  applications.

## Permissions

At install the user agrees to these rules (every cluster):
- **Read** Applications, ApplicationSets and AppProjects; the kinds of the resource tree and its computed health
  (Deployments, StatefulSets, DaemonSets, ReplicaSets, Pods, Jobs, PersistentVolumeClaims, Services, Ingresses); and
  ConfigMaps, for `argocd-cmd-params-cm` (does the server run without TLS?) and `argocd-cm` (local users, SSO) of the
  installation. All namespaces: an Application, its resources and Argo CD itself may be anywhere.
- **Modify** Applications, not confirmed by Sextant (`confirm: false`): Sync, Refresh, Hard refresh and Terminate are
  merge patches of the Application. The Sync… and Terminate… windows are the questions, and Refresh and Hard refresh
  are one click, as in Sextant's former built-in view.
- **Port forward** to Services, all namespaces: "Open Argo CD UI" forwards a port to the installation's
  `argocd-server` Service, and every request to Argo CD's API goes through a forward of Sextant's own (Read and Port
  forward on Services in the installation's namespace). Not asked each time (`confirm: false`): a forward and a
  request reach only the services agreed to below, as Sextant's former built-in view did.
- **Services**, agreed to word for word. Each is the one Service labelled `app.kubernetes.io/name=argocd-server` in
  the installation's namespace, so a Helm release's `<release>-argocd-server` is reached too:
  - `argocd-server`: port `https`, HTTPS whose certificate is not checked because the other end is Sextant's own
    forward on 127.0.0.1. It may receive the key `password` of the Secret `argocd-initial-admin-secret`, which Sextant
    puts into the admin sign-in itself (`{{secret:argocd-initial-admin-secret/password}}`): the extension never
    receives it, and needs no "Secret values" permission. Its sign-in asks for a user and a password.
  - `argocd-server-http`: the same over port `http` in plain HTTP, used only when `argocd-cmd-params-cm` says
    `server.insecure: "true"`.
  - `argocd-server-token` and `argocd-server-token-http`: the same two, signing in with an API token, which Sextant
    sends as the bearer of each request. They may receive the key `token` of every Secret labelled
    `app.kubernetes.io/part-of=argocd` in that namespace: the extension learns only the names of those Secrets
    (`service.secrets`) and asks Sextant to send one's token as the bearer (`auth: "secret:<name>/token"`), never
    reading it, so again no "Secret values" permission.

  What the user types goes from Sextant's dialog to Sextant, never to the extension, and is filled in by Sextant
  (`{{signIn:username}}`, `{{signIn:password}}`, `auth: "signIn:token"`). With "Remember for this cluster" Sextant
  keeps it in the system keychain, valid only while the cluster's API server and CA are the same. Credentials Argo CD
  refused (the admin password, a token, a login) are not sent again in this run of Sextant until they change or you
  sign in in Sextant's dialog, so a changed admin password is not tried from every Diff window.

An update asks for consent again when it changes any of these rules or services.

## Problems

| Id | Kind | When it holds | Grace | Told through another object |
|---|---|---|---|---|
| `degraded` | Application | `status.health.status` is Degraded; the message is Argo CD's health message | none | no |
| `sync-failed` | Application | the last operation's phase is Failed or Error, since it finished; the message is the operation's | none | no |

Both may notify, as the built-in category "Argo CD" did.

## Metrics

None.

## Commands

None.

## Changes it makes

Every change is a merge patch of an Application, sent only after a click: in the action's window for Sync and
Terminate (the window is the question; Sextant does not ask again), or on the action itself for Refresh and Hard
refresh:
- **Sync:** `operation` with `initiatedBy.username: sextant`, `sync.revision` (unless multi-source), `prune`,
  `dryRun`, and the app's own `syncOptions` and `retry`, as `argocd app sync` sends them.
- **Refresh / Hard refresh:** the annotation `argocd.argoproj.io/refresh: normal` or `hard` on every selected
  Application, the manifest's fixed `patch`, sent by Sextant itself in the extension's name and in order
  (`resources.patchMany`, 50 at a time); the first failure stops the rest and Sextant says which. Argo CD removes the
  annotation when done.
- **Terminate:** `status.operationState.phase: Terminating`, as `argocd app terminate-op` does. What was applied stays.

"Open Argo CD UI" starts a port forward of the extension's own (listed on Sextant's port-forward page, reused while it
runs) and opens `https://localhost:<port>/applications/<namespace>/<name>` (`http` without TLS) only after the user
says so in Sextant's dialog. Signing in to Argo CD creates a session in Argo CD; nothing is written to the cluster.

## What it does not do

- No SSO, as before.
- The session bar says "with your sign-in" for a login typed or remembered in Sextant's dialog alike; the built-in
  view told a remembered login from one kept until Sextant closed.
- Sextant forgets the credentials Argo CD refused when it closes, as the built-in view forgot them on disconnecting.
- It never chooses between several namespaces with an `argocd-server` Service: the user picks one, and the choice is
  kept for the cluster.
- It installs neither Argo CD nor anything else, and never runs the `argocd` CLI.
- Columns can show only one value each: the Revision is not shortened to 7 characters, an Application's Sync column
  shows "Syncing" instead of the sync status while an operation runs, Destination and Target namespace are two
  columns, and an AppProject's columns show its first destination and source only (the details list them all).
- Where the sections of Flux and Argo CD both follow Velero, their order between them is the order Sextant loads the
  extensions in.

## Requirements and limits

- Argo CD's CRDs (`argoproj.io` Application, ApplicationSet, AppProject); the section shows only while the cluster
  serves them.
- The diff needs exactly one Service labelled `app.kubernetes.io/name=argocd-server` in the installation's namespace,
  with ports named `https` (and `http` for a server without TLS), and a ready server pod.
- The resource tree and computed health list Pods and the other kinds in the destination namespaces of an app that
  deploys to Argo CD's own cluster.
- Not tried on Argo CD's "apps in any namespace" with several control-plane namespaces, nor on OpenShift GitOps.

## Troubleshooting

- **"Argo CD was not found in this cluster: there is no argocd-server Service."** No Service labelled
  `app.kubernetes.io/name=argocd-server` in a namespace the extension may read.
- **"Choose the Argo CD installation"**: several namespaces have such a Service. Choose the real one; the choice is
  kept for the cluster.
- **"Sign in to Argo CD" appears**: nothing is remembered for the cluster, the admin Secret is gone or its
  password was changed in Argo CD, and no Secret labelled `app.kubernetes.io/part-of=argocd` holds a `token` Argo CD
  accepts. Choose "User and password" or "API token" and sign in in Sextant's dialog; tick
  "Remember for this cluster" to be signed in by itself next time.
- **"Argo CD refused the saved login"**: the remembered password or token changed. Sign in again with "Remember for
  this cluster" to replace it.
- **"Argo CD refused the API token from a Secret labelled app.kubernetes.io/part-of=argocd"**: every such token is
  expired or revoked. Put a current one into the Secret, or sign in with "API token".
- **A conflict naming the label selector**: more than one Service labelled `app.kubernetes.io/name=argocd-server`
  in the namespace; the extension reaches Argo CD only through exactly one.
- **"Sextant refused: …"**: the extension's grant does not cover the call, or you declined a confirmation. Settings →
  Extensions shows its permissions and activity.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/argo-cd        # → extensions/argo-cd/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts extensions/argo-cd
```

(`npx vitest run` and `npx tsc --noEmit` in this folder work too: `vitest.config.ts` and `tsconfig.json` map the SDK
to `../../sdk`.)

- `src/main.ts` picks the view by the frame's context:
  - `details.ts` (`fields`), `tree.ts` (`resources`), `history.ts` (`history`);
  - `actions.ts` (the windows of Sync, Terminate and Open Argo CD UI; Refresh and Hard refresh are fixed patches in
    the manifest) and `diff.ts` (the diff, the order of signing in, the choice of how to sign in and the session bar);
  - `picker.ts` (the choice among several installations).
- Argo CD's objects are read in `argo.ts`, the resource health in `health.ts` (ported from Sextant's built-in
  view), the installation and every request to Argo CD's API in `server.ts`, the diff and the line diff in
  `diffModel.ts`, YAML in `yaml.ts` (Sextant's own writer).
- The details blocks, buttons and states are the SDK's UI kit (`ui` of `@sextant/extension-sdk`); `dom.ts` only maps
  Argo CD's tones onto it.
- The texts are in `src/locales/<lang>.json` (English is the source; most come from Sextant's former built-in
  `src/locales/<lang>/argocd.json`) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete
  in every language of Sextant's `src/locales/`.
- `fixtures/` are the built-in view's fixtures, from a kind cluster with Argo CD.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `argo-cd` and the
     commit (add `argo-cd` to the workflow's `extension` choices first).
  3. The catalog's index picks the release up.
