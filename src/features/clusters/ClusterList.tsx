// Content of the cluster rail: one icon per kubeconfig context with its connection state (and, when the rail is
// expanded, its name), a context menu (connect / reconnect / disconnect / install Flux or Argo CD / settings / change
// icon), the "add" and "refresh" buttons and, when a kubeconfig source cannot be read, a warning that lists those
// sources with their errors. The user puts the clusters in order by dragging them, with Alt+Up / Alt+Down on a focused
// cluster or with "Move up / down / to top / to bottom" in its menu (`order.ts`, `railDrag.ts`); the order is saved in
// `settings.clusterOrder`.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useSettings,
  type AppSettings,
  type ClusterId,
  type ClusterInfo,
  type ConnectionState,
  type KubeconfigSource,
} from "../../api";
import { useAppStore } from "../../app/store";
import { Dialog, Icon, pointRect, SLOW_AFTER_S, useElapsedSeconds, usePopup, usePopupPosition } from "../../components";
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
import { gapTarget, moveCluster, orderClusters, stepTarget, type MoveStep } from "./order";
import { useRailDrag } from "./railDrag";
import { openContextEdit } from "./kubeconfig/apply";
import { ContextEditDialog } from "./kubeconfig/ContextEditDialog";
import { KubeconfigViewDialog, openKubeconfigView } from "./kubeconfig/ViewKubeconfig";
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

/** Where a cluster is among the clusters the rail shows, for the "Move" items of its menu. */
interface Place {
  index: number;
  count: number;
}

/** Alt+Up / Alt+Down on a focused cluster moves it one place. */
function keyStep(e: KeyboardEvent): MoveStep | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === "ArrowUp") return "up";
  if (e.key === "ArrowDown") return "down";
  return null;
}

