// The details section `resources` of an Application: the resources it manages (`status.resources`, with sync and
// health) and, below each, what they own (Deployment → ReplicaSet → Pod, Job → Pod, …), found by `ownerReferences`
// among live lists of those kinds in the app's namespaces. Every row opens its object. Resources in another cluster
// (the app deploys elsewhere) are listed without links or descendants: this cluster cannot show them. For a resource
// the Application gives no health for (Argo CD 3.x), the health is computed the way Argo CD does (`./health`). An
// Application that manages nothing hides the section, as the built-in view showed nothing then.
import { trackObjects, ui, type KindRef, type KubeObject, type Sextant, type Watch } from "@sextant/extension-sdk";
import {
  applicationDestination,
  descendantKinds,
  flattenTree,
  healthTone,
  isInCluster,
  keyOf,
  managedResources,
  resourceTree,
  syncTone,
  type ManagedResource,
  type Needs,
  type TreeNode,
} from "./argo";
import { badge, element, errorBox } from "./dom";
import { podStatus, readyOfDesired, statusTone, trueConditions } from "./fields";
import { HEALTH_KINDS, healthWatchKinds, resourceHealth, type Health } from "./health";
import { t } from "./i18n";
import { followShown, setHidden } from "./shown";

/** One live list the tree needs. */
export interface LiveList {
  items: KubeObject[];
  status: "loading" | "ready" | "error";
  error?: unknown;
  /** Namespaces the cluster refused to list. */
  forbidden: string[];
}

const kindKey = (k: Pick<KindRef, "group" | "kind">) => keyOf(k.group, k.kind);
export const managedKey = (r: ManagedResource): string => `${kindKey(r)}/${r.namespace ?? ""}/${r.name}`;

/** The namespaces to list `kind` in for the descendants and the health of the managed resources; sorted. */
export function namespacesFor(kind: KindRef, ...needs: Needs[]): string[] {
  const namespaces = new Set<string>();
  for (const entry of needs.flat()) {
    if (kindKey(entry.kind) === kindKey(kind)) for (const ns of entry.namespaces) namespaces.add(ns);
  }
  return [...namespaces].sort();
}

/**
 * Health of each managed resource the Application gives none for, by `managedKey`, from the live list of its kind:
 * `Missing` when the listed namespace has no such object. Nothing while the list is loading or failed, or when its
 * namespace cannot be listed.
 */
export function computedHealth(resources: readonly ManagedResource[], lists: ReadonlyMap<string, LiveList>): Map<string, Health> {
  const result = new Map<string, Health>();
  for (const r of resources) {
    const list = lists.get(kindKey(r));
    if (r.health || !r.namespace || !list || list.status !== "ready" || list.forbidden.includes(r.namespace)) continue;
    const live = list.items.find((obj) => obj.metadata.namespace === r.namespace && obj.metadata.name === r.name);
    const health = resourceHealth(r, live);
    if (health) result.set(managedKey(r), health);
  }
  return result;
}

/** What a descendant shows in the health column: a pod's status, a ReplicaSet's ready/desired, a Job's conditions. */
export function liveState(obj: KubeObject, kind: Pick<KindRef, "kind">): string | undefined {
  if (kind.kind === "Pod") return podStatus(obj);
  if (kind.kind === "ReplicaSet") return readyOfDesired(obj);
  if (kind.kind === "Job") return trueConditions(obj).join(", ") || undefined;
  return undefined;
}

function healthCell(node: TreeNode, computed: Health | undefined): Node | string | null {
  const { managed, obj, ref } = node;
  if (managed?.health) return badge(managed.health, healthTone(managed.health));
  if (computed) {
    const word = badge(computed.status, healthTone(computed.status));
    word.title = computed.message ? t("tree.computedHealthMessage", { message: computed.message }) : t("tree.computedHealth");
    return word;
  }
  const live = obj ? liveState(obj, ref.kind) : undefined;
  if (!live) return null;
  // A pod's status has its own colours; counts and conditions stay plain.
  return ref.kind.kind === "Pod" ? badge(live, statusTone(live)) : live;
}

