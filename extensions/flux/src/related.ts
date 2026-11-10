// What a Flux object is related to, as Sextant's built-in Flux view showed it:
// - "Applied resources" of a Kustomization: `status.inventory`, as links;
// - "Resources" of a HelmRelease: its inventory (Flux 2.8+) and the objects helm-controller labelled with its name and
//   namespace, of the kinds a chart usually creates, only in its target and storage namespaces, metadata only;
// - "Used by" of a source: the Kustomizations and HelmReleases, in any namespace the extension may read, that take
//   their artifact from it.
// A kind the user may not list is said so and the other kinds stay; any other failure is shown with Retry. Drawn by the
// SDK's UI kit, as Sextant's details are; an empty inventory hides its section, as the built-in view showed none.
import { ui, type KubeObject, type Sextant, type WatchParams } from "@sextant/extension-sdk";
import { element, errorBox, objectLink, sectionHider } from "./dom";
import { followObject } from "./fields";
import {
  helmReleaseNamespaces,
  helmReleaseSelector,
  HELM_GROUP,
  inventoryOf,
  KUSTOMIZE_GROUP,
  LABELLED_KINDS,
  refKey,
  refOf,
  usesSource,
  type FluxRef,
} from "./flux";
import { i18n, t } from "./i18n";
import { servedKinds, watchLists, type LiveList } from "./live";

const byKey = (a: FluxRef, b: FluxRef) => refKey(a).localeCompare(refKey(b));

/** Kind, name (a link to its details) and namespace of each object. */
export function refTable(sextant: Sextant, refs: FluxRef[]): HTMLElement {
  return ui.table(
    [t("related.kind"), t("related.name"), t("related.namespace")],
    refs.map((r) => [r.kind, objectLink(sextant, r), r.namespace ?? ""]),
    // Resized and kept by Sextant as the built-in view's table was.
    { id: "details", sextant },
  );
}

function retryBox(message: string, retry: () => void): HTMLElement {
  return element("div", { className: "failure" }, ui.errorState(message), ui.button(t("related.retry"), retry));
}

const loadingLine = () => ui.loading(t("related.loading"));
const note = (text: string) => ui.empty(text);

// ---------- A Kustomization's inventory ----------

export function inventoryView(sextant: Sextant, obj: KubeObject): HTMLElement {
  const refs = inventoryOf(obj);
  return refs.length > 0 ? refTable(sextant, refs) : note(t("related.nothingApplied"));
}

/** What a Kustomization applied; the section hides while it applied nothing. */
export function startInventory(sextant: Sextant, root: HTMLElement): () => void {
  const hide = sectionHider(sextant);
  return followObject(sextant, root, (obj) => {
    hide(inventoryOf(obj).length === 0);
    root.replaceChildren(inventoryView(sextant, obj));
  });
}

// ---------- A HelmRelease's resources ----------

/** The inventory, then the labelled objects not in it; what could not be listed under the table. */
export function resourcesView(sextant: Sextant, obj: KubeObject, lists: Record<string, LiveList>, retry: () => void): HTMLElement {
  const inventory = inventoryOf(obj);
  const known = new Set(inventory.map(refKey));
  const labelled = LABELLED_KINDS.flatMap((kind) =>
    (lists[kind.kind]?.items ?? []).map((o) => refOf(o, kind)).filter((r) => !known.has(refKey(r))),
  ).sort(byKey);
  const results = LABELLED_KINDS.map((kind) => ({ kind: kind.kind, list: lists[kind.kind] })).filter(
    (r): r is { kind: string; list: LiveList } => r.list !== undefined && r.list.ready,
  );
  const notAllowed = results.filter((r) => r.list.error?.code === "forbidden").map((r) => r.kind);
  const partly = results
    .filter((r) => r.list.error === null && r.list.forbiddenIn.length > 0)
    .map((r) => `${r.kind}: ${t("related.forbiddenIn", { namespaces: r.list.forbiddenIn.join(", ") })}`);
  const failure = results.find((r) => r.list.error !== null && r.list.error.code !== "forbidden")?.list.error;
  const rows = [...inventory, ...labelled];
  return element(
    "div",
    {},
    rows.length > 0 ? refTable(sextant, rows) : null,
    ...(notAllowed.length > 0 ? [note(t("related.forbidden", { kind: i18n().formatList(notAllowed) }))] : []),
    ...partly.map((line) => note(line)),
    failure ? retryBox(failure.message, retry) : results.length < LABELLED_KINDS.length ? loadingLine() : null,
  );
}

