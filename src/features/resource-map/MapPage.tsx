// The "Map" page (#139): the objects of the namespaces chosen in the namespace filter and how they relate — the way
// in (Ingresses, Gateways, routes), Services and policies, workloads, ReplicaSets and Jobs, pods, their configuration
// and claims — coloured by health with the problems screen's rules. Big groups collapse ("42 pods") and expand on a
// click; any object opens its details. Kinds can be hidden; cluster objects and EndpointSlices start hidden.
//
// Bounded: the namespaces' lists of the kinds the cluster serves (shared with the "Related" tab), at most
// `MAX_MAP_NAMESPACES` namespaces, closed when the page is left; with "All namespaces" the page asks for a choice.
import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../app/store";
import { Button, Checkbox, EmptyState, LoadingIndicator } from "../../components";
import { i18n } from "../../i18n";
import type { PageProps } from "../../layout/pages";
import { useClusterKinds } from "../../resources";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { namespacePlan, useRelationGraph } from "./data";
import { HEALTH_ORDER } from "./health";
import { GAP_X, HIDDEN_BY_DEFAULT, layoutMap, NODE_H, NODE_W, type MapEdge, type MapNode } from "./layout";
import { keyOf } from "./relations";
import { formatNames, HealthDot, objectRefOf, useOpenDetails } from "./ui";

export const MAP_PAGE_ID = "resourceMap";
/** Namespaces the map draws at once. */
export const MAX_MAP_NAMESPACES = 3;

/** The kinds hidden on each cluster's map, kept while the window lives. */
const hiddenByCluster = new Map<string, ReadonlySet<string>>();

/** Forgets the kinds hidden on each cluster's map (tests). */
export function resetMapFilters(): void {
  hiddenByCluster.clear();
}

export function MapPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const namespaces = useSelectedNamespaces(clusterId);
  return (
    <div className="rmap-page">
      <h2 className="rmap-page__title">{t("resourcemap:map.title")}</h2>
      <div className="rmap-page__toolbar">
        <NamespaceFilter clusterId={clusterId} />
      </div>
      {namespaces === undefined ? (
        <LoadingIndicator text={t("resourcemap:map.loading")} />
      ) : namespaces === null || namespaces.length === 0 ? (
        <EmptyState title={t("resourcemap:map.chooseNamespace")} text={t("resourcemap:map.chooseNamespaceText")} />
      ) : (
        <>
          {namespaces.length > MAX_MAP_NAMESPACES && (
            <p className="rmap-page__note" role="status">
              {t("resourcemap:map.firstNamespaces", { count: MAX_MAP_NAMESPACES })}
            </p>
          )}
          <NamespaceMap clusterId={clusterId} namespaces={namespaces.slice(0, MAX_MAP_NAMESPACES)} />
        </>
      )}
    </div>
  );
}

