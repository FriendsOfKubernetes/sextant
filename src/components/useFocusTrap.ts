// Focus handling of modals (#158). Open modals form a stack; only the top one acts: Tab and Shift+Tab cycle inside
// it, Escape closes it (Dialog). A modal marked `alwaysOnTop` (the confirmation of an agent or an extension) stays the
// top while it is open, whatever opens after it. A modal that opens on top takes the focus: an element marked
// `data-autofocus`; in a destructive dialog (a danger button in the footer) or a confirmation, the first non-danger
// footer button ("Cancel"); else the first text field of the body (never a checkbox, which may make the action more
// dangerous); else the first footer button; else the first focusable element; else the dialog itself. When it closes,
// the focus goes to the modal now on top, or back to what had it before (through a closed popup to that popup's opener).
import { useEffect, useRef, type RefObject } from "react";

// The last two elements that got the focus, window-wide: an element that focuses itself while the modal mounts
// (`autoFocus`) is already the latest when the modal's effect runs, so the opener is the one before it.
let lastFocused: HTMLElement | null = null;
let previousFocused: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      if (!(e.target instanceof HTMLElement) || e.target === lastFocused) return;
      previousFocused = lastFocused;
      lastFocused = e.target;
    },
    true,
  );
}

/** Popups closed lately and what opened them: an opener inside a closed popup (a menu item) stands for that opener. */
const closedPopups: { popup: HTMLElement; opener: HTMLElement }[] = [];
const CLOSED_POPUPS_KEPT = 8;

/** Records that `popup` closed; `opener` is what had the focus before it (usePopup). */
export function popupClosed(popup: HTMLElement, opener: HTMLElement | null): void {
  if (!opener) return;
  closedPopups.push({ popup, opener });
  if (closedPopups.length > CLOSED_POPUPS_KEPT) closedPopups.shift();
}

/** `el`, or for an element removed with a closed popup, that popup's opener (and so on); `null` if none is left. */
export function resolveOpener(el: HTMLElement | null): HTMLElement | null {
  for (let hops = 0; el && hops <= CLOSED_POPUPS_KEPT; hops++) {
    if (el.isConnected) return el;
    const target: HTMLElement = el;
    el = [...closedPopups].reverse().find((p) => p.popup === target || p.popup.contains(target))?.opener ?? null;
  }
  return null;
}

/** What had the focus before `root` (a dialog, a popup) took it. */
export function openerOf(root: HTMLElement): HTMLElement | null {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active && active !== document.body && !root.contains(active)) return active;
  const candidate = lastFocused && root.contains(lastFocused) ? previousFocused : lastFocused;
  return candidate && !root.contains(candidate) ? candidate : null;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** The elements of `root` that Tab reaches, in order (hidden ones left out). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && !el.closest("[hidden], [inert]") && el.getAttribute("aria-hidden") !== "true",
  );
}

const DANGER = ".btn--danger";
const TEXT_FIELDS =
  ".dialog__body input:not([type='checkbox']):not([type='radio']), .dialog__body select, .dialog__body textarea";

function initialFocus(root: HTMLElement): HTMLElement {
  const marked = root.querySelector<HTMLElement>("[data-autofocus]");
  if (marked) return marked;
  const footer = root.querySelector<HTMLElement>(".dialog__footer");
  const buttons = footer ? focusableIn(footer) : [];
  const confirmation = root.getAttribute("role") === "alertdialog" || buttons.some((b) => b.matches(DANGER));
  const safe = buttons.find((b) => !b.matches(DANGER));
  if (confirmation && safe) return safe;
  const reachable = focusableIn(root);
  const field = [...root.querySelectorAll<HTMLElement>(TEXT_FIELDS)].find((el) => reachable.includes(el));
  return field ?? buttons[0] ?? reachable[0] ?? root;
}

interface Trap {
  root: HTMLElement;
  alwaysOnTop: boolean;
  order: number;
  /** The element inside that had the focus last, given back when this modal is on top again. */
  last: HTMLElement | null;
}

const traps: Trap[] = [];
let opened = 0;

function topTrap(): Trap | undefined {
  let top: Trap | undefined;
  for (const trap of traps) {
    if (!top || Number(trap.alwaysOnTop) > Number(top.alwaysOnTop)) top = trap;
    else if (trap.alwaysOnTop === top.alwaysOnTop && trap.order > top.order) top = trap;
  }
  return top;
}

/** Whether `root` is the modal on top (the one that takes Tab and Escape); true when no modal is open. */
export function isTopModal(root: HTMLElement | null): boolean {
  const top = topTrap();
  return !top || top.root === root;
}

/** Whether a modal that stays on top (a confirmation) is open: nothing else may take the focus meanwhile. */
export function hasPinnedModal(): boolean {
  return traps.some((t) => t.alwaysOnTop);
}

export interface FocusTrapOptions {
  /**
   * Names what is shown (a queue of confirmations shows one after another in a new element): a new key moves the
   * focus into the new element, and the focus still returns to the opener of the first one.
   */
  key?: string;
  /** The modal stays on top of every other while open (the confirmation of an agent or an extension). */
  alwaysOnTop?: boolean;
}

/** Keeps the focus inside `ref` while `active` and it is the top modal; see the file header. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, options: FocusTrapOptions = {}): void {
  const { key, alwaysOnTop = false } = options;
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) opener.current = null;
  }, [active]);
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    if (!opener.current?.isConnected || root.contains(opener.current)) opener.current = openerOf(root);
    const trap: Trap = { root, alwaysOnTop, order: ++opened, last: null };
    traps.push(trap);
    // A modal opened under a pinned one waits; an element that took the focus itself (`autoFocus`) keeps it.
    if (isTopModal(root) && !root.contains(document.activeElement)) initialFocus(root).focus({ preventScroll: true });

    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && root.contains(e.target)) trap.last = e.target;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented || !isTopModal(root)) return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      // Tab moves natively inside; only the ends wrap around (and a focus outside comes back in).
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      const outside = !root.contains(current);
      if (e.shiftKey && (current === first || current === root || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKey);
      traps.splice(traps.indexOf(trap), 1);
      const back = opener.current;
      // After what closed the modal has settled: what it opened (a new terminal pane, the next confirmation of a
      // queue) may take the focus itself; otherwise the modal now on top gets it, or the opener.
      setTimeout(() => {
        const now = document.activeElement;
        const lost = !now || now === document.body || !now.isConnected || root.contains(now);
        if (!lost) return;
        const top = topTrap();
        if (top) {
          const target = top.last?.isConnected && top.root.contains(top.last) ? top.last : initialFocus(top.root);
          target.focus({ preventScroll: true });
          return;
        }
        resolveOpener(back)?.focus({ preventScroll: true });
      }, 0);
    };
  }, [ref, active, key, alwaysOnTop]);
}
