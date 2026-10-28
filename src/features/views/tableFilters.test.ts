import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, getSettingsSnapshot, loadSettings, mockBackend, type AppSettings, type ClusterInfo, type KubeconfigSource } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import type { TableFilters } from "../../api/generated/TableFilters";
import { resetAppStore, useAppStore } from "../../app/store";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { resetNamespaceRestore } from "../namespaces";
import { EMPTY_TABLE_FILTERS } from "../table-filters/model";
import { getTableFilters, resetTableFiltersState, setTableFilters } from "../table-filters/state";
import { applyView, captureView, type SavedView } from "./model";
import { applyImport, buildExport, exportText, ImportError, parseImport, planImport } from "./transfer";

const POD = "kind:/Pod";
const DEPLOYMENT = "kind:apps/Deployment";
const FILTERS: TableFilters = {
  columns: { owner: { values: { mode: "exclude", values: ["Job", null] }, condition: null } },
  advanced: { type: "group", operator: "or", children: [
    { type: "rule", column: "name", condition: { operator: "startsWith", value: "web" } },
    { type: "rule", column: "age", condition: { operator: "between", value: 60_000, upper: 120_000 } },
  ] },
};
const OTHER: TableFilters = { columns: { ready: { values: null, condition: { operator: "eq", value: true } } }, advanced: null };
const VIEW: SavedView = {
  id: "v1", name: "Pods", cluster: "c1", group: "", kind: "Pod", namespaces: ["shop"], search: "web",
  onlyProblems: false, labelSelector: "app=web", sort: null, hiddenColumns: [],
};
const CLUSTERS: ClusterInfo[] = [{ id: "c1", context: "prod", clusterName: "prod", server: "https://prod", user: "admin", namespace: null, sourceId: "s1" }];
const SOURCES: KubeconfigSource[] = [{ id: "s1", path: "/home/me/.kube/config", kind: "default", error: null }];
const withFilters = (tableFilters: Record<string, TableFilters> = { [POD]: FILTERS }): AppSettings => ({
  ...defaultAppSettings(), clusters: { c1: { ...defaultClusterSettings(), tableFilters } }, views: [{ ...VIEW, tableFilters: FILTERS }],
});
const wire = () => JSON.parse(exportText(buildExport(withFilters(), CLUSTERS, SOURCES, { includeAgentAccess: false })));
function problems(value: unknown): string[] {
  try { parseImport(JSON.stringify(value)); }
  catch (error) { if (error instanceof ImportError) return error.problems; throw error; }
  return [];
}

beforeEach(() => { resetTableFiltersState(); resetSettingsCache(); resetAppStore(); resetNamespaceRestore(); });
afterEach(() => { resetTableFiltersState(); resetSettingsCache(); resetAppStore(); });

describe("saved view table filters", () => {
  it("captures the optimistic filters for the open cluster and kind before persistence finishes", async () => {
    mockBackend();
    await loadSettings();
    useAppStore.getState().setView("c1", POD);
    const saving = setTableFilters("c1", POD, FILTERS);
    const view = captureView("c1", "Pods", "all", "v2")!;
    expect(view.tableFilters).toEqual(FILTERS);
    expect(view.tableFilters).not.toBe(getTableFilters("c1", POD));
    await saving;
    await setTableFilters("c1", POD, OTHER);
    expect(view.tableFilters).toEqual(FILTERS);
    useAppStore.getState().setView("c1", DEPLOYMENT);
    expect(captureView("c1", "Deployments", "all", "v3")).not.toHaveProperty("tableFilters");
    useAppStore.getState().setView("c2", POD);
    expect(captureView("c2", "Pods", "all", "v4")).not.toHaveProperty("tableFilters");
  });

  it("applies saved filters and namespaces, and an old saved view clears only its own target table", async () => {
    mockBackend();
    await loadSettings();
    await setTableFilters("c1", DEPLOYMENT, OTHER);
    await setTableFilters("c2", POD, OTHER);
    await applyView("c1", { ...VIEW, tableFilters: FILTERS });
    expect(getTableFilters("c1", POD)).toEqual(FILTERS);
    expect(getSettingsSnapshot()!.clusters.c1!.namespaces).toEqual(["shop"]);
    await applyView("c1", VIEW);
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", DEPLOYMENT)).toEqual(OTHER);
    expect(getTableFilters("c2", POD)).toEqual(OTHER);
  });

  it("propagates filter save errors while keeping the applied filters visible in the session", async () => {
    mockBackend({ settings_update: () => { throw new Error("cannot save view filters"); } });
    await loadSettings();
    await expect(applyView("c1", { ...VIEW, tableFilters: FILTERS })).rejects.toThrow("cannot save view filters");
    expect(getTableFilters("c1", POD)).toEqual(FILTERS);
  });
});

