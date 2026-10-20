// "Best practices" section of the details panel (#207) for Deployments, StatefulSets, DaemonSets, CronJobs and Jobs:
// the findings of this workload with why they matter and a fix to copy. Watched only while the panel shows it: its
// namespace's HPAs, PodDisruptionBudgets and LimitRanges through the resource map's shared watches, its pods through
// the watch the right-sizing and cost sections share, and the right-sizing history of this workload when Prometheus
// answers.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, HistoryScope, KindRef, KubeObject, WatchSpec } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { useSharedWatches } from "../resource-map/watches";
import { useWorkloadPods } from "../rightsizing/workloadPods";
import "../security/security.css";
import { evaluate } from "./checks";
import { FindingList, SeverityCounts } from "./components";
import { enabledFindings, usePracticesConfig } from "./config";
import { contextFrom, HPA, LIMIT_RANGE, listed, PDB, useRecommendations, useSchedulableNodes } from "./hooks";
import { isPracticeKind, workloadInfo } from "./model";

const GROUPS = new Set(["apps", "batch"]);

export function practicesApplies(kind: KindRef): boolean {
  return GROUPS.has(kind.group) && isPracticeKind(kind.kind);
}

const inNamespace = (kind: KindRef, namespace: string): WatchSpec => ({ kind, namespaces: [namespace], labelSelector: null, fieldSelector: null });

export function PracticesSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const { config, loaded } = usePracticesConfig();
  const namespace = objectRef.namespace ?? "";
  if (!obj || !namespace || !loaded) return null;
  return (
    <section className="sec-section" aria-label={t("practices:details.title")}>
      <h3 className="sec-section__title">{t("practices:details.title")}</h3>
      {config.excluded.has(namespace) ? (
        <p className="sec-note">{t("practices:details.excluded", { namespace })}</p>
      ) : (
        <Findings clusterId={clusterId} kind={objectRef.kind} obj={obj} namespace={namespace} />
      )}
    </section>
  );
}

function Findings({ clusterId, kind, obj, namespace }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject; namespace: string }) {
  const { t } = useTranslation();
  const { config } = usePracticesConfig();
  const specs = useMemo(() => [HPA, PDB, LIMIT_RANGE].map((k) => inNamespace(k, namespace)), [namespace]);
  const [hpas, pdbs, limitRanges] = useSharedWatches(clusterId, specs);
  const replicated = kind.kind === "Deployment" || kind.kind === "StatefulSet" || kind.kind === "DaemonSet";
  const ref = useMemo(() => ({ kind, namespace, name: obj.metadata?.name ?? "" }), [kind, namespace, obj]);
  const watched = useWorkloadPods(clusterId, ref, obj, replicated);
  const pods = replicated && watched.status !== "loading" && watched.status !== "error" ? watched.pods : undefined;
  const schedulableNodes = useSchedulableNodes(clusterId);
  const scope: HistoryScope | null = replicated ? { type: "workload", namespace, kind: kind.kind, name: ref.name } : null;
  const recommendations = useRecommendations(clusterId, scope, pods);

  // A Job a CronJob runs is checked through the CronJob's template.
  const w = workloadInfo(kind.kind, obj);
  const findings = useMemo(() => {
    if (!w) return [];
    const ctx = contextFrom({
      hpas: listed(hpas),
      pdbs: listed(pdbs),
      limitRanges: listed(limitRanges),
      pods,
      schedulableNodes,
      recommendations,
    });
    return enabledFindings(evaluate(w, ctx), config);
  }, [w, hpas, pdbs, limitRanges, pods, schedulableNodes, recommendations, config]);

  if (!w) return null;
  if (findings.length === 0) return <p className="sec-note">{t("practices:details.noFindings")}</p>;
  return (
    <>
      <p className="sec-section__posture">
        <SeverityCounts findings={findings} />
      </p>
      <FindingList findings={findings} />
    </>
  );
}
