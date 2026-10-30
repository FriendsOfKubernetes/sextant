// The windows of the extension's actions (the manifest's `contributes.actions`): each reads the object it runs on,
// builds the smallest change (changes.ts) from a short form, shows it, and sends it once the user presses Apply;
// Sextant then asks for its own confirmation. Nothing is sent from opening a window.
import type { KubeObject, ObjectRef, Sextant } from "@sextant/extension-sdk";
import {
  asYaml,
  cephImagePatch,
  CRUSH_NAME,
  gatewayPatch,
  isObjectName,
  mdsPatch,
  poolPatch,
  poolPlacementPatch,
  QUANTITY,
  storageClassObject,
  type ClassTarget,
} from "./changes";
import { badge, element, errorBox } from "./dom";
import { t } from "./i18n";
import {
  cephPoolName,
  CEPH_CLUSTER,
  OBJECT_BUCKET_CLAIM,
  POD,
  PVC,
  STORAGE_CLASS,
  type CephBlockPool,
  type CephCluster,
  type RookObject,
} from "./rook";
import { claimsOf, driverOf, storageClassesOf, type Claim, type StorageClass } from "./storage";
import { actionWindow, checkbox, field, numberInput, readCount, select, textInput } from "./ui";
import { upgradeChecks } from "./upgrade";

type Spec = Record<string, unknown>;
const specOf = (o: { spec?: unknown }) => (o.spec ?? {}) as Spec;

/** Starts the window of the action `contribution` on the object in the context. */
export function startAction(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const ref = sextant.context.selection[0];
  if (!ref) {
    root.replaceChildren(element("p", { className: "muted", textContent: t("common.nothingSelected") }));
    return () => undefined;
  }
  root.replaceChildren(element("p", { className: "muted", textContent: t("common.loading") }));
  const open = ACTIONS[contribution];
  if (!open) {
    root.textContent = t("common.nothingToShow", { view: contribution });
    return () => undefined;
  }
  void sextant.resources
    .get({ ref })
    .then((object) => open(sextant, root, ref, object))
    .catch((err: unknown) => root.replaceChildren(errorBox(err)));
  return () => undefined;
}

type Opener = (sextant: Sextant, root: HTMLElement, ref: ObjectRef, object: KubeObject) => void | Promise<void>;

const patchOf = (sextant: Sextant, ref: ObjectRef) => (patch: unknown) =>
  sextant.resources.patch({ ref, patch: patch as never, patchType: "merge" });

