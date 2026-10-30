// The "Rook Ceph" page (Storage section): every CephCluster with its health, capacity and freshness, then the
// pools, filesystems, object stores and the other Rook objects with their phases, and the StorageClasses on Ceph
// with how many claims use them. Rook's objects follow Sextant's namespace filter; StorageClasses and the claims
// counted on them are cluster-wide.
import type { HostContext, KubeObject, Sextant } from "@sextant/extension-sdk";
import { badge, element, errorBox, objectLink } from "./dom";
import { servedKinds, watchLists, type LiveList } from "./live";
import {
  CEPH_BLOCK_POOL,
  CEPH_CLIENT,
  CEPH_CLUSTER,
  CEPH_FILESYSTEM,
  CEPH_NFS,
  CEPH_OBJECT_STORE,
  CEPH_OBJECT_STORE_USER,
  healthChecks,
  OBJECT_BUCKET_CLAIM,
  phaseTone,
  PVC,
  refOf,
  STORAGE_CLASS,
  type CephCluster,
  type RookObject,
} from "./rook";
import { capacityView, freshness, headline, REDRAW_MS } from "./status";
import { claimsOf, driverOf, storageClassesOf, targetOf, type Claim, type StorageClass } from "./storage";

const LISTS = {
  clusters: CEPH_CLUSTER,
  pools: CEPH_BLOCK_POOL,
  filesystems: CEPH_FILESYSTEM,
  objectStores: CEPH_OBJECT_STORE,
  nfs: CEPH_NFS,
  clients: CEPH_CLIENT,
  users: CEPH_OBJECT_STORE_USER,
  buckets: OBJECT_BUCKET_CLAIM,
  classes: STORAGE_CLASS,
  pvcs: PVC,
} as const;
type ListName = keyof typeof LISTS;
/** Lists that follow the namespace filter. */
const FILTERED: readonly ListName[] = ["clusters", "pools", "filesystems", "objectStores", "nfs", "clients", "users"];

/** Health checks named on a cluster's card; the rest are in its details. */
export const CARD_CHECKS = 3;

function clusterCard(sextant: Sextant, cluster: CephCluster, now: number): HTMLElement {
  const language = sextant.context.language;
  const checks = healthChecks(cluster);
  const named = checks.slice(0, CARD_CHECKS);
  return element(
    "article",
    { className: "card" },
    element(
      "h2",
      {},
      objectLink(sextant, refOf(cluster, CEPH_CLUSTER)),
      element("span", { className: "muted", textContent: ` in ${cluster.metadata.namespace ?? ""}` }),
    ),
    headline(cluster),
    cluster.status?.message ? element("p", { textContent: cluster.status.message }) : null,
    freshness(cluster, now, language),
    named.length
      ? element(
          "ul",
          { className: "checks compact" },
          ...named.map((c) =>
            element(
              "li",
              {},
              element("code", { textContent: c.code }),
              c.message ? ` ${c.message}` : "",
            ),
          ),
        )
      : null,
    checks.length > CARD_CHECKS
      ? element("p", { className: "muted", textContent: `And ${checks.length - CARD_CHECKS} more health checks in its details.` })
      : null,
    capacityView(cluster, language),
  );
}

function phaseTable(sextant: Sextant, rows: { object: KubeObject; kind: typeof CEPH_CLUSTER; extra?: Node | string }[], extraTitle?: string) {
  return element(
    "table",
    {},
    element(
      "thead",
      {},
      element(
        "tr",
        {},
        element("th", { textContent: "Kind" }),
        element("th", { textContent: "Name" }),
        element("th", { textContent: "Namespace" }),
        element("th", { textContent: "Phase" }),
        extraTitle ? element("th", { textContent: extraTitle }) : null,
      ),
    ),
    element(
      "tbody",
      {},
      ...rows.map(({ object, kind, extra }) => {
        const phase = (object as RookObject).status?.phase;
        return element(
          "tr",
          {},
          element("td", { textContent: kind.kind }),
          element("td", {}, objectLink(sextant, refOf(object, kind))),
          element("td", { textContent: object.metadata.namespace ?? "" }),
          element("td", {}, badge(phase ?? "No status", phaseTone(phase))),
          extraTitle ? element("td", {}, extra ?? "") : null,
        );
      }),
    ),
  );
}

