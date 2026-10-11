// PersistentVolumeClaim (→ its PersistentVolume and StorageClass), PersistentVolume (→ its claim) and StorageClass.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../../api";
import { status } from "../../../resources";
import { Fields, KINDS, link, mapChips, statusText, strings, type FieldRow } from "../ui";

const { get, record, str } = status;

export function PvcDetails({ obj }: { obj: KubeObject }) {
  const spec = get(obj, "spec");
  const rows: FieldRow[] = [
    ["status", statusText(str(get(obj, "status", "phase")))],
    ["volume", link(KINDS.pv, str(get(spec, "volumeName")))],
    ["storageClass", link(KINDS.storageClass, str(get(spec, "storageClassName")))],
    ["accessModes", strings(get(spec, "accessModes")).join(", ")],
    ["capacity", str(get(obj, "status", "capacity", "storage"))],
    ["requested", str(get(spec, "resources", "requests", "storage"))],
    ["volumeMode", str(get(spec, "volumeMode"))],
    ["selector", mapChips(get(spec, "selector", "matchLabels"))],
  ];
  return <Fields rows={rows} />;
}

const PV_SPEC_FIELDS = new Set([
  "accessModes",
  "capacity",
  "claimRef",
  "persistentVolumeReclaimPolicy",
  "storageClassName",
  "volumeMode",
  "nodeAffinity",
  "mountOptions",
]);

export function PvDetails({ obj }: { obj: KubeObject }) {
  const spec = get(obj, "spec");
  const claim = get(spec, "claimRef");
  const claimNs = str(get(claim, "namespace")) ?? null;
  const claimName = str(get(claim, "name"));
  const rows: FieldRow[] = [
    ["status", statusText(str(get(obj, "status", "phase")))],
    ["capacity", str(get(spec, "capacity", "storage"))],
    ["accessModes", strings(get(spec, "accessModes")).join(", ")],
    ["reclaimPolicy", str(get(spec, "persistentVolumeReclaimPolicy"))],
    ["storageClass", link(KINDS.storageClass, str(get(spec, "storageClassName")))],
    ["claim", link(KINDS.pvc, claimName, claimNs, `${claimNs ?? ""}/${claimName ?? ""}`)],
    ["volumeMode", str(get(spec, "volumeMode"))],
    ["source", Object.keys(record(spec)).find((k) => !PV_SPEC_FIELDS.has(k))],
  ];
  return <Fields rows={rows} />;
}

export function StorageClassDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const annotations = record(obj.metadata?.annotations);
  const isDefault =
    annotations["storageclass.kubernetes.io/is-default-class"] === "true" ||
    annotations["storageclass.beta.kubernetes.io/is-default-class"] === "true";
  const expansion = get(obj, "allowVolumeExpansion");
  const rows: FieldRow[] = [
    ["provisioner", str(get(obj, "provisioner"))],
    ["reclaimPolicy", str(get(obj, "reclaimPolicy"))],
    ["volumeBindingMode", str(get(obj, "volumeBindingMode"))],
    ["allowVolumeExpansion", typeof expansion === "boolean" ? t(expansion ? "details:yes" : "details:no") : undefined],
    ["default", isDefault ? t("details:yes") : undefined],
    ["parameters", mapChips(get(obj, "parameters"))],
    ["mountOptions", strings(get(obj, "mountOptions")).join(", ")],
  ];
  return <Fields rows={rows} />;
}
