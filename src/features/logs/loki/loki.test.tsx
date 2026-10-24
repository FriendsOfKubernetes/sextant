import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, mockBackend, type AppSettings, type ClusterInfo, type KindRef, type LokiEntry, type LokiStatus, type MockBackend } from "../../../api";
import { resetSettingsCache } from "../../../api/settings";
import { resetAppStore, useAppStore } from "../../../app/store";
import { axeViolations } from "../../../test/axe";
import "../index";
import { LogsTab, type LogsPayload } from "../LogsTab";
import { resetLokiStatuses } from "./hooks";
import { lokiTexts } from "./lines";
import {
  capText,
  isoOfNs,
  msOfNs,
  nsKey,
  presetRange,
  rangeProblem,
  shownRunStart,
  splitLiveLine,
  withoutLive,
  liveKeys,
} from "./model";
import { PreviousPodsSection } from "./PreviousPodsSection";
import { isPathPrefix, isTenant, LokiSettingsSection, parseLokiService } from "./SettingsSection";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const FOUND: LokiStatus = {
  off: false,
  manual: false,
  source: { namespace: "loki", service: "loki-gateway", port: 80, pathPrefix: "" },
  scheme: "kubernetes",
  containerLabel: true,
};
const NOT_FOUND: LokiStatus = { off: false, manual: false, source: null, scheme: null, containerLabel: false };

const entry = (ts: string, line: string, cut = false): LokiEntry => (cut ? { ts, line, cut } : { ts, line });

describe("the model", () => {
  it("writes and reads timestamps as the kubelet does", () => {
    expect(isoOfNs("1569266497240578000")).toBe("2019-09-23T19:21:37.240578000Z");
    expect(splitLiveLine("2019-09-23T19:21:37.240578000Z GET /cart 200")).toEqual({ ts: "1569266497240578000", text: "GET /cart 200" });
    expect(splitLiveLine("2019-09-23T19:21:37.24Z x")?.ts).toBe("1569266497240000000");
    expect(splitLiveLine("no timestamp")).toBeNull();
    expect(msOfNs("1569266497240578000")).toBe(1569266497240);
    expect(nsKey("999") < nsKey("1000")).toBe(true);
  });

  it("drops only the Loki lines the live view shows with the same time and text", () => {
    const keys = liveKeys(["2019-09-23T19:21:37.240578000Z same", "2019-09-23T19:21:38.000000000Z other"]);
    const entries = [entry("1569266497240578000", "same"), entry("1569266497240578000", "different"), entry("1569266490000000000", "same")];
    expect(withoutLive(entries, keys)).toEqual([entries[1], entries[2]]);
    const texts = lokiTexts(entries, { length: 1, at: () => "2019-09-23T19:21:37.240578000Z same" }, true, " [cut]");
    expect(texts).toEqual(["2019-09-23T19:21:37.240578000Z different", "2019-09-23T19:21:30.000000000Z same"]);
    expect(lokiTexts([entry("1", "piece", true)], { length: 0, at: () => undefined }, false, " [cut]")).toEqual(["piece [cut]"]);
  });

  it("keeps the newest text of a backward read within the cap", () => {
    const entries = [entry("1", "aaaa"), entry("2", "bbbb"), entry("3", "cccc")];
    expect(capText(entries, "backward", 8)).toEqual({ entries: entries.slice(1), dropped: 1 });
    expect(capText(entries, "forward", 8)).toEqual({ entries: entries.slice(0, 2), dropped: 1 });
  });

  it("checks periods and finds where the shown run began", () => {
    expect(presetRange("6h", 10 * 3_600_000)).toEqual({ startMs: 4 * 3_600_000, endMs: 10 * 3_600_000 });
    expect(rangeProblem({ startMs: 0, endMs: 25 * 3_600_000 }, 30 * 3_600_000)).toBe("tooLong");
    expect(rangeProblem({ startMs: 2, endMs: 1 }, 10)).toBe("invalid");
    expect(rangeProblem({ startMs: 1, endMs: 3_600_000 }, 0)).toBe("future");
    const pod = {
      metadata: { name: "web-1" },
      status: {
        containerStatuses: [
          {
            name: "app",
            restartCount: 2,
            state: { running: { startedAt: "2024-05-01T10:00:00Z" } },
            lastState: { terminated: { startedAt: "2024-05-01T09:00:00Z" } },
          },
        ],
      },
    };
    expect(shownRunStart(pod, "app", false)).toBe(Date.parse("2024-05-01T10:00:00Z"));
    expect(shownRunStart(pod, "app", true)).toBe(Date.parse("2024-05-01T09:00:00Z"));
    expect(shownRunStart(pod, "other", false)).toBeNull();
  });

  it("reads the settings fields as the backend does", () => {
    expect(parseLokiService("loki/loki-gateway:80")).toEqual({ namespace: "loki", service: "loki-gateway", port: 80 });
    expect(parseLokiService("loki/loki-gateway")).toBeNull();
    expect(isPathPrefix("")).toBe(true);
    expect(isPathPrefix("/loki-proxy/")).toBe(true);
    expect(isPathPrefix("/a/../b")).toBe(false);
    expect(isPathPrefix("/a?b")).toBe(false);
    expect(isTenant("team-a|team-b")).toBe(true);
    expect(isTenant("a b")).toBe(false);
  });
});

