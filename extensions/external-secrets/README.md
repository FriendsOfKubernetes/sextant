# External Secrets

Views of [External Secrets Operator](https://external-secrets.io/) objects, in every language Sextant has. It lists
ExternalSecrets, ClusterExternalSecrets, SecretStores, ClusterSecretStores and PushSecrets in a sidebar section of
their own with Sextant's tables, tells each one's Ready state with the condition's reason and last error, an
ExternalSecret's store and whether that store is ready, the Secret it writes (a link), its refresh interval and last
sync and the remote keys it asks for by name, a store's provider and capabilities, a ClusterExternalSecret's
namespaces and a PushSecret's source Secret, stores and pushed keys, and counts failed syncs and invalid stores as
problems. It is read-only and never reads a Secret: Secrets are only linked. It replaces Sextant's former built-in
External Secrets view (ADR-0100) with the same behaviour. Its id is `sextant.external-secrets`. Why it is built this
way: ADR-0100 (the readings, the problems, never a Secret), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0152 (kinds in a section of its own), ADR-0153 (computed columns), ADR-0160 (the section's icon
and place, the UI kit), ADR-0161 (printer columns left out, paths picking a list item, notification groups),
ADR-0163 (a problem's reason from the object), ADR-0164 (case tooltips), ADR-0165 (a kind's own "Only problems") and
ADR-0167 (the counter's label by plural form).

## At a glance

| | |
|---|---|
| Id | `sextant.external-secrets` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `external-secrets-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → External Secrets |
| Checked against | External Secrets Operator's `external-secrets.io/v1` objects (`v1alpha1` PushSecrets) as the operator writes them (`apis/externalsecrets/v1/*_types.go`, `apis/externalsecrets/v1alpha1/pushsecret_types.go`) |

## What it adds

**A sidebar section "External Secrets"** (`externalSecrets`), shown while the cluster serves one of its kinds, with
the built-in section's icon, right after Kyverno's section: External Secrets, Cluster External Secrets, Secret Stores,
Cluster Secret Stores and Push Secrets, each with Sextant's own table, filters, selection bar and details. The
section's counter shows how many objects need attention (the problems below). "Only problems" shows every object whose
Ready condition is False, as the built-in tables did.

**Columns**, after Name (and Namespace), in place of the CRDs' own printer columns (left out, as the built-in view
did); every kind's **Status** is Ready, Failed or Pending from the Ready condition, coloured, with the condition's
reason and message on hover, and its **Reason** is the condition's reason:
- External Secrets: **Status** (`es-status`), **Store** (`es-store`: `<kind>/<name>` of `spec.secretStoreRef`,
  `SecretStore` when no kind is set), **Secret** (`es-target`: `spec.target.name`, else the ExternalSecret's own
  name), **Refresh** (`es-refresh`: `spec.refreshInterval`), **Last sync** (`es-last-sync`: the age of
  `status.refreshTime`) and **Reason** (`es-reason`).
- Cluster External Secrets: **Status** (`ces-status`), **Refresh** (`ces-refresh`: `spec.refreshTime`, how often it
  reconciles itself; the built-in column read `spec.refreshInterval`, which a ClusterExternalSecret does not have)
  and **Reason** (`ces-reason`).
- Secret Stores and Cluster Secret Stores: **Status** (`ss-status`, `css-status`), **Provider** (`ss-provider`,
  `css-provider`: the key of `spec.provider`), **Capabilities** (`ss-capabilities`, `css-capabilities`:
  `status.capabilities`) and **Reason** (`ss-reason`, `css-reason`).
- Push Secrets: **Status** (`ps-status`), **Source Secret** (`ps-source`: `spec.selector.secret.name`), **Stores**
  (`ps-stores`: the names of `spec.secretStoreRefs`), **Refresh** (`ps-refresh`), **Last sync** (`ps-last-sync`) and
  **Reason** (`ps-reason`).

**Details** (`external-secrets`, one section titled "External Secrets" on the five kinds, where the built-in section
was):
- **ExternalSecret**: its state, its store (a link) and the store's own state ("Loading…", Ready, Failed, Pending or
  "Store not found"; the store is watched by name while the details are open), the target Secret (a link; its data is
  never read), creation policy, refresh interval ("Fetched once" for 0) and last sync; the **Last error** (the Ready
  condition's message while it failed); the **Keys** by name: each Secret key with its remote key and property, and
  the keys taken in bulk (`dataFrom`: extract, find by name or tags, a generator).
- **ClusterExternalSecret**: its state, the ExternalSecret name it makes, refresh interval, the namespaces it was
  created in, the last error and the **Failed namespaces** with their reasons.
- **SecretStore** and **ClusterSecretStore**: its validation state and reason, provider, capabilities, refresh
  interval and the last error.
- **PushSecret**: its state, source Secret and stores (links), refresh interval, last sync, the last error and the
  **Pushed keys** by name.

The details are drawn with the SDK's UI kit, in the classes of Sextant's own details panel. Edit and Delete are
Sextant's own actions on every kind of the section; the extension adds no action.

## Permissions

- **Read** ExternalSecrets, ClusterExternalSecrets, SecretStores, ClusterSecretStores and PushSecrets (the details
  read the shown object and watch an ExternalSecret's store by name), in every namespace of every cluster.
- Nothing is changed or deleted, no log is read, and no Secret is read: the target and source Secrets are only linked
  to Sextant's own details, and "Secret values" is never asked for.
- Its problem rules judge the five kinds; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

On the five kinds, from Sextant's own watches of the whole objects. Each holds while the object is not being deleted
and its Ready condition is False (a failed sync, a store that does not validate), from the condition's last change,
with the condition's message; its reason is the condition's reason, or `NotReady` without one. There is no grace and
every problem may notify. The built-in rule is two rules per kind here (with and without a reason, as a rule's reason
has no fallback of its own); they never hold together, are one problem group (`not-ready`) and notify once per object.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `external-secret-failed`, `external-secret-failed-no-reason` | ExternalSecret | Ready is False (the sync failed) | None | No |
| `cluster-external-secret-failed`, `cluster-external-secret-failed-no-reason` | ClusterExternalSecret | Ready is False | None | No |
| `secret-store-failed`, `secret-store-failed-no-reason` | SecretStore | Ready is False (the store does not validate) | None | No |
| `cluster-secret-store-failed`, `cluster-secret-store-failed-no-reason` | ClusterSecretStore | Ready is False | None | No |
| `push-secret-failed`, `push-secret-failed-no-reason` | PushSecret | Ready is False (the push failed) | None | No |

Agents get these problems only when the user lets them (Settings → AI agents (MCP), ADR-0146); the built-in category
was never given to agents.

## Metrics

None.

## Commands

None.

## Changes it makes

None: it only reads. Edit and Delete are Sextant's own actions, asked and confirmed by Sextant as on any kind.

## What it does not do

- It never reads a Secret: not the target Secret an ExternalSecret writes, not a PushSecret's source, not a store's
  credentials. What was synced is told by key names from the spec only.
- It does not force a refresh, push, or validate a store, and does not talk to a provider: change the objects with
  Sextant's editor or `kubectl annotate … force-sync=…`.
- It does not show generators, ClusterGenerators or ClusterPushSecrets.

## Requirements and limits

- The External Secrets Operator CRDs, and the operator for the status to say anything.
- The columns and problems are computed by Sextant from field paths (ADR-0153, ADR-0137), so where the built-in view
  computed a value they read it as closely as fields allow; the details always show the full reading. Tests compare
  them with the built-in reading over every Ready condition, store and target reference, provider and store list:
  - **Provider** names the nine common providers (`aws`, `vault`, `gcpsm`, `azurekv`, `kubernetes`, `onepassword`,
    `bitwardensecretsmanager`, `doppler`, `infisical`) and says "Other" for the rest: a column cannot read a map's key,
    and takes ten cases at most. The details name every provider.
  - **Stores** of a PushSecret lists up to five stores, then the first five and "…"; a store picked by a label
    selector (no name) before a named one leaves only the first name. The details list every named store.
  - The status tooltip of a condition with an empty reason reads ": <message>" where the built-in left the colon out.
  - The tables sort the Status columns by their words in the UI language, where the built-in sorted by the state's
    name; the columns' widths are Sextant's defaults.
  - A problem's message is empty where the built-in had none; a Ready condition's time that is not a time is not the
    problem's start; the reason is cleaned and cut at 100 characters as every extension's.
  - The details have a section title ("External Secrets"), which the built-in section did not, and their tables are
    the UI kit's (not resizable).
- Problems are kept as Sextant keeps every extension's (at most 2000 objects with problems per kind and cluster).
- Checked by tests on fixtures of the operator's objects (a failed ExternalSecret, an invalid ClusterSecretStore, a
  synced PushSecret); not yet tried on a live cluster.

## Troubleshooting

- **No "External Secrets" section:** the cluster serves none of its kinds, or the extension is disabled.
- **"Sextant refused: …" in the details:** the extension's permissions do not cover the object. Check Settings →
  Extensions → External Secrets.
- **No "Store status" row:** the cluster does not serve the store's kind (SecretStore or ClusterSecretStore).
- **"Store not found":** no store of that name is there, or your credentials may not list stores.
- **No counter or no problems:** the problem rules need their own consent (Settings → Extensions → External Secrets),
  and the category can be turned off on the Problems page.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/external-secrets        # → extensions/external-secrets/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/external-secrets
```

- `src/main.ts` starts the one view, `details.ts` (the details section, drawn with the SDK's `ui` kit, and the watch of
  an ExternalSecret's store).
- `model.ts` reads External Secrets' fields: the former built-in model, ported, with the built-in problem rule
  (`externalSecretsProblems`, `isProblem`) as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules, "Only problems" and columns with Sextant's own window engine
  (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on every Ready
  condition and the fixtures in `fixtures/`; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they are the built-in view's `externalsecrets`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with
     `external-secrets` and the commit (add `external-secrets` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
