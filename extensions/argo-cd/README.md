# Argo CD

[Argo CD](https://argo-cd.readthedocs.io) in Sextant, in every language Sextant has: Applications, ApplicationSets
and AppProjects in a sidebar section of their own with Sextant's tables, the resources each application manages with
their health, the sync history, Sync, Refresh, Terminate, the diff of desired and live states from Argo CD's API,
and the Argo CD UI. It does what Sextant's built-in Argo CD view did, through the public extension API only. Its id
is `sextant.argo-cd`. Why it is built this way: ADR-0024 to ADR-0032 (the built-in view it reproduces: changes
through the Kubernetes API only, the API reached through a port forward, sign-in from the admin Secret, the choice
of the installation), ADR-0139 (Sextant's own extensions), ADR-0140 (its translations), ADR-0152 to ADR-0154
(kinds, computed columns, action conditions), ADR-0156 (port forwards and links) and ADR-0158 (requests to a
Service, sessions kept by Sextant).

## At a glance

| | |
|---|---|
| Id | `sextant.argo-cd` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `argo-cd-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Argo CD |
| Checked against | The objects of Argo CD v3.5.5 (the fixtures of Sextant's built-in view, `fixtures/`) and Argo CD's API `/api/v1/session` and `/api/v1/applications/<name>/managed-resources` |

## What it adds

**A sidebar section "Argo CD"** (`argocd`), shown while the cluster serves one of its kinds, with Sextant's own
tables (filters, selection, search, saved views, custom columns): **Applications**, **ApplicationSets** and
**AppProjects** (`argoproj.io`). The section's counter shows how many Applications have a problem of the rules
below.

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
- ApplicationSets: **Applications** (`applications`), how many it generated.
- AppProjects: **First destination** (`first-destination`, its namespace as a tooltip) and **First source**
  (`first-source`).

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

**Actions on Applications:**
- **Sync…** (`sync`, a button): revision (the target revision by default; each source's own for a multi-source app),
  Prune, Dry run. Offered only while no operation runs.
- **Refresh** (`refresh`, a button) and **Hard refresh** (`hard-refresh`), on one or several selected Applications.
- **Terminate…** (`terminate`): stops the running operation. Offered only while one runs.
- **Diff** (`diff`): desired (Git) ↔ live (cluster) of each resource, the differing ones first, line by line with the
  unchanged runs folded; a session bar with who is signed in, Reload and Sign out.
- **Open Argo CD UI** (`open-ui`, also on ApplicationSets and AppProjects): the application's page, or the list of
  applications.

## Permissions

At install the user agrees to these rules (every cluster):
- **Read** Applications, ApplicationSets and AppProjects; the kinds of the resource tree and its computed health
  (Deployments, StatefulSets, DaemonSets, ReplicaSets, Pods, Jobs, PersistentVolumeClaims, Services, Ingresses); and
  ConfigMaps, for `argocd-cmd-params-cm` (does the server run without TLS?) and `argocd-cm` (local users, SSO) of the
  installation. All namespaces: an Application, its resources and Argo CD itself may be anywhere.
- **Modify** Applications, asked every time: Sync, Refresh, Hard refresh and Terminate are merge patches of the
  Application.
- **Port forward** to Services, all namespaces: "Open Argo CD UI" forwards a port to `argocd-server`, and every
  request to Argo CD's API goes through a forward of Sextant's own (Read and Port forward on Services in the
  installation's namespace).
- **Secret values** on Secrets, only in the namespace `argocd`. Sextant then puts the `password` of
  `argocd-initial-admin-secret` into the sign-in request itself (`{{secret:argocd-initial-admin-secret/password}}`,
  ADR-0158): the extension never receives it. Rules name a kind and namespaces, not one Secret, so this rule is
  limited to `argocd`, where Argo CD's own manifests install it. In another namespace the extension does not sign in
  by itself and asks for a user and password.
- **Services**, agreed to word for word: `argocd-server` (the Service `argocd-server`, port `https`, HTTPS whose
  certificate is not checked because the other end is Sextant's own forward on 127.0.0.1) and `argocd-server-http`
  (the same Service, port `http`, plain HTTP, used only when `argocd-cmd-params-cm` says `server.insecure: "true"`).

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

Every change is a merge patch of one Application, sent only after a click in the action's window, and Sextant asks
before each one (the Modify rule):
- **Sync:** `operation` with `initiatedBy.username: sextant`, `sync.revision` (unless multi-source), `prune`,
  `dryRun`, and the app's own `syncOptions` and `retry`, as `argocd app sync` sends them.
- **Refresh / Hard refresh:** the annotation `argocd.argoproj.io/refresh: normal` or `hard`, one Application after
  another; Argo CD removes it when done.
- **Terminate:** `status.operationState.phase: Terminating`, as `argocd app terminate-op` does. What was applied stays.

"Open Argo CD UI" starts a port forward of the extension's own (listed on Sextant's port-forward page, reused while it
runs) and opens `https://localhost:<port>/applications/<namespace>/<name>` (`http` without TLS) only after the user
says so in Sextant's dialog. Signing in to Argo CD creates a session in Argo CD; nothing is written to the cluster.

## What it does not do

- **A typed sign-in is not remembered across runs**, unlike the built-in "Remember on this computer": Sextant keeps
  the session in memory only, until it is closed, the cluster is disconnected or the extension's grant changes.
- **No API token sign-in**, neither typed nor from Secrets labelled `app.kubernetes.io/part-of=argocd`: the
  extension can make a session only by Argo CD's `POST /api/v1/session` with a user and password. No SSO, as before.
- The password typed into its sign-in form is seen by the extension (it is the extension's form) and sent only to
  the installation's own `argocd-server`.
- It never chooses between several namespaces with an `argocd-server` Service: the user picks one, and the choice is
  kept for the cluster. It reaches Argo CD's API only through a Service named `argocd-server` (the official manifests
  and a Helm release named `argocd`).
- It installs neither Argo CD nor anything else, and never runs the `argocd` CLI.
- Columns can show only one value each: the Revision is not shortened to 7 characters, an Application's Sync column
  shows "Syncing" instead of the sync status while an operation runs, Destination and Target namespace are two
  columns, and an AppProject's columns show its first destination and source only (the details list them all). The
  CRD's own printer columns stay in the tables beside these.

## Requirements and limits

- Argo CD's CRDs (`argoproj.io` Application, ApplicationSet, AppProject); the section shows only while the cluster
  serves them.
- The diff needs the `argocd-server` Service with ports named `https` (and `http` for a server without TLS) and a
  ready server pod.
- The resource tree and computed health list Pods and the other kinds in the destination namespaces of an app that
  deploys to Argo CD's own cluster.
- Not tried on Argo CD's "apps in any namespace" with several control-plane namespaces, nor on OpenShift GitOps.

## Troubleshooting

- **"Argo CD was not found in this cluster: there is no argocd-server Service."** No Service labelled
  `app.kubernetes.io/name=argocd-server` in a namespace the extension may read.
- **"Choose the Argo CD installation"**: several namespaces have such a Service. Choose the real one; the choice is
  kept for the cluster.
- **"…only through a Service named argocd-server…"**: the installation's Service has another name (a Helm release
  not named `argocd`). Use "Open Argo CD UI" for the diff there.
- **The sign-in form appears**: the admin Secret is gone, its password was changed in Argo CD, or Argo CD runs outside
  the namespace `argocd`. Sign in with a local user; the session lasts until Sextant is closed.
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
  - `actions.ts` (every action window) and `diff.ts` (the diff, the sign-in form and the session bar);
  - `picker.ts` (the choice among several installations).
- Argo CD's objects are read in `argo.ts`, the resource health in `health.ts` (ported from Sextant's built-in
  view), the installation and every request to Argo CD's API in `server.ts`, the diff and the line diff in
  `diffModel.ts`, YAML in `yaml.ts` (Sextant's own writer).
- The texts are in `src/locales/<lang>.json` (English is the source; most come from Sextant's built-in
  `src/locales/<lang>/argocd.json`) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete
  in every language of Sextant's `src/locales/`, and the Sync column's tones name the translated "Syncing" of every
  language.
- `fixtures/` are the built-in view's fixtures, from a kind cluster with Argo CD.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `argo-cd` and the
     commit (add `argo-cd` to the workflow's `extension` choices first).
  3. The catalog's index picks the release up.
