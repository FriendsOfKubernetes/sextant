// "Create" on the Rook Ceph page: a CephBlockPool, CephFilesystem, CephObjectStore or CephObjectStoreUser from a short
// form after Rook's examples (changes.ts), with a StorageClass on it when asked, applied as one YAML: Sextant asks
// once for all of it. Names already taken are refused here; the cluster refuses anything else.
import type { Sextant } from "@sextant/extension-sdk";
import {
  asYaml,
  filesystemObject,
  isObjectName,
  objectStoreObject,
  objectUserObject,
  poolObject,
  storageClassObject,
  type ClassTarget,
} from "./changes";
import { element } from "./dom";
import { t } from "./i18n";
import type { CephCluster, RookObject } from "./rook";
import { driverOf, type StorageClass } from "./storage";
import { changeButton, checkbox, field, numberInput, preview, readCount, select, textInput } from "./ui";

export type CreateKind = "pool" | "filesystem" | "objectStore" | "user";

export interface CreateData {
  clusters: readonly CephCluster[];
  pools: readonly RookObject[];
  filesystems: readonly RookObject[];
  objectStores: readonly RookObject[];
  users: readonly RookObject[];
  classes: readonly StorageClass[];
  /** The operator's namespace: the CSI drivers' name prefix. */
  driverPrefix: string | null;
}

