// The k3s / RKE2 problems of a user who may not list Namespaces (#285): the HelmCharts and their Jobs are watched in
// the accessible namespaces (`restrictedScope`), not cluster-wide.
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceKind } from "../../api";
import { loadClusterKinds, knownClusterKinds, resetClusterKinds } from "../../resources/useKinds";
import { watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetSharedWatches } from "../resource-map/watches";
import { HELM_CHART } from "./model";
import { provideK3s } from "./provider";

let scope: string[] | null = null;
vi.mock("../namespaces/accessStore", async (original) => ({
  ...(await original<typeof import("../namespaces/accessStore")>()),
  restrictedScope: () => scope,
}));

const served: ResourceKind = { kindRef: HELM_CHART, plural: "helmcharts", namespaced: true, verbs: ["list", "watch"], printerColumns: [] };
let wb: WatchBackend;

beforeEach(() => {
  resetClusterKinds();
  resetSharedWatches();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [served]);
});

afterEach(() => {
  wb.backend.restore();
  resetSharedWatches();
  resetClusterKinds();
  scope = null;
});

describe("the k3s / RKE2 source", () => {
  it("watches HelmCharts and their Jobs in the accessible namespaces of a restricted user", async () => {
    loadClusterKinds("c1");
    await waitFor(() => expect(knownClusterKinds("c1")).not.toBeNull());
    scope = ["dev", "team-a"];
    const stop = provideK3s("c1", () => undefined);
    const charts = await watchOf(wb, "HelmChart");
    const jobs = await watchOf(wb, "Job");
    expect(wb.specs.get(charts)?.namespaces).toEqual(["dev", "team-a"]);
    expect(wb.specs.get(jobs)?.namespaces).toEqual(["dev", "team-a"]);
    stop();
    scope = null;
    const again = provideK3s("c1", () => undefined);
    await watchOf(wb, "HelmChart", (s) => s.namespaces === null);
    await watchOf(wb, "Job", (s) => s.namespaces === null);
    again();
  });
});
