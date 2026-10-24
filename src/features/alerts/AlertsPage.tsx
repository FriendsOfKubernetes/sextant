// The "Alerts" page (#264, Cluster section): the alerts of the cluster's Prometheus-compatible source and Alertmanager,
// grouped by severity (most severe first) and then by alert name, each with its state, the object its labels name,
// its age, summary, description, labels and links; filters by severity, namespace, state and text. A second tab lists
// the Alertmanager's active and pending silences, read-only. The data is polled once a minute while the page is shown
// (store.ts); nothing is changed anywhere.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AlertState } from "../../api";
import { Badge, ErrorState, LoadingIndicator, Tabs } from "../../components";
import type { PageProps } from "../../layout/pages";
import { alertKeys, choices, groupAlerts, matches, NO_FILTER, STATES, type AlertFilter } from "./model";
import { SilencesView } from "./SilencesView";
import { anySource, SourceNotes } from "./SourceNotes";
import { useAlerts } from "./store";
import { AlertRow, useSeverityText } from "./ui";
import "./alerts.css";

type Tab = "alerts" | "silences";
const ALERTS_TAB: Tab = "alerts";
const SILENCES_TAB: Tab = "silences";
const ALL = "*";

export function AlertsPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const { report, error, loading } = useAlerts(clusterId);
  const [tab, setTab] = useState<Tab>("alerts");
  const [filter, setFilter] = useState<AlertFilter>(NO_FILTER);
  const severityText = useSeverityText();
  const alerts = report?.alerts;
  const options = useMemo(() => choices(alerts ?? []), [alerts]);
  const shown = useMemo(() => (alerts ?? []).filter((a) => matches(a, filter)), [alerts, filter]);
  const groups = useMemo(() => groupAlerts(shown), [shown]);
  const set = (patch: Partial<AlertFilter>) => setFilter((f) => ({ ...f, ...patch }));

  return (
    <div className="al-page">
      <h2 className="al-page__title">{t("alerts:title")}</h2>
      {error && <ErrorState error={error} />}
      {loading && !report && <LoadingIndicator className="al-loading" text={t("alerts:loading")} />}
      {report && <SourceNotes clusterId={clusterId} report={report} />}
      {report && anySource(report) && (
        <Tabs
          label={t("alerts:tabs.label")}
          selected={tab}
          onSelect={setTab}
          tabs={[
            { id: ALERTS_TAB, label: t("alerts:tabs.alerts", { count: report.alerts.length }) },
            { id: SILENCES_TAB, label: t("alerts:tabs.silences", { count: report.silences.length }) },
          ]}
        >
          {tab === "silences" ? (
            <SilencesView report={report} />
          ) : (
            <>
              <div className="al-toolbar">
                <input
                  type="search"
                  className="al-search"
                  value={filter.search}
                  placeholder={t("alerts:filter.search")}
                  aria-label={t("alerts:filter.search")}
                  onChange={(e) => set({ search: e.target.value })}
                />
                <label className="al-choice">
                  <span>{t("alerts:filter.severity")}</span>
                  <select
                    value={filter.severity ?? ALL}
                    onChange={(e) => set({ severity: e.target.value === ALL ? null : e.target.value })}
                  >
                    <option value={ALL}>{t("alerts:filter.all")}</option>
                    {options.severities.map((s) => (
                      <option key={s} value={s}>
                        {severityText(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="al-choice">
                  <span>{t("alerts:filter.namespace")}</span>
                  <select
                    value={filter.namespace ?? ALL}
                    onChange={(e) => set({ namespace: e.target.value === ALL ? null : e.target.value })}
                  >
                    <option value={ALL}>{t("alerts:filter.all")}</option>
                    {options.namespaces.map((ns) => (
                      <option key={ns} value={ns}>
                        {ns}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="al-choice">
                  <span>{t("alerts:filter.state")}</span>
                  <select
                    value={filter.state ?? ALL}
                    onChange={(e) => set({ state: e.target.value === ALL ? null : (e.target.value as AlertState) })}
                  >
                    <option value={ALL}>{t("alerts:filter.all")}</option>
                    {STATES.map((s) => (
                      <option key={s} value={s}>
                        {t(`alerts:state.${s}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="al-total" role="status">
                  {t("alerts:shown", { count: shown.length })}
                </span>
              </div>
              {report.truncated && <p className="al-note">{t("alerts:truncated", { total: report.totalAlerts })}</p>}
              {groups.length === 0 ? (
                <p className="al-note">{report.alerts.length === 0 ? t("alerts:none") : t("alerts:noneMatch")}</p>
              ) : (
                groups.map((group) => (
                  <section key={group.severity} className="al-group" aria-label={severityText(group.severity)}>
                    <h3 className="al-group__title">
                      {severityText(group.severity)}
                      <Badge>{group.count}</Badge>
                    </h3>
                    {group.names.map((byName) => {
                      const keys = alertKeys(byName.alerts);
                      return (
                        <div key={byName.name} className="al-name">
                          <h4 className="al-name__title">
                            {byName.name || t("alerts:unnamed")}
                            <Badge>{byName.alerts.length}</Badge>
                          </h4>
                          <ul className="al-list">
                            {byName.alerts.map((alert, i) => (
                              <AlertRow key={keys[i]} alert={alert} />
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </section>
                ))
              )}
            </>
          )}
        </Tabs>
      )}
    </div>
  );
}
