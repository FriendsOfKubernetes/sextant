// Details section of an Application: the resources it manages (`status.resources`, with sync and health) and, below
// each, what they own (Deployment → ReplicaSet → Pod, Job → Pod, …), found by `ownerReferences` among live lists
// of those kinds in the app's namespaces. Every row opens its object. Resources in another cluster (the app deploys
// elsewhere) are listed without links or descendants: this cluster cannot show them.
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type KindRef, type KubeObject, type WatchSpec } from "../../api";
import { ErrorState } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { ObjectLink, status, StatusText } from "../../resources";
import { apiVersionOf } from "../../resources/refs";
import { Block } from "../details";
import {
  applicationDestination,
  descendantKinds,
  healthTone,
  isInCluster,
  managedResources,
  resourceTree,
  syncTone,
  type TreeNode,
} from "./model";

const { podStatus, readyOfDesired, trueConditions } = status;

/** The kinds a tree may need, in a fixed order (one live list each). */
const LISTED: KindRef[] = [
  { group: "apps", version: "v1", kind: "ReplicaSet" },
  { group: "batch", version: "v1", kind: "Job" },
  { group: "", version: "v1", kind: "Pod" },
];

const keyOf = (k: Pick<KindRef, "group" | "kind">) => `${k.group}/${k.kind}`;

function specFor(kind: KindRef, needed: { kind: KindRef; namespaces: string[] }[]): WatchSpec | null {
  const entry = needed.find((n) => keyOf(n.kind) === keyOf(kind));
  if (!entry) return null;
  return { kind, namespaces: entry.namespaces, labelSelector: null, fieldSelector: null };
}

/** What a descendant shows in the health column: a pod's status, a ReplicaSet's ready/desired, a Job's conditions. */
function liveState(obj: KubeObject, kind: KindRef): string | undefined {
  if (kind.kind === "Pod") return podStatus(obj);
  if (kind.kind === "ReplicaSet") return readyOfDesired(obj);
  if (kind.kind === "Job") return trueConditions(obj).join(", ") || undefined;
  return undefined;
}

interface Row {
  key: string;
  level: number;
  node: TreeNode;
}

function flatten(nodes: TreeNode[], level = 1, rows: Row[] = []): Row[] {
  for (const node of nodes) {
    rows.push({
      key: `${level}:${keyOf(node.ref.kind)}:${node.ref.namespace ?? ""}:${node.ref.name}`,
      level,
      node,
    });
    flatten(node.children, level + 1, rows);
  }
  return rows;
}

/** Each retry ("Retry" after an error) lists the descendants again. */
export function ResourceTreeSection(props: DetailsSectionProps) {
  const [attempt, setAttempt] = useState(0);
  return <ResourceTreeView key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

function ResourceTreeView({ clusterId, obj, onRetry }: DetailsSectionProps & { onRetry: () => void }) {
  const { t } = useTranslation();
  const app = obj;
  const resources = useMemo(() => (app ? managedResources(app) : []), [app]);
  const local = app ? isInCluster(applicationDestination(app)) : false;
  const needed = useMemo(() => (local ? descendantKinds(resources) : []), [local, resources]);

  const specs = LISTED.map((kind) => specFor(kind, needed));
  const replicaSets = useWatch(clusterId, specs[0] ?? null);
  const jobs = useWatch(clusterId, specs[1] ?? null);
  const pods = useWatch(clusterId, specs[2] ?? null);
  const loading = [replicaSets, jobs, pods].some((list, i) => specs[i] && list.status === "loading");
  const failed = [replicaSets, jobs, pods].find((list, i) => specs[i] && list.status === "error");

  const tree = useMemo(() => {
    const objects = new Map<string, KubeObject[]>([
      [keyOf(LISTED[0]!), [...replicaSets.items.values()]],
      [keyOf(LISTED[1]!), [...jobs.items.values()]],
      [keyOf(LISTED[2]!), [...pods.items.values()]],
    ]);
    return resourceTree(resources, local ? objects : new Map());
  }, [resources, local, replicaSets.items, jobs.items, pods.items]);

  if (!app || resources.length === 0) return null;
  const rows = flatten(tree);
  const headers = [
    t("argocd:tree.kind"),
    t("argocd:tree.name"),
    t("argocd:tree.namespace"),
    t("argocd:tree.sync"),
    t("argocd:tree.health"),
  ];
  return (
    <Block title={t("argocd:tree.title")}>
      {!local && <p className="dt-muted">{t("argocd:tree.remote")}</p>}
      <table className="dt-table argo-tree" aria-label={t("argocd:tree.title")}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, level, node }) => (
            <TreeRow key={key} level={level} node={node} linked={local} />
          ))}
        </tbody>
      </table>
      {failed ? (
        <ErrorState error={failed.error} onRetry={onRetry} />
      ) : (
        loading && (
          <p className="dt-muted" role="status">
            {t("argocd:tree.loading")}
          </p>
        )
      )}
    </Block>
  );
}

function TreeRow({ level, node, linked }: { level: number; node: TreeNode; linked: boolean }) {
  const { ref, managed, obj } = node;
  const target = { apiVersion: apiVersionOf(ref.kind), kind: ref.kind.kind, name: ref.name };
  const name: ReactNode = linked ? (
    <ObjectLink target={target} namespace={ref.namespace}>
      {ref.name}
    </ObjectLink>
  ) : (
    ref.name
  );
  const live = obj ? liveState(obj, ref.kind) : undefined;
  let health: ReactNode = null;
  if (managed?.health) health = <StatusText value={managed.health} tone={healthTone(managed.health)} />;
  // A pod's status has its own colors; counts and conditions stay plain.
  else if (live) health = ref.kind.kind === "Pod" ? <StatusText value={live} /> : live;
  return (
    <tr aria-level={level} data-level={level}>
      <td>
        <span className="argo-tree__kind" style={{ paddingLeft: `${(level - 1) * 16}px` }}>
          {ref.kind.kind}
        </span>
      </td>
      <td>{name}</td>
      <td>{ref.namespace}</td>
      <td>{managed?.sync && <StatusText value={managed.sync} tone={syncTone(managed.sync)} />}</td>
      <td>{health}</td>
    </tr>
  );
}
