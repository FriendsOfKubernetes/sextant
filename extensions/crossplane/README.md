# Crossplane

Read-only views of [Crossplane](https://www.crossplane.io) (`apiextensions.crossplane.io`, `pkg.crossplane.io`, and
the kinds its XRDs define), in every language Sextant has. It lists Composite Resource Definitions, Compositions,
Providers, Configurations and Functions in a sidebar section of their own with Sextant's tables; lists every claim and
composite resource of the kinds the XRDs define on the page "Composite Resources", with Synced, Ready and the first
condition that fails; explains each state in plain words; and follows the chain Claim → composite → composed (managed)
resources by the references Crossplane writes, in the details of claims, composites and managed resources whatever
their kind; and tells the claims and composites that need attention on the Problems page, in notifications and on
the section's counter. It replaces Sextant's former built-in Crossplane view (ADR-0101) with the same views and the
same problems; what still differs is in "Requirements and limits". Its id is `sextant.crossplane`. Why it is built this
way: ADR-0101 (the readings, both Crossplane layouts, a paused resource being no failure), ADR-0137 (problem rules, and
their amendment: kinds read from definitions, `kindsFrom`), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0143 (the section's counter), ADR-0152 (kinds in a section of their own), ADR-0153 (computed
columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths picking an
item), ADR-0165 (a kind's own "Only problems") and ADR-0167 (column widths, match steps with `!=`, untitled details
sections hidden until shown, a details section on every kind of a custom resource group, capped watches, details blocks
in Sextant's own memory, `kindsVersion`, the UI kit's checkbox and resizable tables, more definitions than a
`kindsFrom` reads).

## At a glance

