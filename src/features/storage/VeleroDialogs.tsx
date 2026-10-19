// "Back up namespace…" and "Restore from this backup…" (#152): Velero Backup and Restore objects, created in Velero's
// namespace (where its BackupStorageLocations are) through CreateDialog (form → confirmation → one create). Velero
// does the work; Sextant only creates the request. A restore skips most objects that already exist (some kinds, such as
// ServiceAccounts, are merged), and the confirmation says so.
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KubeObject, type WatchSpec } from "../../api";
import { status } from "../../resources";
import { CreateDialog } from "./CreateDialog";
import {
  DEFAULT_TTL,
  stamp,
  suffixed,
  validNamespace,
  validTtl,
  validVeleroName,
  veleroBackupOf,
  veleroRestoreOf,
} from "./forms";
import { BACKUP_STORAGE_LOCATION, includedNamespaces, veleroNamespaceOf } from "./model";
import { Field } from "./SnapshotDialogs";

const { get } = status;

const LOCATIONS: WatchSpec = { kind: BACKUP_STORAGE_LOCATION, namespaces: null, labelSelector: null, fieldSelector: null };

/** Velero's BackupStorageLocations, watched while the dialog is open. */
function useLocations(clusterId: ClusterId): KubeObject[] {
  const state = useWatch(clusterId, LOCATIONS);
  return useMemo(() => [...state.items.values()], [state.items]);
}

export function VeleroBackupDialog({ clusterId, namespace, close }: { clusterId: ClusterId; namespace: string; close: () => void }) {
  const { t } = useTranslation();
  const ids = { name: useId(), ttl: useId(), loc: useId(), velero: useId() };
  const locations = useLocations(clusterId);
  const veleroNamespace = veleroNamespaceOf(locations);
  const [name, setName] = useState(() => suffixed(namespace, stamp(new Date())));
  const [ttl, setTtl] = useState(DEFAULT_TTL);
  const [storageLocation, setStorageLocation] = useState("");
  const nameOk = validVeleroName(name);
  const ttlOk = validTtl(ttl);
  const object = nameOk && ttlOk ? veleroBackupOf({ veleroNamespace, name, namespace, ttl, storageLocation }) : null;
  const inVelero = locations.filter((l) => l.metadata?.namespace === veleroNamespace);

  return (
    <CreateDialog
      clusterId={clusterId}
      title={t("storage:velero.backupTitle", { namespace })}
      close={close}
      object={object}
      note={t("storage:velero.backupNote", { namespace })}
      form={
        <>
          <Field id={ids.name} label={t("storage:form.name")} hint={nameOk ? undefined : t("storage:velero.invalidName")}>
            <input id={ids.name} className="st-input" value={name} autoFocus onChange={(e) => setName(e.target.value.trim())} />
          </Field>
          <Field id={ids.velero} label={t("storage:velero.namespace")} hint={locations.length === 0 ? t("storage:velero.noLocations") : undefined}>
            <input id={ids.velero} className="st-input" value={veleroNamespace} readOnly />
          </Field>
          <Field id={ids.ttl} label={t("storage:velero.ttl")} hint={ttlOk ? t("storage:velero.ttlHint") : t("storage:velero.invalidTtl")}>
            <input id={ids.ttl} className="st-input" value={ttl} onChange={(e) => setTtl(e.target.value.trim())} />
          </Field>
          <Field id={ids.loc} label={t("storage:velero.location")}>
            <select id={ids.loc} className="st-input" value={storageLocation} onChange={(e) => setStorageLocation(e.target.value)}>
              <option value="">{t("storage:velero.defaultLocation")}</option>
              {inVelero.map((l) => (
                <option key={l.metadata?.name} value={l.metadata?.name ?? ""}>
                  {l.metadata?.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      }
    />
  );
}

export function VeleroRestoreDialog({ clusterId, backup, close }: { clusterId: ClusterId; backup: KubeObject; close: () => void }) {
  const { t } = useTranslation();
  const nameId = useId();
  const mapId = useId();
  const backupName = backup.metadata?.name ?? "";
  // A Restore goes where its Backup is: that namespace is Velero's.
  const veleroNamespace = backup.metadata?.namespace ?? "";
  const sources = includedNamespaces(backup).filter((ns) => ns !== "*");
  const [name, setName] = useState(() => suffixed(backupName, stamp(new Date())));
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const nameOk = validVeleroName(name);
  const mappingOk = Object.values(mapping).every((to) => to === "" || validNamespace(to));
  const object = nameOk && mappingOk ? veleroRestoreOf({ veleroNamespace, name, backup: backupName, mapping }) : null;
  const mapped = Object.entries(mapping).filter(([from, to]) => to !== "" && to !== from);
  const phase = String(get(backup, "status", "phase") ?? "");

  return (
    <CreateDialog
      clusterId={clusterId}
      title={t("storage:velero.restoreTitle", { name: backupName })}
      close={close}
      object={object}
      note={mapped.length > 0 ? t("storage:velero.restoreNoteMapped") : t("storage:velero.restoreNote")}
      form={
        <>
          {phase !== "Completed" && <p className="st-note">{t("storage:velero.restoreNotCompleted", { phase: phase || "—" })}</p>}
          <Field id={nameId} label={t("storage:form.name")} hint={nameOk ? undefined : t("storage:velero.invalidName")}>
            <input id={nameId} className="st-input" value={name} autoFocus onChange={(e) => setName(e.target.value.trim())} />
          </Field>
          {sources.length === 0 ? (
            <p className="action-dialog__hint">{t("storage:velero.allNamespaces")}</p>
          ) : (
            <fieldset className="st-mapping">
              <legend>{t("storage:velero.mapping")}</legend>
              <p className="action-dialog__hint">{t("storage:velero.mappingHint")}</p>
              {sources.map((ns, i) => {
                const id = `${mapId}-${i}`;
                const value = mapping[ns] ?? "";
                return (
                  <Field key={ns} id={id} label={t("storage:velero.mapFrom", { namespace: ns })} hint={value === "" || validNamespace(value) ? undefined : t("storage:velero.invalidNamespace")}>
                    <input id={id} className="st-input" value={value} placeholder={ns} onChange={(e) => setMapping({ ...mapping, [ns]: e.target.value.trim() })} />
                  </Field>
                );
              })}
            </fieldset>
          )}
        </>
      }
    />
  );
}
