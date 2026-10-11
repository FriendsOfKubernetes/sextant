// Node (addresses, capacity/allocatable, taints, scheduling, system info) and Namespace (phase).
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../../api";
import { status } from "../../../resources";
import { Block, chips, Fields, statusText, strings, table, type FieldRow } from "../ui";

const { arr, get, nodeRoles, record, str } = status;

export function NodeDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const s = get(obj, "status");
  const spec = get(obj, "spec");
  const info = get(s, "nodeInfo");
  const addresses = arr(get(s, "addresses")).map((a) => `${str(get(a, "type")) ?? ""}: ${str(get(a, "address")) ?? ""}`);
  const taints = arr(get(spec, "taints")).map((taint) => {
    const value = str(get(taint, "value"));
    return `${str(get(taint, "key")) ?? ""}${value ? `=${value}` : ""}:${str(get(taint, "effect")) ?? ""}`;
  });
  const capacity = record(get(s, "capacity"));
  const allocatable = record(get(s, "allocatable"));
  const resources = [...new Set([...Object.keys(capacity), ...Object.keys(allocatable)])]
    .filter((r) => !r.startsWith("hugepages-") || capacity[r] !== "0")
    .map((r) => [r, String(capacity[r] ?? ""), String(allocatable[r] ?? "")]);
  const cidrs = strings(get(spec, "podCIDRs"));
  const rows: FieldRow[] = [
    ["addresses", chips(addresses)],
    ["roles", chips(nodeRoles(obj))],
    [
      "unschedulable",
      get(spec, "unschedulable") === true
        ? statusText(t("details:node.unschedulable"), "warning")
        : t("details:node.schedulable"),
    ],
    ["taints", chips(taints)],
    ["podCidrs", (cidrs.length > 0 ? cidrs : strings([get(spec, "podCIDR")])).join(", ")],
    ["providerId", str(get(spec, "providerID"))],
  ];
  const resourceTable = table(
    [t("details:columns.resource"), t("details:columns.capacity"), t("details:columns.allocatable")],
    resources,
  );
  const system: FieldRow[] = [
    ["osImage", str(get(info, "osImage"))],
    ["os", str(get(info, "operatingSystem"))],
    ["architecture", str(get(info, "architecture"))],
    ["kernel", str(get(info, "kernelVersion"))],
    ["containerRuntime", str(get(info, "containerRuntimeVersion"))],
    ["kubelet", str(get(info, "kubeletVersion"))],
  ];
  return (
    <>
      <Fields rows={rows} />
      {resourceTable && <Block title={t("details:node.resources")}>{resourceTable}</Block>}
      {info !== undefined && (
        <Block title={t("details:node.system")}>
          <Fields rows={system} />
        </Block>
      )}
    </>
  );
}

export function NamespaceDetails({ obj }: { obj: KubeObject }) {
  const rows: FieldRow[] = [
    ["status", statusText(str(get(obj, "status", "phase")))],
    ["finalizers", chips(strings(get(obj, "spec", "finalizers")))],
  ];
  return <Fields rows={rows} />;
}
