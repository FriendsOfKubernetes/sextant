// The "Timeline" page (#145, section "Cluster"): what changed, when and by whom — to answer "what changed before it
// broke". Recorded changes of the objects the window watches, merged with the partial history the cluster keeps from
// before Sextant was running, each with the problems and Warning events that began soon after it on the object or
// what depends on it.
//
// Bounded: while open the page watches, for at most `MAX_WATCHED_NAMESPACES` namespaces of the filter, the lists the
// map and the "Related" tab share (relations for the correlation, and more kinds for the recorder) plus their
// ConfigMaps and Secrets (values never reach the window); with "All namespaces" it watches nothing of its own. The
// partial history is read for at most `MAX_HISTORY_NAMESPACES` namespaces when the page opens, when the filter changes
// and on Refresh.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HistoryEntry, KindRef, WatchSpec } from "../../api";
import { Button, Checkbox, ErrorState } from "../../components";
import { formatList } from "../../i18n/format";
import type { PageProps } from "../../layout/pages";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { namespacePlan, useRelationGraph } from "../resource-map/data";
import { CONFIG_MAP, SECRET } from "../resource-map/kinds";
import { useSharedWatches } from "../resource-map/watches";
import { dependents } from "./correlate";
import { MAX_HISTORY_NAMESPACES, usePartialHistory, usePersist, useSaveError, useSignals, useTimeline } from "./hooks";
import { buildItems, choicesOf, type TimelineFilters } from "./items";
import { TimelineList, managerName } from "./components";
import { clearTimeline, setPersist } from "./recorder";

export const TIMELINE_PAGE_ID = "changeTimeline";
/** Namespaces of the filter the page watches itself at once. */
export const MAX_WATCHED_NAMESPACES = 3;

const NO_NAMESPACES: readonly string[] = [];
const NO_ENTRIES: readonly HistoryEntry[] = [];