export function ClusterList() {
  const { t } = useTranslation();
  const { clusters, sources, loading } = useClusters();
  const { settings, update } = useSettings();
  const states = useClustersStore((s) => s.states);
  const pendingId = useClustersStore((s) => s.pendingId);
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const expanded = useAppStore((s) => s.railExpanded);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const broken = sources.filter((s) => s.error);
  useCredentialRefresh(clusters);

  // The order shown right after a move, until every save of it is done (the settings then carry it; a failed save
  // falls back to what is saved).
  const [moved, setMoved] = useState<ClusterId[] | null>(null);
  const saving = useRef(0);
  const ordered = orderClusters(clusters, moved ?? settings?.clusterOrder);
  const visible = workspaceClusters(ordered, settings, activeClusterId);
  const [announcement, setAnnouncement] = useState("");
  const hintId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const buttons = useRef(new Map<ClusterId, HTMLButtonElement>());
  const refocus = useRef<ClusterId | null>(null);

  /** Moves `id` to the `to`-th place among the clusters shown, saves the order and says where it went. */
  const move = (id: ClusterId, to: number) => {
    const next = moveCluster(
      ordered.map((c) => c.id),
      visible.map((c) => c.id),
      id,
      to,
    );
    const cluster = visible.find((c) => c.id === id);
    if (!next || !cluster) return;
    setMoved(next);
    const position = Math.max(0, Math.min(to, visible.length - 1)) + 1;
    setAnnouncement(
      t("clusters:order.moved", { name: displayNameOf(cluster, settings), position, count: visible.length }),
    );
    saving.current += 1;
    update((current) => ({ ...current, clusterOrder: next }))
      .catch(() => undefined)
      .finally(() => {
        saving.current -= 1;
        if (saving.current === 0) setMoved(null);
      });
  };
  const step = (id: ClusterId, by: MoveStep) => {
    const index = visible.findIndex((c) => c.id === id);
    if (index < 0) return;
    refocus.current = id;
    move(id, stepTarget(by, index, visible.length));
  };
  const drag = useRailDrag(listRef, (id, gap) => {
    const index = visible.findIndex((c) => c.id === id);
    if (index >= 0) move(id, gapTarget(gap, index));
  });
  // A moved item may lose the focus when its node moves: give it back.
  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    const button = buttons.current.get(id);
    if (button && document.activeElement !== button) button.focus();
  });

  // The drop line: before the item at the gap, or after the last one; none where the drop would change nothing.
  const dragIndex = drag.dragging ? visible.findIndex((c) => c.id === drag.dragging!.id) : -1;
  const dropGap =
    drag.dragging && dragIndex >= 0 && gapTarget(drag.dragging.gap, dragIndex) !== dragIndex ? drag.dragging.gap : -1;

  return (
    <div className={expanded ? "cluster-list cluster-list--expanded" : "cluster-list"}>
      <ul
        ref={listRef}
        className={drag.dragging ? "cluster-list__items cluster-list__items--dragging" : "cluster-list__items"}
        aria-label={t("clusters:rail.list")}
      >
        {visible.map((cluster, index) => (
          <li
            key={cluster.id}
            data-drop={
              dropGap === index ? "before" : dropGap === visible.length && index === visible.length - 1 ? "after" : undefined
            }
          >
            <ClusterIcon
              cluster={cluster}
              settings={settings}
              name={displayNameOf(cluster, settings)}
              color={colorOf(cluster, settings)}
              expanded={expanded}
              state={states[cluster.id] ?? DISCONNECTED}
              selected={cluster.id === activeClusterId || cluster.id === pendingId}
              active={cluster.id === activeClusterId}
              dragging={drag.dragging?.id === cluster.id}
              describedBy={visible.length > 1 ? hintId : undefined}
              buttonRef={(el) => {
                if (el) buttons.current.set(cluster.id, el);
                else buttons.current.delete(cluster.id);
              }}
              pointer={drag.handlers(cluster.id)}
              ignoreClick={drag.consumeClick}
              onKeyDown={(e) => {
                const by = keyStep(e);
                if (!by) return;
                e.preventDefault();
                e.stopPropagation();
                step(cluster.id, by);
              }}
              onMenu={(x, y) => setMenu({ cluster, x, y })}
            />
          </li>
        ))}
      </ul>
      <span id={hintId} hidden>
        {t("clusters:order.hint")}
      </span>
      <span className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="rail-announce">
        {announcement}
      </span>
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
          place={{ index: visible.findIndex((c) => c.id === menu.cluster.id), count: visible.length }}
          onMove={(by) => step(menu.cluster.id, by)}
          onClose={() => setMenu(null)}
        />
      )}
      <AddClusterDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <SourceProblemsDialog open={problemsOpen} sources={broken} onClose={() => setProblemsOpen(false)} />
      <ClusterSettingsDialog />
      <ContextEditDialog />
      <KubeconfigViewDialog />
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
  dragging,
  describedBy,
  buttonRef,
  pointer,
  ignoreClick,
  onKeyDown,
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
  dragging: boolean;
  describedBy: string | undefined;
  buttonRef: (el: HTMLButtonElement | null) => void;
  pointer: Record<
    "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onLostPointerCapture",
    (e: PointerEvent<HTMLElement>) => void
  >;
  ignoreClick: () => boolean;
  onKeyDown: (e: KeyboardEvent) => void;
  onMenu: (x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const seconds = useElapsedSeconds(state.state === "connecting");
  const tooltip = t("clusters:rail.tooltip", { name, state: t(`clusters:state.${state.state}`) });
  const slow = seconds >= SLOW_AFTER_S ? t("clusters:rail.slow", { tooltip, seconds }) : null;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={selected ? "cluster-icon cluster-icon--active" : "cluster-icon"}
      style={{ "--cluster-color": color } as CSSProperties}
      aria-label={name}
      aria-current={active ? "true" : undefined}
      aria-describedby={describedBy}
      aria-keyshortcuts={describedBy ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      title={slow ?? tooltip}
      data-state={state.state}
      data-dragging={dragging ? "true" : undefined}
      {...pointer}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (!ignoreClick()) selectCluster(cluster.id);
      }}
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
          // Drawn from `data-text` by CSS, like the initials: the button's name is the cluster name (WCAG 2.5.3); the
          // seconds are in its tooltip and on the connection screen.
          <span
            className="cluster-icon__elapsed"
            data-slow={slow ? "true" : undefined}
            data-text={t("clusters:connection.seconds", { seconds })}
            aria-hidden="true"
          />
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

const MOVES: readonly [MoveStep, string][] = [
  ["up", "clusters:menu.moveUp"],
  ["down", "clusters:menu.moveDown"],
  ["top", "clusters:menu.moveTop"],
  ["bottom", "clusters:menu.moveBottom"],
];

function ClusterMenu({
  menu,
  state,
  place,
  onMove,
  onClose,
}: {
  menu: MenuState;
  state: ConnectionState;
  place: Place;
  onMove: (by: MoveStep) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLUListElement>(null);
  const id = menu.cluster.id;

  usePopup(ref, onClose);
  // At the pointer, flipped or shifted to stay inside the window (#176).
  usePopupPosition(ref, pointRect(menu.x, menu.y));
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);

  const run = (action: () => unknown) => () => {
    onClose();
    void action();
  };
  const connected = state.state === "connected" || state.state === "connecting";

  return (
    <ul ref={ref} className="cluster-menu" role="menu">
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
      {place.index >= 0 && place.count > 1 && (
        <>
          <li role="separator" className="cluster-menu__separator" />
          {MOVES.map(([by, label]) => (
            <li role="none" key={by}>
              <button
                type="button"
                role="menuitem"
                disabled={by === "up" || by === "top" ? place.index === 0 : place.index === place.count - 1}
                onClick={run(() => onMove(by))}
              >
                {t(label)}
              </button>
            </li>
          ))}
        </>
      )}
      <li role="separator" className="cluster-menu__separator" />
      <li role="none">
        <button type="button" role="menuitem" onClick={run(() => openKubeconfigView(menu.cluster))}>
          {t("kubeconfigview:menu.view")}
        </button>
      </li>
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