export function startResources(sextant: Sextant, root: HTMLElement): () => void {
  let release: KubeObject | null = null;
  let lists: Record<string, LiveList> = {};
  let served: Set<string> | null = null;
  let watching = "";
  let stopWatches: () => void = () => undefined;
  let stopped = false;
  const render = () => {
    if (!stopped && release) root.replaceChildren(resourcesView(sextant, release, lists, retry));
  };
  const watch = () => {
    if (!release || !served) return;
    stopWatches();
    const namespaces = helmReleaseNamespaces(release);
    const labelSelector = helmReleaseSelector(release);
    watching = `${labelSelector} ${namespaces.join(",")}`;
    lists = {};
    // Only names are needed: metadata, nothing of a Secret.
    const specs = Object.fromEntries(
      LABELLED_KINDS.map((kind) => [kind.kind, { kind, namespaces, labelSelector, metadataOnly: true } satisfies Omit<WatchParams, "clusterId">]),
    );
    stopWatches = watchLists(sextant, served, specs, (watched) => {
      lists = watched;
      render();
    });
  };
  function retry() {
    watch();
    render();
  }
  const stopFollow = followObject(sextant, root, (obj) => {
    release = obj;
    // Another release (or a new target namespace) starts the lists again.
    if (`${helmReleaseSelector(obj)} ${helmReleaseNamespaces(obj).join(",")}` !== watching) watch();
    render();
  });
  void servedKinds(sextant)
    .then((kinds) => {
      if (stopped) return;
      served = kinds;
      watch();
      render();
    })
    .catch((err: unknown) => {
      if (!stopped) root.replaceChildren(errorBox(err));
    });
  return () => {
    stopped = true;
    stopFollow();
    stopWatches();
  };
}

// ---------- Who uses a source ----------

export function usedByView(sextant: Sextant, source: KubeObject, lists: { kustomizations: LiveList; releases: LiveList }, retry: () => void): HTMLElement {
  const using = [
    ...lists.kustomizations.items.filter((o) => usesSource(o, source)).map((o) => refOf(o, { group: KUSTOMIZE_GROUP, kind: "Kustomization" })),
    ...lists.releases.items.filter((o) => usesSource(o, source)).map((o) => refOf(o, { group: HELM_GROUP, kind: "HelmRelease" })),
  ].sort(byKey);
  const failed = [lists.kustomizations, lists.releases].find((l) => l.error !== null)?.error;
  const loading = !lists.kustomizations.ready || !lists.releases.ready;
  return element(
    "div",
    {},
    using.length > 0 ? refTable(sextant, using) : null,
    failed ? retryBox(failed.message, retry) : loading ? loadingLine() : using.length === 0 ? note(t("related.notUsed")) : null,
  );
}

export function startUsedBy(sextant: Sextant, root: HTMLElement): () => void {
  let source: KubeObject | null = null;
  let lists: { kustomizations: LiveList; releases: LiveList } | null = null;
  let served: Set<string> | null = null;
  let stopWatches: () => void = () => undefined;
  let stopped = false;
  const render = () => {
    if (stopped || !source) return;
    root.replaceChildren(lists ? usedByView(sextant, source, lists, retry) : loadingLine());
  };
  const watch = () => {
    if (!served) return;
    stopWatches();
    lists = null;
    stopWatches = watchLists(
      sextant,
      served,
      {
        kustomizations: { kind: { group: KUSTOMIZE_GROUP, kind: "Kustomization" } },
        releases: { kind: { group: HELM_GROUP, kind: "HelmRelease" } },
      },
      (watched) => {
        lists = watched;
        render();
      },
    );
  };
  function retry() {
    watch();
    render();
  }
  const stopFollow = followObject(sextant, root, (obj) => {
    source = obj;
    render();
  });
  void servedKinds(sextant)
    .then((kinds) => {
      if (stopped) return;
      served = kinds;
      watch();
    })
    .catch((err: unknown) => {
      if (!stopped) root.replaceChildren(errorBox(err));
    });
  return () => {
    stopped = true;
    stopFollow();
    stopWatches();
  };
}
