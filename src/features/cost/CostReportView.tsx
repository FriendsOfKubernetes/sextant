// One cost report: where it comes from, totals with the split by resource and the idle cost, and the groups.
import { useTranslation } from "react-i18next";
import type { CostAggregate, CostReport, CostRow } from "../../api";
import { useAppStore } from "../../app/store";
import { formatMoney, formatShare } from "./format";
import {
  hasNamespaceColumn,
  isSpecial,
  partCost,
  rowLabel,
  rowObjectRef,
  shownParts,
  totalsOf,
  UNMOUNTED,
  type CostPart,
} from "./model";

const DASH = "—";

export function CostReportView({
  report,
  aggregate,
  filtered,
}: {
  report: CostReport;
  aggregate: CostAggregate;
  filtered: boolean;
}) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  const source = report.source!;
  const currency = report.currency;
  const money = (value: number) => formatMoney(value, currency);
  const totals = totalsOf(report.rows, report.idle);
  const parts = shownParts(totals);
  const withNamespace = hasNamespaceColumn(aggregate);

  const nameOf = (row: CostRow) => {
    if (row.name.endsWith(UNMOUNTED)) return t("cost:unmounted");
    if (isSpecial(row)) return t(`cost:unallocated.${aggregate.type}`);
    const label = rowLabel(row, aggregate);
    return label.kind ? t("cost:workload", { kind: label.kind, name: label.name }) : label.name;
  };

  return (
    <>
      <p className="cost-note">
        {t(`cost:source.${source.product}`, { namespace: source.namespace, service: source.service })}{" "}
        {currency ? t("cost:currency", { currency }) : t("cost:currencyUnknown")}
      </p>
      {filtered && <p className="cost-note">{t("cost:filtered")}</p>}

      <section className="cost-totals" aria-label={t("cost:totals.label")}>
        <dl className="cost-totals__list">
          <div className="cost-total cost-total--main">
            <dt>{t("cost:totals.total")}</dt>
            <dd>{money(totals.total)}</dd>
          </div>
          <div className="cost-total">
            <dt>{t("cost:totals.allocated")}</dt>
            <dd>{money(totals.allocated)}</dd>
          </div>
          <div className="cost-total" title={t("cost:idleHint")}>
            <dt>{t("cost:totals.idle")}</dt>
            <dd>{report.idle ? money(totals.idle) : DASH}</dd>
          </div>
          {parts.map((p) => (
            <div key={p} className="cost-total">
              <dt>{t(`cost:parts.${p}`)}</dt>
              <dd>{money(totals.parts[p])}</dd>
            </div>
          ))}
        </dl>
        <SplitBar parts={parts} values={totals.parts} total={totals.allocated} label={t("cost:split")} />
      </section>

      {report.truncated && (
        <p className="cost-note cost-note--warning">
          {t("cost:truncated", { count: report.rows.length, total: report.totalRows })}
        </p>
      )}
      {report.rows.length === 0 && !report.idle ? (
        <p className="cost-note">{t("cost:empty")}</p>
      ) : (
        <div className="cost-table-wrap">
          <table className="cost-table">
            <thead>
              <tr>
                <th scope="col">{t("cost:column.name")}</th>
                {withNamespace && <th scope="col">{t("cost:column.namespace")}</th>}
                {parts.map((p) => (
                  <th key={p} scope="col" className="cost-num">
                    {t(`cost:parts.${p}`)}
                  </th>
                ))}
                <th scope="col" className="cost-num">
                  {t("cost:column.total")}
                </th>
                <th scope="col" className="cost-num" title={t("cost:efficiencyHint")}>
                  {t("cost:column.efficiency")}
                </th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => {
                const ref = rowObjectRef(row, aggregate);
                const name = nameOf(row);
                return (
                  <tr key={row.name}>
                    <td>
                      {ref ? (
                        <button
                          type="button"
                          className="rt-link"
                          aria-label={t("cost:openObject", { name })}
                          onClick={() => openDetails(ref)}
                        >
                          {name}
                        </button>
                      ) : (
                        <span className={isSpecial(row) ? "cost-special" : undefined}>{name}</span>
                      )}
                    </td>
                    {withNamespace && <td>{row.namespace ?? DASH}</td>}
                    {parts.map((p) => (
                      <td key={p} className="cost-num">
                        {money(partCost(row, p))}
                      </td>
                    ))}
                    <td className="cost-num cost-strong">{money(row.totalCost)}</td>
                    <td className="cost-num">
                      {row.totalEfficiency === null ? DASH : formatShare(row.totalEfficiency)}
                    </td>
                  </tr>
                );
              })}
              {report.idle && (
                <tr className="cost-idle" title={t("cost:idleHint")}>
                  <td>{t("cost:idleRow")}</td>
                  {withNamespace && <td>{DASH}</td>}
                  {parts.map((p) => (
                    <td key={p} className="cost-num">
                      {money(partCost(report.idle!, p))}
                    </td>
                  ))}
                  <td className="cost-num cost-strong">{money(report.idle.totalCost)}</td>
                  <td className="cost-num">{DASH}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** A bar of the allocated cost split by resource; each segment's width is its share. */
function SplitBar({
  parts,
  values,
  total,
  label,
}: {
  parts: CostPart[];
  values: Record<CostPart, number>;
  total: number;
  label: string;
}) {
  const { t } = useTranslation();
  if (!(total > 0)) return null;
  return (
    <div className="cost-split" role="img" aria-label={label}>
      {parts.map((p) => {
        const share = Math.max(0, values[p]) / total;
        if (share <= 0) return null;
        return (
          <span
            key={p}
            className={`cost-split__part cost-split__part--${p}`}
            style={{ width: `${share * 100}%` }}
            title={t("cost:splitPart", { part: t(`cost:parts.${p}`), share: formatShare(share) })}
          />
        );
      })}
    </div>
  );
}
