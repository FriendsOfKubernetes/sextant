// Columns of the VPA tables. VerticalPodAutoscalers: the target, the update mode, the state from the conditions (the
// condition's message as its tooltip), and the first container's CPU and memory target, as the CRD's own printer
// columns show them. Checkpoints: the VPA and container they keep the recommender's histograms for, how many samples
// and when they were last saved (the histograms themselves are not shown).
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { formatDateTime } from "../../i18n";
import { ageColumn, nameColumn, namespaceColumn, StatusText, status, type ColumnDef } from "../../resources";
import { formatAmount, quantity } from "../autoscaling/model";
import { recommendationsOf, STATE_TONE, statusOf, targetOf, updateModeOf } from "./model";

const { get, num, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `vpa:columns.${id}`,
  value,
  ...options,
});

/** The state in words, colored; the deciding condition's message as its tooltip. */
export function StateCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const s = statusOf(obj);
  return (
    <span title={s.message || undefined}>
      <StatusText value={t(`vpa:reason.${s.reason}`)} tone={STATE_TONE[s.state]} />
    </span>
  );
}

const targetText = (obj: KubeObject) => {
  const ref = targetOf(obj);
  return ref ? `${ref.kind}/${ref.name}` : undefined;
};

/** The first container's target of `resource`, as the CRD's printer column; its base amount for sorting. */
const firstTarget = (obj: KubeObject, resource: string) => quantity(recommendationsOf(obj)[0]?.target[resource]);

function AmountCell({ obj, resource }: { obj: KubeObject; resource: string }) {
  const value = firstTarget(obj, resource);
  return <>{value === undefined ? "" : formatAmount(resource, value)}</>;
}

const CPU = "cpu";
const MEMORY = "memory";

export const vpaColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("target", targetText, { width: "minmax(140px, 1fr)" }),
  // The mode is an API value (Off, Initial, Recreate, …): shown as it is in every language.
  col("mode", updateModeOf, { width: "140px" }),
  col("status", (o) => statusOf(o).reason, { width: "160px", render: (o) => <StateCell obj={o} /> }),
  col("cpu", (o) => firstTarget(o, CPU), { width: "80px", render: (o) => <AmountCell obj={o} resource={CPU} /> }),
  col("memory", (o) => firstTarget(o, MEMORY), { width: "90px", render: (o) => <AmountCell obj={o} resource={MEMORY} /> }),
  ageColumn,
];

const lastUpdate = (o: KubeObject) => str(get(o, "status", "lastUpdateTime"));

export const checkpointColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("vpa", (o) => str(get(o, "spec", "vpaObjectName")), { width: "minmax(120px, 1fr)" }),
  col("container", (o) => str(get(o, "spec", "containerName")), { width: "minmax(100px, 1fr)" }),
  col("samples", (o) => num(get(o, "status", "totalSamplesCount")), { width: "90px" }),
  col("lastUpdate", lastUpdate, {
    width: "170px",
    render: (o) => {
      const v = lastUpdate(o);
      return v ? <time dateTime={v}>{formatDateTime(v)}</time> : null;
    },
  }),
  ageColumn,
];
