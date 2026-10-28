// The "Changes" tab of every object's details (#145): the changes Sextant recorded of this object (by kind, namespace
// and name, so a recreated object keeps its story), the partial history the cluster keeps (its field managers' last
// changes, its rollout revisions, its Helm release's revisions), and what went wrong soon after each — on the object
// or what depends on it (through the lists the "Related" tab watches, shared with it).
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { Block } from "../details";
import { nodePlan, useRelationGraph } from "../resource-map/data";
import { dependents } from "./correlate";
import { TimelineList } from "./components";
import { useObjectHistory, useSignals, useTimeline } from "./hooks";
import { ALL, buildItems } from "./items";
import type { HistoryEntry } from "../../api";

const NO_ENTRIES: readonly HistoryEntry[] = [];

export function ChangesSection(props: DetailsSectionProps) {
  return <Changes key={JSON.stringify([props.clusterId, props.objectRef])} {...props} />;
}

function Changes({ clusterId, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  const { kind, namespace, name } = objectRef;
  const all = useTimeline(clusterId);
  const recorded = useMemo(
    () => all.filter((e) => e.kind.group === kind.group && e.kind.kind === kind.kind && e.namespace === namespace && e.name === name),
    [all, kind.group, kind.kind, namespace, name],
  );
  const history = useObjectHistory(clusterId, objectRef);
  const signals = useSignals(clusterId);
  const plan = useMemo(
    () => nodePlan({ group: kind.group, kind: kind.kind, version: kind.version, namespace, name }),
    [kind.group, kind.kind, kind.version, namespace, name],
  );
  const { graph } = useRelationGraph(clusterId, plan);
  const partial = history.data?.entries ?? NO_ENTRIES;
  const items = useMemo(
    () => buildItems(recorded, partial, ALL, signals, (subject) => dependents(graph, subject)),
    [recorded, partial, signals, graph],
  );

  return (
    <div className="tl-tab">
      <Block id="timeline:tab" title={t("timeline:tab")}>
        <p className="dt-muted">{t("timeline:tabLead")}</p>
        {history.error && (
          <p className="tl-page__note" role="status">
            {t("timeline:objectHistoryFailed", { message: history.error.message })}
          </p>
        )}
        {items.length === 0 ? (
          <p className="dt-muted">{history.loading ? t("timeline:partialLoading") : t("timeline:tabEmpty")}</p>
        ) : (
          <TimelineList items={items} showObject={false} label={t("timeline:tab")} />
        )}
      </Block>
    </div>
  );
}