function form(sextant: Sextant, kind: CreateKind, current: () => CreateData): HTMLElement {
  const data = current();
  const clusters = data.clusters.map((c) => c.metadata.namespace ?? "").filter(Boolean);
  const cluster = select(clusters.map((ns) => ({ value: ns, label: ns })), clusters[0] ?? "");
  const name = textInput("", kind === "user" ? "my-user" : kind === "pool" ? "replicapool" : kind === "filesystem" ? "myfs" : "my-store");
  const failureDomain = select(
    [
      { value: "host", label: t("create.failureHost") },
      { value: "osd", label: t("create.failureOsd") },
    ],
    "host",
  );
  const size = numberInput(3, 1, 9);
  const active = numberInput(1, 1, 50);
  const instances = numberInput(1, 1, 100);
  const store = select([], "");
  const displayName = textInput("");
  const withClass = checkbox(t("create.withClass"), kind !== "user");
  const className = textInput("");
  const reclaim = select(
    [
      { value: "Delete", label: t("storageClass.delete") },
      { value: "Retain", label: t("storageClass.retain") },
    ],
    "Delete",
  );
  const fillStores = () => {
    const ns = cluster.value;
    store.replaceChildren(
      ...current().objectStores
        .filter((o) => o.metadata.namespace === ns)
        .map((o) => element("option", { value: o.metadata.name, textContent: o.metadata.name })),
    );
  };
  fillStores();
  cluster.addEventListener("change", fillStores);

  const taken = (list: readonly RookObject[], ns: string, n: string) => list.some((o) => o.metadata.namespace === ns && o.metadata.name === n);
  const build = (): { change: string } | { reason: string } => {
    const data = current();
    const ns = cluster.value;
    const n = name.value.trim();
    if (!ns) return { reason: t("create.noCluster") };
    if (!isObjectName(n)) return { reason: t("create.badName") };
    const sizeValue = readCount(size, 1, 9);
    const domain = failureDomain.value as "host" | "osd";
    const objects: object[] = [];
    let target: ClassTarget | null = null;
    switch (kind) {
      case "pool":
        if (taken(data.pools, ns, n)) return { reason: t("create.taken", { name: n }) };
        if (sizeValue === null) return { reason: t("pool.badSize") };
        objects.push(poolObject({ name: n, namespace: ns, failureDomain: domain, size: sizeValue }));
        target = { type: "rbd", pool: n };
        break;
      case "filesystem": {
        if (taken(data.filesystems, ns, n)) return { reason: t("create.taken", { name: n }) };
        const count = readCount(active, 1, 50);
        if (sizeValue === null) return { reason: t("pool.badSize") };
        if (count === null) return { reason: t("mds.badCount") };
        objects.push(filesystemObject({ name: n, namespace: ns, failureDomain: domain, size: sizeValue, activeCount: count }));
        target = { type: "cephfs", filesystem: n, dataPool: `${n}-replicated` };
        break;
      }
      case "objectStore": {
        if (taken(data.objectStores, ns, n)) return { reason: t("create.taken", { name: n }) };
        const count = readCount(instances, 1, 100);
        if (sizeValue === null) return { reason: t("pool.badSize") };
        if (count === null) return { reason: t("gateways.badCount") };
        objects.push(objectStoreObject({ name: n, namespace: ns, failureDomain: domain, size: sizeValue, instances: count }));
        target = { type: "bucket", objectStore: n };
        break;
      }
      case "user":
        if (taken(data.users, ns, n)) return { reason: t("create.taken", { name: n }) };
        if (!store.value) return { reason: t("create.noStore") };
        objects.push(objectUserObject({ name: n, namespace: ns, store: store.value, displayName: displayName.value.trim() || n }));
        break;
    }
    if (target && withClass.input.checked) {
      const scName = className.value.trim() || `rook-${n}`;
      if (!isObjectName(scName)) return { reason: t("create.badName") };
      if (data.classes.some((sc) => sc.metadata.name === scName)) return { reason: t("storageClass.taken", { name: scName }) };
      if (target.type !== "bucket" && !data.driverPrefix) return { reason: t("create.noOperator") };
      const bucketProvisioner = data.classes.find((sc) => driverOf(sc) === "bucket" && sc.parameters?.objectStoreNamespace === ns)?.provisioner;
      objects.push(
        storageClassObject({
          name: scName,
          clusterNamespace: ns,
          driverPrefix: data.driverPrefix ?? ns,
          bucketProvisioner,
          target,
          reclaimPolicy: reclaim.value as "Delete" | "Retain",
        }),
      );
    }
    return { change: asYaml(objects) };
  };

  const fields: (HTMLElement | null)[] = [field(t("create.cluster"), cluster), field(t("create.name"), name)];
  if (kind !== "user") fields.push(field(t("create.failureDomain"), failureDomain), field(t("create.size"), size, t("pool.sizeHint")));
  if (kind === "filesystem") fields.push(field(t("mds.activeCount"), active));
  if (kind === "objectStore") fields.push(field(t("gateways.instances"), instances));
  if (kind === "user") fields.push(field(t("create.store"), store), field(t("create.displayName"), displayName));
  if (kind !== "user") fields.push(withClass.row, field(t("storageClass.name"), className, t("create.classNameHint")), field(t("storageClass.reclaim"), reclaim));

  const reason = element("p", { className: "muted" });
  const previewSlot = element("div", {});
  const { button, status } = changeButton(t("create.apply"), async () => {
    const built = build();
    if ("reason" in built) throw new Error(built.reason);
    await sextant.resources.apply({ yaml: built.change });
  }, { primary: true, doneText: t("create.done") });
  const body = element("div", { className: "form" }, ...fields);
  const refresh = () => {
    const built = build();
    reason.textContent = "reason" in built ? built.reason : "";
    previewSlot.replaceChildren(...("change" in built ? [preview(built.change)] : []));
    button.disabled = "reason" in built;
  };
  body.addEventListener("input", refresh);
  body.addEventListener("change", refresh);
  refresh();
  return element(
    "details",
    { className: "create" },
    element("summary", { textContent: t(`create.${kind}`) }),
    body,
    reason,
    previewSlot,
    element("div", { className: "actions" }, status, button),
  );
}

/**
 * The "Create" section of the page, or nothing without a CephCluster to create in. Built once and kept across the
 * page's redraws, so a form being filled in stays; `current` gives the lists as they are when a change is built.
 */
export function createSection(sextant: Sextant, current: () => CreateData): HTMLElement | null {
  if (!current().clusters.length) return null;
  return element(
    "section",
    { className: "create-section" },
    element("h2", { textContent: t("create.title") }),
    element("p", { className: "muted", textContent: t("create.intro") }),
    ...(["pool", "filesystem", "objectStore", "user"] as const).map((kind) => form(sextant, kind, current)),
  );
}
