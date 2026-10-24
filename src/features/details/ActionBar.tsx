// The details panel's action bar (#275): the registered actions (src/features/actions/registry.ts) that apply to one
// object, in the order of its kind's `ResourceDef.actions`. Main actions (`placement: "primary"`) are standard-size
// buttons with their icon and label, Delete last; everything else is an item of one "Actions" dropdown at the end of
// the bar, which is not drawn when it would be empty. Actions the header offers itself (copy, pin) are in neither.
// Nothing is rendered when no action fits.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import { Button, renderIcon, usePopup, usePopupPosition } from "../../components";
import { popupClosed } from "../../components/useFocusTrap";
import { useResourceDef } from "../../resources";
import {
  actionLabel,
  detailsActions,
  runAction,
  useActionsVersion,
  type ActionDef,
  type RegisteredAction,
} from "../actions/registry";

function variantOf(action: ActionDef): "danger" | "default" {
  return action.danger ? "danger" : "default";
}

export function ActionBar({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const def = useResourceDef(kind);
  useActionsVersion();
  const { primary, more } = detailsActions([obj], kind, def.actions);
  if (primary.length === 0 && more.length === 0) return null;
  const run = (action: RegisteredAction) => void runAction(action, clusterId, kind, [obj]);
  return (
    <div className="dt-actions" role="toolbar" aria-label={t("details:actions")}>
      {primary.map((action) => (
        <Button key={action.id} variant={variantOf(action)} icon={action.icon} onClick={() => run(action)}>
          {actionLabel(action, t)}
        </Button>
      ))}
      {more.length > 0 && <MoreActions actions={more} onRun={run} />}
    </div>
  );
}

/** The index the focus moves to on `key` in a menu of `count` items (↑ ↓ wrap, Home, End), `null` for another key. */
export function menuKeyTarget(key: string, from: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return (from + 1) % count;
    case "ArrowUp":
      return (from - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * The "Actions" dropdown: a menu button (`aria-haspopup`, `aria-expanded`) whose menu takes the focus on its first
 * item, moves it with the arrow keys, Home and End, and closes on Escape, a click outside or a chosen item, giving the
 * focus back to the button.
 */
function MoreActions({ actions, onRun }: { actions: RegisteredAction[]; onRun: (action: RegisteredAction) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopup(ref, () => setOpen(false), open);
  // Under the button, its right edge aligned; flipped or shifted to stay inside the window.
  usePopupPosition(menuRef, buttonRef, { open, side: "below", align: "end", gap: 4 });
  // `usePopup` watches the wrapper, which holds the button too (a click on it toggles, not closes), so it cannot take
  // the button for the opener: the focus goes back to the button here, and a dialog opened from an item returns to it.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const button = buttonRef.current;
    menu?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    return () => {
      if (menu && button) popupClosed(menu, button);
      const now = document.activeElement;
      if (!now || now === document.body || (menu?.contains(now) ?? false)) button?.focus({ preventScroll: true });
    };
  }, [open]);

  const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const from = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = menuKeyTarget(e.key, from, list.length);
    if (next === null) {
      // Tab leaves the menu: it closes, and the focus goes on from the button.
      if (e.key === "Tab") setOpen(false);
      return;
    }
    e.preventDefault();
    list[next]?.focus();
  };
  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };
  const choose = (action: RegisteredAction) => {
    setOpen(false);
    onRun(action);
  };

  return (
    <div className="dt-more" ref={ref}>
      <Button
        ref={buttonRef}
        icon="more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKey}
      >
        {t("details:moreActions")}
      </Button>
      {open && (
        <div ref={menuRef} className="rt-menu dt-more__menu" role="menu" aria-label={t("details:moreActions")} onKeyDown={onMenuKey}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`rt-menu__item${action.danger ? " rt-menu__item--danger" : ""}`}
              onClick={() => choose(action)}
            >
              <span className="rt-menu__icon" aria-hidden>
                {renderIcon(action.icon)}
              </span>
              {actionLabel(action, t)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
