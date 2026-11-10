// "GPU nodes" (the manifest's page `gpu-nodes` in the section `gpuOperator`), as the built-in page drew it: the nodes
// labelled `nvidia.com/gpu.present=true` (at most `MAX_GPU_NODES` used), with the GPU product and count GPU Feature
// Discovery labels, the `nvidia.com/gpu` and MIG resources' capacity and allocatable from the node status, and the MIG
// configuration with its state. The nodes are watched while the page shows, selected on the API server by the label,
// at most `MAX_GPU_NODES` kept by the core (a note when more match). Read-only.
import { trackObjects, ui, type KubeObject, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { element, remark } from "./dom";
import { t } from "./i18n";
import { link } from "./details";
import { GPU_RESOURCE, gpuNodeOf, LABEL_PRESENT, migStateTone, NODE } from "./model";

export const MAX_GPU_NODES = 500;
export const GPU_NODE_SELECTOR = `${LABEL_PRESENT}=true`;

interface Listed {
  items: KubeObject[];
  loading: boolean;
  unavailable: boolean;
  truncated: boolean;
}

export function pageView(sextant: Sextant, nodes: Listed): HTMLElement {
  const rows: UiContent[][] = nodes.items
    .map(gpuNodeOf)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => {
      const gpu = n.amounts.find((a) => a.resource === GPU_RESOURCE);
      const mig = n.amounts.filter((a) => a.resource !== GPU_RESOURCE);
      return [
        link(sextant, NODE, n.name, null),
        n.product ?? "",
        n.count ?? "",
        gpu ? t("page.amount", { allocatable: gpu.allocatable ?? "", capacity: gpu.capacity ?? "" }) : "",
        ui.chips(mig.map((a) => `${a.resource.slice("nvidia.com/".length)}: ${a.allocatable ?? ""}/${a.capacity ?? ""}`)),
        n.migConfig ?? "",
        n.migState ? ui.status(n.migState, migStateTone(n.migState)) : "",
      ];
    });
  const headers = ["node", "product", "count", "gpus", "mig", "migConfig", "migState"].map((h) => t(`page.columns.${h}`));
  const total = element("p", { className: "gpu-muted", textContent: t("page.total", { count: rows.length }) });
  total.setAttribute("role", "status");
  return element(
    "div",
    { className: "gpu-page" },
    element("h2", { className: "gpu-page__title", textContent: t("page.title") }),
    remark(t("page.hint")),
    nodes.loading && ui.loading(t("loading")),
    !nodes.loading && total,
    nodes.truncated && remark(t("page.truncated", { count: MAX_GPU_NODES })),
    nodes.unavailable && remark(t("page.unavailable")),
    rows.length > 0 && ui.table(headers, rows, { label: t("page.title"), id: "nodesPage", sextant, nowrap: [true, false, true, true, false, true, true] }),
  );
}

/** Starts the page: the GPU nodes of the context's cluster, watched while it shows. */
export function startPage(sextant: Sextant, root: HTMLElement): () => void {
  let nodes: Listed = { items: [], loading: true, unavailable: false, truncated: false };
  const render = () => root.replaceChildren(pageView(sextant, nodes));
  render();
  const watch = sextant.resources.watch(
    { kind: NODE, labelSelector: GPU_NODE_SELECTOR, maxObjects: MAX_GPU_NODES },
    {
      onUpdate: trackObjects(
        (items) => {
          nodes = { ...nodes, items, loading: false, unavailable: false };
          render();
        },
        (other) => {
          if (other.type !== "error" && other.type !== "forbidden") return;
          nodes = { ...nodes, loading: false, unavailable: true };
          render();
        },
      ),
      onError: () => {
        nodes = { ...nodes, loading: false, unavailable: true };
        render();
      },
      onCapped: (total) => {
        nodes = { ...nodes, truncated: total > MAX_GPU_NODES };
        render();
      },
    },
  );
  watch.started.catch(() => undefined);
  return () => void watch.unwatch().catch(() => undefined);
}