export function pageView(sextant: Sextant, lists: Record<ListName, LiveList>, now: number): HTMLElement {
  const errors = Object.values(lists)
    .map((l) => l.error)
    .filter((e): e is string => e !== null);
  const parts: (Node | null)[] = errors.map((e) => element("p", { className: "error", textContent: e }));
  if (!lists.clusters.served) {
    parts.push(element("p", { className: "muted", textContent: "Rook is not installed here: the cluster serves no CephCluster kind." }));
    return element("div", { className: "page" }, ...parts);
  }
  const clusters = lists.clusters.items as CephCluster[];
  parts.push(element("h1", { textContent: "Rook Ceph" }));
  parts.push(
    clusters.length
      ? element("div", { className: "cards" }, ...clusters.map((c) => clusterCard(sextant, c, now)))
      : element("p", { className: "muted", textContent: "No CephCluster in the namespaces shown." }),
  );

  const classes = lists.classes.items as StorageClass[];
  const pvcs = lists.pvcs.items as Claim[];
  const buckets = lists.buckets.items as Claim[];
  const onIt = (object: RookObject, kind: string) => {
    const scs = storageClassesOf(object, kind, classes);
    if (!scs.length) return "—";
    const claims = claimsOf(scs, kind === "CephObjectStore" ? buckets : pvcs).length;
    return `${scs.map((sc) => sc.metadata.name).join(", ")} (${claims} ${claims === 1 ? "claim" : "claims"})`;
  };
  const storage = [
    ...lists.pools.items.map((o) => ({ object: o, kind: CEPH_BLOCK_POOL, extra: onIt(o as RookObject, "CephBlockPool") })),
    ...lists.filesystems.items.map((o) => ({ object: o, kind: CEPH_FILESYSTEM, extra: onIt(o as RookObject, "CephFilesystem") })),
    ...lists.objectStores.items.map((o) => ({ object: o, kind: CEPH_OBJECT_STORE, extra: onIt(o as RookObject, "CephObjectStore") })),
  ];
  if (storage.length) {
    parts.push(element("h2", { textContent: "Pools, filesystems and object stores" }), phaseTable(sextant, storage, "Storage classes"));
  }
  const others = [
    ...lists.nfs.items.map((o) => ({ object: o, kind: CEPH_NFS })),
    ...lists.users.items.map((o) => ({ object: o, kind: CEPH_OBJECT_STORE_USER })),
    ...lists.clients.items.map((o) => ({ object: o, kind: CEPH_CLIENT })),
  ];
  if (others.length) parts.push(element("h2", { textContent: "Other Rook objects" }), phaseTable(sextant, others));

  const cephClasses = classes.filter((sc) => driverOf(sc) !== null);
  if (cephClasses.length) {
    parts.push(
      element("h2", { textContent: "Storage classes on Ceph" }),
      element(
        "table",
        {},
        element(
          "thead",
          {},
          element(
            "tr",
            {},
            element("th", { textContent: "StorageClass" }),
            element("th", { textContent: "Driver" }),
            element("th", { textContent: "Puts data in" }),
            element("th", { textContent: "Claims (all namespaces)" }),
          ),
        ),
        element(
          "tbody",
          {},
          ...cephClasses.map((sc) => {
            const driver = driverOf(sc)!;
            const claims = claimsOf([sc], driver === "bucket" ? buckets : pvcs).length;
            return element(
              "tr",
              {},
              element("td", {}, objectLink(sextant, refOf(sc, STORAGE_CLASS))),
              element("td", { textContent: driver === "rbd" ? "RBD (block)" : driver === "cephfs" ? "CephFS" : "Buckets" }),
              element("td", { textContent: targetOf(sc) ?? "—" }),
              element("td", { textContent: String(claims) }),
            );
          }),
        ),
      ),
    );
  }
  return element("div", { className: "page" }, ...parts);
}

export function startPage(sextant: Sextant, root: HTMLElement): () => void {
  let stopWatches: () => void = () => undefined;
  let stopped = false;
  let shownNamespaces: string | undefined;
  let served: Set<string> | null = null;
  let last: Record<ListName, LiveList> | null = null;
  const render = () => {
    if (!stopped && last?.clusters.ready) root.replaceChildren(pageView(sextant, last, Date.now()));
  };

  const start = (context: HostContext) => {
    const key = JSON.stringify(context.namespaces);
    if (!served || key === shownNamespaces) return;
    shownNamespaces = key;
    stopWatches();
    const namespaces = context.namespaces ?? undefined;
    const specs = Object.fromEntries(
      (Object.keys(LISTS) as ListName[]).map((name) => [
        name,
        { kind: LISTS[name], ...(FILTERED.includes(name) && namespaces ? { namespaces } : {}) },
      ]),
    ) as Record<ListName, { kind: (typeof LISTS)[ListName]; namespaces?: string[] }>;
    stopWatches = watchLists(sextant, served, specs, (lists) => {
      last = lists;
      render();
    });
  };

  root.replaceChildren(element("p", { className: "muted", textContent: "Loading…" }));
  void servedKinds(sextant)
    .then((kinds) => {
      served = kinds;
      start(sextant.context);
    })
    .catch((err: unknown) => root.replaceChildren(errorBox(err)));
  const stopFollow = sextant.onContextChange((context) => start(context));
  // A status nobody refreshes sends no update: draw again now and then so "Stale" shows up anyway.
  const timer = setInterval(render, REDRAW_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    stopFollow();
    stopWatches();
  };
}
