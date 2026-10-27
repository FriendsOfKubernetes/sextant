import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type ClusterInfo, type KubeconfigSource } from "../../api";
import { resetAppStore, tableStateOf, useAppStore } from "../../app/store";
import { mockBackend } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetNamespaceRestore } from "../namespaces";
import {
  applyView,
  captureView,
  deleteView,
  isPinned,
  moveView,
  objectPinOf,
  pinsFor,
  switchWorkspace,
  togglePin,
  viewsFor,
  withView,
  withWorkspace,
  workspaceClusters,
  type SavedView,
} from "./model";
import { applyImport, buildExport, exportText, ImportError, parseImport, planImport } from "./transfer";

const cluster = (id: string, context: string, sourceId = "s1"): ClusterInfo => ({
  id,
  context,
  clusterName: context,
  server: `https://${context}.example:6443`,
  user: "admin",
  namespace: null,
  sourceId,
});
const SOURCES: KubeconfigSource[] = [
  { id: "s1", path: "/home/me/.kube/config", kind: "default", error: null },
  { id: "s2", path: "/home/me/work.yaml", kind: "addedFile", error: null },
];
const CLUSTERS = [cluster("c1", "prod"), cluster("c2", "staging"), cluster("c3", "dev", "s2")];

const VIEW: SavedView = {
  id: "v1",
  name: "Failing deployments",
  cluster: "c1",
  group: "apps",
  kind: "Deployment",
  namespaces: ["shop"],
  search: "web",
  onlyProblems: true,
  labelSelector: "tier=front",
  sort: { column: "age", desc: true },
  hiddenColumns: ["images"],
};

beforeEach(() => {
  resetAppStore();
  resetSettingsCache();
  resetNamespaceRestore();
  mockBackend();
});
afterEach(() => {
  resetAppStore();
  resetSettingsCache();
});

describe("capturing and applying a view", () => {
  it("captures the open table: kind, namespaces, search, filters, sort and hidden columns", () => {
    const app = useAppStore.getState();
    app.setView("c1", "kind:apps/Deployment");
    app.setNamespaces("c1", ["shop"]);
    app.setSearch("c1", "web");
    app.setTableState("c1", "kind:apps/Deployment", {
      onlyProblems: true,
      labelSelector: " tier=front ",
      sort: { column: "age", desc: true },
      hiddenColumns: ["images"],
    });
    const view = captureView("c1", "  Failing deployments ", "cluster", "v1");
    expect(view).toEqual(VIEW);
    expect(captureView("c1", "x", "all")?.cluster).toBeNull();
    expect(captureView("c1", "   ", "all")).toBeNull();
  });

  it("applies a view to a cluster and a different view starts from the defaults again", async () => {
    await applyView("c2", { ...VIEW, cluster: null });
    const cv = useAppStore.getState().clusterViews.c2!;
    expect(cv.view).toBe("kind:apps/Deployment");
    expect(cv.search).toBe("web");
    expect(cv.namespaces).toEqual(["shop"]);
    const table = tableStateOf(cv, "kind:apps/Deployment");
    expect(table).toMatchObject({ onlyProblems: true, labelSelector: "tier=front", sort: { column: "age", desc: true } });
    expect(table.hiddenColumns).toEqual(["images"]);

    useAppStore.getState().setView("c2", "kind:/Pod");
    expect(tableStateOf(useAppStore.getState().clusterViews.c2!, "kind:/Pod").onlyProblems).toBe(false);
  });
});

