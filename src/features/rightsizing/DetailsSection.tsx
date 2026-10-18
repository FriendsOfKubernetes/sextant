// "Right-sizing" section of the details panel (#137) for Deployments, StatefulSets, DaemonSets and pods: the same
// rows as the page for this one workload. A workload's pods are watched in its namespace only (by its selector's
// labels when it has them) and only while the panel shows it; a pod uses the object the panel already has.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HistoryScope, HistoryWindow, KindRef, KubeObject, WatchSpec } from "../../api";
import { useWatch } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { RowsTable, SourceNote } from "./components";
import { buildRows, workloadOf } from "./group";
import { useRightsizingSource } from "./hooks";
import "./rightsizing.css";

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const POD = { group: "", version: "v1", kind: "Pod" };
const WINDOWS: HistoryWindow[] = ["day", "week"];

export function rightsizingApplies(kind: KindRef): boolean {
  if (kind.group === "") return kind.kind === "Pod";
  return kind.group === "apps" && WORKLOADS.has(kind.kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `k=v,…` of the workload's `spec.selector.matchLabels`; `null` when it has none (the whole namespace is watched). */
export function selectorOf(obj: KubeObject | null): string | null {
  const spec = isRecord(obj?.spec) ? obj.spec : undefined;
  const selector = isRecord(spec?.selector) ? spec.selector : undefined;
  const labels = isRecord(selector?.matchLabels) ? selector.matchLabels : undefined;
  if (!labels) return null;
  const pairs = Object.entries(labels).filter((e): e is [string, string] => typeof e[1] === "string");
  return pairs.length > 0 ? pairs.map(([k, v]) => `${k}=${v}`).join(",") : null;
}

export function RightsizingDetailsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const [window, setWindow] = useState<HistoryWindow>("week");
  const kind = objectRef.kind.kind;
  const namespace = objectRef.namespace ?? "";
  const isPod = kind === "Pod";

  const spec: WatchSpec | null =
    !isPod && namespace && obj
      ? { kind: POD, namespaces: [namespace], labelSelector: selectorOf(obj), fieldSelector: null }
      : null;
  const watched = useWatch(clusterId, spec);
  const scope: HistoryScope | null = !namespace
    ? null
    : isPod
      ? { type: "pod", namespace, name: objectRef.name }
      : { type: "workload", namespace, kind, name: objectRef.name };
  const source = useRightsizingSource(clusterId, scope, window);

  const pods = useMemo(() => {
    if (isPod) return obj ? [obj] : [];
    return [...watched.items.values()].filter((p) => {
      const w = workloadOf(p);
      return w.kind === kind && w.name === objectRef.name;
    });
  }, [isPod, obj, watched, kind, objectRef.name]);
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