| | |
|---|---|
| Id | `sextant.crossplane` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `crossplane-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Crossplane |
| Checked against | Crossplane's own types: `apiextensions.crossplane.io/v1` XRDs and Compositions, `pkg.crossplane.io/v1` packages, claims and composites of v1 (`spec.resourceRef(s)`, `spec.claimRef`) and v2 (`spec.crossplane.*`), crossplane-runtime's `crossplane.io/paused` and `ReconcilePaused` |

## What it adds

**A sidebar section "Crossplane"** (`crossplane`), shown while the cluster serves any of its kinds, with the built-in
section's icon and place (after Contour), and a counter of the claims and composites that need attention (the active
problems of the rules below, as the built-in counter counted them): the page Composite Resources, then Composite Resource Definitions,
Compositions, Providers, Configurations and Functions, each with Sextant's own table, filters, selection bar and
details, and Edit and Delete as on every kind.

**The page "Composite Resources"** (`composites`): every claim and composite resource of the kinds the XRDs define
(the composite and claim kinds of the first 20 XRDs by name that the cluster serves), with its kind and role, name and
link, namespace, state (Failed, Progressing, Unknown, Paused or Ready, coloured), Synced, Ready, the first failing
condition's reason and message, and Composition; problems first, then by kind, namespace and name; "Only problems"
(Sextant's own checkbox) leaves out all but the failed ones. Its columns resize as the built-in page's did, and Sextant
remembers their widths (Settings → Appearance resets them with every table's). It shows at most 500 rows; each claim or composite list is
kept to 5000 objects by Sextant, and the page says when it lists only a part or only the first XRDs' kinds. The lists
are watched only while the page shows; a kind an XRD defines that the cluster does not serve yet is looked up again a
second after the XRDs change, and every kind again when the cluster's kinds change (a CRD installed or removed).

**"Only problems"** on Providers, Configurations and Functions, as the built-in tables had it: a package whose
`Installed` or `Healthy` is False.

**Columns**, after Name, in place of the CRDs' own printer columns (left out, as the built-in view did), each with the
built-in column's width and sort order:
- Composite Resource Definitions: **Composite kind** (`xrd-composite`), **Claim kind** (`xrd-claim`: none when the XRD
  defines no claim), **Established** (`xrd-established`) and **Offered** (`xrd-offered`): the condition's status,
  True green, False red, Unknown amber.
- Compositions: **Composite type** (`composition-type`: `<Kind>.<apiVersion>` of `spec.compositeTypeRef`) and
  **Mode** (`composition-mode`: `spec.mode`, else Pipeline with pipeline steps, else Resources).
- Providers, Configurations and Functions: **Status** (`provider-status`, `configuration-status`,
  `function-status`: Failed, Ready, Progressing or Unknown from `Installed` and `Healthy`, coloured, sorted and
  filtered by the state's name in every language), **Package** (`provider-package`, `configuration-package`,
  `function-package`: `spec.package`, whole on hover), **Installed** (`provider-installed`, `configuration-installed`,
  `function-installed`) and **Healthy** (`provider-healthy`, `configuration-healthy`, `function-healthy`).

**Details**, untitled sections as the built-in ones were, drawn with the SDK's UI kit in the classes of Sextant's own
details panel. Their blocks open and close with their titles and are remembered in Sextant's own memory of details
sections (Settings → Appearance), with the panel's "Expand all" and "Collapse all":
- **Crossplane's own kinds** (`crossplane`, order 20, where the generic fields go): one block titled with the kind. An
  XRD's group, composite and claim kinds, versions with their flags (served, referenceable), default Composition,
  Established and Offered, and what that means in plain words; a Composition's composite type, mode, number of classic
  resources and its pipeline's steps with links to their Functions; a package's state in plain words, its first failing
  condition, package, current revision and package, revision activation, Installed and Healthy.
- **Claims, composite resources and managed resources** (`crossplane-resource`, order 21, on every kind of a custom
  resource group — a group with a dot, not Kubernetes' own — as the built-in section was on kinds of installed APIs;
  hidden until it has something to show, and reading nothing on Crossplane's own kinds). A claim or composite is told by the XRDs (watched where the cluster
  serves them, while its first block is open, or the chain block is and the object is known to be one; their kind
looked up again when the cluster's kinds change), a managed
  resource by its shape (`spec.forProvider` or `spec.providerConfigRef`). A claim's or composite's block: its state in
  plain words (paused is the user's choice, not a failure), the first failing condition, role, Synced, Ready,
  Composition, the composite's claim and the connection Secret, each a link; then **Resources**: the chain Claim →
  composite → composed resources, each with Synced, Ready and its first failing message, "Not found" or "Cannot be
  read", at most 30 composed resources ("Not shown: N" for the rest), read once per change of the shown object (and of
  the claim's composite), 4 at a time, each shown as it comes, only while the block is open. A managed resource's block: its state, the first failing
  condition, Synced, Ready, ProviderConfig, external name, deletion policy, management policies, the composite it
  belongs to (its controller, a link) and its claim. When the XRDs cannot be read, the block says why.

Every object named is a link to its details in Sextant's panel.

## Permissions

- **Read** every kind in every namespace of every cluster: claims, composite resources and managed resources are of
  kinds the XRDs and providers define, unknown until the cluster is read. The extension reads only Crossplane's own
  kinds, the kinds the XRDs define, the object shown in the details when its kind is of an installed API, and the
  objects a claim's or composite's references name (a Secret comes without its
  values, as always). It has no grant to read Secret values.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge the kinds the CompositeResourceDefinitions define (the API group at `.spec.group`, the kinds
  at `.spec.names.kind` and `.spec.claimNames.kind` of the first 20 by name); Sextant asks for that separately at
  install, in those words, and reads the XRDs itself to find the kinds.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `crossplane`, on by default, now the extension's own category "Crossplane" (the setting moves
over by itself). The rules judge the claims and composite resources of the kinds the first 20 XRDs by name define, as
Sextant finds them in the cluster (`kindsFrom`: the API group at `.spec.group`, the kinds at `.spec.names.kind` and
`.spec.claimNames.kind`), each object by its own fields. A paused one (`crossplane.io/paused: "true"`, or `Synced`
False with reason `ReconcilePaused`) has none, and neither has a composite that names its claim (`spec.claimRef`, or
`spec.crossplane.claimRef` in Crossplane v2): the claim tells it. Every rule may notify, and all of them notify once
per object (group `not-ready`). Of the rules at most one holds: the one of the condition that fails first as the
built-in view read it (`Synced` first, then the first other False condition but `Ready`, `Ready` last), its reason the
condition's own (else the fallback named below), its message the condition's, counted from the condition's
`lastTransitionTime` (else from when Sextant first saw it). With more than 20 XRDs, or a claim or composite list Sextant
capped at 5000 objects, the Problems page says it shows a part, as the built-in category did.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `not-synced` | The XRDs' kinds | `Synced` is False (Crossplane cannot reconcile it), with its reason, else "Synced=False" | 2 min | A composite by its claim |
| `not-ready-condition` | The XRDs' kinds | `Synced` is not False, `Ready` is False for another reason than Creating or Deleting, and another condition is False with a reason: the first in the object's list, with its reason | 2 min | A composite by its claim |
| `not-ready-condition-unnamed` | The XRDs' kinds | The same without a reason: "`<type>`=False" | 2 min | A composite by its claim |
| `not-ready` | The XRDs' kinds | `Ready` is False for another reason than Creating or Deleting and no other condition is, with `Ready`'s reason, else "Ready=False" | 2 min | A composite by its claim |
| `creating-condition` | The XRDs' kinds | Still being created (`Ready` False with Creating or Deleting, or neither True nor False while a condition is there) and another condition is False, not with reason Deleting: its reason, else "Creating" | 30 min | A composite by its claim |
| `creating` | The XRDs' kinds | Still being created with no other condition False, not being deleted: "Creating", from `Ready`'s change when it is False | 30 min | A composite by its claim |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0101).

## What it does not do

- It does not install, upgrade or configure Crossplane or its packages, run `crossplane` or `kubectl crossplane`, or
  render Compositions: every value comes from the objects' own fields.
- It does not read ProviderRevisions, ConfigurationRevisions, FunctionRevisions, EnvironmentConfigs or Usages.
- It does not judge a managed resource's provider-side state beyond Synced and Ready.

## Requirements and limits

- Crossplane's CRDs; the section shows only the kinds the cluster serves, and the page only XRDs' kinds the cluster
  serves.
- Where it differs from the former built-in view:
  - **Read on every kind**, asked at install. The built-in view read with your own access; the extension reads with it
    too, but only within what you grant it. It cannot ask for less without showing less: a composite resource
    composes objects of any kind (Crossplane v2 composes Deployments, Services and the like, not only managed
    resources), and its chain reads each of them, as the built-in did. What a narrower grant leaves out shows as
    "Cannot be read".
  - On objects Crossplane never writes the rules can read otherwise: a condition without a `type` or with a status that
    is no text counts in the rules' "first other False condition" and its `status` match, where the built-in left it
    out; a claim reference whose names are blank text, or a reason that is an empty text (`""` was the built-in's
    reason, the rules give the fallback); an XRD without a group or kind still counts among the first 20 by name,
    where the built-in skipped it first. Crossplane always writes a type, a status and a reason, and its XRDs' schema
    requires the group and kind.
- Checked by tests on fixtures of Crossplane's objects (copied from the built-in view) against the built-in readings;
  not yet tried on a live cluster.

## Troubleshooting

- **No "Crossplane" section:** the cluster serves none of Crossplane's kinds, or the extension is disabled.
- **"No XRDs: the cluster defines no composite resources." on the page:** the cluster has no XRDs, or the extension may
  not list them.
- **No claim, composite or managed resource block in an object's details:** no XRD defines its kind and it has neither
  `spec.forProvider` nor `spec.providerConfigRef`, or its block is closed.
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Crossplane.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/crossplane        # → extensions/crossplane/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/crossplane
```

- `src/main.ts` starts the view the frame's context names: `details.ts` (the details sections, the XRD watch and the
  chain's reads; drawn by `views.ts`) or `page.ts` (the page and its watches). `dom.ts` keeps the blocks in Sextant's
  memory (`BlockMemory`).
- `model.ts` reads Crossplane's fields; it is the former built-in view's model, ported, with its problem category
  (`builtInProblems`, its `toProblems`) kept as the reference of the rules.
- `model.test.ts` judges the packages' "Only problems" and every column with Sextant's own window engine
  (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on the fixtures in
  `fixtures/` and variants of them; `problems.test.ts` registers the rules as Sextant's window does
  (`src/features/problems/extensionCategories.ts`, the `kindsFrom` detector) and compares every problem the window's
  `resolve` gives with `builtInProblems` on every combination of Synced, Ready, another condition, a pause and a claim
  reference; `views.test.ts` drives the details and the page through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `crossplane`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `crossplane` and the
     commit (add `crossplane` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
