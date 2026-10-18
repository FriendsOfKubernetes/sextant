# Updating the deprecation table

`deprecations.json` is the built-in table of deprecated and removed Kubernetes API versions that the "Upgrade
readiness" page (#142) checks a cluster against. It is data in the repository, not fetched at run time, so it has to
be kept current by hand: **review it for every Kubernetes minor release.**

## Each Kubernetes release

1. Read the release's section of the Deprecated API Migration Guide,
   <https://kubernetes.io/docs/reference/using-api/deprecation-guide/>, and the "Deprecations and removals" part of the
   release notes.
2. For every API version that the release stops serving, add an entry:

   ```json
   { "group": "batch", "version": "v1beta1", "kind": "CronJob", "deprecatedIn": "1.21", "removedIn": "1.25", "replacement": "batch/v1" }
   ```

   - one entry per group, version and kind (the core group is `""`);
   - `deprecatedIn`: the release from which the API server marks the version deprecated (its `Warning` header says
     "deprecated in v1.X+");
   - `removedIn`: the first release that no longer serves it;
   - `replacement`: the `group/version` the guide names (same kind). When the replacement is itself removed later,
     keep the guide's value: the page follows the chain to the version valid at the chosen target. When nothing
     replaces it, write `null` and a `note` whose text is `upgrade:notes.<note>` in `src/locales/*/upgrade.json`
     (translate it into every language).
3. Keep the order: by `removedIn`, then group, version and kind.
4. Raise `reviewedFor` to the release you reviewed, even when it removed nothing.
5. Run `npx vitest run src/features/upgrade`: `table.test.ts` checks the fields, the order, duplicates and notes.

Only APIs a cluster serves by default belong here; alpha APIs and betas that are off by default do not.
