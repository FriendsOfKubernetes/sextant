// "Right-sizing" section of the details panel (#137) for Deployments, StatefulSets, DaemonSets and pods: the same
// rows as the page for this one workload. A workload's pods are watched in its namespace only (by its
// selector when it has one) and only while the panel shows it, through a watch shared with the cost section; a pod
// uses the object the panel already has.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HistoryScope, HistoryWindow, KindRef } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { RowsTable, SourceNote } from "./components";
import { buildRows } from "./group";
import { useRightsizingSource } from "./hooks";
import { useWorkloadPods } from "./workloadPods";
import "./rightsizing.css";

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const WINDOWS: HistoryWindow[] = ["day", "week"];

export function rightsizingApplies(kind: KindRef): boolean {
  if (kind.group === "") return kind.kind === "Pod";
  return kind.group === "apps" && WORKLOADS.has(kind.kind);
}

export function RightsizingDetailsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const [window, setWindow] = useState<HistoryWindow>("week");
  const kind = objectRef.kind.kind;
  const namespace = objectRef.namespace ?? "";
  const isPod = kind === "Pod";

  // Shared with the cost section, which shows the same workload's pods.
  const watched = useWorkloadPods(clusterId, objectRef, obj, !isPod);
  const scope: HistoryScope | null = !namespace
    ? null
    : isPod
      ? { type: "pod", namespace, name: objectRef.name }
      : { type: "workload", namespace, kind, name: objectRef.name };
  const source = useRightsizingSource(clusterId, scope, window);

  const pods = useMemo(() => (isPod ? (obj ? [obj] : []) : watched.pods), [isPod, obj, watched.pods]);
  const rows = useMemo(() => buildRows(pods, source.data, Date.now()), [pods, source.data]);

  if (!namespace) return null;
  return (
    <section className="rs-section" aria-label={t("rightsizing:sectionTitle")}>
      <h3 className="rs-section__title">{t("rightsizing:sectionTitle")}</h3>
      <div className="rs-toolbar">
        {source.mode === "history" && (
          <label className="rs-choice">
            {t("rightsizing:window.label")}
            <select className="rs-select" value={window} onChange={(e) => setWindow(e.target.value as HistoryWindow)}>
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {t(`rightsizing:window.${w}`)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <SourceNote source={source} window={window} />
      {rows.length === 0 ? (
        (isPod || watched.status !== "loading") && <p className="rs-note">{t("rightsizing:empty")}</p>
      ) : (
        <RowsTable rows={rows} window={window} showWorkload={false} />
      )}
    </section>
  );
}
