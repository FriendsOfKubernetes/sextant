// The "Widgets" page in the extension's own sidebar section ("Demo widgets"): every Widget of the namespaces Sextant's
// filter selects, live. The section's counter is Sextant's own (`contributes.sectionBadges`, sextantApi 3): the widgets
// the problem rule finds, counted by Sextant — this page does not count anything itself.
import { trackObjects, type Sextant, type Watch } from "@sextant/extension-sdk";
import { element, WIDGET, type Widget } from "./widget";

/** Draws the page into `root`; returns the function that stops it. */
export function startList(sextant: Sextant, root: HTMLElement): () => void {
  const status = element("p", { className: "muted" });
  const body = element("tbody");
  const table = element(
    "table",
    {},
    element(
      "thead",
      {},
      element("tr", {}, element("th", { textContent: "Name" }), element("th", { textContent: "Namespace" }), element("th", { textContent: "Size" }), element("th", { textContent: "Replicas" })),
    ),
    body,
  );
  root.replaceChildren(element("h1", { textContent: "Widgets" }), status, table);

  const render = (widgets: Widget[]) => {
    status.textContent = widgets.length === 1 ? "1 widget" : `${widgets.length} widgets`;
    body.replaceChildren(
      ...widgets.map((widget) => {
        const name = element("button", { className: "link", textContent: widget.metadata.name });
        name.addEventListener("click", () => {
          void sextant.ui.openDetails({ kind: WIDGET, namespace: widget.metadata.namespace ?? null, name: widget.metadata.name });
        });
        const replicas = widget.spec?.replicas ?? 0;
        return element(
          "tr",
          {},
          element("td", {}, name),
          element("td", { textContent: widget.metadata.namespace ?? "" }),
          element("td", { textContent: widget.spec?.size ?? "—" }),
          element("td", { className: replicas < 1 ? "bad" : "", textContent: String(replicas) }),
        );
      }),
    );
  };

  let watch: Watch | null = null;
  const follow = () => {
    void watch?.unwatch();
    status.textContent = "Loading…";
    const namespaces = sextant.context.namespaces;
    watch = sextant.resources.watch(namespaces === null ? { kind: WIDGET } : { kind: WIDGET, namespaces }, {
      onUpdate: trackObjects<Widget>(render, (update) => {
        if (update.type === "error" || update.type === "forbidden") status.textContent = "Widgets cannot be read here.";
      }),
    });
  };
  follow();
  let shown = JSON.stringify(sextant.context.namespaces);
  const stopContext = sextant.onContextChange((context) => {
    const now = JSON.stringify(context.namespaces);
    if (now === shown) return;
    shown = now;
    follow();
  });
  return () => {
    stopContext();
    void watch?.unwatch();
  };
}
