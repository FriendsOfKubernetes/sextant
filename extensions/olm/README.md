# Operator Lifecycle Manager

Read-only views of the [Operator Lifecycle Manager](https://olm.operatorframework.io/) (OLM), in every language
Sextant has. It lists OLM's Subscriptions, ClusterServiceVersions, InstallPlans, CatalogSources, OperatorGroups and
Operators (`operators.coreos.com`) and, where OLM v1 is installed, its ClusterExtensions and ClusterCatalogs
(`olm.operatorframework.io`) in a sidebar section of their own with Sextant's tables; tells a Subscription's state
and pending upgrade, a CSV's phase, requirements and Deployments (a copy OLM keeps in a target namespace told apart
from its original), an InstallPlan's steps; and reports failed operators, failed or stuck install plans and catalogs
that are not ready. It never approves an InstallPlan. It replaces Sextant's former built-in OLM view (ADR-0121) with
the same behaviour. Its id is `sextant.olm`. Why it is built this way: ADR-0121 (the readings, copies, problems and
no approval), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of its own,
rules narrowed to a label-selected source), ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the
UI kit), ADR-0161 (printer columns left out, paths picking an item, `same`, notification groups), ADR-0163 (field
values in texts, a problem's reason from the object), ADR-0164 (case tooltips, deeper conditions), ADR-0165 (list
cells, a kind's own "Only problems") and ADR-0167 (the counter's own label).

## At a glance

