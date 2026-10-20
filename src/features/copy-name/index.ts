// "Copy namespace/name" (#229) on every kind: the table's row menu, the details panel's action bar, several selected
// rows (one name per line) and Ctrl+C / ⌘C on a focused table row (ResourceTable). A namespaced object is copied as
// `namespace/name` ("Copy namespace/name"), a cluster-scoped one as `name` ("Copy name"). The text goes to the
// clipboard through `navigator.clipboard`, like every other copy in the window, and a short confirmation is shown at
// the bottom of the window. Agents and extensions get nothing new.
import type { ObjectRef } from "../../api";
import { i18n } from "../../i18n";
import { registerSlot } from "../../layout/slots";
import { extendActionsForAll } from "../../resources/registry";
import { registerAction } from "../actions/registry";
import { CopyToast } from "./CopyToast";
import { namesText, shownName } from "./model";
import { showToast } from "./toast";
import "./copyName.css";

/** Puts the names of `refs` on the clipboard and confirms it (or says it failed). */
export async function copyNames(refs: readonly ObjectRef[]): Promise<void> {
  if (refs.length === 0) return;
  const text = namesText(refs);
  try {
    if (!navigator.clipboard) throw new Error("the clipboard is not available");
    await navigator.clipboard.writeText(text);
  } catch {
    showToast(i18n.t("copyname:failed"), "error");
    return;
  }
  showToast(
    refs.length === 1
      ? i18n.t("copyname:copied", { name: shownName(text) })
      : i18n.t("copyname:copiedMany", { count: refs.length }),
  );
}

const named = (obj: { metadata?: { name?: string } }) => Boolean(obj.metadata?.name);

registerAction("copyNamespacedName", {
  labelKey: "copyname:action",
  icon: "copy",
  multiple: true,
  appliesTo: (obj) => named(obj) && Boolean(obj.metadata?.namespace),
  run: ({ refs }) => copyNames(refs),
});
registerAction("copyName", {
  labelKey: "copyname:actionClusterScoped",
  icon: "copy",
  multiple: true,
  appliesTo: (obj) => named(obj) && !obj.metadata?.namespace,
  run: ({ refs }) => copyNames(refs),
});
extendActionsForAll(["copyNamespacedName", "copyName"]);

// After the other hosts of the rail footer (views 1001, kubeconfig credentials 1001): draws only the live region.
registerSlot("railFooter", CopyToast, 1002);

export { nameOf, namesText } from "./model";
