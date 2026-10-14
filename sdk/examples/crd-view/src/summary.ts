// The "Widget summary" section of a Widget's details: size, replicas (one square each) and generation, read again
// whenever Sextant says the object changed (`resourceVersion` of the context).
import type { Sextant } from "@sextant/extension-sdk";
import { element, selectedWidget, type Widget } from "./widget";

const MAX_SQUARES = 50;

export function startSummary(sextant: Sextant, root: HTMLElement): () => void {
  let shown: string | null | undefined;
  let reading = 0;

  const show = async () => {
    const ref = selectedWidget(sextant);
    if (!ref) {
      root.replaceChildren(element("p", { className: "muted", textContent: "No widget." }));
      return;
    }
    const attempt = ++reading;
    try {
      const widget = await sextant.resources.get<Widget>({ ref });
      if (attempt !== reading) return;
      const replicas = widget.spec?.replicas ?? 0;
      const squares = element("div", { className: "replicas" });
      for (let i = 0; i < Math.min(replicas, MAX_SQUARES); i++) squares.append(element("span"));
      root.replaceChildren(
        element(
          "dl",
          {},
          element("dt", { textContent: "Size" }),
          element("dd", { textContent: widget.spec?.size ?? "—" }),
          element("dt", { textContent: "Replicas" }),
          element("dd", {}, `${replicas} `, squares),
          element("dt", { textContent: "Generation" }),
          element("dd", { textContent: String(widget.metadata.generation ?? "—") }),
        ),
      );
    } catch (err) {
      if (attempt === reading) root.replaceChildren(element("p", { className: "error", textContent: (err as Error).message }));
    }
  };

  const follow = () => {
    const version = sextant.context.resourceVersion;
    if (version === shown) return;
    shown = version;
    void show();
  };
  follow();
  return sextant.onContextChange(follow);
}
