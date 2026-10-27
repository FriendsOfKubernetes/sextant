// The OLM CSV source of a user who may not list Namespaces (#285): it watches the accessible namespaces
// (`restrictedScope`), not cluster-wide.
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceKind } from "../../api";
import { resetWatchRegistry } from "../../api/watchRegistry";
import { loadClusterKinds, knownClusterKinds, resetClusterKinds } from "../../resources/useKinds";
import { watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { CSV } from "./model";
import { provideOlm } from "./provider";

let scope: string[] | null = null;
vi.mock("../namespaces/accessStore", async (original) => ({
  ...(await original<typeof import("../namespaces/accessStore")>()),
  restrictedScope: () => scope,
}));

const served: ResourceKind = { kindRef: CSV, plural: "clusterserviceversions", namespaced: true, verbs: ["list", "watch"], printerColumns: [] };
let wb: WatchBackend;

beforeEach(() => {
  resetClusterKinds();
  resetWatchRegistry();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [served]);
});

afterEach(() => {
  wb.backend.restore();
  resetWatchRegistry();
  resetClusterKinds();
  scope = null;
});

describe("the CSV source", () => {
  it("watches the accessible namespaces of a restricted user, and cluster-wide otherwise", async () => {
    loadClusterKinds("c1");
    await waitFor(() => expect(knownClusterKinds("c1")).not.toBeNull());
    scope = ["dev", "team-a"];
    const stop = provideOlm("c1", () => undefined);
    const id = await watchOf(wb, "ClusterServiceVersion");
    expect(wb.specs.get(id)).toMatchObject({ namespaces: ["dev", "team-a"], labelSelector: "!olm.copiedFrom" });
    stop();
    scope = null;
    const again = provideOlm("c1", () => undefined);
    const wide = await watchOf(wb, "ClusterServiceVersion", (s) => s.namespaces === null);
    expect(wb.specs.get(wide)?.labelSelector).toBe("!olm.copiedFrom");
    again();
  });
});
