# OpenShift

Views of [OpenShift](https://docs.openshift.com/)'s own kinds — Routes (`route.openshift.io`), DeploymentConfigs
(`apps.openshift.io`), BuildConfigs and Builds (`build.openshift.io`), ImageStreams (`image.openshift.io`) and Projects
(`project.openshift.io`) — in every language Sextant has, with OpenShift's two actions "Rollout latest" and "Start
build". It tells whether a router admitted a Route, where it answers, its TLS termination and its backends with their
shares and pods; a DeploymentConfig's rollout state, triggers and rollouts; a BuildConfig's source (no credentials in a
URI) and builds; a Build's phase, failure and pod with its logs; an ImageStream's tags and import errors; and a
Project's annotations. It reports Routes no router admitted, failed rollouts, recent failed Builds and failing imports.
It replaces Sextant's former built-in OpenShift view (ADR-0120) with the same behaviour. Its id is `sextant.openshift`.
Why it is built this way: ADR-0120 (OpenShift's own types, the two actions sending only what `oc` sends, and its
amendment: `resources.instantiate`), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0144 (rules across
objects: `newestPer`), ADR-0152 (kinds in a section of its own, `not` in rules, a kind's own "Only problems"), ADR-0153
(computed columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths
picking an item, notification groups), ADR-0163 (field values in texts, a problem's reason from the object), ADR-0164
(case tooltips) and ADR-0167 (the counter's own label, column widths and sort values, tooltip fallbacks, a rule's
literal reason and since fallbacks, lists of a field and counts, details sections without a heading, capped watches,
blocks in Sextant's memory, `newestBy`, `|min`, sorted list columns and plural case texts).

## At a glance

| | |
|---|---|
| Id | `sextant.openshift` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `openshift-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → OpenShift |
| Checked against | OpenShift's objects as github.com/openshift/api defines them (`route/v1`, `apps/v1`, `build/v1`, `image/v1`, `project/v1`), the router's admission (github.com/openshift/router) and `oc rollout latest` / `oc start-build` (github.com/openshift/oc) |

## What it adds

**A sidebar section "OpenShift"** (`openshift`), shown while the cluster serves OpenShift's kinds, with the built-in
section's icon, where the built-in section was: Routes, Deployment Configs, Build Configs, Builds, Image Streams and
Projects, each with its own icon, Sextant's own table, filters, selection bar and details, and Edit and Delete as on
every kind. The section's counter shows how many objects need attention (the problems below). ImageStreamTags are no
kind of the section, as in the built-in view: the API server serves them without `watch`; an ImageStream's details list
its tags.

**"Only problems"** on Routes, DeploymentConfigs, Builds and ImageStreams, as the built-in filter had it — without the
grace periods, and a failed Build however long ago: Routes no router admitted, failed rollouts, failed or errored
Builds, ImageStreams with a failing import.

**Columns**, after Name and Namespace (a Project's after Name), in the built-in columns' widths:
- Route: **Status** (`route-status`: Admitted, Rejected or Not admitted, coloured, the rejecting router's message or
  reason on hover, sorted and filtered by the state's name), **Host** (`route-host`: the host — `spec.host`, else the
  one a router generated — and the path), **Services** (`route-services`: `spec.to` and the alternate backends, each with its share of the requests as the
  router weighs them — `weight`, 100 when unset — with `|share`; one backend alone is its name),
  **TLS** (`route-tls`: the termination).
- DeploymentConfig: **Status** (`dc-status`: Available, Rolling out, Failed, Cancelled, Unavailable, Paused or Not
  deployed from its conditions, coloured, why on hover, sorted and filtered by the state's name), **Ready**
  (`dc-ready`: ready of desired), **Version** (`dc-latest-version`), **Triggers** (`dc-triggers`).
- BuildConfig: **Strategy** (`bc-strategy`), **Source** (`bc-source`: the Git URI without userinfo, query or
  fragment, else the source type), **Output** (`bc-output`), **Last build** (`bc-last-version`), **Triggers**
  (`bc-triggers`).
- Build: **Status** (`build-status`: the phase, New when unset, coloured, why it failed on hover), **Build config**
  (`build-config`), **Strategy** (`build-strategy`), **Duration** (`build-duration`: from the start to the completion,
  or to now), **Started** (`build-started`).
- ImageStream: **Tags** (`is-tags`: of the spec and the status, each once, sorted), **Imports** (`is-imports`: "N
  imports fail" in red, in the language's plural form, sorted and filtered by the count), **Repository**
  (`is-repository`).
- Project: **Display name** (`project-display-name`), **Status** (`project-status`: the phase, coloured),
  **Requester** (`project-requester`).

**Details**, a section **OpenShift** (`openshift`) on the six kinds, drawn with the SDK's UI kit, without a heading of
its own as the built-in section had none, its blocks opening and closing in Sextant's own memory of details sections
(Settings → Appearance, "Expand all", "Collapse all"):
- Route: why no router admitted it, in the router's words (or that none has answered); its state, address, path,
  wildcard policy, target port, TLS termination, plain HTTP policy and whether each inline certificate field is set
  (never a PEM: Sextant hands the extension the Route without its private key), the certificate Secret; **Backends** —
  each Service (a link) with its weight, its share of the requests and its pods ready, from the namespace's Services and
  pods watched while the details are open; **Routers** — what each router says, since when.
- DeploymentConfig: why a rollout failed or waits, in the controller's words; replicas, latest version and its causes,
  strategy, hooks and selector; **Triggers** (an ImageChange trigger's ImageStreamTag linked to its ImageStream); and
  **Rollouts** — the ReplicationControllers labelled with its name, watched while the block is open (at most 200), newest
  first, the first 20, each with the deployer's phase, pods ready, reason and creation.
- BuildConfig: strategy and builder image, source type, Git URI, ref and context directory, an inline Dockerfile only
  as "set", the source Secret by name, output, run policy, last build number, triggers by type (a webhook's secret never
  read), and **Builds** — labelled with its name, watched while the block is open (at most 500), newest number first, the
  first 20, each with its phase, duration, start and why it failed.
- Build: why it failed; its phase, reason, BuildConfig, number, strategy, Git URI and commit, what started it, start,
  completion, duration, output, output image and digest, and the build pod (`openshift.io/build.pod-name`, else the name
  the build controller gives it); **Logs** — a "Build logs" button while the pod exists (Sextant's logs tab of that pod),
  else that it is not created yet or gone, and the log snippet the build controller keeps.
- ImageStream: that N tag imports fail; the repositories and the local lookup policy; **Tags** — each with where it
  points, its current image, when it was imported, whether its import is scheduled, and how many images it held or its
  import error.
- Project: display name, description, requester, node selector, phase, and its Namespace (a link).

The details tables' columns resize (drag a header's right edge) and Sextant remembers their widths, as the built-in
view's did; the same columns keep to one line, the others wrap between words.

**Actions**, buttons of the details bar on their kinds:
- **Rollout latest** (`rollout-latest`) on a DeploymentConfig: its window says what it does and shows the one request it
  sends (`POST …/deploymentconfigs/<name>/instantiate` with its body, as `oc rollout latest`); it reads the latest
  version's ReplicationController first and, while it has not ended or for a paused DeploymentConfig, says why and keeps
  "Roll out" off. Then Sextant's `resources.instantiate` sends it once and the window names the ReplicationController
  made.
- **Start build** (`start-build`) on a BuildConfig: its window shows the request (`POST …/buildconfigs/<name>/instantiate`,
  as `oc start-build` without flags); "Start build" sends it once and the window names the Build made.

## Permissions

Installing asks for consent to:
- **read** Routes, DeploymentConfigs, BuildConfigs, Builds, ImageStreams and Projects in every namespace — the views;
  ReplicationControllers (a DeploymentConfig's rollouts, the latest one before "Rollout latest"), Services and Pods (a
  Route's backends and their pods ready, a Build's pod);
- **modify** DeploymentConfigs and BuildConfigs, without Sextant's own question (`confirm: false`): only through
  `resources.instantiate`, the two actions, whose window is the question and shows the request, as the built-in dialogs
  were the only question;
- read the **logs** of Pods — a Build's pod, opened in Sextant's logs tab;
- judge Routes, DeploymentConfigs, Builds and ImageStreams in **problem rules** (shown on the Problems page and counted
  on the section).

It reads no Secret and no Secret value; a Route's inline private key and a BuildConfig's webhook secrets never reach
it. An update that asks for more asks for consent again.

## Problems

In the extension's category "OpenShift" (`ext:sextant.openshift`), on by default as the built-in category `openshift`
was. Agents never get it, as they did not get the built-in one.

| Rule | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `route-not-admitted` | Route | No router admitted it (an entry of `status.ingress` with `Admitted=True`); the rejecting router's message (else reason) and reason (else `NotAdmitted`), since its rejection, else the Route's creation | 2 min | — |
| `dc-progressing` | DeploymentConfig | A rollout failed (not paused; `Progressing`'s reason `ProgressDeadlineExceeded` or `ReplicationControllerCreateError`, or `ReplicaFailure=True`) with `Progressing=False`: its reason (else `RolloutFailed`) and time; the words of `Progressing` or `ReplicaFailure` | — | — |
| `dc-progressing-other` | DeploymentConfig | The same, neither condition with words: those of `Available=False`, else the latest rollout's details | — | — |
| `dc-replica` | DeploymentConfig | A rollout failed with `ReplicaFailure=True` and `Progressing` not False: `ReplicaFailure`'s reason and time; its words | — | — |
| `dc-replica-other` | DeploymentConfig | The same, without its words: those of `Available=False`, else the details | — | — |
| `dc-deadline` | DeploymentConfig | A rollout failed with neither of the above: `Progressing`'s reason and time; its words | — | — |
| `dc-deadline-other` | DeploymentConfig | The same, without them: those of `Available=False`, else the details | — | — |
| `build-failed` | Build | Phase `Failed`, for a day after it ended (completion, else start, else creation); its reason (else `BuildFailed`) and message | — | Only the Build of its BuildConfig with the highest build number (`newestPer` on `openshift.io/build-config.name`, `newestBy` its `openshift.io/build.number`) |
| `build-error` | Build | Phase `Error`, the same; reason else `BuildError` | — | The same |
| `import-failed` | ImageStream | A tag's `ImportSuccess=False`; the first such tag by name speaks (its message, else reason), since the earliest failure; reason `ImportFailed` | 5 min | — |

Each kind's rules notify once per object (groups `not-admitted`, `rollout-failed`, `build-failed`, `import-failed`).

## Metrics

None.

## Commands

None.

## Changes it makes

Only the two actions, each a POST to an `instantiate` subresource that Sextant's core builds from the object's name
(`resources.instantiate`; ADR-0120 amendment): "Rollout latest" starts a new rollout of a DeploymentConfig (a new
ReplicationController), "Start build" a new Build of a BuildConfig. Each is shown before it is sent — the window shows
the request — sent once on "Roll out" / "Start build", never repeated, and journaled by Sextant. The core checks
"Rollout latest" again right before sending (paused, the latest rollout not ended).

## What it does not do

- It diagnoses no Route: the "Diagnose" action and "Diagnosis" tab of a Route stay Sextant's own
  (`src/features/diagnose/openshift.ts`), as agents' `diagnose_service` uses them.
- It does not scale, restart or roll back DeploymentConfigs (left out as in ADR-0120), cancel builds, approve or edit
  anything else; Edit and Delete are Sextant's own.
- It never reads an ImageStreamTag as a kind of its own, a Secret, a webhook secret or a Route's private key.

## Requirements and limits

An OpenShift cluster (4.x) serving the kinds; each kind shows only where the cluster serves it.

What the extension API cannot say yet, compared with the built-in view (issue #417):
- **Route Services column** sorts by the text shown (each backend with its share), where the built-in sorted by the
  names alone: rows differ in order only where their first names are equal.
- **The ImageStream problem's message** comes from the first failing tag by name in code-point order, where the
  built-in sorted the tags with `localeCompare` (the two differ only for tags in mixed case or with punctuation).
- **Failed Builds told by a later one**: `newestPer` + `newestBy` keep the Build with the highest build number
  (`openshift.io/build.number`) among those with the same `openshift.io/build-config.name` label, as the built-in did;
  the built-in grouped by the BuildConfig `status.config` names first (the label is the controller's copy of it, cut to
  63 characters), and left a Build without a number always standing, where the window then compares it by creation.
- **ImageStream Tags column** sorts in the UI language's collation, where the built-in used `localeCompare`'s
  default locale.
- **Build Duration column**: from `status.startTimestamp` to `status.completionTimestamp`, else to now; the built-in
  took `status.duration` first and counted to now only while the build ran (a finished build without a completion
  time showed nothing).
- **Action windows** are titled by Sextant with the action's name; the built-in dialogs' title ("Roll out
  DeploymentConfig frontend?") is the window's first line.

## Troubleshooting

- *The section is missing*: the cluster serves none of the kinds, or the extension is disabled (Settings → Extensions).
- *"Loading…" stays in Rollouts or Builds*: the ReplicationControllers or Builds cannot be listed; the block then says
  "The list cannot be read." — the user lacks list/watch on them in the namespace.
- *"Roll out" stays off*: the window says why (paused, or the latest rollout still in progress); wait or resume.
- *An action fails*: the window shows the API server's answer; nothing was repeated.

## Development

- Test: `npx vitest run --config sdk/vitest.config.ts ../extensions/openshift` (the rules, kinds' "Only problems" and
  columns judged by Sextant's own window engine against the built-in model ported to `src/model.ts`, on `fixtures/objects.json`; the details and
  action windows through the SDK's test host; the catalogs).
- Type check: `npx tsc -p sdk/tsconfig.test.json`; lint: `npx eslint extensions/openshift/src`.
- Build: `npm run sdk:build -- extensions/openshift`; pack: `npm run sdk:pack -- extensions/openshift/dist`.
- Sextant accepts the manifest: `cargo test -p sextant-core the_sdk_examples_and_sextants_extensions_have_manifests_sextant_accepts`.
- Released from FriendsOfKubernetes/sextant-extensions by its workflow "Release a Sextant extension".
