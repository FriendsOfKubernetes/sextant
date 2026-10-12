// Content of the cluster rail: one icon per kubeconfig context with its connection state, a context menu
// (connect / reconnect / disconnect / settings), the "add" and "refresh" buttons and, when a kubeconfig source cannot
// be read, a warning that lists those sources with their errors.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, type ClusterInfo, type ConnectionState, type KubeconfigSource } from "../../api";
import { useAppStore } from "../../app/store";
import { Dialog, usePopup } from "../../components";
import { AddClusterDialog, SourceError } from "./AddClusterDialog";
import { ClusterSettingsDialog } from "./ClusterSettingsDialog";
import { colorOf, displayNameOf, initialsOf } from "./clusterSettings";
import {
  connectCluster,
  disconnectCluster,
  openClusterSettings,
  refreshClusters,
  selectCluster,
  useClustersStore,
} from "./clustersStore";
import { useClusters } from "./hooks";
import "./clusters.css";

const DISCONNECTED: ConnectionState = { state: "disconnected" };

interface MenuState {
  cluster: ClusterInfo;
  x: number;
  y: number;
}

export function ClusterList() {
  const { t } = useTranslation();
  const { clusters, sources, loading } = useClusters();
  const { settings } = useSettings();
  const states = useClustersStore((s) => s.states);
  const pendingId = useClustersStore((s) => s.pendingId);
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const broken = sources.filter((s) => s.error);

  return (
    <div className="cluster-list">
      <ul className="cluster-list__items" aria-label={t("clusters:rail.list")}>
        {clusters.map((cluster) => {
          const name = displayNameOf(cluster, settings);
          const state = states[cluster.id] ?? DISCONNECTED;
          const selected = cluster.id === activeClusterId || cluster.id === pendingId;
          return (
            <li key={cluster.id}>
              <button
                type="button"
                className={selected ? "cluster-icon cluster-icon--active" : "cluster-icon"}
                style={{ "--cluster-color": colorOf(cluster, settings) } as CSSProperties}
                aria-label={name}
                aria-current={cluster.id === activeClusterId ? "true" : undefined}
                title={t("clusters:rail.tooltip", { name, state: t(`clusters:state.${state.state}`) })}
                data-state={state.state}
                onClick={() => selectCluster(cluster.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ cluster, x: e.clientX, y: e.clientY });
                }}
              >
                <span className="cluster-icon__initials" aria-hidden="true">
                  {initialsOf(name)}
                </span>
                <span className="cluster-icon__status" data-state={state.state} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="cluster-list__actions">
        {broken.length > 0 && (
          <button
            type="button"
            className="icon-btn cluster-list__problems"
            aria-label={t("clusters:sources.problems")}
            title={t("clusters:sources.problems")}
            onClick={() => setProblemsOpen(true)}
          >
            !
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label={t("clusters:rail.add")}
          title={t("clusters:rail.add")}
          onClick={() => setAddOpen(true)}
        >
          +
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("clusters:rail.refresh")}
          title={t("clusters:rail.refresh")}
          disabled={loading}
          onClick={() => void refreshClusters()}
        >
          ⟳
        </button>
      </div>
      {menu && (
        <ClusterMenu
          menu={menu}
          state={states[menu.cluster.id] ?? DISCONNECTED}
          onClose={() => setMenu(null)}
        />
      )}
      <AddClusterDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <SourceProblemsDialog open={problemsOpen} sources={broken} onClose={() => setProblemsOpen(false)} />
      <ClusterSettingsDialog />
    </div>
  );
}

function ClusterMenu({ menu, state, onClose }: { menu: MenuState; state: ConnectionState; onClose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLUListElement>(null);
  const id = menu.cluster.id;

  usePopup(ref, onClose);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);

  const run = (action: () => unknown) => () => {
    onClose();
    void action();
  };
  const connected = state.state === "connected" || state.state === "connecting";

  return (
    <ul ref={ref} className="cluster-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => selectCluster(id))}>
          {t("clusters:menu.open")}
        </button>
      </li>
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => connectCluster(id))}>
          {t(state.state === "disconnected" ? "clusters:menu.connect" : "clusters:menu.reconnect")}
        </button>
      </li>
      {connected && (
        <li role="none">
          <button type="button" role="menuitem" onClick={run(() => disconnectCluster(id))}>
            {t("clusters:menu.disconnect")}
          </button>
        </li>
      )}
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => openClusterSettings(id))}>
          {t("clusters:menu.settings")}
        </button>
      </li>
    </ul>
  );
}

/** The kubeconfig sources that cannot be read, each with its error. */
function SourceProblemsDialog({
  open,
  sources,
  onClose,
}: {
  open: boolean;
  sources: KubeconfigSource[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open && sources.length > 0} title={t("clusters:sources.problemsTitle")} onClose={onClose}>
      <p className="clusters-hint">{t("clusters:sources.problemsHint")}</p>
      <ul className="cluster-problems">
        {sources.map((source) => (
          <li key={source.id} className="cluster-problems__item">
            <span className="cluster-problems__path">{source.path}</span>
            <span className="cluster-problems__kind">{t(`clusters:sources.kind.${source.kind}`)}</span>
            {source.error && <SourceError error={source.error} />}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
