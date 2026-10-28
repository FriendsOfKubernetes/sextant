// Details of VolumeSnapshots and Velero objects (#152): the state in plain words — why a snapshot is not ready, why a
// backup or restore failed or was refused, how many errors and warnings it had, whether a location is unreachable —
// and the fields that matter, with links to the claim, class, content, backup or location. Conditions and YAML are
// the panel's own sections. Read-only.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Age } from "../../components";
import { formatDateTime, formatList } from "../../i18n";
import { Block, Fields, link, type FieldRow } from "../details";
import {
  BACKUP,
  explainSnapshot,
  explainVelero,
  includedNamespaces,
  isKind,
  phaseOf,
  phaseTone,
  restoreSizeOf,
  RESTORE,
  SCHEDULE,
  BACKUP_STORAGE_LOCATION,
  snapshotClassOf,
  snapshotSourceClaim,
  snapshotState,
  VOLUME_SNAPSHOT_CONTENT,
  type Phrase,
} from "./model";

const { get, str } = status;

const SNAPSHOT_API = "snapshot.storage.k8s.io/v1";
const VELERO_API = "velero.io/v1";
const LABELS = "storage:fields";

function Explanation({ phrase }: { phrase: Phrase & { lists?: Record<string, string[]> } }) {
  const { t } = useTranslation();
  const lists = Object.fromEntries(Object.entries(phrase.lists ?? {}).map(([k, v]) => [k, formatList(v)]));
  return <p className={`st-explain st-explain--${phrase.tone ?? "neutral"}`}>{t(`storage:${phrase.key}`, { ...phrase.params, ...lists })}</p>;
}

const time = (obj: KubeObject, ...path: string[]) => {
  const value = str(get(obj, ...path));
  return value ? formatDateTime(value) : null;
};

export function SnapshotSection({ obj, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const { word, tone } = snapshotState(obj);
  const phrase = explainSnapshot(obj);
  const ns = obj.metadata?.namespace ?? null;
  const content = isKind(objectRef.kind, VOLUME_SNAPSHOT_CONTENT);
  const rows: FieldRow[] = content
    ? [
        ["state", <StatusText key="s" value={word} tone={tone} />],
        [
          "snapshot",
          link(
            { apiVersion: SNAPSHOT_API, kind: "VolumeSnapshot" },
            str(get(obj, "spec", "volumeSnapshotRef", "name")),
            str(get(obj, "spec", "volumeSnapshotRef", "namespace")) ?? null,
          ),
        ],
        ["snapshotClass", link({ apiVersion: SNAPSHOT_API, kind: "VolumeSnapshotClass" }, str(get(obj, "spec", "volumeSnapshotClassName")))],
        ["driver", str(get(obj, "spec", "driver"))],
        ["deletionPolicy", str(get(obj, "spec", "deletionPolicy"))],
        ["snapshotHandle", str(get(obj, "status", "snapshotHandle")) ?? str(get(obj, "spec", "source", "snapshotHandle"))],
        ["restoreSize", restoreSizeOf(obj)],
      ]
    : [
        ["state", <StatusText key="s" value={word} tone={tone} />],
        ["source", link({ apiVersion: "v1", kind: "PersistentVolumeClaim" }, snapshotSourceClaim(obj), ns)],
        ["snapshotClass", link({ apiVersion: SNAPSHOT_API, kind: "VolumeSnapshotClass" }, snapshotClassOf(obj))],
        ["content", link({ apiVersion: SNAPSHOT_API, kind: "VolumeSnapshotContent" }, str(get(obj, "status", "boundVolumeSnapshotContentName")))],
        ["restoreSize", restoreSizeOf(obj)],
        ["taken", time(obj, "status", "creationTime")],
      ];
  return (
    <Block id="storage:snapshot.section" title={t("storage:snapshot.section")}>
      {phrase && <Explanation phrase={phrase} />}
      {!content && word === "Ready" && <p className="st-muted">{t("storage:snapshot.restoreHint")}</p>}
      <Fields rows={rows} labelPrefix={LABELS} />
    </Block>
  );
}

export function VeleroSection({ obj, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const kind = objectRef.kind;
  const phase = phaseOf(obj);
  const ns = obj.metadata?.namespace ?? null;
  const namespaces = includedNamespaces(obj);
  const location = (name: string | undefined) => link({ apiVersion: VELERO_API, kind: "BackupStorageLocation" }, name, ns);
  const rows: FieldRow[] = [["phase", phase ? <StatusText key="p" value={phase} tone={phaseTone(phase)} /> : null]];
  if (isKind(kind, BACKUP)) {
    rows.push(
      ["namespaces", namespaces.length > 0 ? formatList(namespaces) : t("storage:velero.everyNamespace")],
      ["ttl", str(get(obj, "spec", "ttl"))],
      ["location", location(str(get(obj, "spec", "storageLocation")))],
      ["started", time(obj, "status", "startTimestamp")],
      ["completed", time(obj, "status", "completionTimestamp")],
      ["expires", time(obj, "status", "expiration")],
    );
  } else if (isKind(kind, RESTORE)) {
    rows.push(
      ["backup", link({ apiVersion: VELERO_API, kind: "Backup" }, str(get(obj, "spec", "backupName")), ns)],
      ["schedule", link({ apiVersion: VELERO_API, kind: "Schedule" }, str(get(obj, "spec", "scheduleName")), ns)],
      ["started", time(obj, "status", "startTimestamp")],
      ["completed", time(obj, "status", "completionTimestamp")],
    );
  } else if (isKind(kind, SCHEDULE)) {
    const lastBackup = str(get(obj, "status", "lastBackup"));
    rows.push(
      ["cron", str(get(obj, "spec", "schedule"))],
      ["namespaces", namespaces.length > 0 ? formatList(namespaces) : t("storage:velero.everyNamespace")],
      ["ttl", str(get(obj, "spec", "template", "ttl"))],
      ["lastBackup", lastBackup ? <Age key="a" timestamp={lastBackup} /> : null],
    );
  } else {
    rows.push(
      ["provider", str(get(obj, "spec", "provider"))],
      ["bucket", str(get(obj, "spec", "objectStorage", "bucket"))],
      ["prefix", str(get(obj, "spec", "objectStorage", "prefix"))],
      ["accessMode", isKind(kind, BACKUP_STORAGE_LOCATION) ? str(get(obj, "spec", "accessMode")) : undefined],
      ["lastValidated", time(obj, "status", "lastValidationTime")],
    );
  }
  return (
    <Block id="storage:velero.section" title={t("storage:velero.section")}>
      {explainVelero(kind, obj).map((p) => (
        <Explanation key={p.key} phrase={p} />
      ))}
      <Fields rows={rows} labelPrefix={LABELS} />
    </Block>
  );
}
