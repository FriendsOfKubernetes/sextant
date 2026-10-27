// The "Pods" tab of a Node's details (#279): every pod on the node in the resource table — the Pods page's columns
// (less "Node"), sorted by any of them, searched over all of them, virtualized, with the row actions — instead of a
// list cut at "Show more". The usage columns read the node's own usage poll.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ResourceTable } from "../../components/Table";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { useResourceDef } from "../../resources";
import { usageColumns } from "./columns";
import { MAX_USAGE_NAMESPACES, useNodePodUsage, useNodePods } from "./hooks";
import { nodePodsSelector, POD } from "./model";
import "./node-pods.css";

/** Pod columns the tab leaves out: every row is on this node. */
const LEFT_OUT = new Set(["node"]);

export function NodePodsTab({ clusterId, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  const node = objectRef.name;
  const def = useResourceDef(POD);
  const { pods } = useNodePods(clusterId, node);
  const usage = useNodePodUsage(clusterId, pods);
  const columns = useMemo(() => {
    const own = usageColumns(clusterId, usage.pods.data, usage.unavailable);
    const byId = new Map(own.map((c) => [c.id, c]));
    return def.columns.filter((c) => !LEFT_OUT.has(c.id)).map((c) => byId.get(c.id) ?? c);
  }, [def.columns, clusterId, usage.pods.data, usage.unavailable]);
  const [search, setSearch] = useState("");
  return (
    <div className="np-tab">
      <PartialUsageNote partial={usage.pods.partial} />
      <ResourceTable
        key={node}
        clusterId={clusterId}
        kind={POD}
        title={t("nodepods:pods.title")}
        columns={columns}
        namespaces={null}
        fieldSelector={nodePodsSelector(node)}
        search={search}
        toolbar={<SearchBox value={search} onChange={setSearch} />}
      />
    </div>
  );
}

/** Says that usage is shown for the pods of the first namespaces only (`usePodUsageOfMany`). */
export function PartialUsageNote({ partial }: { partial: boolean }) {
  const { t } = useTranslation();
  if (!partial) return null;
  return <p className="np-note np-note--partial">{t("nodepods:usagePartial", { max: MAX_USAGE_NAMESPACES })}</p>;
}

export function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <input
      className="np-search"
      type="search"
      value={value}
      placeholder={t("nodepods:search.placeholder")}
      aria-label={t("resources:table.search")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
