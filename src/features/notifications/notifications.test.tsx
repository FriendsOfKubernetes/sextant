import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, NOTIFICATION_COMMANDS, type AppSettings, type KubeObject, type WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import "../../resources";
import { resetClusterKinds } from "../../resources/useKinds";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import { emitDelta, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { POD, resolve } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { GROUP_WINDOW_MS } from "./engine";
import { notifier, resetNotifier } from "./notifier";
import { NotificationHistory } from "./NotificationHistory";
import { NotificationsHost } from "./NotificationsHost";
import { NotificationsPanel } from "./NotificationsPanel";
import { prefsOf } from "./prefs";
import { useSettings } from "../../api";

function crashing(name: string): KubeObject {
  return {
    metadata: { name, namespace: "shop", uid: `uid-${name}` },
    status: {
      phase: "Running",
      containerStatuses: [{ name: "app", restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff" } } }],
    },
  };
}

const cluster = (id: string) => ({
  id,
  context: `ctx-${id}`,
  clusterName: id,
  server: "https://example",
  user: "u",
  namespace: null,
  sourceId: "s",
});

let wb: WatchBackend;
let stored: AppSettings;

function start(notifications: Partial<AppSettings["notifications"]> = {}) {
  wb = watchBackend();
  const defaults = defaultAppSettings();
  stored = { ...defaults, notifications: { ...defaults.notifications, ...notifications } };
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
  wb.backend.on("cluster_kinds", () => []);
  const clusters = [cluster("c1"), cluster("c2"), cluster("c3")];
  const states = { c1: { state: "connected" }, c2: { state: "disconnected" }, c3: { state: "connected" } } as const;
  wb.backend.on("clusters_list", () => clusters);
  wb.backend.on("kubeconfig_sources", () => []);
  wb.backend.on("cluster_state", (args) => states[args.clusterId as keyof typeof states]);
  useClustersStore.setState({ loaded: true, clusters, states });
}

/** The clusters and kinds watched so far. */
function watched(): { cluster: string; kind: string }[] {
  return wb.backend.calls
    .filter((c) => c.cmd === "watch_start")
    .map((c) => ({ cluster: c.args.clusterId as string, kind: (c.args.spec as WatchSpec).kind.kind }));
}

const notified = () => wb.backend.calls.filter((c) => c.cmd === NOTIFICATION_COMMANDS.notify);

beforeEach(() => {
  resetAppStore();
  resetProblemSources();
  resetNotifier();
  resetClusterKinds();
  resetClustersStore();
});

afterEach(() => {
  vi.useRealTimers();
  resetProblemSources();
  resetNotifier();
  resetClustersStore();
  wb.backend.restore();
});

describe("background notifications", () => {
  it("watch the enabled categories of connected clusters only, never Warning events", async () => {
    start();
    render(<NotificationsHost />);
    await waitFor(() => expect(watched().some((w) => w.cluster === "c3" && w.kind === "Job")).toBe(true));
    expect(watched().every((w) => w.cluster === "c1" || w.cluster === "c3")).toBe(true);
    expect(watched().some((w) => w.kind === "Event")).toBe(false);
    expect(new Set(watched().filter((w) => w.cluster === "c1").map((w) => w.kind))).toEqual(
      new Set(["Node", "Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "PersistentVolumeClaim"]),
    );
  });

  it("watch nothing at all when turned off", async () => {
    start({ enabled: false });
    render(<NotificationsHost />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "settings_get")).toBe(true));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(watched()).toEqual([]);
  });

  it("leave out a muted cluster and a category turned off", async () => {
    start({ mutedClusters: ["c1"], disabledCategories: ["pods", "nodes"] });
    render(<NotificationsHost />);
    await waitFor(() => expect(watched().some((w) => w.cluster === "c3")).toBe(true));
    expect(watched().some((w) => w.cluster === "c1")).toBe(false);
    expect(watched().some((w) => w.kind === "Pod" || w.kind === "Node")).toBe(false);
  });

  it("say nothing about problems there at connect, then tell a new one through the OS", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    start({ disabledCategories: ["nodes", "workloads", "jobs", "volumes"] });
    render(<NotificationsHost />);
    const pods = await watchOf(wb, "Pod", () => true);
    // Both clusters list their pods; c1 already has a crash loop.
    for (const call of wb.backend.calls.filter((c) => c.cmd === "watch_start")) {
      const id = [...wb.specs.entries()].find(([, spec]) => spec === call.args.spec)?.[0];
      if (id) emitSnapshot(wb, id, id === pods ? [crashing("old")] : []);
    }
    await act(() => vi.advanceTimersByTimeAsync(GROUP_WINDOW_MS + 100));
    expect(notified()).toEqual([]);

    emitDelta(wb, pods, [crashing("new")]);
    await act(() => vi.advanceTimersByTimeAsync(GROUP_WINDOW_MS + 100));
    expect(notified()).toHaveLength(1);
    const options = notified()[0]!.args.options as { title: string; body: string; extra: Record<string, unknown> };
    expect(options.title).toMatch(/CrashLoopBackOff$/);
    expect(options.body).toContain("Pod shop/new");
    expect(notifier.history().map((h) => h.object.name)).toEqual(["new"]);
    expect(wb.backend.calls.some((c) => c.cmd === NOTIFICATION_COMMANDS.registerActionTypes)).toBe(true);
  });

  it("a click on a notification opens the object; its button mutes them for an hour", async () => {
    start();
    render(<NotificationsHost />);
    await waitFor(() => expect(wb.backend.listenerCount(NOTIFICATION_COMMANDS.actionEvent)).toBe(1));
    const object = { kind: POD, namespace: "shop", name: "web" };
    act(() => wb.backend.emit(NOTIFICATION_COMMANDS.actionEvent, { actionId: "tap", extra: { clusterId: "c3", object } }));
    expect(useAppStore.getState().activeClusterId).toBe("c3");
    expect(useAppStore.getState().details).toEqual(object);

    act(() => wb.backend.emit(NOTIFICATION_COMMANDS.actionEvent, { actionId: "mute-hour", extra: { clusterId: "c3" } }));
    await waitFor(() => expect(stored.notifications.mutedUntil).not.toBeNull());
    const until = Date.parse(stored.notifications.mutedUntil!);
    expect(until - Date.now()).toBeGreaterThan(59 * 60_000);

    // A summary opens the problems screen of its cluster.
    act(() => wb.backend.emit(NOTIFICATION_COMMANDS.actionEvent, { actionId: "tap", extra: { clusterId: "c1", object: null } }));
    expect(useAppStore.getState().activeClusterId).toBe("c1");
    expect(useAppStore.getState().clusterViews.c1?.view).toBe("problems");
  });
});

describe("muting from a notification", () => {
  it("shows when the mute could not be saved", async () => {
    start();
    wb.backend.on("settings_update", () => {
      throw { code: "other", message: "disk full" };
    });
    render(
      <>
        <NotificationsHost />
        <NotificationHistory />
      </>,
    );
    await waitFor(() => expect(wb.backend.listenerCount(NOTIFICATION_COMMANDS.actionEvent)).toBe(1));
    act(() => wb.backend.emit(NOTIFICATION_COMMANDS.actionEvent, { actionId: "mute-hour", extra: { clusterId: "c1" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not mute notifications: disk full");
  });
});

function Panel() {
  const { settings, update } = useSettings();
  return <NotificationsPanel settings={settings} save={(change) => update(change).then(() => true)} />;
}

describe("the Notifications settings", () => {
  it("turn notifications, a category and a cluster off, and mute for an hour", async () => {
    start();
    render(<Panel />);
    const main = await screen.findByRole("checkbox", { name: /Show desktop notifications/ });
    await waitFor(() => expect(main).toBeChecked());

    fireEvent.click(screen.getByRole("checkbox", { name: "Pods" }));
    await waitFor(() => expect(stored.notifications.disabledCategories).toEqual(["pods"]));
    fireEvent.click(screen.getByRole("checkbox", { name: "ctx-c2" }));
    await waitFor(() => expect(stored.notifications.mutedClusters).toEqual(["c2"]));
    fireEvent.click(screen.getByRole("button", { name: "Mute for 1 hour" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Muted until/));
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    await waitFor(() => expect(stored.notifications.mutedUntil).toBeNull());

    fireEvent.click(main);
    await waitFor(() => expect(stored.notifications.enabled).toBe(false));
    expect(screen.getByRole("checkbox", { name: "Pods" })).toBeDisabled();
    // Warning events are on the screen only: no toggle.
    expect(screen.queryByRole("checkbox", { name: "Warning events" })).toBeNull();
  });

  it("set how many days ahead a certificate counts as expiring, within 1..365", async () => {
    start();
    render(<Panel />);
    const field = await screen.findByRole("spinbutton", { name: "Warn this many days before a certificate expires" });
    await waitFor(() => expect(field).toHaveValue(14));
    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(stored.notifications.certExpiryDays).toBe(30));
    fireEvent.change(field, { target: { value: "5000" } });
    fireEvent.blur(field);
    await waitFor(() => expect(stored.notifications.certExpiryDays).toBe(365));
  });
});

/** One notification about a crashing pod of each cluster, through the real notifier. */
function notifyAbout(pods: Record<string, string>) {
  const now = Date.now();
  notifier.setPrefs(prefsOf(defaultAppSettings()));
  for (const clusterId of Object.keys(pods)) notifier.observe({ key: `${clusterId}|pods`, clusterId, status: "ready", problems: [] }, now);
  for (const [clusterId, name] of Object.entries(pods)) {
    const problems = resolve(POD, crashing(name), now);
    notifier.observe({ key: `${clusterId}|pods`, clusterId, status: "ready", problems }, now);
  }
  act(() => notifier.flush());
}

describe("the recent notifications on a cluster's problems screen", () => {
  it("list that cluster's only, every cluster's under All clusters, and clear what is listed", async () => {
    start();
    render(<NotificationHistory clusterId="c1" />);
    expect(await screen.findByText("No notifications from this cluster yet.")).toBeInTheDocument();
    notifyAbout({ c1: "web", c3: "api" });
    const list = () => screen.getByRole("region", { name: "Recent notifications" });
    expect(list()).toHaveTextContent("Pod: shop/web");
    expect(list()).not.toHaveTextContent("Pod: shop/api");
    expect(list()).not.toHaveTextContent("ctx-c1");
    // The mute is app-wide, and says so here.
    await waitFor(() => expect(screen.getByRole("button", { name: "Mute all notifications for 1 hour" })).toBeEnabled());

    const every = screen.getByRole("checkbox", { name: "All clusters" });
    expect(every).not.toBeChecked();
    fireEvent.click(every);
    expect(list()).toHaveTextContent("Pod: shop/api");
    expect(list()).toHaveTextContent("ctx-c3");
    fireEvent.click(every);

    // "Clear" forgets this cluster's entries only.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("No notifications from this cluster yet.")).toBeInTheDocument();
    expect(notifier.history().map((h) => h.clusterId)).toEqual(["c3"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "All clusters" }));
    expect(list()).toHaveTextContent("Pod: shop/api");
  });
});
