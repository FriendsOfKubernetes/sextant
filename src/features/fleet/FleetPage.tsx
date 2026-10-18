// The overview of several clusters ("All clusters", #144): the user picks clusters from the kubeconfig (remembered in
// `settings.fleet.selected`, at most `MAX_SELECTED`); connected ones show at once, the others only after "Connect"
// (connecting can start an exec-plugin sign-in or a cloud CLI, so it never happens by itself, and "Connect all
// selected" runs at most `CONNECT_CONCURRENCY` at a time). Read-only. Everything it watches is held while the page is
// mounted and only for connected clusters: the problem watches of the health cards (shared with the problems screen
// and the notifications) and, as taps on those same watches, compact rows of nodes, pods and workloads; one watch per
// (cluster, kind).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, type ClusterId, type ConnectionState } from "../../api";
import { useAppStore } from "../../app/store";
import { Button, Checkbox, EmptyState, Tabs } from "../../components";
import { displayNameOf } from "../clusters/clusterSettings";
import { useClustersStore } from "../clusters/clustersStore";
import { useClusters } from "../clusters/hooks";
import { ClusterCard } from "./ClusterCard";
import { FLEET_VIEW, MAX_SELECTED } from "./constants";
import { FindTab } from "./FindTab";
import { NODE_ROWS, POD_ROWS, WORKLOAD_ROWS } from "./rows";
import { useClusterRows } from "./rowsStore";
import { connectSelected, dequeue, setFleetSelected, useFleetSelection } from "./store";
import { EventsTable, PodsTable, WorkloadsTable, type FleetCluster } from "./tables";
import "./fleet.css";

const TABS = ["pods", "workloads", "events", "find"] as const;
const DISCONNECTED: ConnectionState["state"] = "disconnected";
type Tab = (typeof TABS)[number];

/** The "home" slot: the overview while it is the window-wide page. */
export function FleetHome() {
  const view = useAppStore((s) => s.homeView);
  return view === FLEET_VIEW ? <FleetPage /> : null;
}

