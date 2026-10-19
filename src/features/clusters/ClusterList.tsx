// Content of the cluster rail: one icon per kubeconfig context with its connection state (and, when the rail is
// expanded, its name), a context menu (connect / reconnect / disconnect / install Flux or Argo CD / settings / change
// icon), the "add" and "refresh" buttons and, when a kubeconfig source cannot be read, a warning that lists those
// sources with their errors.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, type AppSettings, type ClusterInfo, type ConnectionState, type KubeconfigSource } from "../../api";
import { useAppStore } from "../../app/store";
import { Dialog, Icon, SLOW_AFTER_S, useElapsedSeconds, usePopup } from "../../components";
import { AddClusterDialog, SourceError } from "./AddClusterDialog";
import { ClusterAvatar } from "./ClusterAvatar";
import { ClusterSettingsDialog } from "./ClusterSettingsDialog";
import { colorOf, displayNameOf } from "./clusterSettings";
import {
  connectCluster,
  disconnectCluster,
  openClusterSettings,
  refreshClusters,
  selectCluster,
  useClustersStore,
} from "./clustersStore";
import { InstallMenuItems } from "../gitops-install/InstallMenuItems";
import { useClusters } from "./hooks";
import { openContextEdit } from "./kubeconfig/apply";
import { ContextEditDialog } from "./kubeconfig/ContextEditDialog";
import { ExpiryBadge, useCredentialRefresh } from "./kubeconfig/ExpiryBadge";
import { MergeDialog } from "./kubeconfig/MergeDialog";
import { sourceKindLabelKey } from "./sources";
// The active workspace (#149) filters which clusters the rail shows; nothing is connected or disconnected by it.
import { workspaceClusters } from "../views/model";
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
  const expanded = useAppStore((s) => s.railExpanded);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const broken = sources.filter((s) => s.error);
  useCredentialRefresh(clusters);

  return (
    <div className={expanded ? "cluster-list cluster-list--expanded" : "cluster-list"}>
      <ul className="cluster-list__items" aria-label={t("clusters:rail.list")}>
        {workspaceClusters(clusters, settings, activeClusterId).map((cluster) => (
          <li key={cluster.id}>
            <ClusterIcon
              cluster={cluster}
              settings={settings}
              name={displayNameOf(cluster, settings)}
              color={colorOf(cluster, settings)}
              expanded={expanded}
              state={states[cluster.id] ?? DISCONNECTED}
              selected={cluster.id === activeClusterId || cluster.id === pendingId}
              active={cluster.id === activeClusterId}
              onMenu={(x, y) => setMenu({ cluster, x, y })}
            />
          </li>
        ))}
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
            <Icon name="warning" />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label={t("clusters:rail.add")}
          title={t("clusters:rail.add")}
          onClick={() => setAddOpen(true)}
        >
          <Icon name="add" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("clusters:rail.refresh")}
          title={t("clusters:rail.refresh")}
          disabled={loading}
          onClick={() => void refreshClusters()}
        >
          <Icon name="refresh" />
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
      <ContextEditDialog />
      <MergeDialog />
    </div>
  );
}

/**
 * One cluster in the rail; while it connects, the seconds so far (and, after 5 s, that it is slow, in the tooltip).
 * Its accessible name is always the cluster name; the expanded rail also shows that name next to the icon.
 */
function ClusterIcon({
  cluster,
  settings,
  name,
  color,
  expanded,
  state,
  selected,
  active,
  onMenu,
}: {
  cluster: ClusterInfo;
  settings: AppSettings | null;
  name: string;
  color: string;
  expanded: boolean;
  state: ConnectionState;
  selected: boolean;
  active: boolean;
  onMenu: (x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const seconds = useElapsedSeconds(state.state === "connecting");
  const tooltip = t("clusters:rail.tooltip", { name, state: t(`clusters:state.${state.state}`) });
  const slow = seconds >= SLOW_AFTER_S ? t("clusters:rail.slow", { tooltip, seconds }) : null;
  return (
    <button
      type="button"
      className={selected ? "cluster-icon cluster-icon--active" : "cluster-icon"}
      style={{ "--cluster-color": color } as CSSProperties}
      aria-label={name}
      aria-current={active ? "true" : undefined}
      title={slow ?? tooltip}
      data-state={state.state}
      onClick={() => selectCluster(cluster.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <span className="cluster-icon__badge">
        <ClusterAvatar cluster={cluster} settings={settings} />
        <span className="cluster-icon__status" data-state={state.state} aria-hidden="true" />
        <ExpiryBadge clusterId={cluster.id} />
        {seconds >= 1 && (
          <span className="cluster-icon__elapsed" data-slow={slow ? "true" : undefined}>
            {t("clusters:connection.seconds", { seconds })}
          </span>
        )}
      </span>
      {expanded && (
        <span className="cluster-icon__name" aria-hidden="true">
          {name}
        </span>
      )}
    </button>
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
      <InstallMenuItems clusterId={id} run={run} />
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => openClusterSettings(id))}>
          {t("clusters:menu.settings")}
        </button>
      </li>
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => openClusterSettings(id, "icon"))}>
          {t("clusters:menu.changeIcon")}
        </button>
      </li>
      <li role="separator" className="cluster-menu__separator" />
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => openContextEdit("rename", menu.cluster))}>
          {t("kubeconfig:menu.rename")}
        </button>
      </li>
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => openContextEdit("namespace", menu.cluster))}>
          {t("kubeconfig:menu.namespace")}
        </button>
      </li>
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => openContextEdit("duplicate", menu.cluster))}>
          {t("kubeconfig:menu.duplicate")}
        </button>
      </li>
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => openContextEdit("delete", menu.cluster))}>
          {t("kubeconfig:menu.delete")}
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
            <span className="cluster-problems__kind">{t(sourceKindLabelKey(source.kind))}</span>
            {source.error && <SourceError error={source.error} />}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
