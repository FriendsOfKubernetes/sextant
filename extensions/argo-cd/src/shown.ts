// The object a details frame shows: read once, and again whenever Sextant says it changed (its resourceVersion).
import { ui, type KubeObject, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
import { errorBox } from "./dom";
import { t } from "./i18n";

/**
 * A details section hides itself, title included, while it has nothing to show (`ui.setHidden`, ADR-0161), as the
 * built-in view drew nothing then. In a tab Sextant ignores it.
 */
export function setHidden(sextant: Sextant, hidden: boolean): void {
  if (hiddenNow.get(sextant) === hidden) return;
  hiddenNow.set(sextant, hidden);
  void sextant.ui.setHidden(hidden).catch(() => undefined);
}

/** What each client last asked, so an unchanged state is not sent again (a frame starts shown). */
const hiddenNow = new WeakMap<Sextant, boolean>();

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
      root.replaceChildren(ui.empty(t("common.nothingToShow")));
      return;
    }
    const id = ++request;
    try {
      const obj = await sextant.resources.get({ ref });
      if (!stopped && id === request) render(obj, ref);
    } catch (err) {
      if (!stopped && id === request) {
        setHidden(sextant, false);
        root.replaceChildren(errorBox(err));
      }
    }
  };
  root.replaceChildren(ui.loading(t("common.loading")));
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
