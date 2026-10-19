// The "Related" tab of every object's details (#139): what would break if it were deleted, in plain words, and its
// relations one hop both ways, grouped by relation ("Mounted by", "Owns", "Selects", …). Each related object opens its
// details; its chevron shows its own relations in place, so the tree can be followed hop by hop.
//
// Bounded: an object in a namespace watches that namespace's lists (`NAMESPACE_KINDS`, the served kinds only); a
// cluster-scoped one only what can name it (`nodePlan`). Expanding an object of another namespace adds that namespace,
// up to `MAX_NAMESPACES` at once. Everything is let go when the tab closes. A Service also gets the Gateway API
// routes of other namespaces that reach it, through the Gateway API section's own reverse links (`routesReaching`).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KindRef } from "../../api";
import { Badge, Icon } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { useClusterKinds } from "../../resources";
import { Block } from "../details";
import { routesReaching } from "../gateway-api/exposure";
import { useServedRoutes } from "../gateway-api/hooks";
import { mergePlans, nodePlan, planNamespaces, useRelationGraph, type PlanItem } from "./data";
import { nodeHealth } from "./health";
import { deletionImpact, type ImpactLine } from "./impact";
import { ROUTES, same, SERVICE } from "./kinds";
import { keyOf, neighbours, type Graph, type GraphInput, type GraphNode, type NeighbourGroup, type NodeRef } from "./relations";
import { formatNames, HealthDot, objectRefOf, useOpenDetails } from "./ui";

/** Namespaces whose lists the tab may hold open at once (the object's own included). */
export const MAX_NAMESPACES = 4;
/** How deep the tree can be followed. */
export const MAX_DEPTH = 4;
/** Objects a group lists before "Show N more". */
export const SHOWN = 20;

/** The plans of `refs` in order, each one only while the namespaces stay within the cap; which refs got theirs. */
export function cappedPlan(refs: readonly NodeRef[]): { plan: PlanItem[]; covered: Set<string> } {
  let plan: PlanItem[] = [];
  const covered = new Set<string>();
  for (const ref of refs) {
    const next = mergePlans([...plan, ...nodePlan(ref)]);
    if (planNamespaces(next).length > MAX_NAMESPACES) continue;
    plan = next;
    covered.add(keyOf(ref));
  }
  return { plan, covered };
}

export function RelatedSection(props: DetailsSectionProps) {
  // A new object starts with nothing expanded.
  return <Related key={JSON.stringify(props.objectRef)} {...props} />;
}