describe("views, pins and workspaces in the settings", () => {
  const base = (): AppSettings => withView(withView(defaultAppSettings(), VIEW), { ...VIEW, id: "v2", cluster: null, name: "All" });

  it("lists a cluster's own views and those for every cluster; reorders and deletes with its pins", () => {
    let s = base();
    expect(viewsFor(s, "c1").map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(viewsFor(s, "c2").map((v) => v.id)).toEqual(["v2"]);
    s = moveView(s, "v2", -1);
    expect(s.views.map((v) => v.id)).toEqual(["v2", "v1"]);
    s = togglePin(s, { id: "p1", cluster: "c1", target: { type: "view", view: "v1" } });
    expect(pinsFor(s, "c1")).toHaveLength(1);
    s = deleteView(s, "v1");
    expect(s.views.map((v) => v.id)).toEqual(["v2"]);
    expect(s.pins).toEqual([]);
  });

  it("pins and unpins an object per cluster", () => {
    const ref = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "shop", name: "web-0" };
    let s = togglePin(defaultAppSettings(), objectPinOf("c1", ref));
    expect(isPinned(s, objectPinOf("c1", ref))).toBe(true);
    expect(isPinned(s, objectPinOf("c2", ref))).toBe(false);
    expect(pinsFor(s, "c1")).toHaveLength(1);
    s = togglePin(s, objectPinOf("c1", ref));
    expect(s.pins).toEqual([]);
  });

  it("a workspace filters the rail's clusters and keeps the active cluster shown", () => {
    let s = withWorkspace(defaultAppSettings(), { id: "w1", name: "Prod", clusters: ["c1"] });
    expect(workspaceClusters(CLUSTERS, s, null).map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    s = switchWorkspace(s, "w1");
    expect(workspaceClusters(CLUSTERS, s, null).map((c) => c.id)).toEqual(["c1"]);
    expect(workspaceClusters(CLUSTERS, s, "c3").map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(switchWorkspace(s, "gone").activeWorkspace).toBeNull();
    expect(workspaceClusters(CLUSTERS, switchWorkspace(s, null), null)).toHaveLength(3);
  });
});

/** Settings full of things that must never leave the machine. */
function sensitiveSettings(): AppSettings {
  const s = withWorkspace(withView(defaultAppSettings(), VIEW), { id: "w1", name: "Prod", clusters: ["c1", "c2"] });
  return {
    ...s,
    kubeconfigSources: [{ id: "s9", path: "/secret/kubeconfig-with-token", kind: "pasted", error: null }],
    helmPath: "/opt/helm-TOKEN-PATH",
    mcp: { enabled: true, port: 47391 },
    extensions: [
      {
        id: "leaky-ext",
        version: "1.0.0",
        name: "Leaky extension",
        source: { type: "file", name: "leaky.sextant-ext" },
        enabled: true,
        granted: { clusters: { type: "all" }, rules: [] },
        installedAt: 1,
      } as unknown as AppSettings["extensions"][number],
    ],
    clusters: {
      c1: {
        displayName: "Production",
        color: "#ce3933",
        namespaces: ["shop"],
        lastView: "SECRET-LAST-VIEW",
        prometheus: { mode: "auto" },
        usageSource: "auto",
        icon: { type: "text", text: "P" },
        agentAccess: { preset: "readOnly", rules: [] },
        agentAccessUnrecognised: { bearerToken: "eyJhbGciOiJSUzI1NiJ9.SECRET" },
        argocdNamespace: "argocd-SECRET-NS",
        previewChanges: true,
      } as AppSettings["clusters"][string],
    },
  };
}

describe("export", () => {
  it("names clusters by reference and never carries secrets, unread access, extensions or other settings", () => {
    const text = exportText(buildExport(sensitiveSettings(), CLUSTERS, SOURCES, { includeAgentAccess: false }));
    const file = JSON.parse(text);
    expect(Object.keys(file).sort()).toEqual(["clusters", "customColumns", "format", "pins", "snippets", "version", "views", "workspaces"]);
    expect(file.clusters[0]).toEqual({
      id: "c1",
      context: "prod",
      source: { kind: "default", path: "/home/me/.kube/config" },
      settings: { displayName: "Production", color: "#ce3933", icon: { type: "text", text: "P" }, namespaces: ["shop"], previewChanges: true },
    });
    for (const leak of ["SECRET", "TOKEN", "eyJ", "leaky", "mcp", "47391", "kubeconfig-with-token", "agentAccess", "server", "admin", "readOnly"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("includes agent access rules only when asked, and never the unread value", () => {
    const text = exportText(buildExport(sensitiveSettings(), CLUSTERS, SOURCES, { includeAgentAccess: true }));
    const file = JSON.parse(text);
    expect(file.clusters[0].settings.agentAccess).toEqual({ preset: "readOnly", rules: [] });
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("eyJ");
  });
});

describe("import", () => {
  const exported = () => exportText(buildExport(sensitiveSettings(), CLUSTERS, SOURCES, { includeAgentAccess: true }));

  it("rejects unknown fields, naming each", () => {
    const file = JSON.parse(exported());
    file.extra = 1;
    file.clusters[0].settings.token = "abc";
    file.views[0].password = "x";
    let error: unknown;
    try {
      parseImport(JSON.stringify(file));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ImportError);
    const problems = (error as ImportError).problems;
    expect(problems).toContain("$.extra: unknown field");
    expect(problems).toContain("$.clusters[0].settings.token: unknown field");
    expect(problems).toContain("$.views[0].password: unknown field");
  });

  it("rejects another format, another version, bad types and non-JSON", () => {
    expect(() => parseImport("not json")).toThrow(ImportError);
    expect(() => parseImport(JSON.stringify({ ...JSON.parse(exported()), format: "x" }))).toThrow(ImportError);
    expect(() => parseImport(JSON.stringify({ ...JSON.parse(exported()), version: 5 }))).toThrow(ImportError);
    const bad = JSON.parse(exported());
    bad.views[0].onlyProblems = "yes";
    bad.views[0].id = "../x";
    expect(() => parseImport(JSON.stringify(bad))).toThrow(/onlyProblems: not true or false.*id: not a valid id|id: not a valid id.*onlyProblems/);
  });

  it("previews per section and lists clusters this machine does not have as missing", () => {
    const file = parseImport(exported());
    // Another machine: c1 under another id (same path and context), no c2, a local view v1 that differs.
    const local: AppSettings = withView(defaultAppSettings(), { ...VIEW, cluster: "x1", name: "Mine" });
    const localClusters = [cluster("x1", "prod")];
    const plan = planImport(file, local, localClusters, SOURCES);
    const prod = plan.clusters.find((c) => c.context === "prod")!;
    expect(prod.localId).toBe("x1");
    expect(prod.match).toBe("exact");
    expect(prod.added.sort()).toEqual(["color", "displayName", "icon", "namespaces", "previewChanges"]);
    // The local agent access is Off: a choice, so the file's rules change it (only with overwriting allowed).
    expect(prod.changed).toEqual(["agentAccess"]);
    expect(plan.clusters.find((c) => c.context === "staging")!.localId).toBeNull();
    expect(plan.views[0]).toMatchObject({ status: "changed", entry: { id: "v1", cluster: "x1" } });
    expect(plan.workspaces[0]).toMatchObject({ status: "added", entry: { clusters: ["x1"] } });
    expect(plan.hasAgentAccess).toBe(true);

    // Nothing is overwritten and no agent access is taken unless chosen.
    const kept = applyImport(local, plan, { overwrite: false, agentAccess: false });
    expect(kept.views[0]!.name).toBe("Mine");
    expect(kept.clusters.x1!.agentAccess).toEqual({ preset: "off", rules: [] });
    expect(kept.clusters.x1!.displayName).toBe("Production");
    expect(kept.workspaces).toHaveLength(1);
    expect(Object.keys(kept.clusters)).toEqual(["x1"]);

    const ticked = applyImport(local, plan, { overwrite: false, agentAccess: true });
    expect(ticked.clusters.x1!.agentAccess).toEqual({ preset: "off", rules: [] });

    const replaced = applyImport(local, plan, { overwrite: true, agentAccess: true });
    expect(replaced.views[0]!.name).toBe("Failing deployments");
    expect(replaced.clusters.x1!.agentAccess).toEqual({ preset: "readOnly", rules: [] });
  });

  it("never applies agent access to a cluster that only shares the context name", () => {
    const file = parseImport(exported());
    // The only local "prod" comes from another kubeconfig file: matched by name only.
    const plan = planImport(file, defaultAppSettings(), [cluster("y1", "prod", "s2")], SOURCES);
    const prod = plan.clusters.find((c) => c.context === "prod")!;
    expect(prod).toMatchObject({ localId: "y1", match: "name", agentAccessSkipped: true });
    expect([...prod.added, ...prod.changed]).not.toContain("agentAccess");
    expect(plan.hasAgentAccess).toBe(false);
    const applied = applyImport(defaultAppSettings(), plan, { overwrite: true, agentAccess: true });
    expect(applied.clusters.y1?.agentAccess ?? { preset: "off", rules: [] }).toEqual({ preset: "off", rules: [] });
    expect(applied.clusters.y1!.displayName).toBe("Production");
  });

  it("skips views and pins of missing clusters and keeps what is already the same", () => {
    const s = togglePin(sensitiveSettings(), { id: "p1", cluster: "c1", target: { type: "view", view: "v1" } });
    const file = parseImport(exportText(buildExport(s, CLUSTERS, SOURCES, { includeAgentAccess: false })));
    const same = planImport(file, s, CLUSTERS, SOURCES);
    expect(same.views.map((v) => v.status)).toEqual(["kept"]);
    expect(same.pins.map((p) => p.status)).toEqual(["kept"]);
    const empty = planImport(file, defaultAppSettings(), [cluster("z", "elsewhere")], SOURCES);
    expect(empty.views.map((v) => v.status)).toEqual(["skipped"]);
    expect(empty.pins.map((p) => p.status)).toEqual(["skipped"]);
    expect(empty.clusters.every((c) => c.localId === null)).toBe(true);
  });
});
