# Changes of Flux

## 1.3.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4) with the extension API's question placeholders and headless actions (ADR-0164,
#378, #379). The permissions are unchanged, so updating does not ask for consent again.

- **Suspend names its object.** Sextant asks "Suspend Kustomization podinfo?" and says what it means for that object,
  as the built-in view did ("Suspend {{kind}} {{name}}?", filled in by Sextant), in every language.
- **Reconcile with source has no window.** Its frame runs out of sight (`headless`): it reads the object, sends the
  source's, the HelmChart's and the object's patches in one call and ends, so nothing flashes up. A failure is a
  notice that names the object that failed and the error; your own refusal of a question of Sextant's ends it
  silently. The window, its waiting line and its Retry are gone.

## 1.2.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4) with the extension API's fixed-patch actions, field values in column cases and
problem reasons (#375). The actions and problems are now those of Sextant's former built-in Flux view.

- **Actions are one click again.** Reconcile now and Resume send their patch at once, on every selected object, with
  no window and no question; Suspend asks Sextant's own question ("Suspend this object?" and what it means), then
  sends. Sextant sends these patches itself (`patch` in the manifest). Reconcile with source still opens its window,
  because it reads the object to find its source, but sends at once, shows that it is waiting and closes itself once
  sent; a failure stays shown, names the object that failed and offers Retry.
- **No confirmation on top.** The rule that lets the extension modify Flux objects no longer asks Sextant's
  confirmation for every change (`confirm: false`): Suspend's question is the one question, as in the built-in view.
  Because the grant changed, **updating asks you to agree to the extension's permissions again.**
- **Alerts and Providers** have the Ready, Status and Revision columns of every other Flux kind, as the built-in
  tables had (empty for v1beta3 objects, which have no status).
- **Source column:** `Kind/name`, or `Kind/namespace/name` when the source is in another namespace, as the built-in
  table showed it (it showed the name only).
- **Problems:** the reason is Flux's own (the Ready condition's reason, such as `BuildFailed` or
  `BucketOperationFailed`) and the message is the Ready condition's whole message, no longer cut at 100 characters.

## 1.1.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4). Closer to Sextant's former built-in Flux view, through the extension API's
additions of ADR-0160 and ADR-0161.

- **The Flux section** has Flux's icon and comes right after Velero, where the built-in section was.
- **The command palette** searches Kustomizations and HelmReleases by default and takes `ks` and `hr` as their short
  names.
- **Columns:** the CRDs' printer columns are left out, so Ready and Status show once; the columns are placed by id in
  the built-in order in every language; Ready and Status read the Ready condition by its type; Status has the whole
  message as a tooltip; Suspended keeps its tones when translated.
- **Problems:** the message is the Ready condition's reason and message (it named the first condition); the grace
  counts from the Ready condition's last transition; the six rules share one notification group.
- **Actions:** Reconcile now and Resume on several objects, and Reconcile with source, send every patch in one call, so
  Sextant asks once; a refusal sends nothing.
- **Details** are drawn with the SDK's UI kit, as Sextant's details are; a Kustomization that applied nothing has no
  "Applied resources" section; inventory links open the version the inventory names.

## 1.0.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's built-in Flux view as an extension.

- **The Flux section** with Sextant's own tables of the 13 Flux kinds, and a counter of the objects with a problem.
- **Columns** Source, Ready, Status, Revision and Suspended.
- **Details:** the Flux fields of every object, a Kustomization's applied resources, a HelmRelease's resources and the
  Kustomizations and HelmReleases that use a source.
- **Actions:** Reconcile now, Reconcile with source, Suspend and Resume, each showing its patch first and confirmed
  by Sextant.
- **Problems:** a GitRepository, OCIRepository, HelmRepository, Bucket, Kustomization or HelmRelease that is not
  ready and not suspended or still reconciling, after 2 minutes.
- Installing it asks for consent: Read on the Flux kinds and on the kinds a Helm chart usually creates, Modify on the
  Flux kinds.
