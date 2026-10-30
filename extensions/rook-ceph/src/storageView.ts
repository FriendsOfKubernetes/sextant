// "Storage classes and claims" of a CephBlockPool, CephFilesystem or CephObjectStore: the StorageClasses on it
// (storage.ts) and the PersistentVolumeClaims or ObjectBucketClaims that use them, live.
import type { ObjectRef, Sextant } from "@sextant/extension-sdk";
import { badge, element, errorBox, LINK_MARK, objectLink, withLinks } from "./dom";
import { t } from "./i18n";
import { servedKinds, watchLists, type LiveList } from "./live";
import { OBJECT_BUCKET_CLAIM, phaseTone, PVC, refOf, STORAGE_CLASS, type RookObject } from "./rook";
import { claimsOf, storageClassesOf, type Claim, type StorageClass } from "./storage";

export const MAX_CLAIMS = 50;

export function storageView(
  sextant: Sextant,
  target: RookObject,
  kind: string,
  lists: { classes: LiveList; claims: LiveList },
): HTMLElement {
  const classes = storageClassesOf(target, kind, lists.classes.items as StorageClass[]);
  const parts: HTMLElement[] = [lists.classes, lists.claims]
    .map((l) => l.error)
    .filter((e): e is string => e !== null)
    .map((e) => element("p", { className: "error", textContent: e }));
  if (classes.length === 0) {
    parts.push(
      element("p", {
        className: "muted",
        textContent:
          kind === "CephObjectStore" ? t("storage.noBucketClass") : t("storage.noVolumeClass"),
      }),
    );
    return element("div", {}, ...parts);
  }
  const claimKind = kind === "CephObjectStore" ? OBJECT_BUCKET_CLAIM : PVC;
  const claims = claimsOf(classes, lists.claims.items as Claim[]);
  parts.push(
    element(
      "p",
      {},
      ...withLinks(
        t("storage.classes", { count: classes.length, classes: LINK_MARK }),
        classes.map((sc) => objectLink(sextant, refOf(sc, STORAGE_CLASS))),
      ),
    ),
  );
  if (!lists.claims.served) {
    parts.push(element("p", { className: "muted", textContent: t("storage.notServed", { kind: claimKind.kind }) }));
  } else if (claims.length === 0) {
    parts.push(element("p", { className: "muted", textContent: t("storage.noClaims", { kind: claimKind.kind }) }));
  } else {
    parts.push(
      element(
        "table",
        {},
        element(
          "thead",
          {},
          element(
            "tr",
            {},
            element("th", { textContent: claimKind.kind }),
            element("th", { textContent: t("table.namespace") }),
            element("th", { textContent: "StorageClass" }),
            element("th", { textContent: t("table.phase") }),
            claimKind === PVC ? element("th", { textContent: t("table.capacity") }) : null,
          ),
        ),
        element(
          "tbody",
          {},
          ...claims.slice(0, MAX_CLAIMS).map((claim) =>
            element(
              "tr",
              {},
              element("td", {}, objectLink(sextant, refOf(claim, claimKind))),
              element("td", { textContent: claim.metadata.namespace ?? "" }),
              element("td", { textContent: claim.spec?.storageClassName ?? "" }),
              element("td", {}, badge(claim.status?.phase ?? "—", phaseTone(claim.status?.phase))),
              claimKind === PVC
                ? element("td", { textContent: claim.status?.capacity?.storage ?? claim.spec?.resources?.requests?.storage ?? "" })
                : null,
            ),
          ),
        ),
      ),
    );
    if (claims.length > MAX_CLAIMS) {
      parts.push(element("p", { className: "muted", textContent: t("common.andMore", { count: claims.length - MAX_CLAIMS }) }));
    }
  }
  return element("div", {}, ...parts);
}

export function startStorage(sextant: Sextant, root: HTMLElement): () => void {
  const ref: ObjectRef | undefined = sextant.context.selection[0];
  if (!ref) {
    root.replaceChildren(element("p", { className: "muted", textContent: t("common.nothingSelected") }));
    return () => undefined;
  }
  const kind = ref.kind.kind;
  let target: RookObject | null = null;
  let lists: { classes: LiveList; claims: LiveList } | null = null;
  let stopped = false;
  let stopWatches: () => void = () => undefined;
  const render = () => {
    if (!stopped && target && lists && lists.classes.ready && lists.claims.ready) {
      root.replaceChildren(storageView(sextant, target, kind, lists));
    }
  };
  root.replaceChildren(element("p", { className: "muted", textContent: t("common.loading") }));

  let shown: string | null | undefined;
  const follow = () => {
    if (sextant.context.resourceVersion === shown) return;
    shown = sextant.context.resourceVersion;
    void sextant.resources
      .get({ ref })
      .then((object) => {
        target = object as RookObject;
        render();
      })
      .catch((err: unknown) => root.replaceChildren(errorBox(err)));
  };
  follow();
  const stopFollow = sextant.onContextChange(follow);

  void servedKinds(sextant)
    .then((served) => {
      if (stopped) return;
      stopWatches = watchLists(
        sextant,
        served,
        { classes: { kind: STORAGE_CLASS }, claims: { kind: kind === "CephObjectStore" ? OBJECT_BUCKET_CLAIM : PVC } },
        (watched) => {
          lists = watched;
          render();
        },
      );
    })
    .catch((err: unknown) => root.replaceChildren(errorBox(err)));

  return () => {
    stopped = true;
    stopFollow();
    stopWatches();
  };
}
