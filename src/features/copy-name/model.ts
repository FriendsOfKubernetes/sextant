// "Copy namespace/name" (#229): the text put on the clipboard — one line per object, `namespace/name` for a
// namespaced object and `name` alone for a cluster-scoped one. Only this format (the user's choice).
import type { ObjectRef } from "../../api";

/** `namespace/name`, or `name` for a cluster-scoped object. */
export function nameOf(ref: Pick<ObjectRef, "namespace" | "name">): string {
  return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

/** The clipboard text for `refs`: one name per line, in the given order (no trailing newline). */
export function namesText(refs: ReadonlyArray<Pick<ObjectRef, "namespace" | "name">>): string {
  return refs.map(nameOf).join("\n");
}

/** Longest name shown in the confirmation; the clipboard always gets the whole text. */
export const MAX_SHOWN_CHARS = 120;

/** `text` cut to `MAX_SHOWN_CHARS` code points with an ellipsis. */
export function shownName(text: string): string {
  const chars = [...text];
  return chars.length <= MAX_SHOWN_CHARS ? text : `${chars.slice(0, MAX_SHOWN_CHARS - 1).join("")}…`;
}
