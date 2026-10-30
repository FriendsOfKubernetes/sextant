// The "Daemons" tab of a CephCluster: the operator, Ceph's daemons, the CSI drivers and the toolbox, as pods found
// by Rook's labels (see components.ts), OSDs grouped by node. Pods only: everything else is in their details.
import type { Sextant } from "@sextant/extension-sdk";
import { componentsOf, daemonIdOf, isReady, notReadyReason, OPERATOR_SELECTOR, restartsOf, type Component, type Pod } from "./components";
import { badge, element, errorBox, objectLink } from "./dom";
import { kindKey, servedKinds, watchLists, type LiveList } from "./live";
import { POD, refOf } from "./rook";

/** Pod rows shown per component; the rest are counted. */
export const MAX_ROWS = 50;

function podTable(sextant: Sextant, pods: Pod[], withNode: boolean): HTMLElement {
  const shown = pods.slice(0, MAX_ROWS);
  const table = element(
    "table",
    {},
    element(
      "thead",
      {},
      element(
        "tr",
        {},
        element("th", { textContent: "Pod" }),
        element("th", { textContent: "Daemon" }),
        withNode ? element("th", { textContent: "Node" }) : null,
        element("th", { textContent: "State" }),
        element("th", { textContent: "Restarts" }),
      ),
    ),
    element(
      "tbody",
      {},
      ...shown.map((pod) =>
        element(
          "tr",
          {},
          element("td", {}, objectLink(sextant, refOf(pod, POD))),
          element("td", { textContent: daemonIdOf(pod) === pod.metadata.name ? "" : daemonIdOf(pod) }),
          withNode ? element("td", { textContent: pod.spec?.nodeName ?? "not scheduled" }) : null,
          element("td", {}, isReady(pod) ? badge("Ready", "ok") : badge(notReadyReason(pod), "error")),
          element("td", { textContent: String(restartsOf(pod)) }),
        ),
      ),
    ),
  );
  if (pods.length <= MAX_ROWS) return table;
  return element("div", {}, table, element("p", { className: "muted", textContent: `And ${pods.length - MAX_ROWS} more.` }));
}

function componentView(sextant: Sextant, component: Component): HTMLElement {
  const tone = component.ready === component.pods.length ? "ok" : component.ready === 0 ? "error" : "warning";
  return element(
    "section",
    {},
    element("h3", {}, `${component.title} `, badge(`${component.ready} of ${component.pods.length} ready`, tone)),
    podTable(sextant, component.pods, true),
  );
}

export function daemonsView(sextant: Sextant, namespace: string, lists: Record<"cluster" | "operator" | "csi", LiveList>): HTMLElement {
  const components = componentsOf(
    namespace,
    lists.cluster.items as Pod[],
    lists.operator.items as Pod[],
    lists.csi.items as Pod[],
  );
  const errors = Object.values(lists)
    .map((l) => l.error)
    .filter((e): e is string => e !== null);
  const parts: (HTMLElement | null)[] = errors.map((e) => element("p", { className: "error", textContent: e }));
  if (!components.groups.some((g) => g.id === "operator")) {
    parts.push(
      element("p", {
        className: "warning-text",
        textContent: "No Rook operator pod (app=rook-ceph-operator) was found in the namespaces this extension may read: without it, nothing reconciles the cluster and its status is not refreshed.",
      }),
    );
  }
  for (const group of components.groups) {
    if (group.id !== "osd") {
      parts.push(componentView(sextant, group));
      continue;
    }
    const tone = group.ready === group.pods.length ? "ok" : group.ready === 0 ? "error" : "warning";
    parts.push(
      element(
        "section",
        {},
        element("h3", {}, `${group.title} `, badge(`${group.ready} of ${group.pods.length} ready`, tone)),
        ...components.osdsByNode.map(({ node, pods }) =>
          element(
            "div",
            { className: "node-group" },
            element("h4", { textContent: `${node || "Not scheduled"} (${pods.filter(isReady).length} of ${pods.length} ready)` }),
            podTable(sextant, pods, false),
          ),
        ),
      ),
    );
  }
  if (components.groups.length === 0 && lists.cluster.ready) {
    parts.push(element("p", { className: "muted", textContent: `No pods of Rook were found in ${namespace}.` }));
  }
  return element("div", { className: "daemons" }, ...parts);
}

/** Starts the tab for the CephCluster in the context. */
export function startDaemons(sextant: Sextant, root: HTMLElement): () => void {
  const ref = sextant.context.selection[0];
  const namespace = ref?.namespace;
  if (!namespace) {
    root.replaceChildren(element("p", { className: "muted", textContent: "No CephCluster." }));
    return () => undefined;
  }
  root.replaceChildren(element("p", { className: "muted", textContent: "Loading…" }));
  let stopped = false;
  let stopMain: () => void = () => undefined;
  let stopCsi: () => void = () => undefined;
  let csiNamespaces = "";
  const lists: Record<"cluster" | "operator" | "csi", LiveList> = {
    cluster: { items: [], ready: false, served: true, error: null },
    operator: { items: [], ready: false, served: true, error: null },
    csi: { items: [], ready: true, served: true, error: null },
  };
  const render = () => {
    if (!stopped && lists.cluster.ready) root.replaceChildren(daemonsView(sextant, namespace, lists));
  };

  void servedKinds(sextant)
    .then((served) => {
      if (stopped) return;
      // The cluster's namespace holds the daemons (and often the operator and CSI); the operator may run elsewhere.
      stopMain = watchLists(
        sextant,
        served,
        { cluster: { kind: POD, namespaces: [namespace] }, operator: { kind: POD, labelSelector: OPERATOR_SELECTOR } },
        (main) => {
          lists.cluster = main.cluster;
          lists.operator = main.operator;
          const others = [...new Set(main.operator.items.map((p) => p.metadata.namespace ?? ""))]
            .filter((ns) => ns && ns !== namespace)
            .sort();
          if (others.join(",") !== csiNamespaces) {
            csiNamespaces = others.join(",");
            stopCsi();
            lists.csi = { items: [], ready: true, served: true, error: null };
            if (others.length) {
              stopCsi = watchLists(sextant, served, { csi: { kind: POD, namespaces: others } }, (csi) => {
                lists.csi = csi.csi;
                render();
              });
            }
          }
          render();
        },
      );
      if (!served.has(kindKey(POD))) root.replaceChildren(element("p", { className: "error", textContent: "The cluster serves no Pods." }));
    })
    .catch((err: unknown) => root.replaceChildren(errorBox(err)));

  return () => {
    stopped = true;
    stopMain();
    stopCsi();
  };
}
