// "Create snapshot" of a claim and "Restore to a new PVC" of a ready VolumeSnapshot (#152): the forms, built on
// CreateDialog (form → confirmation listing the object → one create). The lists they offer (snapshot classes, storage
// classes) are watched only while the dialog is open.
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, useWatch, type ClusterId, type KubeObject, type WatchSpec } from "../../api";
import { status } from "../../resources";
import { CreateDialog } from "./CreateDialog";
import {
  ACCESS_MODES,
  restoredClaimOf,
  sizeAtLeast,
  snapshotOf,
  stamp,
  suffixed,
  validName,
} from "./forms";
import {
  isDefaultSnapshotClass,
  isDefaultStorageClass,
  restoreSizeOf,
  snapshotSourceClaim,
  STORAGE_CLASS,
  VOLUME_SNAPSHOT_CLASS,
  PVC,
} from "./model";

const { arr, get, str } = status;

const all = (kind: WatchSpec["kind"]): WatchSpec => ({ kind, namespaces: null, labelSelector: null, fieldSelector: null });

function useList(clusterId: ClusterId, spec: WatchSpec | null): KubeObject[] {
  const state = useWatch(clusterId, spec);
  return useMemo(
    () => [...state.items.values()].sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? "")),
    [state.items],
  );
}

/** A labelled field of a form. */
export function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id: string }) {
  return (
    <div className="action-dialog__field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="action-dialog__hint">{hint}</span>}
    </div>
  );
}

/** The snapshot class to offer first: the default one of the claim's driver, else one of its driver, else none. */
export function preferredSnapshotClass(classes: readonly KubeObject[], driver: string | undefined): string {
  const ofDriver = classes.filter((c) => driver !== undefined && str(get(c, "driver")) === driver);
  const pick = ofDriver.find(isDefaultSnapshotClass) ?? ofDriver[0];
  return pick?.metadata?.name ?? "";
}

export function SnapshotDialog({ clusterId, claim, close }: { clusterId: ClusterId; claim: KubeObject; close: () => void }) {
  const { t } = useTranslation();
  const ids = { name: useId(), cls: useId() };
  const namespace = claim.metadata?.namespace ?? "";
  const claimName = claim.metadata?.name ?? "";
  const [name, setName] = useState(() => suffixed(claimName, stamp(new Date())));
  const classes = useList(clusterId, all(VOLUME_SNAPSHOT_CLASS));
  const storageClasses = useList(clusterId, all(STORAGE_CLASS));
  const storageClass = str(get(claim, "spec", "storageClassName"));
  const driver = str(get(storageClasses.find((c) => c.metadata?.name === storageClass), "provisioner"));
  const [picked, setPicked] = useState<string | null>(null);
  const snapshotClass = picked ?? preferredSnapshotClass(classes, driver);
  const valid = validName(name);
  const object = valid ? snapshotOf({ namespace, claim: claimName, name, snapshotClass }) : null;

  return (
    <CreateDialog
      clusterId={clusterId}
      title={t("storage:snapshot.createTitle", { name: claimName })}
      close={close}
      object={object}
      form={
        <>
          <Field id={ids.name} label={t("storage:form.name")} hint={valid ? undefined : t("storage:form.invalidName")}>
            <input id={ids.name} className="st-input" value={name} autoFocus onChange={(e) => setName(e.target.value.trim())} />
          </Field>
          <Field id={ids.cls} label={t("storage:snapshot.class")} hint={t("storage:snapshot.classHint")}>
            <select id={ids.cls} className="st-input" value={snapshotClass} onChange={(e) => setPicked(e.target.value)}>
              <option value="">{t("storage:snapshot.defaultClass")}</option>
              {classes.map((c) => {
                const n = c.metadata?.name ?? "";
                const label = str(get(c, "driver")) === driver && driver ? t("storage:snapshot.classOfDriver", { name: n }) : n;
                return (
                  <option key={n} value={n}>
                    {label}
                  </option>
                );
              })}
            </select>
          </Field>
        </>
      }
    />
  );
}

