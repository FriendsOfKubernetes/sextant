// The health card of one cluster in the overview: its connection (Connect / Reconnect only on a click, the error
// inline), and once connected the nodes' version, ready nodes, CPU and memory against allocatable capacity, problems
// by category (the problems screen's rules and shared watches) and the state of Flux, Argo CD and Gateway API when
// the cluster serves them.
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, ClusterId, ClusterInfo } from "../../api";
import { Button, LoadingIndicator, useElapsedSeconds } from "../../components";
import { useClusterKinds } from "../../resources";
import { ClusterAvatar } from "../clusters/ClusterAvatar";
import { connectCluster, selectCluster } from "../clusters/clustersStore";
import { useClusterState } from "../clusters/hooks";
import { connectionErrorText } from "../clusters/Welcome";
import { formatBytes, formatCpu, percentKey, percentOf } from "../metrics/format";
import { useMetricsStatus, useNodeUsage } from "../metrics/hooks";
import { usageUnavailable } from "../metrics/components";
import { useClusterProblems } from "../problems/hooks";
import { OPT_IN_CATEGORIES, PROBLEM_CATEGORIES, type ProblemCategory } from "../problems/model";
import { sourcesFor } from "../problems/sources";
import { countByCategory, summarizeNodes, type NodeRow } from "./rows";
import { useConnectQueue } from "./store";
import type { RowsState } from "./rowsStore";

/**
 * The categories the cards watch: every one but the opt-in ones (security findings, which watch CronJobs and more),
 * which only the problems screen turns on.
 */
export const FLEET_CATEGORIES: readonly ProblemCategory[] = PROBLEM_CATEGORIES.filter((c) => !OPT_IN_CATEGORIES.includes(c));
/** Categories shown as "installed tools" (only when the cluster serves their kinds), apart from the other problems. */
const TOOLS: readonly ProblemCategory[] = ["flux", "argocd", "gateway"];
/** The other categories, listed when they have problems. Warning events have a line of their own. */
const LISTED = FLEET_CATEGORIES.filter((c) => !TOOLS.includes(c) && c !== "events");

export function ClusterCard({
  cluster,
  name,
  settings,
  nodes,
}: {
  cluster: ClusterInfo;
  name: string;
  settings: AppSettings | null;
  /** The cluster's node rows (watched by the page while the cluster is connected). */
  nodes: RowsState<NodeRow> | undefined;
}) {
  const { t } = useTranslation();
  const state = useClusterState(cluster.id);
  const seconds = useElapsedSeconds(state.state === "connecting");
  const waiting = useConnectQueue((s) => s.waiting.includes(cluster.id));

  let body: ReactNode;
  if (state.state === "connected") body = <Health clusterId={cluster.id} nodes={nodes} />;
  else if (waiting && (state.state === "disconnected" || state.state === "error")) {
    body = (
      <p className="fleet-card__state" role="status">
        {t("fleet:card.waiting")}
      </p>
    );
  } else if (state.state === "connecting") {
    body = (
      <p className="fleet-card__state" role="status">
        {seconds >= 1 ? t("fleet:card.connectingFor", { seconds }) : t("fleet:card.connecting")}
      </p>
    );
  } else if (state.state === "error") {
    body = (
      <div className="fleet-card__error" role="alert" data-code={state.code}>
        <p>{connectionErrorText(t, state)}</p>
        {state.message && <p className="fleet-card__details">{t("common:error.details", { message: state.message })}</p>}
        <Button size="compact" onClick={() => void connectCluster(cluster.id)}>
          {t("fleet:card.reconnect")}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="fleet-card__offline">
        <p className="fleet-card__state">{t("fleet:card.disconnected")}</p>
        <Button size="compact" onClick={() => void connectCluster(cluster.id)}>
          {t("fleet:card.connect")}
        </Button>
      </div>
    );
  }

  return (
    <section className="fleet-card" aria-label={name} data-state={state.state}>
      <header className="fleet-card__head">
        <ClusterAvatar cluster={cluster} settings={settings} size={28} />
        <h3 className="fleet-card__name" title={cluster.server}>
          {name}
        </h3>
        {state.state === "connected" && (
          <Button
            size="compact"
            iconOnly
            icon="external"
            label={t("fleet:card.open", { cluster: name })}
            onClick={() => selectCluster(cluster.id)}
          />
        )}
      </header>
      {body}
    </section>
  );
}

