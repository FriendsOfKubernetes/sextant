import { useTranslation } from "react-i18next";
import {
  DOCK_MAX_HEIGHT,
  DOCK_MIN_HEIGHT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useAppStore,
} from "../app/store";
import { EmptyState } from "../components";
import { ClusterRail } from "./ClusterRail";
import { DetailsPanel } from "./details/DetailsPanel";
import { Dock } from "./dock/Dock";
import { MainView } from "./main/MainView";
import { Sidebar } from "./sidebar/Sidebar";
import { getSlot } from "./slots";
import { Splitter } from "./Splitter";
import "./layout.css";

/**
 * The window in the Lens layout: cluster rail | sidebar | main view (+ details panel sliding in from the right)
 * with the dock below. The zones know nothing about resource kinds.
 */
export function AppShell() {
  const { t } = useTranslation();
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const details = useAppStore((s) => s.details);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const dockOpen = useAppStore((s) => s.dock.open);
  const dockHeight = useAppStore((s) => s.dock.height);
  const { setSidebarWidth, setDockHeight } = useAppStore.getState();
  const Welcome = getSlot("welcome");

  return (
    <div className="app-shell">
      <ClusterRail />
      {activeClusterId && (
        <>
          <nav className="sidebar" aria-label={t("common:layout.sidebar")} style={{ width: sidebarWidth }}>
            <Sidebar clusterId={activeClusterId} />
          </nav>
          <Splitter
            orientation="vertical"
            label={t("common:layout.resizeSidebar")}
            value={sidebarWidth}
            min={SIDEBAR_MIN_WIDTH}
            max={SIDEBAR_MAX_WIDTH}
            direction={1}
            onResize={setSidebarWidth}
          />
        </>
      )}
      <div className="workspace">
        <div className="workspace__top">
          <main className="main" aria-label={t("common:layout.main")}>
            {activeClusterId ? (
              <MainView clusterId={activeClusterId} />
            ) : Welcome ? (
              <Welcome />
            ) : (
              <EmptyState title={t("common:welcome.title")} text={t("common:welcome.text")} />
            )}
          </main>
          {details && activeClusterId && (
            <DetailsPanel key={JSON.stringify(details)} clusterId={activeClusterId} objectRef={details} />
          )}
        </div>
        {dockOpen && (
          <Splitter
            orientation="horizontal"
            label={t("common:layout.resizeDock")}
            value={dockHeight}
            min={DOCK_MIN_HEIGHT}
            max={DOCK_MAX_HEIGHT}
            direction={-1}
            onResize={setDockHeight}
          />
        )}
        <Dock />
      </div>
    </div>
  );
}
