import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DOCK_MAX_HEIGHT,
  DOCK_MIN_HEIGHT,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useAppStore,
  useClusterView,
} from "../app/store";
import { EmptyState, Icon } from "../components";
import { ExtensionsHost } from "../extensions/ExtensionsHost";
import { AboutHost } from "../features/about/AboutHost";
// The file, not the feature's index: the shell mounts the dialog, the feature registers the rest.
import { ConsentNotice } from "../features/extensions/ConsentNotice";
import { InstallHost } from "../features/gitops-install/InstallHost";
import { ConfirmHost } from "../features/mcp/ConfirmHost";
import { PaletteHost } from "../features/palette/PaletteHost";
import { ClusterRail } from "./ClusterRail";
import { DetailsPanel } from "./details/DetailsPanel";
import { Dock } from "./dock/Dock";
import { MainView } from "./main/MainView";
import { Sidebar } from "./sidebar/Sidebar";
import { getSlot, useSlotsVersion } from "./slots";
import { Splitter } from "./Splitter";
import { useNarrowLayout } from "./useNarrowLayout";
import "./layout.css";

/**
 * The window in the Lens layout: cluster rail | sidebar | main view (+ details panel sliding in from the right)
 * with the dock below. The zones know nothing about resource kinds.
 *
 * In a narrow window (up to 768 px) the rail and the sidebar move into a menu opened from a top bar; the details
 * panel and the dock take the full width.
 *
 * Window-wide, mounted once: the confirmation dialog for what an AI agent or an extension asks to do (`ConfirmHost`),
 * the notice that an extension is paused for new permissions with its review window (`ConsentNotice`), the extension
 * host, which keeps extension contributions registered (`ExtensionsHost`), the About dialog (`AboutHost`, opened
 * by the tray menu and by Settings) and the Flux / Argo CD install dialog (`InstallHost`, opened from the cluster
 * menu and the cluster settings; outside the rail, so switching between the narrow and the wide layout never
 * unmounts a running install) and the command palette with its Ctrl+K / Cmd+K shortcut (`PaletteHost`).
 */
export function AppShell() {
  const { t } = useTranslation();
  const narrow = useNarrowLayout();
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const details = useAppStore((s) => s.details);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const dockOpen = useAppStore((s) => s.dock.open);
  const dockHeight = useAppStore((s) => s.dock.height);
  const { setSidebarWidth, setDockHeight } = useAppStore.getState();
  useSlotsVersion();
  const Welcome = getSlot("welcome");
  const homeView = useAppStore((s) => s.homeView);
  const Home = getSlot("home");

  const sidebar = activeClusterId && (
    <nav
      className="sidebar"
      aria-label={t("common:layout.sidebar")}
      style={narrow ? undefined : { width: sidebarWidth }}
    >
      <Sidebar clusterId={activeClusterId} />
    </nav>
  );

  return (
    <div className={narrow ? "app-shell app-shell--narrow" : "app-shell"}>
      {narrow ? (
        <NarrowMenu clusterId={activeClusterId}>
          <ClusterRail />
          {sidebar}
        </NarrowMenu>
      ) : (
        <>
          <ClusterRail />
          {activeClusterId && (
            <>
              {sidebar}
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
        </>
      )}
      <div className="workspace">
        <div className="workspace__top">
          <main className="main" aria-label={t("common:layout.main")}>
            {activeClusterId ? (
              <MainView clusterId={activeClusterId} />
            ) : homeView && Home ? (
              <Home />
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
      <AboutHost />
      <InstallHost />
      <ConfirmHost />
      <ConsentNotice />
      <ExtensionsHost />
      <PaletteHost />
    </div>
  );
}

/**
 * Top bar with a menu button and the drawer holding the rail and the sidebar. The drawer stays mounted while closed
 * (hidden by CSS), so dialogs that live in the rail keep working; it closes when a cluster or a section is chosen,
 * on Escape and on a click outside.
 */
function NarrowMenu({ clusterId, children }: { clusterId: string | null; children: React.ReactNode }) {
  const { t } = useTranslation();
  const drawerId = useId();
  const [open, setOpen] = useState(false);
  const { view } = useClusterView(clusterId);

  useEffect(() => setOpen(false), [clusterId, view]);
  const homeView = useAppStore((s) => s.homeView);
  useEffect(() => setOpen(false), [homeView]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <header className="topbar">
        <button
          type="button"
          className="icon-btn topbar__menu"
          aria-label={t(open ? "settings:menu.close" : "settings:menu.open")}
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="menu" />
        </button>
        <span className="topbar__title">{t("common:app.name")}</span>
      </header>
      {open && <div className="drawer-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />}
      <div
        id={drawerId}
        className={open ? "drawer drawer--open" : "drawer"}
        data-open={open}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label={t("settings:menu.title")}
      >
        {children}
      </div>
    </>
  );
}
