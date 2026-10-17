// Desktop notifications (the Tauri notification plugin behind the transport, `transport.ts`; `mockBackend` swaps it
// in tests): show one, register the buttons a notification may carry, and hear what the user did with one (a click on
// the notification itself is `tap`). Nothing leaves the machine: the OS notification service shows them.
import { toApiError } from "./errors";
import { currentTransport, type Unsubscribe } from "./transport";

export interface DesktopNotification {
  /** 32-bit integer identifier. */
  id: number;
  title: string;
  body: string;
  /** A registered action type: its actions become the notification's buttons (where the platform has them). */
  actionTypeId?: string;
  /** Data handed back with an action on the notification (where to go on a click). */
  extra?: Record<string, unknown>;
}

export interface NotificationActionType {
  id: string;
  actions: { id: string; title: string }[];
}

/** What the user did with a notification: `tap` (a click on it) or the id of one of its actions. */
export interface NotificationAction {
  actionId: string;
  /** The `extra` of the notification, when the platform reports it. */
  extra: Record<string, unknown> | null;
}

/** Mock command names of the notification plugin (what `mockBackend` records) and the mock event of an action. */
export const NOTIFICATION_COMMANDS = {
  notify: "plugin:notification|notify",
  registerActionTypes: "plugin:notification|register_action_types",
  /** The mock event a test emits for an action on a notification (`NotificationAction`). */
  actionEvent: "plugin:notification:actionPerformed",
} as const;

async function wrap<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toApiError(err);
  }
}

export const notifications = {
  /** Shows a notification through the OS notification service. */
  show: (notification: DesktopNotification) => wrap(() => currentTransport().notify(notification)),
  /** Registers the buttons notifications may reference by `actionTypeId`; again replaces them. */
  registerActionTypes: (types: NotificationActionType[]) =>
    wrap(() => currentTransport().registerNotificationActions(types)),
  /** Hears every action on Sextant's notifications; resolves to the unsubscribe function. */
  onAction: (handler: (action: NotificationAction) => void): Promise<Unsubscribe> =>
    currentTransport().onNotificationAction(handler),
};
