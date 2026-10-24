// The one clipboard path of "Copy namespace/name" (#229) and the header's copy buttons (#274): `navigator.clipboard`,
// like every other copy in the window, then a short confirmation at the bottom of the window (`toast.ts`).
import type { ObjectRef } from "../../api";
import { i18n } from "../../i18n";
import { namesText, shownName } from "./model";
import { showToast } from "./toast";

/** Puts the names of `refs` on the clipboard and confirms it (or says it failed). */
export async function copyNames(refs: readonly ObjectRef[]): Promise<void> {
  if (refs.length === 0) return;
  const text = namesText(refs);
  if (refs.length === 1) {
    await copyText(text);
    return;
  }
  if (await writeClipboard(text)) showToast(i18n.t("copyname:copiedMany", { count: refs.length }));
}

/** Puts `text` (a name, a namespace) on the clipboard and confirms it as "Copied <text>" (or says it failed). */
export async function copyText(text: string): Promise<void> {
  if (await writeClipboard(text)) showToast(i18n.t("copyname:copied", { name: shownName(text) }));
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error("the clipboard is not available");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    showToast(i18n.t("copyname:failed"), "error");
    return false;
  }
}
