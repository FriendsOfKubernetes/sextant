// The overview's tables across the selected clusters: pods, workloads (Deployments, StatefulSets, DaemonSets) and
// Warning events, each with a Cluster column, filtered by cluster and namespace. Every table reads the problem watches
// the health cards hold: pods and workloads as row taps on them (`useClusterRows`, held by the page), Warning events as
// the problems of the `events` source. Each cluster shows at most `MAX_SHOWN_ROWS` rows after the filters (the worst
// first) and says how many more there are.
import { Fragment, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, ObjectRef } from "../../api";
import { Age, ErrorState, LoadingIndicator } from "../../components";
import { StatusText } from "../../resources";
import { sourcesOf, sourcesVersion, subscribeSources } from "../problems/store";
import { MAX_EVENTS, MAX_SHOWN_ROWS } from "./constants";
import {
  capRows,
  comparePods,
  compareWorkloads,
  eventRows,
  POD_ROWS,
  WORKLOAD_ROWS,
  type EventRow,
  type PodRow,
  type WorkloadRow,
} from "./rows";
import type { RowsState } from "./rowsStore";
import { openInCluster } from "./store";

export interface FleetCluster {
  id: ClusterId;
  name: string;
}

export interface TableProps {
  /** The selected connected clusters, in the overview's order: all are watched, whatever the filter shows. */
  clusters: FleetCluster[];
  /** The cluster the filter shows; "" = every one. */
  only: ClusterId | "";
  /** "" = every namespace. */
  namespace: string;
  /** Reports the namespaces the table's rows have, for the namespace filter. */
  children?: (namespaces: string[]) => ReactNode;
}

const NO_VALUE = "—";

interface ClusterRows<R> {
  cluster: FleetCluster;
  status: RowsState<R>["status"];
  errors: { kind: string; error: unknown }[];
  truncated: boolean;
  rows: R[];
}

function namespacesOf(groups: ClusterRows<{ namespace: string }>[]): string[] {
  const set = new Set<string>();
  for (const g of groups) for (const r of g.rows) if (r.namespace) set.add(r.namespace);
  return [...set].sort();
}

function NameButton({ cluster, object, children }: { cluster: FleetCluster; object: ObjectRef; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="fleet-link"
      aria-label={t("fleet:openIn", { kind: object.kind.kind, name: object.name, cluster: cluster.name })}
      onClick={() => openInCluster(cluster.id, object)}
    >
      {children}
    </button>
  );
}

/** Loading, errors and "kept only part" notes of each cluster, above the table. */
function Notes<R>({ groups }: { groups: ClusterRows<R>[] }) {
  const { t } = useTranslation();
  return (
    <>
      {groups.map((g) => (
        <Fragment key={g.cluster.id}>
          {g.status === "loading" && (
            <LoadingIndicator
              className="fleet-note"
              text={t("fleet:loadingIn", { cluster: g.cluster.name })}
            />
          )}
          {g.errors.map((e) => (
            <ErrorState
              key={e.kind}
              className="fleet-note"
              title={t("fleet:listFailed", { kind: e.kind, cluster: g.cluster.name })}
              error={e.error}
            />
          ))}
          {g.truncated && (
            <p className="fleet-note fleet-note--warning" role="status">
              {t("fleet:truncated", { cluster: g.cluster.name })}
            </p>
          )}
        </Fragment>
      ))}
    </>
  );
}

