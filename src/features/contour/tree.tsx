// The delegation tree of an HTTPProxy: for a root, every proxy it includes, and theirs, with the path prefix each
// one gets (include prefixes concatenate from the root down) and its state; for an included proxy, the roots that
// reach it with only the branches leading to it, then everything under it. The opened proxy is marked. Read from the
// compact rows of the shared HTTPProxy watch (`useProxyIndex`), at most `MAX_TREE_NODES` nodes and `MAX_ROOTS` roots.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { StatusText } from "../../resources";
import { Block, link } from "../details";
import { useProxyIndex } from "./hooks";
import { apiVersionOf, delegationTree, HEALTH_TONE, HTTP_PROXY, proxyKey, rootsReaching, type ProxyState, type TreeNode } from "./model";

const PROXY_TYPE = { apiVersion: apiVersionOf(HTTP_PROXY), kind: HTTP_PROXY.kind };
const STATE_HEALTH = { valid: "ready", invalid: "failed", orphaned: "failed", pending: "progressing" } as const;

function StateText({ state }: { state: ProxyState }) {
  const { t } = useTranslation();
  return <StatusText value={t(`contour:state.${state}`)} tone={HEALTH_TONE[STATE_HEALTH[state]]} />;
}

function Node({ node, current, top }: { node: TreeNode; current: string; top: boolean }) {
  const { t } = useTranslation();
  const [namespace, name] = [node.key.slice(0, node.key.indexOf("/")), node.key.slice(node.key.indexOf("/") + 1)];
  const isCurrent = node.key === current;
  const label = node.row?.root ? (node.row.fqdn ?? "") : node.tcp ? t("contour:tree.tcp") : node.prefix;
  const extra = node.cycle
    ? t("contour:tree.cycle")
    : !node.row
      ? t("contour:tree.missing")
      : node.row.root && !top
        ? t("contour:tree.rootIncluded")
        : node.conditions.filter((c) => !c.startsWith("prefix=")).join(", ");
  return (
    <li className="cm-chain__item" aria-current={isCurrent ? "true" : undefined}>
      <span className="cm-chain__row">
        <span className="cm-chain__kind">{HTTP_PROXY.kind}</span>
        {isCurrent ? <strong>{node.key}</strong> : link(PROXY_TYPE, name, namespace, node.key)}
        {node.row && <StateText state={node.row.state} />}
        {label && <code>{label}</code>}
        {extra && <span className="cm-chain__extra">{extra}</span>}
      </span>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child, i) => (
            <Node key={`${child.key}:${i}`} node={child} current={current} top={false} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function DelegationTree({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const { index, loading, failed, truncated } = useProxyIndex(clusterId, true);
  const key = proxyKey(obj.metadata?.namespace ?? "", obj.metadata?.name ?? "");
  const row = index.get(key);
  const roots = row?.root ? [key] : rootsReaching(index, key);
  const trees = roots.map((root) => delegationTree(index, root, row?.root ? undefined : key));
  const cut = truncated || trees.some((tree) => tree.truncated);
  let body;
  if (failed) body = <p className="cm-muted">{t("contour:tree.failed")}</p>;
  else if (loading && !row) body = <p className="cm-muted">{t("contour:tree.loading")}</p>;
  else if (trees.length === 0) body = <p className="cm-muted">{t("contour:tree.noRoot")}</p>;
  else
    body = (
      <ul className="cm-chain">
        {trees.map((tree) => (
          <Node key={tree.node.key} node={tree.node} current={key} top />
        ))}
      </ul>
    );
  return (
    <Block title={t("contour:tree.title")}>
      {body}
      {cut && <p className="cm-muted">{t("contour:tree.truncated")}</p>}
    </Block>
  );
}