let backend: MockBackend;
let stored: AppSettings;
let status: LokiStatus;

beforeEach(() => {
  resetAppStore();
  resetLokiStatuses();
  resetSettingsCache();
  stored = defaultAppSettings();
  status = FOUND;
  backend = mockBackend({
    logs_start: () => "s1",
    logs_stop: () => undefined,
    loki_status: () => status,
    loki_logs_start: () => undefined,
    loki_logs_stop: () => undefined,
    settings_get: () => structuredClone(stored),
    settings_update: (args) => {
      stored = structuredClone(args.settings as AppSettings);
      return structuredClone(stored);
    },
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("logs__scroll") ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("logs__scroll") ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("logs__scroll") ? 800 : 0;
  });
  HTMLElement.prototype.scrollTo = function () {} as typeof HTMLElement.prototype.scrollTo;
});
afterEach(() => {
  backend.restore();
  resetSettingsCache();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.restoreAllMocks();
});

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

const payload: LogsPayload = {
  clusterId: "c1",
  pod: { kind: POD, namespace: "shop", name: "web-7c9f8d6b5d-x2x4q" },
  containers: [{ name: "app", init: false }],
};

function renderTab(overrides: Partial<LogsPayload> = {}) {
  const tab = { id: "logs-1", type: "logs" as const, title: "web", payload: { ...payload, ...overrides } };
  return render(<LogsTab tab={tab} active />);
}

describe("a logs tab", () => {
  it("of a gone pod offers Loki's older lines and shows them marked, oldest first", async () => {
    backend.on("logs_start", () => {
      throw { code: "notFound", message: 'pods "web-7c9f8d6b5d-x2x4q" not found' };
    });
    const view = renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Load older lines from Loki" }));
    await waitFor(() => expect(calls("loki_logs_start")).toHaveLength(1));
    const args = calls("loki_logs_start")[0]!;
    const query = args.query as { range: { startMs: number; endMs: number } };
    expect(args.query).toMatchObject({
      namespace: "shop",
      pod: "web-7c9f8d6b5d-x2x4q",
      container: "app",
      direction: "backward",
      limit: 5000,
    });
    expect(query.range.endMs - query.range.startMs).toBe(3_600_000);
    // Nothing but names, a period and a limit leave the window.
    expect(Object.keys(args.query as object).sort()).toEqual(["container", "direction", "limit", "namespace", "pod", "range"]);
    const id = args.streamId as string;
    act(() => backend.emit(`loki:${id}`, { type: "entries", entries: [entry("1569266495000000000", "newer line")] }));
    act(() => backend.emit(`loki:${id}`, { type: "entries", entries: [entry("1569266490000000000", "older line")] }));
    act(() => backend.emit(`loki:${id}`, { type: "ended", lines: 2, truncated: false }));
    expect(await screen.findByTestId("loki-count")).toHaveTextContent("2 lines from Loki");
    const rows = [...view.container.querySelectorAll(".logs__line--loki")].map((r) => r.textContent);
    expect(rows).toEqual(["Lokiolder line", "Lokinewer line"]);
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it("of a gone pod says what is needed when the cluster has no Loki", async () => {
    status = NOT_FOUND;
    backend.on("logs_start", () => {
      throw { code: "notFound", message: "gone" };
    });
    renderTab();
    expect(await screen.findByTestId("loki-unavailable")).toHaveTextContent("loki-gateway");
    expect(screen.queryByRole("button", { name: "Load older lines from Loki" })).not.toBeInTheDocument();
  });

  it("of a running pod keeps the Loki bar closed until asked and ends the read where the shown run began", async () => {
    backend.on("resource_get", () => ({
      metadata: { name: "web-7c9f8d6b5d-x2x4q", namespace: "shop" },
      status: { containerStatuses: [{ name: "app", state: { running: { startedAt: "2024-05-01T10:00:00Z" } } }] },
    }));
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Older lines from Loki" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Period" }), { target: { value: "6h" } });
    fireEvent.click(screen.getByRole("button", { name: "Load older lines from Loki" }));
    await waitFor(() => expect(calls("loki_logs_start")).toHaveLength(1));
    const range = (calls("loki_logs_start")[0]!.query as { range: { startMs: number; endMs: number } }).range;
    expect(range.endMs).toBe(Date.parse("2024-05-01T10:00:00Z"));
    expect(range.endMs - range.startMs).toBe(6 * 3_600_000);
  });

  it("opened for a pod found in Loki reads it at once and starts no live stream", async () => {
    renderTab({ loki: { range: { startMs: 1000, endMs: 2000 } } });
    await waitFor(() => expect(calls("loki_logs_start")).toHaveLength(1));
    expect(calls("loki_logs_start")[0]!.query).toMatchObject({ range: { startMs: 1000, endMs: 2000 } });
    expect(calls("logs_start")).toHaveLength(0);
    expect(screen.queryByRole("checkbox", { name: "Follow" })).not.toBeInTheDocument();
  });
});

