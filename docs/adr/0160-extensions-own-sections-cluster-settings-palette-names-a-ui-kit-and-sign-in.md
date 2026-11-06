# ADR-0160: Extensions' own sections, cluster settings, palette names, a UI kit and Sextant's sign-in

## Context

Writing the Flux, Argo CD and Argo Rollouts extensions on the extension API 4 (ADR-0152–0159) showed what still
differed from the built-in views (#354–#358):
- a section without an icon or a place;
- no tab in a cluster's settings;
- kinds the palette does not search by default and knows no short names for;
- details drawn by each extension in its own way;
- an Argo CD sign-in whose password the extension sees and that is not remembered.

The user asked for these in 0.30.0, and for Sextant's shared controls, such as the namespace choice, in the SDK.

## Decision

- **`contributes.sections`** (`sextantApi` 4): `{section, title?, icon?, after?}`.
  - The section is the extension's own (a title makes it so, as a `sectionTitle` does).
  - `icon` is shown on its header, and `after` names one of Sextant's sections it comes right after
    (`placeSection`, `sectionOrder`). A Sextant section is never described by an extension.
- **`contributes.clusterSettings: {title}`** adds a tab of that title to a cluster's settings.
  - The tab shows the frame with the view `settings` and the contribution `clusterSettings`, the cluster as
    `clusterId`.
  - The protocol's views only grow by contribution ids, so a released SDK's view type still fits (ADR-0142).
- **Palette names.** `contributes.kinds[i].aliases` (lowercase short names) are kind prefixes in the palette;
  one Sextant uses is ignored. `searchByDefault` adds the kind to the default search, after Sextant's own kinds.
- **The UI kit** `@sextant/extension-sdk`'s `ui`. It is plain DOM in the classes and tokens of Sextant's details
  panel and axe-checked:
  - blocks: `block` (collapsible), `fields`, `table`, `status`, `chips`, `muted`, `pre`, `inline`, `objectLink`;
  - states: `empty`, `errorState`, `loading`;
  - controls: `button`, `searchInput`, `tabs`, and `namespaceSelect` (the cluster's namespaces when the extension may
    list them, else the window's).
- **Sign-in in Sextant's own dialog.**
  - A service may declare `signIn.fields` (id, label, secret).
  - `ui.signIn({namespace, service})` shows Sextant's dialog. The values go from the window straight to Rust through
    the window-only `extension_service_sign_in`, never through the frame.
  - The values are kept for the run. With "Remember" they also go to the keyring, as `extension:<id>:service-sign-in:
    <service>@<cluster>/<namespace>`, with the API server and CA they were typed for. A remembered sign-in counts only
    while both match (ADR-0029's binding).
  - A body value exactly `{{signIn:<field>}}` is filled in by Sextant, and the journal names only the field ids.
  - `service.forget` drops the run's values and the keyring entry. A new sign-in drops the session it made.

## Consequences

- The extensions' sections can sit where the built-in ones did, with their icons.
- The GitOps tab can move with them.
- The palette finds `hr`, `ks` and `app` as before once the extensions declare them.
- Moved views look like Sextant's own.
- An Argo CD sign-in typed by the user is as private and as lasting as with the built-in diff.