describe("version 4 filter transfer", () => {
  it("round-trips the cluster map and saved-view filters, and previews the new shared field", () => {
    const exported = wire();
    expect(exported.version).toBe(4);
    expect(exported.clusters[0].settings.tableFilters).toEqual({ [POD]: FILTERS });
    const file = parseImport(JSON.stringify(exported));
    expect(file.views[0]!.tableFilters).toEqual(FILTERS);
    const plan = planImport(file, defaultAppSettings(), CLUSTERS, SOURCES);
    expect(plan.clusters[0]!.added).toContain("tableFilters");
    const next = applyImport(defaultAppSettings(), plan, { overwrite: false, agentAccess: false });
    expect(next.clusters.c1!.tableFilters).toEqual({ [POD]: FILTERS });
    expect(next.views[0]!.tableFilters).toEqual(FILTERS);
  });

  it("omits an empty cluster map from exports", () => {
    const file = buildExport(withFilters({}), CLUSTERS, SOURCES, { includeAgentAccess: false });
    expect(file.clusters[0]!.settings).not.toHaveProperty("tableFilters");
  });

  it("puts the file's tables over the same tables only when overwriting, keeping this machine's other tables (#294)", () => {
    const local = withFilters({ [POD]: OTHER, [DEPLOYMENT]: OTHER });
    const file = parseImport(JSON.stringify(wire()));
    const plan = planImport(file, local, CLUSTERS, SOURCES);
    expect(plan.clusters[0]!.changed).toContain("tableFilters");
    expect(applyImport(local, plan, { overwrite: false, agentAccess: false }).clusters.c1!.tableFilters![POD]).toEqual(OTHER);
    const next = applyImport(local, plan, { overwrite: true, agentAccess: false });
    expect(next.clusters.c1!.tableFilters).toEqual({ [POD]: FILTERS, [DEPLOYMENT]: OTHER });
  });

  it("never applies table filters to a cluster matched by its context name only (#294)", () => {
    const incoming = wire();
    incoming.clusters[0].id = "elsewhere:prod";
    incoming.clusters[0].source.path = "/home/colleague/.kube/config";
    const local = withFilters({});
    const plan = planImport(parseImport(JSON.stringify(incoming)), local, CLUSTERS, SOURCES);
    expect(plan.clusters[0]!.match).toBe("name");
    expect(plan.clusters[0]!.filtersSkipped).toBe(true);
    expect([...plan.clusters[0]!.added, ...plan.clusters[0]!.changed]).not.toContain("tableFilters");
    expect(applyImport(local, plan, { overwrite: true, agentAccess: false }).clusters.c1!.tableFilters).toEqual({});
  });

  it("an empty map in the file changes nothing: filters are merged table by table, never cleared by an import", () => {
    const incoming = wire();
    incoming.clusters[0].settings.tableFilters = {};
    const local = withFilters();
    const plan = planImport(parseImport(JSON.stringify(incoming)), local, CLUSTERS, SOURCES);
    expect([...plan.clusters[0]!.added, ...plan.clusters[0]!.changed]).not.toContain("tableFilters");
    expect(applyImport(local, plan, { overwrite: true, agentAccess: false }).clusters.c1!.tableFilters).toEqual({ [POD]: FILTERS });
  });

  it.each([1, 2, 3])("reads version %i without changing the cluster filter map when overwriting an old saved view", (version) => {
    const old = wire();
    old.version = version;
    delete old.clusters[0].settings.tableFilters;
    delete old.views[0].tableFilters;
    old.views[0].name = "Renamed by old version";
    if (version < 3) delete old.customColumns;
    if (version < 2) delete old.snippets;
    const file = parseImport(JSON.stringify(old));
    expect(file.clusters[0]!.settings).not.toHaveProperty("tableFilters");
    expect(file.views[0]).not.toHaveProperty("tableFilters");
    const local = withFilters();
    const plan = planImport(file, local, CLUSTERS, SOURCES);
    expect([...plan.clusters[0]!.added, ...plan.clusters[0]!.changed]).not.toContain("tableFilters");
    const next = applyImport(local, plan, { overwrite: true, agentAccess: false });
    expect(next.clusters.c1!.tableFilters).toEqual(local.clusters.c1!.tableFilters);
    expect(next.views[0]!.name).toBe("Renamed by old version");
    expect(next.views[0]).not.toHaveProperty("tableFilters");
  });

  it.each([1, 2, 3])("rejects filter fields in version %i instead of silently accepting newer data", (version) => {
    const old = wire();
    old.version = version;
    old.clusters[0].settings.tableFilters = { [POD]: FILTERS };
    if (version < 3) delete old.customColumns;
    if (version < 2) delete old.snippets;
    expect(problems(old)).toEqual(expect.arrayContaining([
      "$.clusters[0].settings.tableFilters: unknown field", "$.views[0].tableFilters: unknown field",
    ]));
  });

  it("honors an explicit empty v4 saved-view filter value", () => {
    const incoming = wire();
    incoming.views[0].tableFilters = EMPTY_TABLE_FILTERS;
    const local = withFilters();
    const plan = planImport(parseImport(JSON.stringify(incoming)), local, CLUSTERS, SOURCES);
    expect(applyImport(local, plan, { overwrite: true, agentAccess: false }).views[0]!.tableFilters).toEqual(EMPTY_TABLE_FILTERS);
  });

  it("rejects an invalid branch of a saved OR expression with its full path", () => {
    const file = wire();
    file.views[0].tableFilters.advanced.children[1].condition.operator = "regex";
    expect(problems(file)).toContain("$.views[0].tableFilters.advanced.children[1].condition.operator: unknown operator");
  });

  it("rejects a malformed cluster filter branch with its full map path", () => {
    const file = wire();
    file.clusters[0].settings.tableFilters = { [POD]: structuredClone(FILTERS) };
    file.clusters[0].settings.tableFilters[POD].advanced.children[1].unexpected = true;
    expect(problems(file)).toContain(`$.clusters[0].settings.tableFilters.${POD}.advanced.children[1].unexpected: unknown field`);
  });

  it("rejects invalid table ids and oversized imported maps", () => {
    const file = wire();
    file.clusters[0].settings.tableFilters = { overview: FILTERS };
    expect(problems(file)).toContain("$.clusters[0].settings.tableFilters.overview: invalid resource view id");
    file.clusters[0].settings.tableFilters = Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`kind:/Kind${i}`, OTHER]));
    expect(problems(file)).toContain("$.clusters[0].settings.tableFilters: too many tables");
  });
});
