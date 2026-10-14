// Short notices extensions show with `ui.notify(text)`: a few at a time, each for a few seconds, with the name of the
// extension that sent it. The text is the extension's, shown as plain text.
import { useSyncExternalStore } from "react";
import { MAX_NOTICE_CHARS } from "./protocol";

export interface Notice {
  id: number;
  /** The extension's name. */
  extension: string;
  text: string;
}

/** How long a notice stays. */
export const NOTICE_MS = 8_000;
/** Notices shown at once; older ones go. */
const MAX_NOTICES = 4;

let notices: readonly Notice[] = [];
let counter = 0;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function changed(next: readonly Notice[]): void {
  notices = next;
  for (const listener of [...listeners]) listener();
}

export function pushNotice(extension: string, text: string): void {
  const id = ++counter;
  const clipped = text.length > MAX_NOTICE_CHARS ? `${text.slice(0, MAX_NOTICE_CHARS - 1)}…` : text;
  const next = [...notices, { id, extension, text: clipped }];
  for (const gone of next.slice(0, Math.max(0, next.length - MAX_NOTICES))) clearTimer(gone.id);
  changed(next.slice(-MAX_NOTICES));
  timers.set(
    id,
    setTimeout(() => dismissNotice(id), NOTICE_MS),
  );
}

export function dismissNotice(id: number): void {
  clearTimer(id);
  if (notices.some((n) => n.id === id)) changed(notices.filter((n) => n.id !== id));
}

function clearTimer(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

export function useNotices(): readonly Notice[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => notices,
    () => notices,
  );
}

/** Forgets every notice (tests). */
export function resetNotices(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  changed([]);
}