| | |
|---|---|
| Id | `sextant.olm` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `olm-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Operator Lifecycle Manager |
| Checked against | OLM v0 objects as operator-framework/api writes them (`operators.coreos.com/v1alpha1` and `v1`), OLM v1's `olm.operatorframework.io/v1` (operator-controller) |

## What it adds

**A sidebar section "Operators (OLM)"** (`olm`), shown while the cluster serves one of its kinds, with the built-in
section's icon, right after KServe's section: Subscriptions, Cluster Service Versions, Install Plans, Catalog Sources,
Operator Groups, Operators, Cluster Extensions and Cluster Catalogs, each with Sextant's own table, filters, selection
bar and details, and Edit and Delete as on every kind. The section's counter shows how many OLM objects need
attention (the problems below).

**"Only problems"**, as the built-in tables had it: on Subscriptions those whose resolution failed more than ten
minutes ago, whose InstallPlan failed, or whose InstallPlan has been planning or installing for half an hour; on
Cluster Service Versions the originals failed for five minutes; on Catalog Sources those not READY (nor IDLE); on
Install Plans the failed ones.

**Columns**, after Name and Namespace (Name for the cluster-scoped kinds), in place of the CRDs' own printer columns
(left out, as the built-in view did):
- Subscriptions: **Package** (`subscription-package`), **Channel** (`subscription-channel`), **Catalog**
  (`subscription-source`), **Approval** (`subscription-approval`, Automatic when unset, as OLM reads it),
  **Installed CSV** (`subscription-installed`) and **State** (`subscription-state`: Resolution failed, Install plan
  failed, Upgrade failed, Waiting for approval, Upgrade pending, Upgrade available, Up to date or Pending, coloured,
  the failing condition's message on hover).
- Cluster Service Versions: **Display name** (`csv-display-name`), **Version** (`csv-version`), **Phase**
  (`csv-phase`, coloured, the reason and message on hover) and **Copy of** (`csv-copied-from`: for a copy, the
  namespace of its original).
- Install Plans: **CSVs** (`install-plan-csvs`), **Approval** (`install-plan-approval`), **Approved**
  (`install-plan-approved`) and **Phase** (`install-plan-phase`, coloured).
- Catalog Sources: **Display name** (`catalog-source-display-name`), **Type** (`catalog-source-type`), **Publisher**
  (`catalog-source-publisher`) and **Connection** (`catalog-source-connection`: the registry's gRPC state, coloured,
  the catalog's message on hover).
- Operator Groups: **Target namespaces** (`operator-group-targets`: "All namespaces", else the namespaces OLM
  reports, else the requested ones) and **Upgrade strategy** (`operator-group-upgrade-strategy`, Default when unset).
- Operators: **Components** (`operator-components`).
- Cluster Extensions: **Package** (`cluster-extension-package`), **Installed version**
  (`cluster-extension-installed-version`), **Installed** (`cluster-extension-installed`) and **Progressing**
  (`cluster-extension-progressing`): each condition as "Status (Reason)", coloured, its message on hover;
  Progressing True while retrying, blocked or past its deadline is a warning.
- Cluster Catalogs: **Image** (`cluster-catalog-image`), **Serving** (`cluster-catalog-serving`) and **Unpacked**
  (`cluster-catalog-last-unpacked`, an age).

**Details**, a section per kind, drawn with the SDK's UI kit in the classes of Sextant's own details panel:
- **Subscription** (`subscription`): why it failed or what it waits for, the pending upgrade, its package, channel,
  catalog, approval, starting, installed and current CSV, its InstallPlan, and the catalogs' health. The installed CSV
  and the InstallPlan are watched by name while the section shows, for their phases.
- **ClusterServiceVersion** (`csv`): why it failed, unmet requirements, its phase, version, provider, `replaces`,
  `skips`, the Subscription that installed it (the namespace's Subscriptions are watched for it), install modes, the
  requirements, owned and required CRDs, and the Deployments of its install strategy with ready/desired and
  availability (watched by the labels OLM puts on them: `olm.owner=<csv>,olm.owner.kind=ClusterServiceVersion`). A
  copy says it is one and links its original instead.
- **InstallPlan** (`install-plan`): that Sextant does not approve install plans, why it failed, its approval, CSVs and
  catalog, bundle lookups and steps (at most 200). A step's manifest is never shown.
- **CatalogSource** (`catalog-source`), **OperatorGroup** (`operator-group`), **Operator** (`operator`),
  **ClusterExtension** (`cluster-extension`) and **ClusterCatalog** (`cluster-catalog`): the registry and its
  connection, the target namespaces and upgrade strategy (a warning for `TechPreviewUnsafeFailForward`), the
  components (at most 200), OLM v1's package, installed bundle and conditions, and the catalog's image, poll interval
  and base URL (text, never requested).

Every object named is a link to its details in Sextant's panel.

## Permissions

- **Read** Subscriptions, ClusterServiceVersions, InstallPlans, CatalogSources, OperatorGroups, Operators,
  ClusterExtensions and ClusterCatalogs (each section reads the object it shows, and a Subscription's InstallPlan and
  installed CSV), and Deployments (a CSV's install strategy Deployments), in every namespace of every cluster.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge Subscriptions, ClusterServiceVersions and CatalogSources; Sextant asks for that separately
  at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `olm`, on by default. ClusterServiceVersions are watched for problems without their copies:
the rules' source is the label selector `!olm.copiedFrom`, so the API server drops every copy OLM keeps in a target
namespace, and the rules skip a copy OLM marked only by `status.reason: Copied` or by an `olm.operatorNamespace`
annotation of another namespace. InstallPlans are never watched for problems: the Subscription tells the plan it uses
now. Waiting for an approval is never a problem. Every rule may notify; a rule's reason is the object's own (the
condition's or the CSV's reason), and the `-unnamed` rules give the built-in fallback reason when the object gives
none.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `csv-failed` | ClusterServiceVersion | An original in phase Failed, with a reason | 5 min from `status.lastTransitionTime` | No |
| `csv-failed-unnamed` | ClusterServiceVersion | The same without a reason (reason "Failed") | 5 min | No |
| `resolution-failed` | Subscription | `ResolutionFailed` is True, with a reason | 10 min from the condition's change | No |
| `resolution-failed-unnamed` | Subscription | The same without a reason (reason "ResolutionFailed") | 10 min | No |
| `install-plan-failed` | Subscription | `InstallPlanFailed` is True: its current InstallPlan failed | None | No |
| `install-plan-failed-unnamed` | Subscription | The same without a reason (reason "InstallPlanFailed") | None | No |
| `install-plan-stuck` | Subscription | `InstallPlanPending` is True with reason Planning, Installing or InstallPlanNotYetReconciled | 30 min from the condition's change | No |
| `catalog-not-ready` | CatalogSource | The registry's connection state is neither READY nor IDLE | 10 min from when Sextant first saw it | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only. It has no action of its own, and in particular nothing approves an InstallPlan
(ADR-0121): approving installs or upgrades an operator with cluster-wide permissions, and stays a `kubectl patch` or
console action.

## What it does not do

- It does not approve InstallPlans, create Subscriptions or uninstall operators.
- It does not resolve or recompute what OLM decides: every state shown is OLM's own verdict from the objects.
- It does not show an InstallPlan step's manifest: Sextant hides it from extensions (it may be a bundle's Secret).
- It does not request a ClusterCatalog's base URL or talk to a catalog's registry.
- It reports no problems of OLM v1, OperatorGroups or Operators, as the built-in view did not.

## Requirements and limits

- OLM's CRDs (OLM v0, OLM v1, or both); the section shows only the kinds the cluster serves.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - A Subscription's "InstallPlan failed" and "stuck" problems are about the Subscription; the built-in ones were
    about its InstallPlan, which the problems screen opened.
  - A stuck InstallPlan whose condition has no time counts from when Sextant first saw it; the built-in rule started
    again when the plan's phase moved.
  - The CSV phases Replacing and Deleting are drawn in the neutral colour (the built-in table muted them).
  - The State, Approved, Installed and Progressing columns sort by the text shown; the CSVs column joins the names as
    a list in the UI language ("a, b and c"), where the built-in one wrote them with commas.
  - "Only problems" on Subscriptions and Cluster Service Versions leaves out an object whose condition time does not
    read as a time; the built-in filter counted it at once.
  - The details are a titled section per kind (the built-in one had no title of its own); its blocks are always open
    when shown (the built-in panel remembered closed blocks), and a CSV's Deployments are watched while the section
    shows, open or closed.
  - The lists the details watch are not capped (the built-in view listed at most 50 Deployments of a CSV and 500
    Subscriptions of a namespace); each is narrowed to one namespace by name or OLM's labels.
- Checked by tests on fixtures of OLM's objects (copied from the built-in view) against the built-in readings and
  rules; not yet tried on a live cluster.

## Troubleshooting

- **No "Operators (OLM)" section:** the cluster serves none of OLM's kinds, or the extension is disabled.
- **A CSV's Deployments say "Cannot tell":** the extension may not read Deployments there, or the CSV's name is too
  long to be a label value (over 63 characters), so OLM could not have labelled them either.
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Operator Lifecycle Manager.
- **A copied CSV shows no requirements or Deployments:** they are its original's; follow the "Original" link.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/olm        # → extensions/olm/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/olm
```

- `src/main.ts` starts the details section the frame's context names: `details.ts` (Subscription, CSV, InstallPlan,
  and the watches they hold) or `views.ts` (the other kinds), drawn with the SDK's `ui` kit.
- `model.ts` reads OLM's fields; it is the former built-in view's model, ported, with its problem detector
  (`olmProblems`) and filter (`isProblem`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules, the kinds' "Only problems" and the columns with Sextant's own
  window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on
  the fixtures in `fixtures/`; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `olm`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `olm` and the
     commit (add `olm` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