function NamespaceMap({ clusterId, namespaces }: { clusterId: string; namespaces: string[] }) {
  const { t } = useTranslation();
  const nsKey = namespaces.join("\u0000");
  // `nsKey` stands for `namespaces` by value.
  const plan = useMemo(() => namespacePlan(nsKey.split("\u0000")), [nsKey]);
  const { graph, loading, failed } = useRelationGraph(clusterId, plan);
  const [hidden, setHiddenState] = useState<ReadonlySet<string>>(
    () => hiddenByCluster.get(clusterId) ?? new Set(HIDDEN_BY_DEFAULT),
  );
  const setHidden = (next: ReadonlySet<string>) => {
    hiddenByCluster.set(clusterId, next);
    setHiddenState(next);
  };
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const layout = useMemo(() => layoutMap(graph, { hidden, expanded, now: Date.now() }), [graph, hidden, expanded]);
  const [focus, setFocus] = useState<string | null>(null);
  const lit = useMemo(() => {
    if (focus === null) return null;
    const ids = new Set([focus]);
    for (const e of layout.edges) {
      if (e.from === focus) ids.add(e.to);
      if (e.to === focus) ids.add(e.from);
    }
    return ids;
  }, [focus, layout]);

  const toggleKind = (id: string, shown: boolean) => {
    const next = new Set(hidden);
    if (shown) next.delete(id);
    else next.add(id);
    setHidden(next);
  };
  const toggleGroup = (groupId: string) => {
    const next = new Set(expanded);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    setExpanded(next);
  };

  return (
    <div className="rmap-map">
      <div className="rmap-map__controls">
        <fieldset className="rmap-kinds">
          <legend className="rmap-kinds__legend">{t("resourcemap:map.kinds")}</legend>
          {layout.kinds.map((k) => (
            <label key={k.id} className="rmap-kinds__item">
              <Checkbox checked={!hidden.has(k.id)} onChange={(e) => toggleKind(k.id, e.target.checked)} />
              {t("resourcemap:map.kindCount", { kind: k.kind, count: k.count })}
            </label>
          ))}
        </fieldset>
        <div className="rmap-legend" aria-label={t("resourcemap:map.legend")}>
          {HEALTH_ORDER.map((h) => (
            <span key={h} className="rmap-legend__item">
              <HealthDot health={h} />
              {t(`resourcemap:health.${h}`)}
            </span>
          ))}
        </div>
        {expanded.size > 0 && (
          <Button size="compact" onClick={() => setExpanded(new Set())}>
            {t("resourcemap:map.collapseGroups")}
          </Button>
        )}
      </div>
      {failed.length > 0 && (
        <p className="rmap-page__note" role="status">
          {t("resourcemap:related.failed", { kinds: formatNames(failed) })}
        </p>
      )}
      {layout.truncated > 0 && (
        <p className="rmap-page__note" role="status">
          {t("resourcemap:map.truncated", { count: layout.truncated })}
        </p>
      )}
      {layout.nodes.length === 0 ? (
        loading ? (
          <LoadingIndicator text={t("resourcemap:map.loading")} />
        ) : (
          <p className="rmap-page__note">{t("resourcemap:map.empty")}</p>
        )
      ) : (
        <div className="rmap-scroll">
          <div className="rmap-canvas" style={{ width: layout.width, height: layout.height }}>
            <MapEdges nodes={layout.nodes} edges={layout.edges} focus={focus} />
            {layout.nodes.map((node) => (
              <MapNodeBox
                key={node.id}
                clusterId={clusterId}
                node={node}
                onGroup={toggleGroup}
                onFocus={setFocus}
                dimmed={lit !== null && !lit.has(node.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function groupLabel(node: MapNode, t: ReturnType<typeof useTranslation>["t"]): string {
  const count = node.members.length;
  if (node.remainder) return t("resourcemap:map.remainder", { count });
  const key = `resourcemap:map.groupOf.${node.kind}`;
  return i18n.exists(`${key}_other`) ? t(key, { count }) : t("resourcemap:map.group", { count });
}

function MapNodeBox({
  clusterId,
  node,
  onGroup,
  onFocus,
  dimmed,
}: {
  clusterId: string;
  node: MapNode;
  onGroup: (groupId: string) => void;
  onFocus: (id: string | null) => void;
  dimmed: boolean;
}) {
  const { t } = useTranslation();
  const kinds = useClusterKinds(clusterId);
  const openDetails = useOpenDetails();
  const selected = useAppStore((s) => s.details);
  const isGroup = !node.node;
  const target = node.node ? objectRefOf(node.node, kinds.kinds) : null;
  const isSelected =
    node.node !== undefined &&
    selected !== null &&
    keyOf({ group: selected.kind.group, kind: selected.kind.kind, namespace: selected.namespace, name: selected.name }) === node.node.key;
  const style: CSSProperties = { left: node.x, top: node.y, width: NODE_W, height: NODE_H };
  const problems = node.healthCounts.problem ?? 0;
  const label = isGroup ? groupLabel(node, t) : node.name;
  const classes = [
    "rmap-node",
    `rmap-node--${node.health}`,
    isGroup ? "rmap-node--group" : "",
    isSelected ? "rmap-node--selected" : "",
    dimmed ? "rmap-node--dimmed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      style={style}
      data-node={node.id}
      disabled={!isGroup && !target}
      aria-label={
        isGroup
          ? t("resourcemap:map.groupNode", { kind: node.kind, label })
          : t("resourcemap:related.open", { kind: node.kind, name: node.name })
      }
      title={isGroup ? t("resourcemap:map.expandGroup") : undefined}
      onMouseEnter={() => onFocus(node.id)}
      onMouseLeave={() => onFocus(null)}
      onFocus={() => onFocus(node.id)}
      onBlur={() => onFocus(null)}
      onClick={() => {
        if (isGroup && node.groupId) onGroup(node.groupId);
        else if (target) openDetails(target);
      }}
    >
      <span className="rmap-node__head">
        <HealthDot health={node.health} />
        <span className="rmap-node__kind">{node.kind}</span>
        {isGroup && problems > 0 && (
          <span className="rmap-node__problems">{t("resourcemap:map.groupProblems", { count: problems })}</span>
        )}
      </span>
      <span className="rmap-node__name">{label}</span>
    </button>
  );
}

function MapEdges({ nodes, edges, focus }: { nodes: MapNode[]; edges: MapEdge[]; focus: string | null }) {
  const { t } = useTranslation();
  const at = new Map(nodes.map((n) => [n.id, n]));
  const width = Math.max(...nodes.map((n) => n.x + NODE_W), 0);
  const height = Math.max(...nodes.map((n) => n.y + NODE_H), 0);
  return (
    <svg className="rmap-edges" width={width} height={height} aria-hidden="true">
      {edges.map((edge) => {
        const a = at.get(edge.from);
        const b = at.get(edge.to);
        if (!a || !b) return null;
        const active = focus !== null && (edge.from === focus || edge.to === focus);
        return (
          <path
            key={edge.id}
            className={`rmap-edge rmap-edge--${edge.relation}${active ? " rmap-edge--active" : ""}${focus !== null && !active ? " rmap-edge--dimmed" : ""}`}
            d={edgePath(a, b)}
          >
            <title>{t(`resourcemap:relation.${edge.relation}.out`)}</title>
          </path>
        );
      })}
    </svg>
  );
}

/** A curve from the side of `a` facing `b` to the side of `b` facing `a` (both right sides within one column). */
export function edgePath(a: Pick<MapNode, "x" | "y">, b: Pick<MapNode, "x" | "y">): string {
  const ay = a.y + NODE_H / 2;
  const by = b.y + NODE_H / 2;
  if (a.x === b.x) {
    const x = a.x + NODE_W;
    const bulge = Math.min(GAP_X - 8, 24 + Math.abs(by - ay) / 8);
    return `M ${x} ${ay} C ${x + bulge} ${ay}, ${x + bulge} ${by}, ${x} ${by}`;
  }
  const forward = b.x > a.x;
  const sx = forward ? a.x + NODE_W : a.x;
  const tx = forward ? b.x : b.x + NODE_W;
  const dx = Math.max(24, Math.abs(tx - sx) / 2);
  const c1 = forward ? sx + dx : sx - dx;
  const c2 = forward ? tx - dx : tx + dx;
  return `M ${sx} ${ay} C ${c1} ${ay}, ${c2} ${by}, ${tx} ${by}`;
}
