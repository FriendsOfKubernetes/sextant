// Columns of the helm-controller and k3s tables. HelmCharts: the state the chart itself tells (helm-controller's
// `Failed` and `JobCreated` conditions — the Job's outcome is in the details: a table cell opens no watch), the chart,
// its version, where it installs and the Addon that deployed it. HelmChartConfigs: the HelmChart they override (the
// one of the same name). Addons: the manifest file and its checksum. etcd snapshots: node, storage, size, creation
// time and state.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { Age } from "../../components";
import { formatBytes, parseQuantity } from "../metrics/format";
import { ageColumn, ageOptions, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import {
  addonChecksumOf,
  addonOwnerOf,
  addonSourceOf,
  CHART_TONE,
  chartFailureOf,
  chartInfoOf,
  chartStateOf,
  SNAPSHOT_TONE,
  snapshotOf,
  snapshotStateOf,
} from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `k3s:columns.${id}`,
  value,
  ...options,
});

/** A HelmChart's state in words, colored; helm-controller's message as its tooltip. */
export function ChartStateText({ obj, job }: { obj: KubeObject; job?: KubeObject }) {
  const { t } = useTranslation();
  const state = chartStateOf(obj, job);
  return (
    <span title={chartFailureOf(obj, job) || undefined}>
      <StatusText value={t(`k3s:chartState.${state}`)} tone={CHART_TONE[state]} />
    </span>
  );
}

/** A snapshot's size: a byte count as bytes, any other quantity as it is. */
export function sizeText(size: string | undefined): string {
  if (!size) return "";
  const bytes = parseQuantity(size);
  return bytes === undefined ? size : formatBytes(bytes);
}

export const chartColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("state", (o) => chartStateOf(o), {
    width: "120px",
    render: (o) => <ChartStateText obj={o} />,
    searchText: (o, ctx) => ctx.t(`k3s:chartState.${chartStateOf(o)}`),
  }),
  col("chart", (o) => chartInfoOf(o).chart ?? "", { width: "minmax(140px, 2fr)" }),
  col("version", (o) => chartInfoOf(o).version ?? "", { width: "minmax(80px, 1fr)" }),
  col("targetNamespace", (o) => chartInfoOf(o).targetNamespace, { width: "minmax(100px, 1fr)" }),
  col("addon", (o) => addonOwnerOf(o)?.name ?? "", { width: "minmax(100px, 1fr)" }),
  ageColumn,
];

export const configColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  // A HelmChartConfig overrides the HelmChart of its own name.
  col("helmChart", (o) => o.metadata?.name ?? "", { width: "minmax(140px, 1fr)" }),
  ageColumn,
];

export const addonColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("source", (o) => addonSourceOf(o) ?? "", { width: "minmax(200px, 3fr)" }),
  col("checksum", (o) => (addonChecksumOf(o) ?? "").slice(0, 12), { width: "120px" }),
  ageColumn,
];

function SnapshotState({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const s = snapshotOf(obj);
  const state = snapshotStateOf(s);
  return (
    <span title={s.error || undefined}>
      <StatusText value={t(`k3s:snapshotState.${state}`)} tone={SNAPSHOT_TONE[state]} />
    </span>
  );
}

function Created({ obj }: { obj: KubeObject }) {
  const created = snapshotOf(obj).createdAt;
  return created ? <Age timestamp={created} /> : null;
}

export const snapshotColumns: ColumnDef[] = [
  nameColumn,
  col("node", (o) => snapshotOf(o).node ?? "", { width: "minmax(120px, 1fr)" }),
  col("storage", (o) => snapshotOf(o).storage, {
    width: "90px",
    render: (o) => <StorageText obj={o} />,
    searchText: (o, ctx) => ctx.t(`k3s:storage.${snapshotOf(o).storage}`),
  }),
  col("size", (o) => sizeText(snapshotOf(o).size), { width: "100px" }),
  col("created", (o) => snapshotOf(o).createdAt ?? "", {
    width: "110px",
    render: (o) => <Created obj={o} />,
    ...ageOptions((o) => snapshotOf(o).createdAt),
  }),
  col("state", (o) => snapshotStateOf(snapshotOf(o)), {
    width: "110px",
    render: (o) => <SnapshotState obj={o} />,
    searchText: (o, ctx) => ctx.t(`k3s:snapshotState.${snapshotStateOf(snapshotOf(o))}`),
  }),
  ageColumn,
];

function StorageText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  return <>{t(`k3s:storage.${snapshotOf(obj).storage}`)}</>;
}
