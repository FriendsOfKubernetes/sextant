# Flux

[Flux CD](https://fluxcd.io)'s objects in Sextant, in every language Sextant has: sources, Kustomizations,
HelmReleases, image automation and notifications in a sidebar section of their own, with Sextant's own tables. It
shows each object's readiness, revision and source, what a Kustomization or HelmRelease applied and which objects use
a source, tells what fails to reconcile as a problem, and offers Reconcile, Reconcile with source, Suspend and Resume.
It is Sextant's former built-in Flux view, rebuilt on the public extension API. Its id is `sextant.flux`. Why it is
built this way: ADR-0024 (Flux only through the Kubernetes API, no `flux` command), ADR-0031 (the Flux section),
ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of the extension's own and
`not` in problem rules), ADR-0153 (computed columns), ADR-0154 (when an action applies and where its button goes),
ADR-0160 (the section's icon and place, palette names, the UI kit) and ADR-0161 (printer columns left out, a condition
picked by its type, columns placed by id, one confirmation for several patches, notification groups, hidden
sections).

## At a glance

| | |
|---|---|
| Id | `sextant.flux` |
| Version | 1.1.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants keep their built-in Flux view. |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `flux-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Flux |
| Checked against | Flux v2.9's objects (`source.toolkit.fluxcd.io/v1`, `kustomize.toolkit.fluxcd.io/v1`, `helm.toolkit.fluxcd.io/v2`, `image.toolkit.fluxcd.io/v1`, `notification.toolkit.fluxcd.io/v1beta3` and `v1`) as the controllers wrote them on a kind cluster (`fixtures/`) |

## What it adds

**The sidebar section "Flux"** (`flux`), with Flux's icon, right after Velero where Sextant's built-in Flux section
was, shown only while the cluster serves one of its kinds, with a counter of the objects that have a problem of the
rules below. It lists, with Sextant's own tables (filters, selection, search, saved views, custom columns, the
palette), in this order: Git Repositories, OCI Repositories, Helm Repositories, Helm Charts, Buckets, Kustomizations,
Helm Releases, Image Repositories, Image Policies, Image Update Automations, Alerts, Providers and Receivers. A kind the
cluster does not serve is not listed. The command palette searches Kustomizations and HelmReleases without being
asked and takes `ks` and `hr` as their short names (`hr podinfo`), as it did for the built-in view.

**Columns**, in this order right after Namespace, each placed after the one before it by its id; the CRDs' own
printer columns are left out, so Ready and Status are not shown twice:
- **Source** of a Kustomization or HelmRelease (`source-kustomization`, `source-helmrelease`): the name of its
  `sourceRef`, `chart.spec.sourceRef` or `chartRef`; the kind in the tooltip.
- **Ready**: the Ready condition's status (found by its type wherever it is in the list), True in green, False in red,
  Unknown (reconciling) in yellow.
- **Status**: the Ready condition's message, what was applied or what failed; the whole message in the tooltip.
- **Revision**: the first of the source's artifact revision, the Kustomization's last applied revision, the
  HelmRelease's chart version, the ImagePolicy's latest image (else the tag of `latestRef`), the ImageRepository's
  last scan, the ImageUpdateAutomation's last pushed commit (else the revision it looked at).
- **Suspended**: Yes in yellow, or No, in every language (the tone goes with the case, not the word).

By kind:

| Kind | Columns |
|---|---|
| GitRepository | `ready-gitrepository` `status-gitrepository` `revision-gitrepository` `suspended-gitrepository` |
| OCIRepository | `ready-ocirepository` `status-ocirepository` `revision-ocirepository` `suspended-ocirepository` |
| HelmRepository | `ready-helmrepository` `status-helmrepository` `revision-helmrepository` `suspended-helmrepository` |
| HelmChart | `ready-helmchart` `status-helmchart` `revision-helmchart` `suspended-helmchart` |
| Bucket | `ready-bucket` `status-bucket` `revision-bucket` `suspended-bucket` |
| Kustomization | `source-kustomization` `ready-kustomization` `status-kustomization` `revision-kustomization` `suspended-kustomization` |
| HelmRelease | `source-helmrelease` `ready-helmrelease` `status-helmrelease` `revision-helmrelease` `suspended-helmrelease` |
| ImageRepository | `ready-imagerepository` `status-imagerepository` `revision-imagerepository` `suspended-imagerepository` |
| ImagePolicy | `ready-imagepolicy` `status-imagepolicy` `revision-imagepolicy` `suspended-imagepolicy` |
| ImageUpdateAutomation | `ready-imageupdateautomation` `status-imageupdateautomation` `revision-imageupdateautomation` `suspended-imageupdateautomation` |
| Alert | `suspended-alert` (Flux's Alerts and Providers have no status, and a manifest has at most 50 columns) |
| Provider | `suspended-provider` |
| Receiver | `ready-receiver` `status-receiver` `revision-receiver` `suspended-receiver` |

**Details of every Flux object:** **Flux** (`fields`, a section): Ready with its reason, the status message, the
revision and the last attempted one when it differs, Suspended, interval, timeout, the source and the HelmChart as
links, the chart, URL, reference (branch, tag, semver, commit, …), endpoint, bucket, path, target namespace, release
name, prune, Depends on as links, the image, the ImagePolicy's image repository and the Alert's provider as links, the
event severity and sources, a Provider's or Receiver's type, the channel, the webhook path and the last reconcile
request. A field without a value is left out. The details are drawn with the SDK's UI kit, in the look of Sextant's
own details panel.

**Kustomization details:** **Applied resources** (`inventory`, a section): the objects of its `status.inventory`, as
links to their details (in the version the inventory names). A Kustomization that applied nothing has no such section,
as with the built-in view.

**HelmRelease details:** **Resources** (`resources`, a section): its `status.inventory` (Flux 2.8 and newer) and the
objects helm-controller labelled with its name and namespace (Deployments, StatefulSets, DaemonSets, Jobs, CronJobs,
Services, ConfigMaps, Secrets, ServiceAccounts, PersistentVolumeClaims, Ingresses), only in its target and storage
namespaces, live. A kind you may not list is named under the table; the others stay.

**Source details** (GitRepository, OCIRepository, HelmRepository, HelmChart, Bucket): **Used by** (`used-by`, a
section): the Kustomizations and HelmReleases, in every namespace you may read, that take their artifact from it,
live.

**Actions**, as buttons of the details bar on the Flux kinds and in the selection bar; however many objects an action
changes, Sextant asks once:
- **Reconcile now** (`reconcile`, several objects at once).
- **Reconcile with source** (`reconcile-with-source`, in the "Actions" menu, on a Kustomization or HelmRelease that
  names a source).
- **Suspend** (`suspend`, on an object that is not suspended).
- **Resume** (`resume`, several objects at once, on suspended objects).

Sextant's own Edit and Delete stay where they are for every kind.

## Permissions

- **Read** on the 13 Flux kinds: the tables, details, problems, and Used by. **Read** on Deployments, StatefulSets,
  DaemonSets, Jobs, CronJobs, Services, ConfigMaps, Secrets, ServiceAccounts, PersistentVolumeClaims and Ingresses:
  only to list, by helm-controller's labels and metadata only, what a HelmRelease created. A Secret's values are never
  read (Sextant never gives them to an extension without "Secret values", which this one does not ask for).
- **Modify** on the 13 Flux kinds, each change confirmed by Sextant: the merge patches of the actions below.
- Nothing is deleted by the extension.

All clusters and namespaces; Sextant's own access rules decide where it may act. An update that adds a kind or an
action asks for consent again.

## Problems

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `not-ready-gitrepository` | GitRepository | Ready is False, it is not suspended, and the reason is none of DependencyNotReady, Progressing, ProgressingWithRetry, ReconciliationInProgress | 2 minutes from the Ready condition's last transition | No |
| `not-ready-ocirepository` | OCIRepository | the same | 2 minutes | No |
| `not-ready-helmrepository` | HelmRepository | the same | 2 minutes | No |
| `not-ready-bucket` | Bucket | the same | 2 minutes | No |
| `not-ready-kustomization` | Kustomization | the same | 2 minutes | No |
| `not-ready-helmrelease` | HelmRelease | the same | 2 minutes | No |

Each notifies, all six in one notification group (`not-ready`), as the built-in rule did. The message is the Ready
condition's reason and message.

## Metrics

None.

## Commands

None.

## Changes it makes

Every change is a merge patch, shown in the action's window before it is sent. All the objects of one action go in one
`resources.patchMany` call (up to 50; more in further calls), so Sextant confirms them once, in one list; they are sent
once each, one at a time, in order:
- **Reconcile now**: `metadata.annotations["reconcile.fluxcd.io/requestedAt"]` set to the time it is sent, which
  every Flux controller watches.
- **Reconcile with source**: the same on the source of a Kustomization; on a HelmRelease's chart source and then on
  its HelmChart (`status.helmChart`), so the chart is pulled again; then on the object itself.
- **Suspend**: `spec.suspend: true`, after the question "Suspend <kind> <name>?" and what it means.
- **Resume**: `spec.suspend: false`.

Sextant's or the user's refusal sends nothing. The cluster's error on one object stops before the next and names the
object that failed; nothing is retried.

## What it does not do

- It never runs the `flux` command and never talks to Flux's controllers: everything goes through the Kubernetes API
  (ADR-0024).
- It does not install Flux. Installing Flux from its official manifests stays in a cluster's context menu of Sextant.
- It does not change a Flux object's spec beyond `suspend`: edit an object with Sextant's own Edit.
- It does not show Flux's events or logs: the details' Events and the controllers' pods do.

## Requirements and limits

- Flux v2 with the current API versions. Older versions a cluster serves are read by field name, as Flux keeps them.
- A problem's title is fixed per kind ("Kustomization not ready"), where the built-in view showed the Ready reason as
  the reason; the reason starts the message instead. A message shows at most 100 characters of each field, so a
  long Ready message is cut.
- The Flux fields are a section titled "Flux" of the details, below Sextant's own fields, where the built-in view put
  them among those fields.
- The Suspended column's No is in the table's normal colour, where the built-in table greyed it.
- A column cannot join two fields: an ImagePolicy whose status has only `latestRef` shows its tag as the revision
  (the details show `name:tag`), and Source shows the source's name with its kind in the tooltip.
- Notification Alerts and Providers have no status, so they show Suspended only.
- What a HelmRelease created is looked for among the 11 kinds above, as helm-controller labels them; other kinds of a
  chart show only through the inventory.

## Troubleshooting

- **The Flux section is missing:** the cluster serves none of Flux's kinds (Flux is not installed), or the extension
  is disabled in Settings → Extensions.
- **"You don't have permission to list these objects: …" under Resources:** you may not list that kind there; the
  other kinds are still shown.
- **A list fails with an error and Retry:** the cluster could not be reached or refused the list; Retry lists again.
- **An action says "Sextant refused":** Sextant's access rules for the extension, or you, declined the change.

## Development

- Type check: `cd extensions/flux && npx tsc --noEmit`.
- Tests (from the repository root): `npx vitest run --config sdk/vitest.config.ts extensions/flux`. They check the
  columns and problem rules with Sextant's own evaluator of extension conditions against `fixtures/`, the patches,
  the details sections and the action windows against the SDK's test host, and the texts in every language.
- Check the manifest: `node sdk/scripts/cli.mjs check extensions/flux`.
- Build: `npm run sdk:build -- extensions/flux`; pack: `npm run sdk:pack -- extensions/flux/dist`.
- `npm run sdk:check` does all of these for every folder of `extensions/`.
- Released from FriendsOfKubernetes/sextant-extensions by its workflow "Release a Sextant extension" (folder `flux`).
