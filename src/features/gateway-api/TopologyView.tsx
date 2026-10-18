// The "Topology" tab of a Gateway: the tree Gateway → listeners → routes → rules → backends (Services with pod
// readiness), with the routes the Gateway did not accept in one "Not attached" group, laid out like the Argo CD
// resource tree (an indented table, one row per node, `aria-level`), each node with a health dot and, when broken, a
// short reason (the explanation in its tooltip). Objects open their details; "Only problems" keeps the paths to broken
// nodes. Routes of every served kind are watched while the tab is open, Services and EndpointSlices only in the
// backends' namespaces, ReferenceGrants only where a backend is elsewhere.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { dotSeparator, listSeparator } from "../../i18n";
import type { ClusterId, KubeObject } from "../../api";
import { Checkbox } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { StatusText } from "../../resources";
import { Block } from "../details";
import { HEALTH_TONE } from "./columns";
import { LoadingLine, nameFrom, phrasesText, refLink } from "./details";
import { useBackendState, useGrants, useServedRoutes } from "./hooks";
import { backendText, explainReason, isKind, GATEWAY, type Health } from "./model";
import { flattenTopology, gatewayTopology, onlyProblems, type TopologyNode } from "./topology";

function HealthDot({ health }: { health: Health }) {
  const { t } = useTranslation();
  return <span className={`gw-dot gw-dot--${health}`} role="img" aria-label={t(`gateway:health.${health}`)} />;
}

/** Reasons Sextant finds itself (not a controller's), with their own text. */
const OWN_REASONS = new Set([
  "NoBackends",
  "NoEndpoints",
  "PodsNotReady",
  "BackendNotFound",
  "RefNotPermitted",
  "InvalidKind",
  "ListenersBroken",
]);

/** What the node is: kind and name (a link for objects), plus a muted detail. */
function NodeLabel({ node, gatewayNamespace }: { node: TopologyNode; gatewayNamespace: string | null }) {
  const { t } = useTranslation();
  let kind: string | undefined;
  let name: ReactNode;
  let detail: string | undefined;
  switch (node.type) {
    case "gateway":
      kind = node.ref.kind;
      name = refLink(node.ref);
      break;
    case "notAttached":
      name = t("gateway:topology.notAttached");
      detail = t("gateway:topology.notAttachedHint");
      break;
    case "listener": {
      const l = node.listener;
      kind = t("gateway:topology.listener");
      name = l.name;
      detail = [`${l.port ?? ""}/${l.protocol}`, l.hostname].filter(Boolean).join(" ");
      break;
    }
    case "route":
      kind = node.routeKind.kind;
      name = refLink(node.ref, nameFrom(node.ref, gatewayNamespace));
      detail = node.hostnames && node.hostnames.length > 0 ? node.hostnames.join(listSeparator()) : undefined;
      break;
    case "rule": {
      const { rule } = node;
      kind = undefined;
      name = rule.name
        ? t("gateway:route.ruleNamed", { n: rule.index + 1, name: rule.name })
        : t("gateway:route.rule", { n: rule.index + 1 });
      const matched =
        rule.matches.length > 0 ? rule.matches.map((m) => phrasesText(m, t, dotSeparator())).join(" | ") : undefined;
      const filters = rule.filters.length > 0 ? phrasesText(rule.filters, t, listSeparator()) : undefined;
      detail = [matched, filters].filter(Boolean).join(dotSeparator()) || undefined;
      break;
    }
    case "backend": {
      const b = node.backend;
      kind = node.mirror ? t("gateway:topology.mirror") : b.kind;
      const text = backendText(b, node.routeNamespace);
      name = b.group === "" && b.kind === "Service" ? refLink(b, text) : text;
      detail = node.split ? `${b.percent}%` : undefined;
      break;
    }
  }
  return (
    <span className="gw-tree__label">
      {kind && <span className="gw-tree__kind">{`${kind} `}</span>}
      <span className="gw-tree__name">{name}</span>
      {detail && <span className="gw-tree__detail dt-muted"> {detail}</span>}
    </span>
  );
}

