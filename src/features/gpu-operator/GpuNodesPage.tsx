// "GPU nodes" (NVIDIA GPU Operator section, #245): the nodes labelled `nvidia.com/gpu.present=true` (at most
// `MAX_GPU_NODES`), with the GPU product and count GPU Feature Discovery labels, the `nvidia.com/gpu` and MIG
// resources' capacity and allocatable from the node status, and the MIG configuration with its state. Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LoadingIndicator } from "../../components";
import type { PageProps } from "../../layout/pages";
import { StatusText } from "../../resources";
import { chips, KINDS, link, table, type ColumnWrap } from "../details";
import { MAX_GPU_NODES, useGpuNodes } from "./hooks";
import { GPU_RESOURCE, gpuNodeOf, migStateTone } from "./model";

const PAGE_TABLE = "gpuNodesPage";
const WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap", "nowrap", undefined, "nowrap", "nowrap"];

export function GpuNodesPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const nodes = useGpuNodes(clusterId);
  const rows: ReactNode[][] = nodes.items
    .map(gpuNodeOf)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => {
      const gpu = n.amounts.find((a) => a.resource === GPU_RESOURCE);
      const mig = n.amounts.filter((a) => a.resource !== GPU_RESOURCE);
      return [
        link(KINDS.node, n.name),
        n.product ?? "",
        n.count ?? "",
        gpu ? t("gpuoperator:page.amount", { allocatable: gpu.allocatable ?? "", capacity: gpu.capacity ?? "" }) : "",
        chips(mig.map((a) => `${a.resource.slice("nvidia.com/".length)}: ${a.allocatable ?? ""}/${a.capacity ?? ""}`)),
        n.migConfig ?? "",
        n.migState ? <StatusText key="m" value={n.migState} tone={migStateTone(n.migState)} /> : "",
      ];
    });
  const view = table(
    PAGE_TABLE,
    [
      t("gpuoperator:page.columns.node"),
      t("gpuoperator:page.columns.product"),
      t("gpuoperator:page.columns.count"),
      t("gpuoperator:page.columns.gpus"),
      t("gpuoperator:page.columns.mig"),
      t("gpuoperator:page.columns.migConfig"),
      t("gpuoperator:page.columns.migState"),
    ],
    rows,
    WRAP,
  );
  return (
    <div className="gpu-page">
      <h2 className="gpu-page__title">{t("gpuoperator:page.title")}</h2>
      <p className="gpu-muted">{t("gpuoperator:page.hint")}</p>
      {nodes.loading && <LoadingIndicator text={t("gpuoperator:loading")} />}
      {!nodes.loading && (
        <p className="gpu-muted" role="status">
          {t("gpuoperator:page.total", { count: rows.length })}
        </p>
      )}
      {nodes.truncated && <p className="gpu-muted">{t("gpuoperator:page.truncated", { count: MAX_GPU_NODES })}</p>}
      {nodes.unavailable && <p className="gpu-muted">{t("gpuoperator:page.unavailable")}</p>}
      {rows.length > 0 && view}
    </div>
  );
}
