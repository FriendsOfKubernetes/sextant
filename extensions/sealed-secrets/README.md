# Sealed Secrets

Read-only views of [Bitnami Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) (`bitnami.com`), in every
language Sextant has. It lists SealedSecrets in a sidebar section of their own with Sextant's table; tells the
controller's Synced state with its error in plain words, the scope a SealedSecret was sealed for, the target Secret and
how it stands to the SealedSecret (from its metadata only), the sealed keys by name and sealed size, and the controller
found in the cluster with its sealing keys (metadata only; the certificate is never read). Failed unseals and synced
SealedSecrets whose Secret is missing are problems of an opt-in category. No value, sealed or decrypted, is ever shown. It replaces Sextant's former built-in Sealed
Secrets view (ADR-0109) with the same behaviour; the few places where the extension API cannot say exactly the same
are in "Requirements and limits". Its id is `sextant.sealed-secrets`. Why it is built this way: ADR-0109 (the readings,
the problems and the rule that Secrets are read as metadata only), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0152 (kinds in a section of their own, `not`), ADR-0153 (computed columns), ADR-0160 (the
section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths picking an item), ADR-0163 (a
problem's reason), ADR-0164 (a case's own value), ADR-0165 (a kind's own "Only problems") and ADR-0167 (the counter's
own label, problem categories of the extension's own, column widths and sort keys, offsets, counts in conditions,
untitled details sections, details blocks in Sextant's own memory).

## At a glance

| | |
|---|---|
| Id | `sextant.sealed-secrets` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `sealed-secrets-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Sealed Secrets |
| Checked against | bitnami-labs/sealed-secrets' own types and controller (`pkg/apis/sealedsecrets/v1alpha1/types.go`, `sealedsecret_expansion.go`, `pkg/controller/controller.go`), kubeseal's defaults and the Helm chart's labels |

## What it adds

**A sidebar section "Sealed Secrets"** (`sealedSecrets`), shown while the cluster serves SealedSecrets, with the
built-in section's icon and place (after Crossplane): Sealed Secrets, with Sextant's own table, filters, selection bar
and details, and Edit and Delete as on every kind. The section's counter shows how many SealedSecrets have a problem (a
failed unseal, a missing Secret), only while the opt-in category below is on.

**"Only problems"**, as the built-in table had it: SealedSecrets whose Synced condition is False for the current
generation.

**Columns**, in place of the CRD's own printer columns (left out, as the built-in view did), after Namespace, each with
the built-in column's width, sort order and filter:
- **Status** (`status`): Synced in green, Pending in amber (no status yet, or a status of an older generation:
  `status.observedGeneration` behind `metadata.generation`), Failed in red; the controller's message on hover; sorted
  and filtered by the state's name, `ready`, `progressing` or `failed`, in every language.
- **Scope** (`scope`): Strict, Namespace-wide or Cluster-wide, from the SealedSecret's own annotations
  `sealedsecrets.bitnami.com/cluster-wide` and `…/namespace-wide` (each only when exactly `"true"`, cluster-wide
  first), as the controller reads them; sorted and filtered by `strict`, `namespaceWide` or `clusterWide`.
- **Keys** (`keys`): how many keys `spec.encryptedData` seals, a number (0 without any).
- **Message** (`message`): the Synced condition's message.

**Details** (`sealed-secret`), untitled, in the built-in section's place (before the conditions), drawn with the SDK's
UI kit in the classes of Sextant's own details panel:
- the fields: Status (the controller's message on hover), Since and Last checked (the condition's times), Generation
  ("2 of 3 observed by the controller"), Scope in words ("Strict: unseals only under this name in this namespace"),
  Secret (a link to the target Secret, which always has the SealedSecret's name), Secret state — read by name in the
  SealedSecret's namespace, metadata only, while the section shows: managed by this SealedSecret, taken over
  (annotation `managed`), patched (annotation `patch`), controlled by another object, not managed, not found, or
  "Cannot tell" where it cannot be read — and the template's Secret type, Immutable and Owner reference;
- **Last error**: the controller's error and what it means (no key decrypts it, a Secret of that name not managed by
  it, an immutable Secret, the deprecated `spec.data`); without an error, a note when the controller has written no
  status, when the status is of an older generation, or when the deprecated `spec.data` is used;
- **Keys**: the sealed keys by name and sealed size (from the base64 text's length, never decoded), and the template's
  keys by name (`(left out)` for one set to null) — never a value;
- **Controller**: the Deployments found by kubeseal's default name (`sealed-secrets-controller` in `kube-system`) and
  by the Helm chart's label (`app.kubernetes.io/name=sealed-secrets`), each a link with its ready replicas and images,
  or a note when none is found or the Deployments cannot be read; inside it **Sealing keys**: the Secrets labelled
  `sealedsecrets.bitnami.com/sealed-secrets-key` in the controllers' namespaces (at most 5), metadata only, newest
  first, each a link with its state (`active`, `compromised`) and creation time.

The blocks open and close as the built-in ones (open at first, remembered in Sextant's own memory of details sections,
with the panel's "Expand all" and "Collapse all"); a closed block draws and watches nothing: the Deployments are
watched only while "Controller" is open, the sealing keys only while "Sealing keys" is open too. The tables keep the
built-in ones' columns on one line (an image list wraps between words); their columns resize, and Sextant remembers
their widths, as the built-in tables did.

## Permissions

- **Read** SealedSecrets, Secrets and Deployments in every namespace of every cluster: the details read the shown
  SealedSecret; Secrets are only ever watched as metadata (the target Secret by name, the sealing keys by their label),
  and Deployments to find the controller.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge SealedSecrets and, to tell whether a SealedSecret's Secret exists, list Secrets by name —
  metadata only, never a value; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `sealedSecrets`: the extension's own category **Sealed Secrets** (`sealed-secrets`), opt-in —
off until turned on on the Problems page, because it lists every SealedSecret of a cluster and the metadata of the
Secrets in their namespaces.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `sync-failed` | SealedSecret | Synced is False for the current generation (not while it is being deleted); reason `SyncFailed`, the controller's error as the message, notified | 5 minutes after the condition changed (the controller retries with a back-off) | No |
| `target-missing` | SealedSecret | Synced is True for the current generation, but no Secret of its name exists in its namespace (not while it is being deleted); reason `TargetMissing`, "Says it is synced, but its Secret … does not exist.", notified. Judged only where the Secrets are listed in full: a list that is loading, failed, capped or not readable there is "cannot tell", never a problem | 2 minutes after it is first seen (the controller recreates an owned Secret on its deletion) | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0109).

## What it does not do

- It never shows a value, sealed or decrypted: of `spec.encryptedData` only key names and sizes, of the template's
  data only key names. It never reads a Secret's data, the target's or a sealing key's, and never the controller's
  certificate, which lives in the same Secret as the private key.
- It does not seal, re-encrypt or rotate anything, run kubeseal, or ask the controller for anything.
- It does not install or upgrade the controller.

## Requirements and limits

- The Sealed Secrets CRD (`bitnami.com/v1alpha1`); the section shows only where the cluster serves it. A controller
  under another name or label than kubeseal's default and the Helm chart's is not found.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - To tell a missing Secret, Sextant lists Secrets (metadata only) in the namespaces of the SealedSecrets that say
    they are synced (`narrowLookups`), as the built-in did, within those the extension may read. Past 40 such
    namespaces it lists them in every namespace the extension may read, at most 5000, and beyond that it cannot tell;
    the built-in stopped at 20 namespaces and then could not tell at all.
  - The table's search finds Status and Scope by the words shown (Synced, Cluster-wide); the built-in matched their
    names (`ready`, `clusterWide`). Filters still go by the names.
  - The extension's permission reads Secrets in every namespace; it only ever watches their metadata, as the built-in
    view did, but the grant itself does not say "metadata only".
- Checked by tests on fixtures of Sealed Secrets objects (copied from the built-in view) against the built-in readings
  and rule; not yet tried on a live cluster.

## Troubleshooting

- **No "Sealed Secrets" section:** the cluster does not serve SealedSecrets, or the extension is disabled.
- **The counter shows nothing:** the category "Sealed Secrets" is off; turn it on on the Problems page.
- **"No controller found":** the controller runs under another name than `sealed-secrets-controller` in `kube-system`
  and without the Helm chart's label.
- **"Cannot tell" in Secret state:** the Secret cannot be read in that namespace with your credentials.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Sealed Secrets.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/sealed-secrets        # → extensions/sealed-secrets/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/sealed-secrets
```

- `src/main.ts` starts the details section; `details.ts` draws it with the SDK's `ui` kit and holds its watches (the
  target Secret, the controllers, the sealing keys); `dom.ts` keeps the blocks in Sextant's memory (`BlockMemory`)
  and formats dates and sizes as Sextant does.
- `model.ts` reads the Sealed Secrets fields; it is the former built-in view's model, ported, with its problem
  detector (`builtInProblems`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rule, the kind's "Only problems" and the columns with Sextant's own
  window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on
  the fixtures in `fixtures/` and variants of them (every Synced status, message and generation shape, scopes, keys,
  deletion); `views.test.ts` drives the details through the SDK's test host, blocks included.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's
  `sealedsecrets` texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every
  language of Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `sealed-secrets`
     and the commit (add `sealed-secrets` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