/** The claim a snapshot was taken of, if it is still there (its class, access mode and volume mode are offered). */
function useSourceClaim(clusterId: ClusterId, snapshot: KubeObject): KubeObject | null {
  const namespace = snapshot.metadata?.namespace ?? null;
  const name = snapshotSourceClaim(snapshot);
  const [claim, setClaim] = useState<KubeObject | null>(null);
  useEffect(() => {
    if (!name) return;
    let live = true;
    api.resources.get(clusterId, { kind: PVC, namespace, name }).then(
      (obj) => live && setClaim(obj),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [clusterId, namespace, name]);
  return claim;
}

export function RestoreClaimDialog({ clusterId, snapshot, close }: { clusterId: ClusterId; snapshot: KubeObject; close: () => void }) {
  const { t } = useTranslation();
  const ids = { name: useId(), ns: useId(), size: useId(), cls: useId(), mode: useId() };
  const namespace = snapshot.metadata?.namespace ?? "";
  const snapshotName = snapshot.metadata?.name ?? "";
  const minimum = restoreSizeOf(snapshot);
  const source = useSourceClaim(clusterId, snapshot);
  const storageClasses = useList(clusterId, all(STORAGE_CLASS));
  const [name, setName] = useState(() => suffixed(snapshotName, "restore"));
  const [size, setSize] = useState<string | null>(null);
  const [storageClass, setStorageClass] = useState<string | null>(null);
  const [accessMode, setAccessMode] = useState<string | null>(null);

  const sourceSize = str(get(source, "spec", "resources", "requests", "storage"));
  const shownSize = size ?? minimum ?? sourceSize ?? "";
  const shownClass = storageClass ?? str(get(source, "spec", "storageClassName")) ?? "";
  const shownMode = accessMode ?? (arr(get(source, "spec", "accessModes")).find((m): m is string => typeof m === "string") ?? "ReadWriteOnce");
  const volumeMode = str(get(source, "spec", "volumeMode"));
  const nameOk = validName(name);
  const sizeOk = sizeAtLeast(shownSize, minimum);
  const object =
    nameOk && sizeOk
      ? restoredClaimOf({ namespace, snapshot: snapshotName, name, size: shownSize, storageClass: shownClass, accessMode: shownMode, volumeMode })
      : null;
  const defaultClass = storageClasses.find(isDefaultStorageClass)?.metadata?.name;

  return (
    <CreateDialog
      clusterId={clusterId}
      title={t("storage:restore.title", { name: snapshotName })}
      close={close}
      object={object}
      form={
        <>
          <Field id={ids.name} label={t("storage:form.name")} hint={nameOk ? undefined : t("storage:form.invalidName")}>
            <input id={ids.name} className="st-input" value={name} autoFocus onChange={(e) => setName(e.target.value.trim())} />
          </Field>
          <Field id={ids.ns} label={t("storage:form.namespace")} hint={t("storage:restore.namespaceHint")}>
            <input id={ids.ns} className="st-input" value={namespace} readOnly />
          </Field>
          <Field
            id={ids.size}
            label={t("storage:restore.size")}
            hint={sizeOk ? (minimum ? t("storage:restore.sizeHint", { size: minimum }) : undefined) : minimum ? t("storage:restore.sizeTooSmall", { size: minimum }) : t("storage:restore.sizeInvalid")}
          >
            <input id={ids.size} className="st-input" value={shownSize} onChange={(e) => setSize(e.target.value.trim())} />
          </Field>
          <Field id={ids.cls} label={t("storage:restore.storageClass")}>
            <select id={ids.cls} className="st-input" value={shownClass} onChange={(e) => setStorageClass(e.target.value)}>
              <option value="">{defaultClass ? t("storage:restore.defaultClassNamed", { name: defaultClass }) : t("storage:restore.defaultClass")}</option>
              {storageClasses.map((c) => (
                <option key={c.metadata?.name} value={c.metadata?.name ?? ""}>
                  {c.metadata?.name}
                </option>
              ))}
              {shownClass && !storageClasses.some((c) => c.metadata?.name === shownClass) && <option value={shownClass}>{shownClass}</option>}
            </select>
          </Field>
          <Field id={ids.mode} label={t("storage:restore.accessMode")}>
            <select id={ids.mode} className="st-input" value={shownMode} onChange={(e) => setAccessMode(e.target.value)}>
              {ACCESS_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </>
      }
    />
  );
}
