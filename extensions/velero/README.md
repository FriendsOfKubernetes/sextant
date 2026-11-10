# Velero

Views and two create-only actions for [Velero](https://velero.io/), in every language Sextant has. It lists Velero's
Backups, Schedules, Restores, BackupStorageLocations and VolumeSnapshotLocations in a sidebar section of their own
with Sextant's tables, reads each one's state in plain words (why it was refused or failed, how many errors and
warnings it had, how far it got, whether a location is reachable), backs up a namespace and restores from a backup by
creating Velero's own Backup and Restore objects, each shown before it is created. It replaces the Velero part of
Sextant's former built-in storage insights (ADR-0086) with the same behaviour; volume usage, VolumeSnapshots and their
actions stay in Sextant. Its id is `sextant.velero`. Why it is built this way: ADR-0086 (storage actions only create
new objects; its amendment, `resources.create`), ADR-0139 (Sextant's own extensions), ADR-0140 (translations),
ADR-0152 (kinds in a section of its own), ADR-0153 (computed columns), ADR-0154 (action conditions), ADR-0160 (the
section's icon and place, the UI kit), ADR-0161 (printer columns left out), ADR-0164 and ADR-0165 (case values, list
cells, a kind's own "Only problems"), ADR-0167's amendments (text conditions, number keys read from a path, column
widths, untitled sections, blocks in Sextant's memory, actions that need served kinds).

## At a glance

| | |
|---|---|
| Id | `sextant.velero` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4 with `resources.create` (#412): Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `velero-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Velero |
| Checked against | Velero v1.x objects as the server writes them (`velero.io/v1`, the phases of `pkg/apis/velero/v1`) |

## What it adds

**A sidebar section "Velero"** (`velero`), shown while the cluster serves one of its kinds, with the built-in
section's icon, right after Volume Snapshots: Backups, Schedules, Restores, Backup Storage Locations and Volume
Snapshot Locations, each with Sextant's own table, filters, selection bar and details. "Only problems" on each table
shows the objects that failed, partly failed, were refused or cannot reach their storage (phase `Failed`,
`FailedValidation`, `Unavailable` or one ending in `PartiallyFailed`), as the built-in tables did.

**Columns**, after Name and Namespace, in place of the CRDs' own printer columns (left out, as the built-in view
did), each as wide as the built-in one. Every **Phase** is coloured as before: Completed, Enabled and Available
green, partly failed amber, failed, refused and unavailable red, the phases on their way (and any other) muted.
- Backups: **Namespaces** (`backup-namespaces`: `spec.includedNamespaces`, `*` for every namespace), **Phase**
  (`backup-phase`), **Errors** (`backup-errors`, red when there are any, 0 when Velero wrote none; sorted and filtered
  as a number), **Warnings** (`backup-warnings`, amber when there are any) and **Completed** (`backup-completed`: the
  age of its completion).
- Schedules: **Schedule** (`schedule-schedule`: the cron expression), **Namespaces** (`schedule-namespaces`: the
  template's), **Paused** (`schedule-paused`: "true" while paused, else blank), **Phase** (`schedule-phase`) and
  **Last backup** (`schedule-last-backup`: its age).
- Restores: **Backup** (`restore-backup`: the backup, else the schedule it restores from), **Phase**
  (`restore-phase`), **Errors** (`restore-errors`) and **Warnings** (`restore-warnings`).
- Backup Storage Locations: **Provider** (`location-provider`), **Bucket** (`location-bucket`), **Default**
  (`location-default`: "true" for Velero's default location, else blank), **Phase** (`location-phase`) and
  **Validated** (`location-last-validated`: the age of its last validation).
- Volume Snapshot Locations: **Provider** (`snapshot-location-provider`) and **Phase** (`snapshot-location-phase`).

**Details:** **Velero** (`velero`, a section of all five kinds, after the fields; one block titled "Velero", open by
default and closable with its title, kept in Sextant's memory of details sections with "Expand all" and "Collapse
all", as the built-in block was): the state in plain words — why Velero refused it (its validation errors), why it
failed, how many errors and warnings it had and which `velero … logs` command holds the details, how many items are
done while it runs, that Velero is deleting it, that a Schedule is paused, why a location is unavailable — and the
fields that matter: a Backup's phase, namespaces, TTL, storage location (a link), start, completion and expiry; a
Restore's phase, backup and schedule (links), start and completion; a Schedule's phase, cron expression, namespaces,
TTL and the age of its last backup; a location's phase, provider, bucket, prefix, access mode (Backup Storage
Locations) and last validation. Conditions, events and YAML are Sextant's own sections. Drawn with the SDK's UI kit,
in the classes of Sextant's own details panel.

**Actions**, in "Actions":
- **Back up namespace…** (`back-up-namespace`, on a Namespace that is not terminating, where the cluster serves
  Velero's Backups): a window with the backup's name (the namespace and the time, `shop-20261019-1432`), Velero's
  namespace (read-only: where Velero's default BackupStorageLocation is, else its first one, else `velero`, the
  locations taken in the order the watch delivered them, as the built-in dialog took them), how long to keep it (TTL,
  Velero's default 720h0m0s) and the storage location (Velero's default, or one of its locations), then the
  confirmation. The name has the focus.
- **Restore from this backup…** (`restore-backup`, on a Backup that Velero is not deleting): a window with the
  restore's name and, for a backup of named namespaces, the namespace to restore each one into (empty: the same
  one); it warns when the backup is not Completed. The name has the focus. Then the confirmation.

Edit and Delete are Sextant's own actions on every kind of the section.

## Permissions

- **Read** Backups, Schedules, Restores, BackupStorageLocations and VolumeSnapshotLocations (the details, the
  Restore window's read of its backup, and the Backup window's watch of the storage locations), in every namespace of
  every cluster.
- **Modify** Backups and Restores: `resources.create` of the one object each window shows. Sextant does not ask
  again (`confirm: false`): the window's confirmation lists the object and its YAML and is the one question, as the
  built-in dialogs were. Sextant still checks the object against the extension's grants and journals it.
- Namespaces are not read: "Back up namespace…" takes the namespace's name from the selection.
- Nothing is deleted, patched or applied, and no logs, Secrets, commands or metrics are asked for.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

None. The built-in view had no problem category for Velero either: "Only problems" on its tables comes from the
kinds' own condition (`problemWhen`), and the section has no counter.

## Metrics

None.

## Commands

None.

## Changes it makes

Only the two actions change anything, and only by creating one new object; nothing that exists is ever changed.
Each window is a form, then a confirmation that lists the object — kind, namespace and name ("Backup
velero/shop-20261019-1432"), what Velero does with it, and its YAML — and creates exactly that object with one
`resources.create` (#412) when "Create" is pressed. The object goes into Velero's namespace: a Backup where Velero's
storage locations are, a Restore where its Backup is.
- A **Backup** names the one namespace (`spec.includedNamespaces`), its TTL and, when chosen, the storage location.
  Velero backs up every object of the namespace and, where it is set up for that, its volumes; the backup runs in
  Velero, not in Sextant.
- A **Restore** names the backup and, when a namespace is restored under another name, `spec.namespaceMapping` with
  only the namespaces that change. With `existingResourcePolicy` unset, Velero skips most objects that already exist
  (some kinds, such as ServiceAccounts, are merged) and counts them as warnings of the restore; the confirmation says
  so.

A name already taken — also by an object made after the form was filled — is refused by the API server (`conflict`)
and the object there is left as it was; the window says "… already exists: nothing was changed." Nothing reaches the
cluster before "Create", a failure stays in the window, and nothing is retried.

## What it does not do

- It does not create, pause or change Schedules, storage locations or snapshot locations, and does not delete
  backups (Sextant's Delete removes the Backup object; Velero's `DeleteBackupRequest` is not made).
- It does not set restore options beyond the namespace mapping (resource filters, `existingResourcePolicy`, PV
  restore), and backs up exactly one namespace: use the `velero` CLI or Sextant's editor for more.
- It does not read Velero's logs or its object storage: the details name the `velero backup logs` /
  `velero restore logs` command.
- It does not show volume usage, VolumeSnapshots or their actions, which stay in Sextant.

## Requirements and limits

- Velero's CRDs, and Velero's server for anything to happen to the objects created.
- Checked by tests on fixtures of Velero's objects; not yet tried on a live cluster.

## Troubleshooting

- **No "Velero" section:** the cluster serves none of its kinds, or the extension is disabled.
- **"No BackupStorageLocation was found: Velero may not be set up."** in the backup window: no location is there, or
  the extension may not read them; the Backup then goes into `velero`.
- **"Sextant refused: …" in a window:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Velero.
- **"… already exists: nothing was changed.":** pick another name and confirm again.
- **A backup or restore stays New:** Velero's server does not run, or does not watch that namespace.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/velero        # → extensions/velero/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/velero
```

- `src/main.ts` picks the view by the frame's context: `details.ts` (the details section, drawn with the SDK's `ui`
  kit) or `actions.ts` (the two windows).
- `model.ts` reads Velero's fields (phases and their tones, the plain words, Velero's namespace); `forms.ts` builds
  the two objects and checks names and TTLs; `yaml.ts` is Sextant's own YAML writer. All are the former built-in
  view's, ported.
- `model.test.ts` judges the manifest's columns, the kinds' "Only problems" and the actions' conditions with Sextant's
  own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model,
  on the fixtures in `fixtures/`; `views.test.ts` drives the details and the windows through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `storage`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `velero` and the
     commit (add `velero` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
