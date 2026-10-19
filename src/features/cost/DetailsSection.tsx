// "Cost" section of a Deployment's, StatefulSet's or DaemonSet's details (#153): its cost over the last 7 days from
// OpenCost or Kubecost, a monthly estimate, and — when right-sizing has a recommendation for it — the estimated
// savings of applying it at this workload's own unit prices. Without OpenCost or Kubecost the section is not shown.
// The savings need the workload's pods and its usage history; both come from the watch and the poller the
// right-sizing section shares (`useWorkloadPods`, `useRightsizingSource`), so showing both opens each only once.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { CostQuery, CostRow, CostWindow, KindRef, KubeObject, ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { Button } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { RIGHTSIZING_PAGE_ID } from "../rightsizing/RightsizingPage";
import { buildRows } from "../rightsizing/group";
import { useRightsizingSource } from "../rightsizing/hooks";
import { useWorkloadPods } from "../rightsizing/workloadPods";
import { formatMoney } from "./format";
import { useCostReport } from "./hooks";
import { findWorkload, monthlyEstimate, reductionOf, savingsEstimate, unitPrices } from "./model";
import "./cost.css";

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const DASH = "—";
/** The period the details show. */
const WINDOW: CostWindow = "week";

export function costApplies(kind: KindRef): boolean {
  return kind.group === "apps" && WORKLOADS.has(kind.kind);
}

export function CostDetailsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const namespace = objectRef.namespace ?? "";
  const query: CostQuery | null = namespace
    ? { window: WINDOW, aggregate: { type: "workload" }, namespaces: [namespace] }
    : null;
  const report = useCostReport(clusterId, query);
  const data = report.data;
  // Nothing to say without a cost service, and nothing while the first answer is on its way.
  if (!namespace || report.loading || (!report.error && !data?.source)) return null;

  const row = data ? findWorkload(data.rows, namespace, objectRef.kind.kind, objectRef.name) : null;
  const currency = data?.currency ?? null;
  const money = (value: number) => formatMoney(value, currency);
  return (
    <section className="cost-section" aria-label={t("cost:details.title")}>
      <h3 className="cost-section__title">{t("cost:details.title")}</h3>
      {report.error ? (
        <p className="cost-note cost-note--warning">{t("cost:failed")}</p>
      ) : !row ? (
        <p className="cost-note">{t("cost:details.noData")}</p>
      ) : (
        <>
          <dl className="cost-facts">
            <dt>{t("cost:details.periodCost")}</dt>
            <dd>{money(row.totalCost)}</dd>
            <dt>{t("cost:details.monthly")}</dt>
            <dd title={t("cost:details.monthlyHint")}>{money(monthlyEstimate(row, WINDOW))}</dd>
          </dl>
          <p className="cost-note">{t("cost:details.monthlyHint")}</p>
          <Prices row={row} currency={currency} />
          <Savings clusterId={clusterId} objectRef={objectRef} obj={obj} row={row} currency={currency} />
          {!currency && <p className="cost-note">{t("cost:currencyUnknown")}</p>}
        </>
      )}
    </section>
  );
}

function Prices({ row, currency }: { row: CostRow; currency: string | null }) {
  const { t } = useTranslation();
  const prices = unitPrices(row);
  const price = (value: number | null) => (value === null ? DASH : formatMoney(value, currency));
  if (prices.cpuPerCoreHour === null && prices.ramPerGiBHour === null) return null;
  return (
    <p className="cost-note">
      {t("cost:details.prices", { cpu: price(prices.cpuPerCoreHour), memory: price(prices.ramPerGiBHour) })}
    </p>
  );
}

function Savings({
  clusterId,
  objectRef,
  obj,
  row,
  currency,
}: {
  clusterId: string;
  objectRef: ObjectRef;
  obj: KubeObject | null;
  row: CostRow;
  currency: string | null;
}) {
  const { t } = useTranslation();
  const setView = useAppStore((s) => s.setView);
  const namespace = objectRef.namespace ?? "";
  const kind = objectRef.kind.kind;
  // The same shared pod watch and history poller as the right-sizing section above.
  const { pods } = useWorkloadPods(clusterId, objectRef, obj);
  const source = useRightsizingSource(clusterId, { type: "workload", namespace, kind, name: objectRef.name }, "week");
  const rows = useMemo(() => buildRows(pods, source.data, Date.now()), [pods, source.data]);
  const { recommended, reduction } = reductionOf(rows);
  if (!recommended) return null;

  const savings = savingsEstimate(reduction, unitPrices(row));
  return (
    <div className="cost-savings">
      <dl className="cost-facts">
        <dt>{t("cost:details.savings")}</dt>
        <dd>
          {savings && savings.total > 0
            ? t("cost:details.savingsValue", { amount: formatMoney(savings.total, currency) })
            : DASH}
        </dd>
      </dl>
      <p className="cost-note">
        {!savings
          ? t("cost:details.noPrices")
          : savings.total > 0
            ? t("cost:details.savingsHint")
            : t("cost:details.noSavings")}
      </p>
      <Button onClick={() => setView(clusterId, RIGHTSIZING_PAGE_ID)}>{t("cost:details.openRightsizing")}</Button>
    </div>
  );
}
