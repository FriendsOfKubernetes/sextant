// #209: the kept answers about newer chart versions.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type ChartUpdate, type ChartUpdates, type HelmRelease, type InstalledChart, type MockBackend } from "../../api";
import { resetChartUpdates, useChartUpdates } from "./updates";

function release(name: string, chart: string, chartVersion: string): HelmRelease {
  return {
    name,
    namespace: "apps",
    revision: 1,
    chart,
    chartVersion,
    appVersion: "1.0.0",
    status: "deployed",
    updated: "2026-10-11T18:00:00Z",
    unreadableRevision: null,
    unreadable: false,
  };
}

function update(c: InstalledChart): ChartUpdate {
  return {
    chart: c.chart,
    version: c.version,
    chartRef: `bitnami/${c.chart}`,
    latest: c.version,
    latestAppVersion: null,
    step: null,
    upToDate: true,
    otherRepos: [],
    error: null,
  };
}

let backend: MockBackend;
/** What the next `helm_chart_updates` reports besides the charts asked. */
let next: Omit<ChartUpdates, "charts">;

beforeEach(() => {
  resetChartUpdates();
  next = { repos: 2, repoProblems: [], skipped: 0 };
  backend = mockBackend({
    helm_chart_updates: (args) => ({ charts: (args.charts as InstalledChart[]).map(update), ...structuredClone(next) }),
    helm_repo_update: () => null,
  });
});

afterEach(() => backend.restore());

const asked = () => backend.calls.filter((c) => c.cmd === "helm_chart_updates").map((c) => (c.args.charts as InstalledChart[]).map((x) => x.chart));

const nginx = release("web", "nginx", "15.1.0");
const postgres = release("db", "postgresql", "12.0.0");

describe("useChartUpdates", () => {
  it("drops the kept answers of every cluster after the repositories are updated", async () => {
    const c1 = renderHook(() => useChartUpdates("c1", [nginx], true));
    await waitFor(() => expect(c1.result.current.repos).toBe(2));
    const c2 = renderHook(() => useChartUpdates("c2", [postgres], true));
    await waitFor(() => expect(c2.result.current.repos).toBe(2));
    c2.unmount();
    expect(asked()).toEqual([["nginx"], ["postgresql"]]);

    act(() => c1.result.current.updateRepos());
    await waitFor(() => expect(asked()).toHaveLength(3));
    await waitFor(() => expect(c1.result.current.updatingRepos).toBe(false));

    // The other cluster's answer came from the old indexes: it is asked again.
    const again = renderHook(() => useChartUpdates("c2", [postgres], true));
    await waitFor(() => expect(asked()).toHaveLength(4));
    expect(asked()[3]).toEqual(["postgresql"]);
    await waitFor(() => expect(again.result.current.loading).toBe(false));
  });

  it("adds a partial answer's repository problems and skipped charts to the kept ones", async () => {
    next = { repos: 2, repoProblems: [{ repo: "stale", message: "Repo \"stale\" is corrupt or missing." }], skipped: 1 };
    const hook = renderHook(({ releases }) => useChartUpdates("c1", releases, true), { initialProps: { releases: [nginx] } });
    await waitFor(() => expect(hook.result.current.repos).toBe(2));

    // A new release: only its chart is asked, and that answer has its own problems.
    next = { repos: 3, repoProblems: [{ repo: "old", message: "Repo \"old\" is corrupt or missing." }], skipped: 2 };
    hook.rerender({ releases: [nginx, postgres] });
    await waitFor(() => expect(hook.result.current.repos).toBe(3));
    expect(asked()).toEqual([["nginx"], ["postgresql"]]);
    expect(hook.result.current.problems.map((p) => p.repo)).toEqual(["old", "stale"]);
    expect(hook.result.current.skipped).toBe(3);
    expect([...hook.result.current.updates.keys()]).toHaveLength(2);
  });
});