function MoreRow({ cluster, more, columns }: { cluster: FleetCluster; more: number; columns: number }) {
  const { t } = useTranslation();
  if (more <= 0) return null;
  return (
    <tr className="fleet-table__more">
      <td colSpan={columns}>{t("fleet:more", { count: more, cluster: cluster.name })}</td>
    </tr>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="fleet-note">{text}</p>;
}

// ---------- Pods ----------

export function PodsTable({
  clusters,
  only,
  namespace,
  children,
  rows: watched,
}: TableProps & { rows: Map<ClusterId, RowsState<PodRow>> }) {
  const { t } = useTranslation();
  const groups = useMemo<ClusterRows<PodRow>[]>(
    () =>
      clusters.map((cluster) => {
        const state = watched.get(cluster.id);
        return {
          cluster,
          status: state?.status ?? "loading",
          errors: state?.status === "error" ? [{ kind: "Pod", error: state.error }] : [],
          truncated: state?.truncated ?? false,
          rows: [...(state?.rows.values() ?? [])].sort(comparePods),
        };
      }),
    [clusters, watched],
  );
  const keep = (r: PodRow) => !namespace || r.namespace === namespace;
  const visible = groups.filter((g) => !only || g.cluster.id === only);
  const shown = visible.map((g) => ({ ...g, ...capRows(g.rows, keep, MAX_SHOWN_ROWS) }));
  const any = shown.some((g) => g.shown.length > 0);
  const columns = 8;

  return (
    <>
      {children?.(namespacesOf(visible))}
      <Notes groups={visible} />
      {any ? (
        <div className="fleet-table-wrap">
          <table className="fleet-table" aria-label={t("fleet:tabs.pods")}>
            <thead>
              <tr>
                <th scope="col">{t("fleet:columns.cluster")}</th>
                <th scope="col">{t("fleet:columns.namespace")}</th>
                <th scope="col">{t("fleet:columns.name")}</th>
                <th scope="col">{t("fleet:columns.status")}</th>
                <th scope="col">{t("fleet:columns.ready")}</th>
                <th scope="col">{t("fleet:columns.restarts")}</th>
                <th scope="col">{t("fleet:columns.node")}</th>
                <th scope="col">{t("fleet:columns.age")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => (
                <Fragment key={g.cluster.id}>
                  {g.shown.map((r) => (
                    <tr key={`${r.namespace}/${r.name}`}>
                      <td className="fleet-table__cluster">{g.cluster.name}</td>
                      <td>{r.namespace}</td>
                      <td>
                        <NameButton cluster={g.cluster} object={{ kind: POD_ROWS.kind, namespace: r.namespace, name: r.name }}>
                          {r.name}
                        </NameButton>
                      </td>
                      <td>
                        <StatusText value={r.status} />
                      </td>
                      <td className="fleet-table__num">{`${r.ready}/${r.containers}`}</td>
                      <td className="fleet-table__num">{r.restarts}</td>
                      <td>{r.node ?? NO_VALUE}</td>
                      <td>
                        <Age timestamp={r.created} />
                      </td>
                    </tr>
                  ))}
                  <MoreRow cluster={g.cluster} more={g.more} columns={columns} />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        visible.every((g) => g.status !== "loading") && <Empty text={t("fleet:empty")} />
      )}
    </>
  );
}

// ---------- Workloads ----------

export function WorkloadsTable({
  clusters,
  only,
  namespace,
  children,
  rows: [deployments, statefulSets, daemonSets],
}: TableProps & { rows: readonly Map<ClusterId, RowsState<WorkloadRow>>[] }) {
  const { t } = useTranslation();
  const groups = useMemo<ClusterRows<WorkloadRow>[]>(
    () =>
      clusters.map((cluster) => {
        const states = [deployments, statefulSets, daemonSets].map((m, i) => ({
          kind: WORKLOAD_ROWS[i]!.kind.kind,
          state: m?.get(cluster.id),
        }));
        const rows: WorkloadRow[] = [];
        for (const { state } of states) rows.push(...(state?.rows.values() ?? []));
        rows.sort(compareWorkloads);
        return {
          cluster,
          status: states.some((s) => !s.state || s.state.status === "loading") ? "loading" : "ready",
          errors: states.filter((s) => s.state?.status === "error").map((s) => ({ kind: s.kind, error: s.state!.error })),
          truncated: states.some((s) => s.state?.truncated),
          rows,
        };
      }),
    [clusters, deployments, statefulSets, daemonSets],
  );
  const keep = (r: WorkloadRow) => !namespace || r.namespace === namespace;
  const visible = groups.filter((g) => !only || g.cluster.id === only);
  const shown = visible.map((g) => ({ ...g, ...capRows(g.rows, keep, MAX_SHOWN_ROWS) }));
  const any = shown.some((g) => g.shown.length > 0);
  const columns = 6;

  return (
    <>
      {children?.(namespacesOf(visible))}
      <Notes groups={visible} />
      {any ? (
        <div className="fleet-table-wrap">
          <table className="fleet-table" aria-label={t("fleet:tabs.workloads")}>
            <thead>
              <tr>
                <th scope="col">{t("fleet:columns.cluster")}</th>
                <th scope="col">{t("fleet:columns.namespace")}</th>
                <th scope="col">{t("fleet:columns.kind")}</th>
                <th scope="col">{t("fleet:columns.name")}</th>
                <th scope="col">{t("fleet:columns.ready")}</th>
                <th scope="col">{t("fleet:columns.age")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => (
                <Fragment key={g.cluster.id}>
                  {g.shown.map((r) => (
                    <tr key={`${r.kind.kind}/${r.namespace}/${r.name}`} data-behind={r.ready < r.desired ? "true" : undefined}>
                      <td className="fleet-table__cluster">{g.cluster.name}</td>
                      <td>{r.namespace}</td>
                      <td>{r.kind.kind}</td>
                      <td>
                        <NameButton cluster={g.cluster} object={{ kind: r.kind, namespace: r.namespace, name: r.name }}>
                          {r.name}
                        </NameButton>
                      </td>
                      <td className="fleet-table__num">
                        <StatusText value={`${r.ready}/${r.desired}`} tone={r.ready < r.desired ? "warning" : "success"} />
                      </td>
                      <td>
                        <Age timestamp={r.created} />
                      </td>
                    </tr>
                  ))}
                  <MoreRow cluster={g.cluster} more={g.more} columns={columns} />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        visible.every((g) => g.status !== "loading") && <Empty text={t("fleet:empty")} />
      )}
    </>
  );
}

// ---------- Warning events ----------

function kindLabel(kind: KindRef): string {
  return kind.kind;
}

/**
 * Warning events of the clusters, newest first, at most `MAX_EVENTS` per cluster: the problem watches of the health
 * cards (category "events"), so the events are not watched twice.
 */
export function EventsTable({ clusters, only, namespace, children }: TableProps) {
  const { t } = useTranslation();
  const version = useSyncExternalStore(subscribeSources, sourcesVersion, sourcesVersion);
  const groups = useMemo<ClusterRows<EventRow>[]>(() => {
    void version;
    return clusters.map((cluster) => {
      const sources = sourcesOf(cluster.id).filter((s) => s.category === "events");
      const problems = sources.flatMap((s) => s.problems);
      return {
        cluster,
        status: sources.length === 0 || sources.some((s) => s.status === "loading") ? "loading" : "ready",
        errors: sources.filter((s) => s.status === "error").map((s) => ({ kind: "Event", error: s.error })),
        truncated: false,
        rows: eventRows(problems, MAX_EVENTS),
      };
    });
  }, [clusters, version]);
  const keep = (r: EventRow) => !namespace || r.namespace === namespace;
  const visible = groups.filter((g) => !only || g.cluster.id === only);
  const shown = visible.map((g) => ({ ...g, ...capRows(g.rows, keep, MAX_SHOWN_ROWS) }));
  const any = shown.some((g) => g.shown.length > 0);
  const columns = 6;

  return (
    <>
      {children?.(namespacesOf(visible))}
      <Notes groups={visible} />
      {any ? (
        <div className="fleet-table-wrap">
          <table className="fleet-table" aria-label={t("fleet:tabs.events")}>
            <thead>
              <tr>
                <th scope="col">{t("fleet:columns.cluster")}</th>
                <th scope="col">{t("fleet:columns.namespace")}</th>
                <th scope="col">{t("fleet:columns.object")}</th>
                <th scope="col">{t("fleet:columns.reason")}</th>
                <th scope="col">{t("fleet:columns.message")}</th>
                <th scope="col">{t("fleet:columns.age")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => (
                <Fragment key={g.cluster.id}>
                  {g.shown.map((r) => (
                    <tr key={r.key}>
                      <td className="fleet-table__cluster">{g.cluster.name}</td>
                      <td>{r.namespace || NO_VALUE}</td>
                      <td>
                        <NameButton cluster={g.cluster} object={r.object}>
                          {t("fleet:objectName", { kind: kindLabel(r.object.kind), name: r.object.name })}
                        </NameButton>
                      </td>
                      <td>
                        <StatusText value={r.reason} tone="warning" />
                      </td>
                      <td className="fleet-table__message">{r.message ?? ""}</td>
                      <td>
                        <Age timestamp={r.since} />
                      </td>
                    </tr>
                  ))}
                  <MoreRow cluster={g.cluster} more={g.more} columns={columns} />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        visible.every((g) => g.status !== "loading") && <Empty text={t("fleet:noWarnings")} />
      )}
    </>
  );
}