function Related({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const { kind, namespace, name } = objectRef;
  const self = useMemo<NodeRef>(
    () => ({ group: kind.group, kind: kind.kind, version: kind.version, namespace, name }),
    [kind.group, kind.kind, kind.version, namespace, name],
  );
  const selfKey = keyOf(self);
  /** Expanded rows by their path in the tree, with the object each shows. */
  const [expanded, setExpanded] = useState<ReadonlyMap<string, NodeRef>>(new Map());
  const { plan, covered } = useMemo(() => cappedPlan([self, ...expanded.values()]), [self, expanded]);

  const isService = same(kind, SERVICE) && namespace !== null;
  const { routes } = useServedRoutes(clusterId, isService);
  const extra = useMemo(() => {
    const inputs: GraphInput[] = obj ? [{ kind, items: [obj] }] : [];
    if (isService) {
      for (const reaching of routesReaching(routes, { namespace: namespace ?? "", name })) {
        const routeKind: KindRef | undefined = ROUTES.find((r) => same(r, reaching.kind));
        if (routeKind) inputs.push({ kind: routeKind, items: [reaching.route] });
      }
    }
    return inputs;
  }, [obj, kind, isService, routes, namespace, name]);

  const { graph, loading, failed } = useRelationGraph(clusterId, plan, extra);
  const impact = deletionImpact(graph, selfKey);
  const toggle = (path: string, ref: NodeRef) =>
    setExpanded((prev) => {
      const next = new Map(prev);
      if (next.has(path)) {
        // Collapsing a row collapses what was opened under it too.
        for (const p of [...next.keys()]) if (p === path || p.startsWith(`${path}>`)) next.delete(p);
      } else next.set(path, ref);
      return next;
    });

  const tree = (
    <RelatedTree
      clusterId={clusterId}
      graph={graph}
      nodeKey={selfKey}
      depth={0}
      path=""
      expanded={expanded}
      covered={covered}
      onToggle={toggle}
      home={namespace}
    />
  );
  const hasRelations = neighbours(graph, selfKey).length > 0;

  return (
    <div className="rmap-related">
      <Block title={t("resourcemap:impact.title")}>
        {impact.length > 0 ? (
          <ul className="rmap-impact" aria-label={t("resourcemap:impact.title")}>
            {impact.map((line) => (
              <li key={line.id} className="rmap-impact__line" data-impact={line.id}>
                <Icon name="warning" />
                <span className="rmap-impact__text">{impactText(line, t)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dt-muted">{loading ? t("resourcemap:related.loading") : t("resourcemap:impact.none")}</p>
        )}
      </Block>
      <Block title={t("resourcemap:related.title")}>
        <p className="rmap-related__scope dt-muted">{t("resourcemap:related.scope")}</p>
        {failed.length > 0 && (
          <p className="rmap-related__failed" role="status">
            {t("resourcemap:related.failed", { kinds: formatNames(failed) })}
          </p>
        )}
        {hasRelations ? tree : <p className="dt-muted">{loading ? t("resourcemap:related.loading") : t("resourcemap:related.none")}</p>}
      </Block>
    </div>
  );
}

type T = ReturnType<typeof useTranslation>["t"];

export function impactText(line: ImpactLine, t: T): string {
  if (line.id === "recreated") return t("resourcemap:impact.recreated", { kind: line.owner?.kind, name: line.owner?.name });
  if (line.id === "cascade") return t("resourcemap:impact.cascade", { count: line.count, kinds: formatNames(line.kinds ?? []) });
  return t(`resourcemap:impact.${line.id}`, { count: line.count });
}

interface TreeProps {
  clusterId: string;
  graph: Graph;
  nodeKey: string;
  /** The row this level hangs under: not listed again. */
  parentKey?: string;
  depth: number;
  path: string;
  expanded: ReadonlyMap<string, NodeRef>;
  covered: ReadonlySet<string>;
  onToggle: (path: string, ref: NodeRef) => void;
  /** The opened object's namespace: other namespaces are named. */
  home: string | null;
}

function RelatedTree(props: TreeProps) {
  const groups = neighbours(props.graph, props.nodeKey)
    .map((g) => ({ ...g, items: g.items.filter((i) => i.node.key !== props.parentKey) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="rmap-tree">
      {groups.map((group) => (
        <RelationGroup key={`${group.relation}|${group.direction}`} group={group} {...props} />
      ))}
    </div>
  );
}

function RelationGroup({ group, ...props }: TreeProps & { group: NeighbourGroup }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(SHOWN);
  const label = t(`resourcemap:relation.${group.relation}.${group.direction}`);
  const hidden = group.items.length - limit;
  return (
    <section className="rmap-group" aria-label={label} data-relation={`${group.relation}.${group.direction}`}>
      <h4 className="rmap-group__title">
        {label}
        <Badge>{group.items.length}</Badge>
      </h4>
      <ul className="rmap-group__list">
        {group.items.slice(0, limit).map(({ edge, node }) => (
          <RelatedRow
            key={`${edge.from}|${edge.to}|${edge.relation}`}
            node={node}
            optional={edge.optional}
            template={edge.template}
            {...props}
            path={`${props.path}>${group.relation}.${group.direction}`}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="rt-link rmap-group__more" onClick={() => setLimit((n) => n + 10 * SHOWN)}>
          {t("resourcemap:related.showMore", { count: hidden })}
        </button>
      )}
    </section>
  );
}

function RelatedRow({
  node,
  optional,
  template,
  ...props
}: TreeProps & { node: GraphNode; optional?: boolean; template?: boolean }) {
  const { t } = useTranslation();
  const kinds = useClusterKinds(props.clusterId);
  const openDetails = useOpenDetails();
  // The group is part of the path: an object listed under two relations opens under the one clicked.
  const path = `${props.path}>${node.key}`;
  const open = props.expanded.has(path);
  const target = objectRefOf(node, kinds.kinds);
  const { kind, name, namespace } = node.ref;
  const canExpand = props.depth + 1 < MAX_DEPTH;
  return (
    <li className="rmap-row">
      <div className="rmap-row__line">
        {canExpand ? (
          <button
            type="button"
            className="icon-btn rmap-row__toggle"
            aria-expanded={open}
            aria-label={t(open ? "resourcemap:related.collapse" : "resourcemap:related.expand", { kind, name })}
            onClick={() => props.onToggle(path, node.ref)}
          >
            <Icon name={open ? "chevronDown" : "chevronRight"} />
          </button>
        ) : (
          <span className="rmap-row__toggle" />
        )}
        <HealthDot health={nodeHealth(node, Date.now())} />
        <span className="rmap-row__kind">{kind}</span>
        {target ? (
          <button
            type="button"
            className="rt-link rmap-row__name"
            aria-label={t("resourcemap:related.open", { kind, name })}
            onClick={() => openDetails(target)}
          >
            {name}
          </button>
        ) : (
          <span className="rmap-row__name">{name}</span>
        )}
        {namespace !== null && namespace !== props.home && (
          <span className="dt-muted">{t("resourcemap:related.inNamespace", { namespace })}</span>
        )}
        {optional && <Badge>{t("resourcemap:related.optional")}</Badge>}
        {template && <Badge>{t("resourcemap:related.template")}</Badge>}
      </div>
      {open &&
        (props.covered.has(node.key) ? (
          <RelatedTree {...props} nodeKey={node.key} parentKey={props.nodeKey} depth={props.depth + 1} path={path} />
        ) : (
          <p className="dt-muted rmap-row__note">{t("resourcemap:related.tooManyNamespaces")}</p>
        ))}
    </li>
  );
}
