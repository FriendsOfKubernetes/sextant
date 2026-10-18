// Turning a category on or off in the notification settings touches only that category's watches: a notification
// already waiting for its group window is still shown, and the other sources keep their first look (#143 review).
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, NOTIFICATION_COMMANDS, updateSettings, type AppSettings, type KubeObject } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore } from "../../app/store";
import "../../resources";
import { resetClusterKinds } from "../../resources/useKinds";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import { emitDelta, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { GROUP_WINDOW_MS } from "../notifications/engine";
import { NotificationsHost } from "../notifications/NotificationsHost";
import { resetNotifier } from "../notifications/notifier";
import { setCategory } from "../notifications/prefs";
import { resetProblemSources } from "../problems/store";

const crashing = (name: string): KubeObject => ({
  metadata: { name, namespace: "shop", uid: `uid-${name}` },
  status: { phase: "Running", containerStatuses: [{ name: "app", restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff" } } }] },
});

let wb: WatchBackend;
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetProblemSources();
  resetNotifier();
  resetClusterKinds();
  resetClustersStore();
  resetSettingsCache();
  wb = watchBackend();
  const defaults = defaultAppSettings();
  stored = { ...defaults, notifications: { ...defaults.notifications, disabledCategories: ["nodes", "workloads", "volumes"] } };
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
  wb.backend.on("cluster_kinds", () => []);
  const clusters = [{ id: "c1", context: "ctx-c1", clusterName: "c1", server: "https://example", user: "u", namespace: null, sourceId: "s" }];
  wb.backend.on("clusters_list", () => clusters);
  wb.backend.on("kubeconfig_sources", () => []);
  wb.backend.on("cluster_state", () => ({ state: "connected" }));
  useClustersStore.setState({ loaded: true, clusters, states: { c1: { state: "connected" } } });
});

afterEach(() => {
  vi.useRealTimers();
  resetProblemSources();
  resetNotifier();
  resetClustersStore();
  resetSettingsCache();
  wb.backend.restore();
});

const notified = () => wb.backend.calls.filter((c) => c.cmd === NOTIFICATION_COMMANDS.notify);

describe("toggling a notification category", () => {
  it("keeps a waiting notification of another category", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<NotificationsHost />);
    const pods = await watchOf(wb, "Pod", () => true);
    emitSnapshot(wb, await watchOf(wb, "Job", () => true), []);
    emitSnapshot(wb, pods, []);
    await act(() => vi.advanceTimersByTimeAsync(GROUP_WINDOW_MS + 100));

    emitDelta(wb, pods, [crashing("new")]);
    // While it waits for its group window, Jobs are turned off and security on.
    await act(async () => {
      await updateSettings(setCategory("jobs", false));
      await updateSettings(setCategory("security", true));
    });
    await act(() => vi.advanceTimersByTimeAsync(GROUP_WINDOW_MS + 100));
    expect(notified()).toHaveLength(1);
    expect((notified()[0]!.args.options as { body: string }).body).toContain("Pod shop/new");
  });
});
