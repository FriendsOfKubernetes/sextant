// The object a details frame shows: read once, and again whenever Sextant says it changed (its resourceVersion).
import type { KubeObject, ObjectRef, Sextant } from "@sextant/extension-sdk";
import { element, errorBox } from "./dom";
import { t } from "./i18n";

/**
 * Calls `render(obj, ref)` with the shown object, now and after each change; a failed read shows the error. Returns
 * the function that stops following it.
 */
export function followShown(sextant: Sextant, root: HTMLElement, render: (obj: KubeObject, ref: ObjectRef) => void): () => void {
  let stopped = false;
  let version: string | null | undefined;
  let request = 0;
  const load = async () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      root.replaceChildren(element("p", { className: "muted", textContent: t("common.nothingToShow") }));
      return;
    }
    const id = ++request;
    try {
      const obj = await sextant.resources.get({ ref });
      if (!stopped && id === request) render(obj, ref);
    } catch (err) {
      if (!stopped && id === request) root.replaceChildren(errorBox(err));
    }
  };
  root.replaceChildren(element("p", { className: "muted", textContent: t("common.loading") }));
  version = sextant.context.resourceVersion;
  void load();
  const off = sextant.onContextChange((context) => {
    if (context.resourceVersion === version) return;
    version = context.resourceVersion;
    void load();
  });
  return () => {
    stopped = true;
    off();
  };
}
