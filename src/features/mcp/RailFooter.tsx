// The bottom of the cluster rail (slot "railFooter"): the Settings button, then the agent activity button (visible
// while the MCP server is on, with a dot for ten seconds after each call of an agent), and the window-wide dialogs of
// this feature: the confirmation of what an agent asks to do and the activity log.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { events, useSettings } from "../../api";
import { Icon } from "../../components";
import { SettingsButton } from "../settings";
import { ActivityDialog } from "./ActivityDialog";
import { ConfirmHost } from "./ConfirmHost";
import "./mcp.css";
import { useMcpUi } from "./store";

/** How long the dot stays after a call. */
export const ACTIVITY_DOT_MS = 10_000;

export function McpRailFooter() {
  const open = useMcpUi((s) => s.activityOpen);
  const close = useMcpUi((s) => s.closeActivity);
  return (
    <>
      <SettingsButton />
      <ActivityButton />
      <ConfirmHost />
      <ActivityDialog open={open} onClose={close} />
    </>
  );
}

function ActivityButton() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const enabled = settings?.mcp.enabled ?? false;
  const openActivity = useMcpUi((s) => s.openActivity);
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const unsubscribe = events.onMcpAudit(() => {
      if (!live) return;
      setActive(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setActive(false), ACTIVITY_DOT_MS);
    });
    return () => {
      live = false;
      clearTimeout(timer.current);
      setActive(false);
      void unsubscribe.then((off) => off(), () => undefined);
    };
  }, [enabled]);

  if (!enabled) return null;
  const label = t(active ? "mcp:activity.openActive" : "mcp:activity.open");
  return (
    <button
      type="button"
      className="icon-btn mcp-rail-button"
      aria-label={label}
      title={label}
      data-active={active || undefined}
      onClick={openActivity}
    >
      <Icon name="agent" />
      {active && <span className="mcp-rail-button__dot" aria-hidden="true" />}
    </button>
  );
}
