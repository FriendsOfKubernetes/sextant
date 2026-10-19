import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../app/store";
import { EmptyState, Icon, renderIcon } from "../../components";
import { getDockActions, getDockTabComponent, useDockVersion, type DockActionDef } from "./registry";

/**
 * Bottom dock: a header with tabs, registered actions and an open/close toggle; the body shows the active tab.
 * Tabs stay mounted while hidden (and while the dock is closed) so their sessions keep running.
 */
export function Dock() {
  const { t } = useTranslation();
  const dock = useAppStore((s) => s.dock);
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const { setActiveDockTab, closeDockTab, toggleDock } = useAppStore.getState();
  useDockVersion();
  const labelOf = (action: DockActionDef) => action.label ?? (action.labelKey ? t(action.labelKey) : action.id);
  const ctx = { activeClusterId };
  const actions = getDockActions().filter((a) => a.available?.(ctx) ?? true);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const sectionRef = useRef<HTMLElement>(null);
  const trigger = useDockFocus(sectionRef, dock.activeTabId, dock.open, tabButtons);

  // The WAI-ARIA tabs pattern: ←/→ (wrapping), Home/End select and focus a tab; Delete closes it; Escape returns
  // focus to where it was before the tab opened.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const tabs = dock.tabs;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else if (e.key === "Delete") {
      e.preventDefault();
      const neighbour = tabs[index + 1] ?? tabs[index - 1];
      closeDockTab(tabs[index]!.id);
      if (neighbour) requestAnimationFrame(() => tabButtons.current.get(neighbour.id)?.focus());
      else trigger.restore();
      return;
    } else if (e.key === "Escape") {
      e.preventDefault();
      trigger.restore();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    setActiveDockTab(id);
    tabButtons.current.get(id)?.focus();
  };

  return (
    <section
      ref={sectionRef}
      className={dock.open ? "dock dock--open" : "dock"}
      aria-label={t("common:layout.dock")}
      style={dock.open ? { height: dock.height } : undefined}
    >
      <div className="dock__header">
        {/* The tab list holds only the tabs (ARIA). It spans a grid of tab/close column pairs and lays its tabs on the
            odd columns (subgrid); the close buttons, its siblings, take the even ones, so each sits beside its tab. Without
            subgrid (older engines) the tabs get one width and each close button is placed by `--dock-tab-index`
            (layout.css). */}
        <div
          className="dock__tabs"
          style={dock.tabs.length > 0 ? { gridTemplateColumns: `repeat(${dock.tabs.length}, max-content max-content)` } : undefined}
        >
          <div className="dock__tablist" role="tablist" aria-label={t("a11y:dock.tabs")}>
            {dock.tabs.map((tab, index) => {
              const active = tab.id === dock.activeTabId;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    if (el) tabButtons.current.set(tab.id, el);
                    else tabButtons.current.delete(tab.id);
                  }}
                  type="button"
                  role="tab"
                  id={`dock-tab-${tab.id}`}
                  aria-selected={active}
                  aria-controls={`dock-panel-${tab.id}`}
                  aria-keyshortcuts="Delete"
                  tabIndex={active ? 0 : -1}
                  className={active ? "dock__tab-title dock__tab-title--active" : "dock__tab-title"}
                  style={{ gridColumn: index * 2 + 1, "--dock-tab-index": index } as CSSProperties}
                  onClick={() => setActiveDockTab(tab.id)}
                  onKeyDown={(e) => onTabKey(e, index)}
                >
                  {tab.title}
                </button>
              );
            })}
          </div>
          {dock.tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              className={
                tab.id === dock.activeTabId
                  ? "icon-btn icon-btn--small dock__tab-close dock__tab-close--active"
                  : "icon-btn icon-btn--small dock__tab-close"
              }
              // Only the active tab's close button is a tab stop (right after its tab); Delete closes any tab.
              tabIndex={tab.id === dock.activeTabId ? 0 : -1}
              style={{ gridColumn: index * 2 + 2, "--dock-tab-index": index } as CSSProperties}
              aria-label={t("common:actions.closeTab", { title: tab.title })}
              onClick={() => closeDockTab(tab.id)}
            >
              <Icon name="close" />
            </button>
          ))}
        </div>
        <div className="dock__actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="dock__action"
              title={labelOf(action)}
              aria-label={labelOf(action)}
              onClick={() => action.run(ctx)}
            >
              {action.icon === undefined ? labelOf(action) : renderIcon(action.icon)}
            </button>
          ))}
          <button
            type="button"
            className="icon-btn"
            aria-expanded={dock.open}
            aria-label={t(dock.open ? "common:actions.closeDock" : "common:actions.openDock")}
            onClick={toggleDock}
          >
            <Icon name={dock.open ? "chevronDown" : "chevronUp"} />
          </button>
        </div>
      </div>
      <div className="dock__body" hidden={!dock.open}>
        {dock.tabs.length === 0 && <EmptyState title={t("common:dock.empty")} />}
        {dock.tabs.map((tab) => {
          const Component = getDockTabComponent(tab.type);
          const active = tab.id === dock.activeTabId;
          return (
            <div
              key={tab.id}
              role="tabpanel"
              id={`dock-panel-${tab.id}`}
              aria-labelledby={`dock-tab-${tab.id}`}
              className="dock__panel"
              hidden={!active}
            >
              {Component && <Component tab={tab} active={active && dock.open} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Focus around the dock (#158). The element focused last outside the dock is the trigger of what opens in it. A tab
 * that becomes active takes the focus on its tab button, unless its content took it already (a terminal focuses
 * itself). `restore()` gives the focus back to the trigger (or the main view).
 */
function useDockFocus(
  section: RefObject<HTMLElement | null>,
  activeTabId: string | null,
  open: boolean,
  tabButtons: RefObject<Map<string, HTMLButtonElement>>,
) {
  const lastOutside = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const previous = useRef(activeTabId);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && !section.current?.contains(target)) lastOutside.current = target;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [section]);

  useEffect(() => {
    if (activeTabId === previous.current) return;
    previous.current = activeTabId;
    if (!activeTabId || !open) return;
    trigger.current = lastOutside.current;
    // Content that took the focus itself (a terminal) keeps it; otherwise the new tab gets it.
    const inBody = section.current?.querySelector(".dock__body")?.contains(document.activeElement) ?? false;
    if (!inBody) tabButtons.current.get(activeTabId)?.focus({ preventScroll: true });
  }, [activeTabId, open, section, tabButtons]);

  return {
    restore() {
      const target = trigger.current?.isConnected ? trigger.current : null;
      const fallback = document.querySelector<HTMLElement>("main [tabindex='0'], main button, main input");
      (target ?? fallback)?.focus({ preventScroll: true });
    },
  };
}
