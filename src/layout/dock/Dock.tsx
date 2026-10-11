import { useTranslation } from "react-i18next";
import { useAppStore } from "../../app/store";
import { EmptyState } from "../../components";
import { getDockActions, getDockTabComponent } from "./registry";

/**
 * Bottom dock: a header with tabs, registered actions and an open/close toggle; the body shows the active tab.
 * Tabs stay mounted while hidden (and while the dock is closed) so their sessions keep running.
 */
export function Dock() {
  const { t } = useTranslation();
  const dock = useAppStore((s) => s.dock);
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const { setActiveDockTab, closeDockTab, toggleDock } = useAppStore.getState();
  const ctx = { activeClusterId };
  const actions = getDockActions().filter((a) => a.available?.(ctx) ?? true);

  return (
    <section
      className={dock.open ? "dock dock--open" : "dock"}
      aria-label={t("common:layout.dock")}
      style={dock.open ? { height: dock.height } : undefined}
    >
      <div className="dock__header">
        <div className="dock__tabs" role="tablist">
          {dock.tabs.map((tab) => (
            <div key={tab.id} className={tab.id === dock.activeTabId ? "dock__tab dock__tab--active" : "dock__tab"}>
              <button
                type="button"
                role="tab"
                id={`dock-tab-${tab.id}`}
                aria-selected={tab.id === dock.activeTabId}
                aria-controls={`dock-panel-${tab.id}`}
                className="dock__tab-title"
                onClick={() => setActiveDockTab(tab.id)}
              >
                {tab.title}
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--small"
                aria-label={t("common:actions.closeTab", { title: tab.title })}
                onClick={() => closeDockTab(tab.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="dock__actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="dock__action"
              title={t(action.labelKey)}
              aria-label={t(action.labelKey)}
              onClick={() => action.run(ctx)}
            >
              {action.icon ?? t(action.labelKey)}
            </button>
          ))}
          <button
            type="button"
            className="icon-btn"
            aria-expanded={dock.open}
            aria-label={t(dock.open ? "common:actions.closeDock" : "common:actions.openDock")}
            onClick={toggleDock}
          >
            {dock.open ? "▾" : "▴"}
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