/** "OK", "3/3 pods ready", or the reason with its explanation in the tooltip. */
function NodeStatus({ node }: { node: TopologyNode }) {
  const { t } = useTranslation();
  const ready = node.type === "backend" ? node.readiness : undefined;
  if (node.type === "notAttached") return null;
  if (node.health !== "problem" || !node.reason) {
    const value = ready
      ? t("gateway:route.podsReady", { ready: ready.ready, total: ready.total })
      : node.health === "pending" && node.reason
        ? `${t("gateway:health.pending")}: ${node.reason}`
        : t(`gateway:health.${node.health}`);
    return <StatusText value={value} tone={HEALTH_TONE[node.health]} />;
  }
  const own = OWN_REASONS.has(node.reason)
    ? t(`gateway:topology.reasons.${node.reason}`, { ...node.params, ...ready })
    : node.reason;
  const explained = explainReason(node.reason);
  const title = [explained ? t(explained) : undefined, node.message].filter(Boolean).join("\n") || undefined;
  return (
    <span title={title}>
      <StatusText value={own} tone="danger" />
    </span>
  );
}

function GatewayTopology({ clusterId, gateway }: { clusterId: ClusterId; gateway: KubeObject }) {
  const { t } = useTranslation();
  const [problemsOnly, setProblemsOnly] = useState(false);
  const { routes, loading } = useServedRoutes(clusterId);
  const ns = gateway.metadata?.namespace ?? null;
  // The backends of the routes on this Gateway decide which namespaces to list Services, slices and grants in.
  const first = gatewayTopology(gateway, { routes });
  const backends = flattenTopology(first).flatMap(({ node }) => (node.type === "backend" ? [node] : []));
  const serviceNamespaces = backends.flatMap(({ backend: b }) =>
    b.group === "" && b.kind === "Service" && b.namespace ? [b.namespace] : [],
  );
  const crossNamespaces = backends.flatMap(({ backend: b, routeNamespace }) =>
    b.namespace && b.namespace !== routeNamespace ? [b.namespace] : [],
  );
  const { servicesIn, readiness } = useBackendState(clusterId, serviceNamespaces);
  const grantsIn = useGrants(clusterId, crossNamespaces);
  const tree = gatewayTopology(gateway, { routes, servicesIn, grantsIn, readiness });
  const shown = problemsOnly ? onlyProblems(tree) : tree;
  const rows = shown ? flattenTopology(shown) : [];
  const title = t("gateway:topology.title");

  // The tab itself is titled "Topology": the block has no heading of its own, only the filter.
  return (
    <div className="gw-topology">
      <Block
        actions={
          <label className="gw-tree__filter">
            <Checkbox checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
            {t("resources:table.onlyProblems")}
          </label>
        }
      >
        {rows.length > 0 ? (
          <table className="dt-table gw-table gw-tree" aria-label={title}>
            <thead>
              <tr>
                <th>{t("gateway:topology.node")}</th>
                <th>{t("gateway:topology.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ node, level }) => (
                <tr
                  key={node.key}
                  aria-level={level}
                  data-level={level}
                  data-type={node.type}
                  data-health={node.health}
                  className={node.type === "notAttached" ? "gw-tree__group" : undefined}
                >
                  <td>
                    <span className="gw-tree__cell" style={{ paddingLeft: `${(level - 1) * 16}px` }}>
                      <HealthDot health={node.health} />
                      <NodeLabel node={node} gatewayNamespace={ns} />
                    </span>
                  </td>
                  <td>
                    <NodeStatus node={node} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="dt-muted">{t("gateway:topology.noProblems")}</p>
        )}
        {loading && <LoadingLine text={t("gateway:attached.loading")} />}
      </Block>
    </div>
  );
}

export function TopologySection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj || !isKind(objectRef.kind, GATEWAY)) return null;
  return <GatewayTopology clusterId={clusterId} gateway={obj} />;
}