function Health({ clusterId, nodes }: { clusterId: ClusterId; nodes: RowsState<NodeRow> | undefined }) {
  const { t } = useTranslation();
  const problems = useClusterProblems(clusterId, FLEET_CATEGORIES);
  const discovery = useClusterKinds(clusterId);
  const metricsStatus = useMetricsStatus(clusterId);
  const usage = useNodeUsage(clusterId);

  const summary = useMemo(() => summarizeNodes(nodes?.rows.values() ?? []), [nodes]);
  const counts = useMemo(() => countByCategory(problems.active, Date.now()), [problems.active]);
  const served = useMemo(
    () => TOOLS.filter((tool) => discovery.kinds && sourcesFor([tool], discovery.kinds).length > 0),
    [discovery.kinds],
  );

  const nodesLoading = !nodes || nodes.status === "loading";
  const version =
    summary.versions.length === 0
      ? null
      : summary.versions.length === 1
        ? summary.versions[0]
        : t("fleet:card.versionRange", { lowest: summary.versions[0], highest: summary.versions.at(-1) });

  let cpu: ReactNode = null;
  let memory: ReactNode = null;
  if (usageUnavailable(metricsStatus, usage)) {
    cpu = memory = <span className="fleet-card__muted">{t("fleet:card.noMetrics")}</span>;
  } else if (usage.data) {
    let usedCpu = 0;
    let usedMemory = 0;
    for (const u of usage.data.values()) {
      usedCpu += u.usage.cpuMillicores;
      usedMemory += u.usage.memoryBytes;
    }
    const value = (used: number, total: number | undefined, format: (v: number) => string) => {
      const percent = percentOf(used, total);
      return percent === undefined
        ? format(used)
        : t("fleet:card.usage", { percent: t(percentKey("metrics:percent", percent), { value: percent }), used: format(used) });
    };
    cpu = value(usedCpu, summary.cpu, formatCpu);
    memory = value(usedMemory, summary.memory, formatBytes);
  }

  const listed = LISTED.filter((c) => (counts.get(c) ?? 0) > 0);
  const failed = problems.sources.filter((s) => s.status === "error");

  return (
    <div className="fleet-card__body">
      <dl className="fleet-card__facts">
        <dt>{t("fleet:card.version")}</dt>
        <dd title={t("fleet:card.versionHint")}>{version ?? (nodesLoading ? "…" : "—")}</dd>
        <dt>{t("fleet:card.nodes")}</dt>
        <dd data-testid="fleet-nodes">
          {nodes?.status === "error"
            ? t("fleet:card.nodesFailed")
            : nodesLoading
              ? "…"
              : t("metrics:overview.nodesReady", { ready: summary.ready, count: summary.total })}
        </dd>
        <dt>{t("metrics:overview.cpu")}</dt>
        <dd>{cpu ?? "…"}</dd>
        <dt>{t("metrics:overview.memory")}</dt>
        <dd>{memory ?? "…"}</dd>
      </dl>

      <div className="fleet-card__problems" aria-label={t("fleet:card.problems")} role="group">
        <h4 className="fleet-card__subhead">{t("fleet:card.problems")}</h4>
        {problems.loading && listed.length === 0 ? (
          <LoadingIndicator className="fleet-card__loading" text={t("problems:loading")} />
        ) : listed.length === 0 ? (
          <p className="fleet-card__ok">{t("fleet:card.noProblems")}</p>
        ) : (
          <ul className="fleet-card__counts">
            {listed.map((c) => (
              <li key={c} data-category={c}>
                <span>{t(`problems:categories.${c}`)}</span>
                <span className="fleet-card__count">{counts.get(c)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="fleet-card__muted" data-category="events">
          {t("fleet:card.warnings", { count: counts.get("events") ?? 0 })}
        </p>
        {failed.length > 0 && (
          <p className="fleet-card__muted">{t("fleet:card.someNotWatched", { count: failed.length })}</p>
        )}
      </div>

      {served.length > 0 && (
        <ul className="fleet-card__tools" aria-label={t("fleet:card.tools")}>
          {served.map((tool) => {
            const count = counts.get(tool) ?? 0;
            return (
              <li key={tool} data-tool={tool} data-problems={count}>
                <span>{t(`problems:categories.${tool}`)}</span>
                <span className={count > 0 ? "fleet-card__bad" : "fleet-card__good"}>
                  {count > 0 ? t("problems:total", { count }) : t("fleet:card.toolOk")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