/** The tree as a table, each row with its level (`aria-level`) and the kind indented by it. */
export function treeTable(sextant: Sextant, tree: TreeNode[], computed: ReadonlyMap<string, Health>, linked: boolean): HTMLElement {
  const headers = [t("tree.kind"), t("tree.name"), t("tree.namespace"), t("tree.sync"), t("tree.health")];
  const flat = flattenTree(tree);
  const rows = flat.map(({ level, node }) => {
    const { ref, managed } = node;
    const kind = element("span", { className: "tree-kind", textContent: ref.kind.kind });
    kind.style.paddingLeft = `${(level - 1) * 16}px`;
    return [
      kind,
      linked ? ui.objectLink(sextant, ref) : ref.name,
      ref.namespace ?? "",
      managed?.sync ? badge(managed.sync, syncTone(managed.sync)) : null,
      healthCell(node, managed ? computed.get(managedKey(managed)) : undefined),
    ];
  });
  const node = ui.table(headers, rows, { label: t("tree.title"), id: "tree", sextant });
  node.querySelector("table")?.classList.add("tree");
  node.querySelectorAll("tbody tr").forEach((row, i) => row.setAttribute("aria-level", String(flat[i]!.level)));
  return node;
}

export function startTree(sextant: Sextant, root: HTMLElement): () => void {
  let app: KubeObject | null = null;
  /** One watch per kind of `HEALTH_KINDS`, with the namespaces it lists. */
  const watches = new Map<string, { namespaces: string; watch: Watch; list: LiveList }>();
  let scheduled = false;

  const render = () => {
    if (!app) return;
    const resources = managedResources(app);
    setHidden(sextant, resources.length === 0);
    if (resources.length === 0) {
      root.replaceChildren(ui.empty(t("diff.empty")));
      return;
    }
    const local = isInCluster(applicationDestination(app));
    const lists = new Map([...watches].map(([key, w]) => [key, w.list] as const));
    const objects = new Map<string, KubeObject[]>([...lists].map(([key, list]) => [key, list.items]));
    const tree = resourceTree(resources, local ? objects : new Map());
    const computed = local ? computedHealth(resources, lists) : new Map<string, Health>();
    const needed = local ? descendantKinds(resources) : [];
    const ofDescendants = needed.map((n) => lists.get(kindKey(n.kind))).filter((l): l is LiveList => l !== undefined);
    const failed = ofDescendants.find((l) => l.status === "error");
    const loading = ofDescendants.some((l) => l.status === "loading");
    const nodes: Node[] = [];
    if (!local) nodes.push(ui.empty(t("tree.remote")));
    nodes.push(treeTable(sextant, tree, computed, local));
    if (failed) nodes.push(element("div", { className: "error-row" }, errorBox(failed.error), ui.button(t("diff.retry"), () => restart())));
    else if (loading) nodes.push(ui.loading(t("tree.loading")));
    root.replaceChildren(...nodes);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };

  const stopAll = () => {
    for (const w of watches.values()) void w.watch.unwatch().catch(() => undefined);
    watches.clear();
  };

  /** Watches what the current app needs, keeping the watches whose namespaces did not change. */
  const sync = () => {
    if (!app) return;
    const resources = managedResources(app);
    const local = isInCluster(applicationDestination(app));
    const needed = local ? descendantKinds(resources) : [];
    const healthNeeded = local ? healthWatchKinds(resources) : [];
    for (const kind of HEALTH_KINDS) {
      const key = kindKey(kind);
      const namespaces = namespacesFor(kind, needed, healthNeeded);
      const current = watches.get(key);
      if (current && current.namespaces === namespaces.join(",")) continue;
      if (current) void current.watch.unwatch().catch(() => undefined);
      watches.delete(key);
      if (namespaces.length === 0) continue;
      const list: LiveList = { items: [], status: "loading", forbidden: [] };
      const watch = sextant.resources.watch(
        { kind, namespaces },
        {
          onUpdate: trackObjects(
            (items) => {
              list.items = items;
              list.status = "ready";
              schedule();
            },
            (other) => {
              if (other.type === "forbidden") list.forbidden = other.namespaces;
              else if (other.type === "error") {
                list.status = "error";
                list.error = new Error(other.message);
              }
              schedule();
            },
          ),
          onError: (error) => {
            list.status = "error";
            list.error = error;
            schedule();
          },
        },
      );
      watches.set(key, { namespaces: namespaces.join(","), watch, list });
    }
    render();
  };

  const restart = () => {
    stopAll();
    sync();
  };

  const stopShown = followShown(sextant, root, (obj) => {
    app = obj;
    sync();
  });
  return () => {
    stopShown();
    stopAll();
  };
}
