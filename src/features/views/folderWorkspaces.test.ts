// Workspaces of kubeconfig folders' subfolders (ADR-0148): computed from the clusters, read-only, one per subfolder.
import { describe, expect, it } from "vitest";
import type { AppSettings, ClusterInfo, KubeconfigSource } from "../../api";
import { defaultAppSettings } from "../../api/settings";
import { folderWorkspaces, isFolderWorkspaceId } from "./folderWorkspaces";
import { activeWorkspace, switchWorkspace, workspaceClusters } from "./model";

const folder = (id: string, workspaces?: boolean): KubeconfigSource => ({
  id,
  path: `/kube/${id}`,
  kind: "folder",
  error: null,
  ...(workspaces === undefined ? {} : { workspaces }),
});

const cluster = (id: string, sourceId: string, subfolder?: string): ClusterInfo => ({
  id,
  context: id,
  clusterName: id,
  server: "https://x",
  user: "u",
  namespace: null,
  sourceId: `file-${id}`,
  folder: { sourceId, ...(subfolder ? { subfolder } : {}) },
  fileName: `${id}.yaml`,
});

describe("workspaces of kubeconfig folders", () => {
  const clusters = [cluster("a1", "f1", "team-a"), cluster("a2", "f1", "team-a"), cluster("b1", "f1", "team-b"), cluster("top", "f1"), cluster("x", "f2", "team-a")];

  it("are one per subfolder of a folder whose workspaces are on, the folder's own files in none", () => {
    const made = folderWorkspaces(clusters, [folder("f1"), folder("f2", false)]);
    expect(made.map((w) => [w.name, w.clusters, w.folder])).toEqual([
      ["team-a", ["a1", "a2"], "/kube/f1"],
      ["team-b", ["b1"], "/kube/f1"],
    ]);
    expect(made.every((w) => isFolderWorkspaceId(w.id) && /^[A-Za-z0-9_-]{1,64}$/.test(w.id))).toBe(true);
    // The same subfolder in another folder is another workspace.
    const both = folderWorkspaces(clusters, [folder("f1"), folder("f2")]);
    expect(new Set(both.map((w) => w.id)).size).toBe(3);
  });

  it("can be the active workspace, beside the user's own of the same name", () => {
    const made = folderWorkspaces(clusters, [folder("f1")]);
    const settings: AppSettings = { ...defaultAppSettings(), workspaces: [{ id: "w1", name: "team-a", clusters: ["top"] }] };
    const switched = switchWorkspace(settings, made[0]!.id, made);
    expect(activeWorkspace(switched, made)?.clusters).toEqual(["a1", "a2"]);
    expect(workspaceClusters(clusters, switched, null, made).map((c) => c.id)).toEqual(["a1", "a2"]);
    // The user's workspace of the same name is untouched.
    expect(switched.workspaces).toEqual(settings.workspaces);
    // Without the folder's workspaces (turned off, the folder removed) the id names nothing.
    expect(activeWorkspace(switched, [])).toBeNull();
  });
});