export function TimelinePage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const namespaces = useSelectedNamespaces(clusterId);
  const chosen = namespaces && namespaces.length > 0 ? namespaces : null;
  const recorded = useTimeline(clusterId);
  const signals = useSignals(clusterId);
  const persist = usePersist();
  const saveError = useSaveError();
  const [kind, setKind] = useState<string | null>(null);
  const [manager, setManager] = useState<string | null>(null);
  const [onlyBeforeProblems, setOnlyBeforeProblems] = useState(false);
  const [partialOn, setPartialOn] = useState(true);
  const partial = usePartialHistory(clusterId, chosen, partialOn);

  const watched = chosen?.slice(0, MAX_WATCHED_NAMESPACES) ?? NO_NAMESPACES;
  const nsKey = watched.join("\u0000");
  const plan = useMemo(() => (nsKey ? namespacePlan(nsKey.split("\u0000")) : []), [nsKey]);
  const { graph } = useRelationGraph(clusterId, plan);
  const configSpecs = useMemo<WatchSpec[]>(
    () =>
      nsKey
        ? nsKey.split("\u0000").flatMap((ns) =>
            [CONFIG_MAP, SECRET].map((k: KindRef) => ({ kind: k, namespaces: [ns], labelSelector: null, fieldSelector: null })),
          )
        : [],
    [nsKey],
  );
  useSharedWatches(clusterId, configSpecs);

  const filters: TimelineFilters = { namespaces: chosen, kind, manager, onlyBeforeProblems, partial: partialOn };
  const partialEntries = partial.data?.entries ?? NO_ENTRIES;
  const items = useMemo(
    () =>
      buildItems(recorded, partialEntries, filters, signals, (subject) =>
        plan.length > 0 ? dependents(graph, subject) : new Set<string>(),
      ),
    // `filters` is rebuilt each render from the values listed.
    [recorded, partialEntries, chosen, kind, manager, onlyBeforeProblems, partialOn, signals, graph, plan.length],
  );
  const choices = useMemo(() => choicesOf(recorded, partialEntries), [recorded, partialEntries]);
  const failedLists = (partial.data?.reports ?? []).filter((r) => r.error);

  return (
    <div className="tl-page">
      <h2 className="tl-page__title">{t("timeline:title")}</h2>
      <p className="tl-page__lead">{t("timeline:lead")}</p>
      <div className="tl-page__toolbar">
        <NamespaceFilter clusterId={clusterId} />
        <label className="tl-page__field">
          {t("timeline:filters.kind")}
          <select className="tl-page__select" value={kind ?? ""} onChange={(e) => setKind(e.target.value || null)}>
            <option value="">{t("timeline:filters.anyKind")}</option>
            {choices.kinds.map((id) => (
              <option key={id} value={id}>
                {id.split("/")[1]}
              </option>
            ))}
          </select>
        </label>
        <label className="tl-page__field">
          {t("timeline:filters.manager")}
          <select className="tl-page__select" value={manager ?? ""} onChange={(e) => setManager(e.target.value || null)}>
            <option value="">{t("timeline:filters.anyManager")}</option>
            {choices.managers.map((m) => (
              <option key={m} value={m}>
                {managerName(m, t)}
              </option>
            ))}
          </select>
        </label>
        <label className="tl-page__choice">
          <Checkbox checked={onlyBeforeProblems} onChange={(e) => setOnlyBeforeProblems(e.target.checked)} />
          {t("timeline:filters.onlyBeforeProblems")}
        </label>
        <label className="tl-page__choice">
          <Checkbox checked={partialOn} onChange={(e) => setPartialOn(e.target.checked)} />
          {t("timeline:filters.partial")}
        </label>
        <label className="tl-page__choice" title={t("timeline:filters.persistHint")}>
          <Checkbox checked={persist} onChange={(e) => void setPersist(e.target.checked)} />
          {t("timeline:filters.persist")}
        </label>
        {partialOn && chosen && (
          <Button size="compact" icon="refresh" onClick={partial.refresh} disabled={partial.loading}>
            {t("timeline:refresh")}
          </Button>
        )}
        <Button size="compact" onClick={() => clearTimeline(clusterId)} disabled={recorded.length === 0}>
          {t("timeline:clear")}
        </Button>
      </div>

      {persist && saveError && (
        <p className="tl-page__note" role="alert">
          {t("timeline:saveFailed", { message: saveError.message })}
        </p>
      )}
      {partialOn && !chosen && <p className="tl-page__note">{t("timeline:partialNeedsNamespaces")}</p>}
      {partialOn && chosen && chosen.length > MAX_HISTORY_NAMESPACES && (
        <p className="tl-page__note">{t("timeline:partialFirstNamespaces", { count: MAX_HISTORY_NAMESPACES })}</p>
      )}
      {chosen && chosen.length > MAX_WATCHED_NAMESPACES && (
        <p className="tl-page__note">{t("timeline:relatedLimited", { count: MAX_WATCHED_NAMESPACES })}</p>
      )}
      {!chosen && <p className="tl-page__note">{t("timeline:allNamespacesNote")}</p>}
      {partialOn && partial.loading && <p className="tl-page__note" role="status">{t("timeline:partialLoading")}</p>}
      {partialOn && partial.error && <ErrorState error={partial.error} onRetry={partial.refresh} />}
      {failedLists.length > 0 && (
        <p className="tl-page__note" role="status">
          {t("timeline:partialSkipped", { kinds: formatList([...new Set(failedLists.map((r) => r.what))]) })}
        </p>
      )}
      {partial.data?.truncated && <p className="tl-page__note">{t("timeline:partialTruncated")}</p>}

      {items.length === 0 ? (
        <p className="tl-page__empty">{recorded.length === 0 && partialEntries.length === 0 ? t("timeline:empty") : t("timeline:emptyFiltered")}</p>
      ) : (
        <TimelineList items={items} showObject label={t("timeline:title")} />
      )}
    </div>
  );
}