describe("the previous pods of a workload", () => {
  const ref = { kind: DEPLOYMENT, namespace: "shop", name: "web" };

  it("are found in Loki by the workload's name and open in a tab of Loki's lines", async () => {
    backend.on("loki_names", (args) =>
      (args.query as { type: string }).type === "workloadPods"
        ? { names: ["web-5f6d7c8b9d-b2c4d", "web-7c9f8d6b5d-x2x4q"], truncated: false }
        : { names: ["app"], truncated: false },
    );
    const view = render(<PreviousPodsSection clusterId="c1" objectRef={ref} obj={null} />);
    fireEvent.click(await screen.findByRole("button", { name: "Find pods in Loki" }));
    expect(await screen.findByRole("button", { name: "web-5f6d7c8b9d-b2c4d" })).toBeInTheDocument();
    expect(calls("loki_names")[0]!.query).toEqual({ type: "workloadPods", namespace: "shop", kind: "Deployment", name: "web" });
    expect(await axeViolations(view.container)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "web-7c9f8d6b5d-x2x4q" }));
    await waitFor(() => expect(useAppStore.getState().dock.tabs).toHaveLength(1));
    const opened = useAppStore.getState().dock.tabs[0]!.payload as LogsPayload;
    expect(opened.pod.name).toBe("web-7c9f8d6b5d-x2x4q");
    expect(opened.containers).toEqual([{ name: "app", init: false }]);
    expect(opened.loki?.range.endMs).toBe((calls("loki_names")[0]!.range as { endMs: number }).endMs);
  });

  it("say what is needed when there is no Loki", async () => {
    status = NOT_FOUND;
    const view = render(<PreviousPodsSection clusterId="c1" objectRef={ref} obj={null} />);
    expect(await screen.findByText(/name its Service in the cluster settings/)).toBeInTheDocument();
    expect(await axeViolations(view.container)).toEqual([]);
  });
});

describe("the Loki cluster settings", () => {
  const cluster: ClusterInfo = {
    id: "c1",
    context: "kind-sextant-test",
    clusterName: "kind-sextant-test",
    server: "https://127.0.0.1:6443",
    user: "admin",
    namespace: null,
    sourceId: "default",
  };

  it("say why the Service named in the settings did not answer", async () => {
    status = {
      off: false,
      manual: true,
      source: null,
      scheme: null,
      containerLabel: false,
      probeError: { code: "forbidden", message: "no permission to reach Loki loki/loki through the API server (services/proxy)" },
    };
    const view = render(<LokiSettingsSection clusterId="c1" cluster={cluster} />);
    const detected = await screen.findByTestId("loki-detected");
    expect(detected).toHaveTextContent("did not answer as Loki");
    expect(detected).toHaveTextContent("What the API server answered: no permission to reach Loki loki/loki");
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it("save a Service and a tenant, and refuse a malformed tenant", async () => {
    const view = render(<LokiSettingsSection clusterId="c1" cluster={cluster} />);
    expect(await screen.findByTestId("loki-detected")).toHaveTextContent("loki/loki-gateway:80");
    fireEvent.click(screen.getByRole("radio", { name: "Use this Service" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Service (namespace/name:port)" }), { target: { value: "logs/my-loki:3100" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Tenant (X-Scope-OrgID)" }), { target: { value: "bad tenant" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("tenant ID");
    expect(calls("settings_update")).toHaveLength(0);
    fireEvent.change(screen.getByRole("textbox", { name: "Tenant (X-Scope-OrgID)" }), { target: { value: "team-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("settings_update")).toHaveLength(1));
    expect(stored.clusters.c1?.loki).toEqual({
      mode: { mode: "manual", namespace: "logs", service: "my-loki", port: 3100, pathPrefix: "" },
      tenant: "team-a",
    });
    expect(await axeViolations(view.container)).toEqual([]);
  });
});
