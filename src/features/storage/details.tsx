// Details of VolumeSnapshots and their contents (#152): the state in plain words — why a snapshot is not ready — and
// the fields that matter, with links to the claim, class and content. Conditions and YAML are the panel's own
// sections. Read-only.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { formatDateTime } from "../../i18n";
import { Block, Fields, link, type FieldRow } from "../details";
import {
  explainSnapshot,
  isKind,
  restoreSizeOf,
  snapshotClassOf,
  snapshotSourceClaim,
  snapshotState,
  VOLUME_SNAPSHOT_CONTENT,
  type Phrase,
} from "./model";

const { get, str } = status;

const SNAPSHOT_API = "snapshot.storage.k8s.io/v1";
const LABELS = "storage:fields";

function Explanation({ phrase }: { phrase: Phrase }) {
  const { t } = useTranslation();
  return <p className={`st-explain st-explain--${phrase.tone ?? "neutral"}`}>{t(`storage:${phrase.key}`, phrase.params)}</p>;
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