export function FleetPage() {
  const { t } = useTranslation();
  const { clusters, loaded } = useClusters();
  const { settings } = useSettings();
  const states = useClustersStore((s) => s.states);
  const selected = useFleetSelection();
  const [tab, setTab] = useState<Tab>("pods");
  const [clusterFilter, setClusterFilter] = useState<ClusterId | "">("");
  const [namespace, setNamespace] = useState("");

  const byId = useMemo(() => new Map(clusters.map((c) => [c.id, c])), [clusters]);
  const known = useMemo(() => new Set(clusters.map((c) => c.id)), [clusters]);
  const full = selected.length >= MAX_SELECTED;
  const names = useMemo(
    () => new Map(clusters.map((c) => [c.id, displayNameOf(c, settings)])),
    [clusters, settings],
  );
  const connected = useMemo(() => selected.filter((id) => states[id]?.state === "connected"), [selected, states]);
  const offline = selected.length - connected.length;
  // A cluster chosen in the filter that left the selection or its connection: every cluster again.
  const onlyCluster = clusterFilter && connected.includes(clusterFilter) ? clusterFilter : "";
  // Held here, before the cards' problem watches list their kinds (child effects run first, events come later), so a
  // tap rarely costs a second list.
  const nodes = useClusterRows(connected, NODE_ROWS);
  const pods = useClusterRows(connected, POD_ROWS);
  const deployments = useClusterRows(connected, WORKLOAD_ROWS[0]!);
  const statefulSets = useClusterRows(connected, WORKLOAD_ROWS[1]!);
  const daemonSets = useClusterRows(connected, WORKLOAD_ROWS[2]!);
  const workloads = useMemo(() => [deployments, statefulSets, daemonSets], [deployments, statefulSets, daemonSets]);
  const connectedClusters = useMemo<FleetCluster[]>(
    () => connected.map((id) => ({ id, name: names.get(id) ?? id })),
    [connected, names],
  );
  const toConnect = selected.filter((id) => {
    const state = states[id]?.state ?? DISCONNECTED;
    return state === "disconnected" || state === "error";
  });

  const filters = (namespaces: string[]) => (
    <div className="fleet-filters">
      <label className="fleet-filters__choice">
        {t("fleet:filters.cluster")}
        <select className="fleet-select" value={onlyCluster} onChange={(e) => setClusterFilter(e.target.value)}>
          <option value="">{t("fleet:filters.allClusters")}</option>
          {connected.map((id) => (
            <option key={id} value={id}>
              {names.get(id) ?? id}
            </option>
          ))}
        </select>
      </label>
      <label className="fleet-filters__choice">
        {t("fleet:filters.namespace")}
        <select className="fleet-select" value={namespace} onChange={(e) => setNamespace(e.target.value)}>
          <option value="">{t("fleet:filters.allNamespaces")}</option>
          {[...new Set([...namespaces, ...(namespace ? [namespace] : [])])].sort().map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  let content;
  switch (tab) {
    case "pods":
      content = <PodsTable clusters={connectedClusters} only={onlyCluster} namespace={namespace} rows={pods}>{filters}</PodsTable>;
      break;
    case "workloads":
      content = <WorkloadsTable clusters={connectedClusters} only={onlyCluster} namespace={namespace} rows={workloads}>{filters}</WorkloadsTable>;
      break;
    case "events":
      content = <EventsTable clusters={connectedClusters} only={onlyCluster} namespace={namespace}>{filters}</EventsTable>;
      break;
    case "find":
      content = <FindTab clusters={connectedClusters.filter((c) => !onlyCluster || c.id === onlyCluster)} />;
      break;
  }

  if (loaded && clusters.length === 0) {
    return (
      <div className="fleet">
        <EmptyState title={t("fleet:title")} text={t("fleet:noClusters")} />
      </div>
    );
  }

  return (
    <div className="fleet">
      <header className="fleet__header">
        <h2 className="fleet__title">{t("fleet:title")}</h2>
        <p className="fleet-note">{t("fleet:intro")}</p>
      </header>

      <fieldset className="fleet-picker">
        <legend className="fleet-picker__legend">{t("fleet:picker.label")}</legend>
        <ul className="fleet-picker__list">
          {clusters.map((c) => {
            const state = states[c.id]?.state ?? DISCONNECTED;
            return (
              <li key={c.id}>
                <label className="fleet-picker__item" data-state={state}>
                  <Checkbox
                    checked={selected.includes(c.id)}
                    disabled={full && !selected.includes(c.id)}
                    onChange={(e) => {
                      if (!e.target.checked) dequeue(c.id);
                      void setFleetSelected(c.id, e.target.checked, known);
                    }}
                  />
                  <span className="fleet-picker__name">{names.get(c.id)}</span>
                  <span className="fleet-picker__state">{t(`clusters:state.${state}`)}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {full && (
          <p className="fleet-note fleet-note--warning" role="status">
            {t("fleet:picker.limit", { count: MAX_SELECTED })}
          </p>
        )}
        <div className="fleet-picker__actions">
          <Button disabled={toConnect.length === 0} onClick={() => connectSelected(toConnect)}>
            {t("fleet:picker.connectAll")}
          </Button>
          <span className="fleet-note">{t("fleet:picker.connectHint")}</span>
        </div>
      </fieldset>

      {selected.length === 0 ? (
        <p className="fleet-note" role="status">
          {t("fleet:picker.none")}
        </p>
      ) : (
        <>
          <div className="fleet__cards">
            {selected.map((id) => {
              const cluster = byId.get(id);
              return cluster ? (
                <ClusterCard
                  key={id}
                  cluster={cluster}
                  name={names.get(id) ?? id}
                  settings={settings}
                  nodes={nodes.get(id)}
                />
              ) : null;
            })}
          </div>

          {offline > 0 && (
            <p className="fleet-note" role="status">
              {t("fleet:notConnected", { count: offline })}
            </p>
          )}
          <Tabs
            className="fleet__tabs"
            label={t("fleet:tabs.label")}
            tabs={TABS.map((id) => ({ id, label: t(`fleet:tabs.${id}`) }))}
            selected={tab}
            onSelect={setTab}
          >
            {connected.length === 0 ? <p className="fleet-note">{t("fleet:noneConnected")}</p> : content}
          </Tabs>
        </>
      )}
    </div>
  );
}
