// The problems screen (#136): everything that is red in the cluster on one page — nodes, pods, workloads, Jobs,
// volume claims, certificates, Flux, Argo CD and Gateway API objects and Warning events — grouped by category and
// namespace with the reason and the age, each a link to its details. Follows the namespace filter; "Only new since…"
// hides what began before the mark. The cluster's last desktop notifications are listed below (every cluster's under
// "All clusters").
// Security findings (Baseline Pod Security Standard violations, #143) are an opt-in category: listed while
// "Security findings" is on — the saved setting `notifications.enabledCategories`, which the sidebar counter and the
// notifications follow too.
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../app/store";
import { Age, Badge, Button, Checkbox, ErrorState, LoadingIndicator } from "../../components";
import type { PageProps } from "../../layout/pages";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { NotificationHistory } from "../notifications/NotificationHistory";
import { messageText } from "../notifications/engine";
import { filterProblems, groupProblems } from "./group";
import { useCategoriesOn, useClusterProblems } from "./hooks";
import { updateSettings } from "../../api";
import { setCategory } from "../notifications/prefs";
import { PROBLEM_CATEGORIES, startedAt, type Problem } from "./model";
import "./problems.css";
import { useProblemsUi } from "./ui";
import { formatTime } from "../../i18n";

export function ProblemsPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const namespaces = useSelectedNamespaces(clusterId);
  const categories = useCategoriesOn(PROBLEM_CATEGORIES);
  const showSecurity = categories.includes("security");
  const { sources, active, loading } = useClusterProblems(clusterId, categories);
  const mark = useProblemsUi((s) => s.marks[clusterId]) ?? null;
  const onlyNew = useProblemsUi((s) => s.onlyNew[clusterId] ?? false);
  const { setOnlyNew, markSeen } = useProblemsUi.getState();
  // The first visit sets the mark: "new" is what begins from now on.
  useEffect(() => useProblemsUi.getState().ensureMark(clusterId, Date.now()), [clusterId]);

  const shown = filterProblems(active, {
    namespaces: namespaces ?? null,
    newSince: onlyNew && mark !== null ? mark : null,
  });
  const groups = groupProblems(shown);
  const failed = sources.filter((s) => s.status === "error");
  const truncated = sources.some((s) => s.truncated);

  return (
    <div className="problems">
      <h2 className="problems__title">{t("problems:title")}</h2>
      <div className="problems__toolbar">
        <NamespaceFilter clusterId={clusterId} />
        <label className="problems__choice">
          <Checkbox
            checked={onlyNew}
            disabled={mark === null}
            onChange={(e) => setOnlyNew(clusterId, e.target.checked)}
          />
          {t("problems:onlyNewSince", { time: mark === null ? "" : formatTime(mark) })}
        </label>
        <label className="problems__choice">
          <Checkbox
            checked={showSecurity}
            onChange={(e) => void updateSettings(setCategory("security", e.target.checked)).catch(() => undefined)}
          />
          {t("problems:showSecurity")}
        </label>
        <label className="problems__choice">
          <Checkbox
            checked={categories.includes("disk")}
            onChange={(e) => void updateSettings(setCategory("disk", e.target.checked)).catch(() => undefined)}
          />
          {t("problems:showDisk")}
        </label>
        <label className="problems__choice">
          <Checkbox
            checked={categories.includes("practices")}
            onChange={(e) => void updateSettings(setCategory("practices", e.target.checked)).catch(() => undefined)}
          />
          {t("problems:showPractices")}
        </label>
        <label className="problems__choice">
          <Checkbox
            checked={categories.includes("policies")}
            onChange={(e) => void updateSettings(setCategory("policies", e.target.checked)).catch(() => undefined)}
          />
          {t("problems:showPolicies")}
        </label>
        <label className="problems__choice">
          <Checkbox
            checked={categories.includes("prometheusOperator")}
            onChange={(e) => void updateSettings(setCategory("prometheusOperator", e.target.checked)).catch(() => undefined)}
          />
          {t("problems:showPrometheusOperator")}
        </label>
        <Button size="compact" onClick={() => markSeen(clusterId, Date.now())}>
          {t("problems:markSeen")}
        </Button>
        <span className="problems__total" role="status">
          {t("problems:total", { count: shown.length })}
        </span>
      </div>

      {failed.map((s) => (
        <ErrorState
          key={s.key}
          className="problems__error"
          title={t("problems:sourceFailed", { kind: s.def.kind.kind })}
          error={s.error!}
        />
      ))}
      {truncated && <p className="problems__hint">{t("problems:truncated")}</p>}

      {groups.length === 0 ? (
        loading ? (
          <LoadingIndicator className="problems__loading" text={t("problems:loading")} />
        ) : (
          <p className="problems__empty">{onlyNew ? t("problems:noneNew") : t("problems:none")}</p>
        )
      ) : (
        groups.map((group) => (
          <section key={group.category} className="problems__group" aria-label={t(`problems:categories.${group.category}`)}>
            <h3 className="problems__heading">
              {t(`problems:categories.${group.category}`)}
              <Badge tone="danger">{group.count}</Badge>
            </h3>
            {group.namespaces.map((ns) => (
              <div key={ns.namespace ?? ""} className="problems__ns">
                <h4 className="problems__ns-name">{ns.namespace ?? t("problems:clusterWide")}</h4>
                <ul className="problems__list">
                  {ns.problems.map((p) => (
                    <ProblemRow key={`${p.category}|${p.key}`} problem={p} />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      )}

      <NotificationHistory clusterId={clusterId} />
    </div>
  );
}

function ProblemRow({ problem }: { problem: Problem }) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  const { object } = problem;
  const message = messageText(problem);
  return (
    <li className="problems__row" data-reason={problem.reason}>
      <button
        type="button"
        className="rt-link problems__object"
        aria-label={t("resources:table.openObject", { kind: object.kind.kind, name: object.name })}
        onClick={() => openDetails(object)}
      >
        {`${object.kind.kind}: ${object.name}`}
      </button>
      <Badge tone={problem.notify ? "danger" : "warning"}>{problem.reason}</Badge>
      <span className="problems__message" title={message}>
        {message}
      </span>
      <span className="problems__age">
        <Age timestamp={new Date(startedAt(problem)).toISOString()} />
      </span>
    </li>
  );
}
