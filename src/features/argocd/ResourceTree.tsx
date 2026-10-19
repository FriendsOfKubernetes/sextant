// Details section of an Application: the resources it manages (`status.resources`, with sync and health) and, below
// each, what they own (Deployment → ReplicaSet → Pod, Job → Pod, …), found by `ownerReferences` among live lists
// of those kinds in the app's namespaces. Every row opens its object. Resources in another cluster (the app deploys
// elsewhere) are listed without links or descendants: this cluster cannot show them.
// Argo CD 3.x no longer writes the health of each resource into the Application (it keeps it in its app tree), so
// for a resource without one Sextant lists its kind and computes the health the way Argo CD does (`./health`).
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type KindRef, type KubeObject, type WatchSpec, type WatchState } from "../../api";
import { ErrorState } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { ObjectLink, status, StatusText } from "../../resources";
import { apiVersionOf } from "../../resources/refs";
import { Block } from "../details";
import { HEALTH_KINDS, healthWatchKinds, resourceHealth, type Health } from "./health";
import {
  applicationDestination,
  descendantKinds,
  healthTone,
  isInCluster,
  managedResources,
  resourceTree,
  syncTone,
  type ManagedResource,
  type TreeNode,
} from "./model";

const { podStatus, readyOfDesired, sortStatuses, trueConditions } = status;

/** The kinds a tree may need, in a fixed order (one live list each): every descendant kind (ReplicaSet, Job, Pod)
 * is also a kind whose health is computed. */
const LISTED: KindRef[] = HEALTH_KINDS;

const keyOf = (k: Pick<KindRef, "group" | "kind">) => `${k.group}/${k.kind}`;

type Needs = { kind: KindRef; namespaces: string[] }[];

/** One list of `kind` in every namespace either the descendants or the health of the managed resources need. */
function specFor(kind: KindRef, ...needs: Needs[]): WatchSpec | null {
  const namespaces = new Set<string>();
  for (const entry of needs.flat()) {
    if (keyOf(entry.kind) === keyOf(kind)) for (const ns of entry.namespaces) namespaces.add(ns);
  }
  if (namespaces.size === 0) return null;
  return { kind, namespaces: [...namespaces].sort(), labelSelector: null, fieldSelector: null };
}

const listed = (list: WatchState) => list.status === "ready" || list.status === "reconnecting";

/**
 * Health of each managed resource the Application gives none for, by `managedKey`, from the live list of its kind:
 * `Missing` when the listed namespace has no such object. Nothing while the list is loading or failed, or when its
 * namespace cannot be listed.
 */
function computedHealth(resources: ManagedResource[], lists: Map<string, WatchState>): Map<string, Health> {
  const result = new Map<string, Health>();
  for (const r of resources) {
    const list = lists.get(keyOf(r));
    if (r.health || !r.namespace || !list || !listed(list) || list.forbidden?.includes(r.namespace)) continue;
    let live: KubeObject | undefined;
    for (const obj of list.items.values()) {
      if (obj.metadata?.namespace === r.namespace && obj.metadata?.name === r.name) live = obj;
    }
    const health = resourceHealth(r, live);
    if (health) result.set(managedKey(r), health);
  }
  return result;
}

const managedKey = (r: ManagedResource) => `${keyOf(r)}/${r.namespace ?? ""}/${r.name}`;

/** What a descendant shows in the health column: a pod's status, a ReplicaSet's ready/desired, a Job's conditions. */
function liveState(obj: KubeObject, kind: KindRef): string | undefined {
  if (kind.kind === "Pod") return podStatus(obj);
  if (kind.kind === "ReplicaSet") return readyOfDesired(obj);
  if (kind.kind === "Job") return sortStatuses(trueConditions(obj)).join(", ") || undefined;
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
  const healthNeeded = useMemo(() => (local ? healthWatchKinds(resources) : []), [local, resources]);

  const specs = LISTED.map((kind) => specFor(kind, needed, healthNeeded));
  // One hook per kind of `LISTED`, in its order.
  const deployments = useWatch(clusterId, specs[0] ?? null);
  const statefulSets = useWatch(clusterId, specs[1] ?? null);
  const daemonSets = useWatch(clusterId, specs[2] ?? null);
  const replicaSets = useWatch(clusterId, specs[3] ?? null);
  const pods = useWatch(clusterId, specs[4] ?? null);
  const jobs = useWatch(clusterId, specs[5] ?? null);
  const claims = useWatch(clusterId, specs[6] ?? null);
  const services = useWatch(clusterId, specs[7] ?? null);
  const ingresses = useWatch(clusterId, specs[8] ?? null);
  const all = [deployments, statefulSets, daemonSets, replicaSets, pods, jobs, claims, services, ingresses];
  const lists = new Map(LISTED.map((kind, i) => [keyOf(kind), all[i]!] as const));
  // Loading and errors are about the descendants; a health list that is still loading or failed leaves the
  // health of its resources empty.
  const ofDescendants = needed.map((n) => lists.get(keyOf(n.kind))).filter((l): l is WatchState => l !== undefined);
  const loading = ofDescendants.some((list) => list.status === "loading");
  const failed = ofDescendants.find((list) => list.status === "error");

  const tree = useMemo(() => {
    const objects = new Map<string, KubeObject[]>([
      [keyOf(LISTED[3]!), [...replicaSets.items.values()]],
      [keyOf(LISTED[5]!), [...jobs.items.values()]],
      [keyOf(LISTED[4]!), [...pods.items.values()]],
    ]);
    return resourceTree(resources, local ? objects : new Map());
  }, [resources, local, replicaSets.items, jobs.items, pods.items]);
  const computed = local ? computedHealth(resources, lists) : new Map<string, Health>();

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
            <TreeRow
              key={key}
              level={level}
              node={node}
              linked={local}
              computed={node.managed ? computed.get(managedKey(node.managed)) : undefined}
            />
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

function TreeRow({
  level,
  node,
  linked,
  computed,
}: {
  level: number;
  node: TreeNode;
  linked: boolean;
  /** Health Sextant computed for a managed resource the Application gives none for. */
  computed: Health | undefined;
}) {
  const { t } = useTranslation();
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
  else if (computed) {
    const title = computed.message
      ? t("argocd:tree.computedHealthMessage", { message: computed.message })
      : t("argocd:tree.computedHealth");
    health = (
      <span title={title}>
        <StatusText value={computed.status} tone={healthTone(computed.status)} />
      </span>
    );
  }
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
