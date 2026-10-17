// Desktop notifications about new problems in connected clusters (#135), also while the window is hidden in the tray.
// The rules are the problems screen's (features/problems); `NotificationsHost` watches the enabled categories of the
// connected, unmuted clusters, `engine.ts` decides what to tell (quiet start, one per state change, grouping, rate
// limit, mute), the OS shows it (Tauri notification plugin, `api.notifications`). Can be turned off: Settings →
// General → Notifications (global switch, per category, per cluster), "Mute for 1 hour" on a notification and on the
// problems screen, which also lists the last notifications (`NotificationHistory`).
import { registerSlot } from "../../layout/slots";
import "./notifications.css";
import { NotificationsHost } from "./NotificationsHost";

/** After the Settings button and the agent activity button: it draws nothing. */
registerSlot("railFooter", NotificationsHost, 1000);

export { NotificationHistory } from "./NotificationHistory";
export { NotificationsPanel } from "./NotificationsPanel";
export { notifier, openTarget } from "./notifier";