const ACTIONS: Record<string, Opener> = {
  upgrade(sextant, root, ref, object) {
    const cluster = object as CephCluster;
    const current = (cluster.spec?.cephVersion?.image as string | undefined) ?? "";
    const image = textInput(current, "quay.io/ceph/ceph:v20.2.4-20260818");
    const list = element("ul", { className: "checks compact badged" });
    const draw = () => {
      const checks = upgradeChecks(cluster, image.value);
      list.replaceChildren(
        ...checks.map((c) =>
          element("li", {}, badge(t(c.level === "block" ? "upgrade.blocks" : "upgrade.warns"), c.level === "block" ? "error" : "warning"), t(`upgrade.check.${c.id}`, c.values)),
        ),
      );
      return checks;
    };
    actionWindow(sextant, root, {
      intro: [element("p", { textContent: t("upgrade.intro") }), element("p", { className: "muted", textContent: t("upgrade.current", { image: current || "—" }) })],
      form: [field(t("upgrade.image"), image), list],
      build: () => {
        const checks = draw();
        if (image.value.trim() === current) return { reason: t("upgrade.unchanged") };
        if (checks.some((c) => c.level === "block")) return { reason: t("upgrade.blocked") };
        return { change: cephImagePatch(image.value.trim(), cluster.metadata.resourceVersion) };
      },
      send: patchOf(sextant, ref),
      applyLabel: t("upgrade.apply"),
      notice: () => t("upgrade.notice", { name: ref.name, image: image.value.trim() }),
    });
  },

  "pool-settings"(sextant, root, ref, object) {
    const pool = object as CephBlockPool;
    const spec = specOf(pool) as {
      replicated?: { size?: number };
      erasureCoded?: unknown;
      quotas?: { maxSize?: string; maxObjects?: number };
      failureDomain?: string;
      deviceClass?: string;
      crushRoot?: string;
    };
    const replicated = spec.replicated?.size !== undefined && !spec.erasureCoded;
    const size = numberInput(spec.replicated?.size, 1, 9);
    size.disabled = !replicated;
    const maxSize = textInput(spec.quotas?.maxSize, "100Gi");
    const maxObjects = textInput(spec.quotas?.maxObjects?.toString(), "1000000");
    const failureDomain = textInput(spec.failureDomain, "host");
    const deviceClass = textInput(spec.deviceClass, "ssd");
    const crushRoot = textInput(spec.crushRoot, "default");
    const optional = (input: HTMLInputElement, before: string | undefined) => {
      const value = input.value.trim();
      return value === (before ?? "") ? undefined : value === "" ? null : value;
    };
    actionWindow(sextant, root, {
      intro: [element("p", { textContent: t("pool.intro", { pool: cephPoolName(pool) }) })],
      form: [
        field(t("pool.size"), size, replicated ? t("pool.sizeHint") : t("pool.erasureCoded")),
        field(t("pool.maxSize"), maxSize, t("pool.quotaHint")),
        field(t("pool.maxObjects"), maxObjects),
        element("h3", { textContent: t("pool.placement") }),
        element("p", { className: "warning-text", textContent: t("pool.placementWarning") }),
        field(t("pool.failureDomain"), failureDomain),
        field(t("pool.deviceClass"), deviceClass),
        field(t("pool.crushRoot"), crushRoot),
      ],
      build: () => {
        const sizeValue = replicated ? readCount(size, 1, 9) : undefined;
        if (replicated && sizeValue === null) return { reason: t("pool.badSize") };
        const maxSizeValue = optional(maxSize, spec.quotas?.maxSize);
        if (typeof maxSizeValue === "string" && !QUANTITY.test(maxSizeValue)) return { reason: t("pool.badQuantity") };
        const objectsText = optional(maxObjects, spec.quotas?.maxObjects?.toString());
        if (typeof objectsText === "string" && !/^[1-9]\d*$/.test(objectsText)) return { reason: t("pool.badObjects") };
        const placement = {
          failureDomain: optional(failureDomain, spec.failureDomain),
          deviceClass: optional(deviceClass, spec.deviceClass),
          crushRoot: optional(crushRoot, spec.crushRoot),
        };
        for (const value of Object.values(placement)) if (typeof value === "string" && !CRUSH_NAME.test(value)) return { reason: t("pool.badCrushName") };
        const settings = poolPatch({
          size: sizeValue === spec.replicated?.size ? undefined : (sizeValue ?? undefined),
          maxSize: maxSizeValue,
          maxObjects: objectsText === undefined ? undefined : objectsText === null ? null : Number(objectsText),
        });
        const placed = poolPlacementPatch(placement);
        const merged = { spec: { ...(settings.spec as Spec), ...(placed.spec as Spec) } };
        if (Object.keys(merged.spec).length === 0) return { reason: t("change.nothing") };
        return { change: { ...merged, metadata: { resourceVersion: pool.metadata.resourceVersion } } };
      },
      send: patchOf(sextant, ref),
      applyLabel: t("change.apply"),
      notice: t("pool.notice", { name: ref.name }),
    });
  },

  mds(sextant, root, ref, object) {
    const mds = (specOf(object).metadataServer ?? {}) as { activeCount?: number; activeStandby?: boolean };
    const active = numberInput(mds.activeCount ?? 1, 1, 50);
    const standby = checkbox(t("mds.activeStandby"), mds.activeStandby ?? false);
    actionWindow(sextant, root, {
      intro: [element("p", { textContent: t("mds.intro") })],
      form: [field(t("mds.activeCount"), active, t("mds.activeHint")), standby.row],
      build: () => {
        const count = readCount(active, 1, 50);
        if (count === null) return { reason: t("mds.badCount") };
        if (count === mds.activeCount && standby.input.checked === (mds.activeStandby ?? false)) return { reason: t("change.nothing") };
        return { change: mdsPatch(count, standby.input.checked, object.metadata.resourceVersion) };
      },
      send: patchOf(sextant, ref),
      applyLabel: t("change.apply"),
      notice: t("mds.notice", { name: ref.name }),
    });
  },

  gateways(sextant, root, ref, object) {
    const current = ((specOf(object).gateway ?? {}) as { instances?: number }).instances ?? 1;
    const instances = numberInput(current, 1, 100);
    actionWindow(sextant, root, {
      intro: [element("p", { textContent: t("gateways.intro") })],
      form: [field(t("gateways.instances"), instances)],
      build: () => {
        const count = readCount(instances, 1, 100);
        if (count === null) return { reason: t("gateways.badCount") };
        if (count === current) return { reason: t("change.nothing") };
        return { change: gatewayPatch(count, object.metadata.resourceVersion) };
      },
      send: patchOf(sextant, ref),
      applyLabel: t("change.apply"),
      notice: () => t("gateways.notice", { name: ref.name, count: Number(instances.value) }),
    });
  },

  async "create-class"(sextant, root, ref, object) {
    const kind = ref.kind.kind;
    const namespace = ref.namespace ?? "";
    const [classes, operators] = await Promise.all([
      sextant.resources.list({ kind: STORAGE_CLASS }).then((r) => r.items as StorageClass[]),
      sextant.resources.list({ kind: POD, labelSelector: "app=rook-ceph-operator", limit: 5 }).then((r) => r.items),
    ]);
    const driverPrefix = operators[0]?.metadata.namespace ?? namespace;
    const bucketProvisioner = classes.find((sc) => driverOf(sc) === "bucket" && sc.parameters?.objectStoreNamespace === namespace)?.provisioner;
    let target: ClassTarget;
    if (kind === "CephBlockPool") target = { type: "rbd", pool: cephPoolName(object as CephBlockPool) };
    else if (kind === "CephFilesystem") {
      const dataPools = (specOf(object).dataPools ?? []) as { name?: string }[];
      const first = dataPools[0]?.name ? `${ref.name}-${dataPools[0].name}` : `${ref.name}-data0`;
      target = { type: "cephfs", filesystem: ref.name, dataPool: first };
    } else target = { type: "bucket", objectStore: ref.name };
    const name = textInput(`${ref.name}`.toLowerCase());
    const reclaim = select(
      [
        { value: "Delete", label: t("storageClass.delete") },
        { value: "Retain", label: t("storageClass.retain") },
      ],
      "Delete",
    );
    const existing = storageClassesOf(object as RookObject, kind, classes);
    actionWindow(sextant, root, {
      intro: [
        element("p", { textContent: t("storageClass.intro") }),
        existing.length ? element("p", { className: "muted", textContent: t("storageClass.existing", { classes: existing.map((c) => c.metadata.name).join(", ") }) }) : null,
      ],
      form: [field(t("storageClass.name"), name), field(t("storageClass.reclaim"), reclaim)],
      build: () => {
        const value = name.value.trim();
        if (!isObjectName(value)) return { reason: t("create.badName") };
        if (classes.some((sc) => sc.metadata.name === value)) return { reason: t("storageClass.taken", { name: value }) };
        return {
          change: asYaml([
            storageClassObject({
              name: value,
              clusterNamespace: namespace,
              driverPrefix,
              bucketProvisioner,
              target,
              reclaimPolicy: reclaim.value as "Delete" | "Retain",
            }),
          ]),
        };
      },
      send: (yaml) => sextant.resources.apply({ yaml: yaml as string }),
      applyLabel: t("storageClass.create"),
      notice: () => t("storageClass.notice", { name: name.value.trim() }),
    });
  },

  async "delete-unused"(sextant, root, ref, object) {
    const kind = ref.kind.kind;
    const blockers: string[] = [];
    if (kind === "StorageClass") {
      const claimKind = driverOf(object as StorageClass) === "bucket" ? OBJECT_BUCKET_CLAIM : PVC;
      const claims = (await sextant.resources.list({ kind: claimKind, limit: 5000 })).items as Claim[];
      const used = claimsOf([object as StorageClass], claims);
      if (used.length) blockers.push(t("delete.claimsUse", { count: used.length, claims: used.slice(0, 5).map((c) => `${c.metadata.namespace}/${c.metadata.name}`).join(", ") }));
    } else if (kind === "CephBlockPool" || kind === "CephFilesystem" || kind === "CephObjectStore") {
      const classes = (await sextant.resources.list({ kind: STORAGE_CLASS })).items as StorageClass[];
      const on = storageClassesOf(object as RookObject, kind, classes);
      const claims = (await sextant.resources.list({ kind: kind === "CephObjectStore" ? OBJECT_BUCKET_CLAIM : PVC, limit: 5000 })).items as Claim[];
      const used = claimsOf(on, claims);
      if (used.length) blockers.push(t("delete.claimsUse", { count: used.length, claims: used.slice(0, 5).map((c) => `${c.metadata.namespace}/${c.metadata.name}`).join(", ") }));
      if (on.length) blockers.push(t("delete.classesOn", { classes: on.map((c) => c.metadata.name).join(", ") }));
    }
    const conditions = ((object.status as { conditions?: { type?: string; status?: string; message?: string }[] } | undefined)?.conditions ?? [])
      .filter((c) => /DeletionIsBlocked$/.test(c.type ?? "") && c.status === "True");
    for (const c of conditions) blockers.push(t("delete.rookBlocks", { message: c.message ?? c.type ?? "" }));
    actionWindow(sextant, root, {
      intro: [
        element("p", { textContent: t("delete.intro", { kind, name: ref.name }) }),
        kind === CEPH_CLUSTER.kind ? null : element("p", { className: "warning-text", textContent: t("delete.dataWarning") }),
        blockers.length ? element("ul", { className: "checks compact" }, ...blockers.map((b) => element("li", { className: "error", textContent: b }))) : null,
      ],
      form: [],
      build: () => (blockers.length ? { reason: t("delete.blocked") } : { change: { delete: ref } }),
      send: () => sextant.resources.delete({ ref }),
      applyLabel: t("delete.apply"),
      notice: t("delete.notice", { kind, name: ref.name }),
      danger: true,
    });
  },
};
