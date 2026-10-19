// The "Cost" page (#153) in the Cluster section: costs from OpenCost or Kubecost over the last 24 hours, 7 or 30 days,
// grouped by namespace, workload, Pod, node or the value of a label, split into CPU, memory, storage and network
// (GPU and other when there are any), with the idle cost apart. Follows the namespace filter. Read-only; without
// OpenCost or Kubecost it says so and where to get it — Sextant does not install it.
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { CostAggregate, CostQuery, CostWindow } from "../../api";
import { Button, EmptyState, ErrorState, LoadingIndicator } from "../../components";
import type { PageProps } from "../../layout/pages";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { CostReportView } from "./CostReportView";
import { useCostReport } from "./hooks";
import { filterNamespaces, isLabelKey } from "./model";
import "./cost.css";

export const COST_PAGE_ID = "cost";

const WINDOWS: CostWindow[] = ["day", "week", "month"];
type AggregateType = CostAggregate["type"];
const AGGREGATES: AggregateType[] = ["namespace", "workload", "pod", "node", "label"];

export function CostPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const selected = useSelectedNamespaces(clusterId);
  const [window, setWindow] = useState<CostWindow>("week");
  const [type, setType] = useState<AggregateType>("namespace");
  const [labelDraft, setLabelDraft] = useState("");
  const [labelKey, setLabelKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const aggregate: CostAggregate | null =
    type === "label" ? (labelKey ? { type: "label", key: labelKey } : null) : { type };
  const namespaces = selected === undefined ? null : filterNamespaces(selected);
  const query: CostQuery | null = selected === undefined || !aggregate ? null : { window, aggregate, namespaces };
  const report = useCostReport(clusterId, query, attempt);

  const draft = labelDraft.trim();
  const draftInvalid = draft !== "" && !isLabelKey(draft);
  const submitLabel = (e: FormEvent) => {
    e.preventDefault();
    if (draft && !draftInvalid) setLabelKey(draft);
  };

  let body;
  if (selected === undefined || (query && report.loading)) {
    body = <LoadingIndicator className="cost-loading" text={t("cost:loading")} />;
  } else if (!query || !aggregate) {
    body = <p className="cost-note">{t("cost:labelKey.choose")}</p>;
  } else if (report.error) {
    body = <ErrorState error={report.error} title={t("cost:failed")} onRetry={() => setAttempt((n) => n + 1)} />;
  } else if (!report.data) {
    body = null;
  } else if (!report.data.source) {
    body = <EmptyState title={t("cost:notFound.title")} text={t("cost:notFound.text")} />;
  } else {
    body = <CostReportView report={report.data} aggregate={aggregate} filtered={namespaces !== null} />;
  }

  return (
    <div className="cost-page">
      <h2 className="cost-page__title">{t("cost:title")}</h2>
      <p className="cost-note">{t("cost:intro")}</p>
      <div className="cost-toolbar">
        <label className="cost-choice">
          {t("cost:window.label")}
          <select value={window} onChange={(e) => setWindow(e.target.value as CostWindow)}>
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {t(`cost:window.${w}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="cost-choice">
          {t("cost:aggregate.title")}
          <select value={type} onChange={(e) => setType(e.target.value as AggregateType)}>
            {AGGREGATES.map((a) => (
              <option key={a} value={a}>
                {t(`cost:aggregate.${a}`)}
              </option>
            ))}
          </select>
        </label>
        {type === "label" && (
          <form className="cost-choice" onSubmit={submitLabel}>
            <label className="cost-choice">
              {t("cost:labelKey.label")}
              <input
                className="cost-input"
                value={labelDraft}
                spellCheck={false}
                aria-invalid={draftInvalid}
                onChange={(e) => setLabelDraft(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={!draft || draftInvalid}>
              {t("cost:labelKey.show")}
            </Button>
            {draftInvalid && <span className="cost-note cost-note--warning">{t("cost:labelKey.invalid")}</span>}
          </form>
        )}
        <NamespaceFilter clusterId={clusterId} />
      </div>
      {body}
    </div>
  );
}
