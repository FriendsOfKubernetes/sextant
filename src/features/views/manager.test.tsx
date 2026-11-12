// The workspaces tab of the views manager: a workspace of a kubeconfig folder is copied into one of the user's own to
// edit (#328, ADR-0148 amendment); the folder's own stays as it is.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type ClusterInfo, type KubeconfigSource, type MockBackend } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetClustersStore } from "../clusters/clustersStore";
import { ViewsHost } from "./Manager";
import { closeManager, openManager } from "./ui";

const cluster = (id: string): ClusterInfo => ({
  id,
  context: id,
  clusterName: id,
  server: "https://x",
  user: "u",
  namespace: null,
  sourceId: `file-${id}`,
  folder: { sourceId: "prod" },
  fileName: id,
});
const folder: KubeconfigSource = { id: "prod", path: "/home/me/kube/prod", kind: "folder", error: null };

let backend: MockBackend;
beforeEach(() => {
  resetSettingsCache();
  resetClustersStore();
  backend = mockBackend({ clusters_list: () => [cluster("p1"), cluster("p2")], kubeconfig_sources: () => [folder] }, {});
});
afterEach(() => {
  closeManager();
  backend.restore();
});

describe("the workspaces of kubeconfig folders in the manager", () => {
  it("are copied into an editable workspace of the user's own", async () => {
    openManager("workspaces");
    render(<ViewsHost />);
    const list = await screen.findByRole("list", { name: "Workspaces of kubeconfig folders" });
    // The folder's own files make a workspace named after it.
    expect(within(list).getByText("prod")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Copy prod as a workspace of your own" }));
    const name = await screen.findByLabelText("Workspace name");
    expect(name).toHaveValue("prod");
    fireEvent.change(name, { target: { value: "prod and more" } });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    await waitFor(() => expect(backend.settings.workspaces).toHaveLength(1));
    const copy = backend.settings.workspaces[0]!;
    expect(copy).toMatchObject({ name: "prod and more", clusters: ["p1", "p2"] });
    expect(copy.id.startsWith("folder-")).toBe(false);
  });
});
