// "Composite resources" (Crossplane section, #213): every claim and composite of the kinds the XRDs define (at most
// `MAX_XRDS` XRDs), with Synced, Ready and the first failing condition, problems first; "Only problems" leaves the
// rest out. The rows come from the shared store (store.ts), the same the problems provider holds.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox, LoadingIndicator } from "../../components";
import { ResizableTable } from "../../components/Table";
import type { PageProps } from "../../layout/pages";
import { StatusText } from "../../resources";
import { apiVersionOf } from "../../resources/refs";
import { link } from "../details";
import { conditionTone, HEALTH_TONE, type Health } from "./model";
import { MAX_XRDS, useCrossplane, type Row } from "./store";

const RANK: Record<Health, number> = { failed: 0, progressing: 1, unknown: 2, paused: 3, ready: 4 };

const byState = (a: Row, b: Row) =>
  RANK[a.health] - RANK[b.health] ||
  a.ref.kind.kind.localeCompare(b.ref.kind.kind) ||
  (a.ref.namespace ?? "").localeCompare(b.ref.namespace ?? "") ||
  a.ref.name.localeCompare(b.ref.name);

/** Rows drawn at most. */
export const MAX_SHOWN = 500;

export function CompositesPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const state = useCrossplane(clusterId);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const rows = state.rows.filter((r) => !onlyProblems || r.health === "failed").sort(byState);
  const shown = rows.slice(0, MAX_SHOWN);
  const condition = (value: string | undefined) => (value ? <StatusText value={value} tone={conditionTone(value)} /> : null);

  return (
    <div className="cm-page">
      <h2 className="cm-page__title">{t("crossplane:page.title")}</h2>
      <p className="cm-muted">{t("crossplane:page.hint")}</p>
      <div className="cm-page__toolbar">
        <label className="problems__choice">
          <Checkbox checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          {t("crossplane:page.onlyProblems")}
        </label>
        {!state.loading && (
          <span className="cm-muted" role="status">
            {t("crossplane:page.total", { count: rows.length })}
          </span>
        )}
      </div>
      {state.loading && state.served && <LoadingIndicator text={t("crossplane:page.loading")} />}
      {state.xrdsTruncated && <p className="cm-muted">{t("crossplane:page.xrdsTruncated", { count: MAX_XRDS })}</p>}
      {(state.rowsTruncated || rows.length > shown.length) && <p className="cm-muted">{t("crossplane:page.rowsTruncated", { count: shown.length })}</p>}
      {!state.loading && rows.length === 0 && <p className="cm-muted">{t(state.xrds.length === 0 ? "crossplane:page.noXrds" : "crossplane:page.none")}</p>}
      {shown.length > 0 && (
        <ResizableTable tableId="crossplane.composites" className="cm-table">
          <thead>
            <tr>
              <th>{t("crossplane:page.columns.kind")}</th>
              <th>{t("crossplane:page.columns.name")}</th>
              <th>{t("crossplane:page.columns.namespace")}</th>
              <th>{t("crossplane:page.columns.state")}</th>
              <th>{t("crossplane:page.columns.synced")}</th>
              <th>{t("crossplane:page.columns.ready")}</th>
              <th>{t("crossplane:page.columns.reason")}</th>
              <th>{t("crossplane:page.columns.composition")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.uid}>
                <td>{t(`crossplane:page.kindWithRole.${row.role}`, { kind: row.ref.kind.kind })}</td>
                <td>{link({ apiVersion: apiVersionOf(row.ref.kind), kind: row.ref.kind.kind }, row.ref.name, row.ref.namespace)}</td>
                <td>{row.ref.namespace ?? ""}</td>
                <td>
                  <StatusText value={t(`crossplane:health.${row.health}`)} tone={HEALTH_TONE[row.health]} />
                </td>
                <td>{condition(row.synced)}</td>
                <td>{condition(row.ready)}</td>
                <td className="cm-table__names">
                  {row.failing?.reason ?? ""}
                  {row.failing?.message && <div className="cm-message">{row.failing.message}</div>}
                </td>
                <td>{row.composition ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </ResizableTable>
      )}
    </div>
  );
}
