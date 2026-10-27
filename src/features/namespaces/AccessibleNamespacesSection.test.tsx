import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type AccessQuery, type ClusterInfo, type MockBackend } from "../../api";
import { resetAppStore } from "../../app/store";
import { axeViolations } from "../../test/axe";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import { getClusterSettingsTabs } from "../clusters/settingsRegistry";
import "./index";
import { AccessibleNamespacesSection } from "./AccessibleNamespacesSection";
import { getAccess } from "./accessStore";
import { resetNamespaceRestore } from "./namespaces";

const CLUSTER: ClusterInfo = {
  id: "c1",
  context: "team",
  clusterName: "c1",
  server: "https://x",
  user: "u",
  namespace: "dev",
  sourceId: "s",
};

let backend: MockBackend;

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  resetClustersStore();
  backend = mockBackend(
    {
      rbac_can_i: (args) =>
        (args.queries as AccessQuery[]).map((q) => ({
          allowed: q.resource === "pods" && q.namespace !== "team-b",
          denied: false,
          reason: "",
          evaluationError: "",
        })),
      rbac_whoami: () => ({ username: "alice", serviceAccountNamespace: null }),
      cluster_kinds: () => [],
    },
    { settings: { clusters: { c1: { ...defaultClusterSettings(), knownNamespaces: ["team-a", "team-b"] } } } },
  );
  useClustersStore.setState({ clusters: [CLUSTER] });
});

afterEach(() => {
  resetNamespaceRestore();
  resetClustersStore();
  backend.restore();
});

describe("the “Accessible namespaces” section", () => {
  it("is in the Connection tab of the cluster settings", () => {
    const tab = getClusterSettingsTabs().find((t) => t.sections.some((s) => s.id === "accessibleNamespaces"));
    expect(tab?.id).toBe("connection");
  });

  it("adds and removes known namespaces, refusing what is not a namespace name", async () => {
    render(<AccessibleNamespacesSection clusterId="c1" cluster={CLUSTER} />);
    const list = await screen.findByRole("list", { name: "Accessible namespaces" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["team-a", "team-b"]);
    expect(screen.getByRole("status").textContent).toBe(
      "Connect to the cluster to check which of these namespaces you may read.",
    );

    const input = screen.getByRole("textbox", { name: "Namespace" });
    fireEvent.change(input, { target: { value: "team-c, Bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toBe("“Bad” is not a namespace name");
    expect(await axeViolations(document)).toEqual([]);

    fireEvent.change(input, { target: { value: "team-c team-d" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(backend.settings.clusters.c1?.knownNamespaces).toEqual(["team-a", "team-b", "team-c", "team-d"]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove team-b" }));
    await waitFor(() => expect(backend.settings.clusters.c1?.knownNamespaces).toEqual(["team-a", "team-c", "team-d"]));
    // The last one removed: none left (`null`, left out of the file).
    for (const ns of ["team-a", "team-c", "team-d"]) {
      fireEvent.click(await screen.findByRole("button", { name: `Remove ${ns}` }));
      await waitFor(() => expect(screen.queryByRole("button", { name: `Remove ${ns}` })).toBeNull());
    }
    expect(backend.settings.clusters.c1?.knownNamespaces).toBeNull();
    expect(screen.getByText("No namespaces yet.")).toBeTruthy();
  });

  it("shows what the access check says of each namespace, and the ones it found", async () => {
    render(<AccessibleNamespacesSection clusterId="c1" cluster={CLUSTER} />);
    act(() => useClustersStore.setState({ states: { c1: { state: "connected" } } }));
    await waitFor(() => expect(getAccess("c1").status).toBe("ready"));
    expect(screen.getByRole("status").textContent).toBe(
      "You may not list the namespaces of this cluster: “All namespaces” watches the accessible namespaces below.",
    );
    expect(screen.getByText("The API server knows you as alice.")).toBeTruthy();
    const known = screen.getByRole("list", { name: "Accessible namespaces" });
    expect(within(known).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "team-aaccessible",
      "team-bno access",
    ]);
    const found = screen.getByRole("list", { name: "Found when connecting" });
    expect(within(found).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["devaccessibleKeep"]);
    expect(await axeViolations(document)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Keep dev" }));
    await waitFor(() => expect(backend.settings.clusters.c1?.knownNamespaces).toEqual(["team-a", "team-b", "dev"]));
  });
});
