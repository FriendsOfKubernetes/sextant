// Custom columns (#214) in saved views and their export (#149): a view carries the columns its table showed, the
// export (version 3) carries the stored columns; older exports still import, and each version is read strictly.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, mockBackend, type AppSettings, type ClusterInfo, type KubeconfigSource } from "../../api";
import { loadSettings, resetSettingsCache } from "../../api/settings";
import { resetAppStore, tableStateOf, useAppStore } from "../../app/store";
import { resetNamespaceRestore } from "../namespaces";
import { applyView, captureView } from "../views/model";
import { applyImport, buildExport, exportText, ImportError, parseImport, planImport } from "../views/transfer";
import type { CustomColumn } from "./model";

const CLUSTERS: ClusterInfo[] = [
  { id: "c1", context: "prod", clusterName: "prod", server: "https://prod:6443", user: "u", namespace: null, sourceId: "s1" },
];
const SOURCES: KubeconfigSource[] = [{ id: "s1", path: "/home/me/.kube/config", kind: "default", error: null }];

const TEAM: CustomColumn = { cluster: null, group: "", kind: "Pod", source: "label", path: "team", title: "Team" };
const NODE: CustomColumn = { cluster: "c1", group: "", kind: "Pod", source: "field", path: ".spec.nodeName", title: "Node" };

function withColumns(columns: CustomColumn[]): AppSettings {
  return { ...defaultAppSettings(), customColumns: columns };
}

function problems(text: string): string[] {
  try {
    parseImport(text);
  } catch (err) {
    if (err instanceof ImportError) return err.problems;
    throw err;
  }
  return [];
}

beforeEach(() => {
  resetAppStore();
  resetSettingsCache();
  resetNamespaceRestore();
});
afterEach(() => {
  resetAppStore();
  resetSettingsCache();
});

describe("a saved view", () => {
  it("captures the custom columns its table shows and brings them back when applied", async () => {
    mockBackend({}, { settings: { customColumns: [TEAM, NODE] } });
    await loadSettings();
    const app = useAppStore.getState();
    app.setView("c1", "kind:/Pod");
    app.setTableState("c1", "kind:/Pod", { viewColumns: [{ source: "annotation", path: "example.com/owner", title: "" }] });
    const view = captureView("c1", "Pods", "all", "v1")!;
    expect(view.customColumns).toEqual([
      { source: "label", path: "team", title: "Team" },
      { source: "field", path: ".spec.nodeName", title: "Node" },
      { source: "annotation", path: "example.com/owner", title: "" },
    ]);

    await applyView("c2", view);
    const table = tableStateOf(useAppStore.getState().clusterViews.c2!, "kind:/Pod");
    expect(table.viewColumns).toEqual(view.customColumns);
  });

  it("without custom columns is saved as before, without the field", async () => {
    mockBackend();
    await loadSettings();
    useAppStore.getState().setView("c1", "kind:/Pod");
    expect(captureView("c1", "Pods", "all", "v1")).not.toHaveProperty("customColumns");
  });
});

describe("the export", () => {
  const settings = (): AppSettings => ({
    ...withColumns([TEAM, NODE]),
    views: [
      {
        id: "v1",
        name: "Pods",
        cluster: null,
        group: "",
        kind: "Pod",
        namespaces: null,
        search: "",
        onlyProblems: false,
        labelSelector: "",
        sort: { column: "custom:label:team", desc: false },
        hiddenColumns: [],
        customColumns: [{ source: "label", path: "team", title: "Team" }],
      },
    ],
  });
  const exported = () => JSON.parse(exportText(buildExport(settings(), CLUSTERS, SOURCES, { includeAgentAccess: false })));

  it("round-trips the custom columns and the views' columns", () => {
    const file = parseImport(JSON.stringify(exported()));
    expect(file.customColumns).toEqual([TEAM, NODE]);
    expect(file.views[0]!.customColumns).toEqual([{ source: "label", path: "team", title: "Team" }]);
    const plan = planImport(file, defaultAppSettings(), CLUSTERS, SOURCES);
    expect(plan.customColumns.map((c) => [c.label, c.status])).toEqual([
      ["Pod Team", "added"],
      ["Pod Node", "added"],
    ]);
    const next = applyImport(defaultAppSettings(), plan, { overwrite: false, agentAccess: false });
    expect(next.customColumns).toEqual([TEAM, NODE]);
    expect(next.views[0]!.customColumns).toEqual(file.views[0]!.customColumns);
  });

  it("previews kept, changed and skipped columns; a changed header replaces only when overwriting", () => {
    const file = parseImport(JSON.stringify(exported()));
    const local = withColumns([{ ...TEAM, title: "Owner team" }, NODE]);
    const plan = planImport(file, local, [], []);
    // Without cluster c1 here, its column is skipped.
    expect(plan.customColumns.map((c) => c.status)).toEqual(["changed", "skipped"]);
    expect(applyImport(local, plan, { overwrite: false, agentAccess: false }).customColumns![0]!.title).toBe("Owner team");
    expect(applyImport(local, plan, { overwrite: true, agentAccess: false }).customColumns![0]!.title).toBe("Team");
  });

  it("reads older exports, which have no custom columns", () => {
    const v2 = { ...exported(), version: 2 };
    delete v2.customColumns;
    delete v2.views[0].customColumns;
    const file = parseImport(JSON.stringify(v2));
    expect(file.customColumns).toEqual([]);
    expect(file.views[0]).not.toHaveProperty("customColumns");
    const v1 = { ...v2, version: 1 };
    delete v1.snippets;
    expect(parseImport(JSON.stringify(v1)).customColumns).toEqual([]);
  });

  it("is strict: the fields of a newer version, a missing section and bad columns are errors", () => {
    const v2 = { ...exported(), version: 2 };
    expect(problems(JSON.stringify(v2))).toEqual(
      expect.arrayContaining(["$.customColumns: unknown field", "$.views[0].customColumns: unknown field"]),
    );
    const missing = exported();
    delete missing.customColumns;
    expect(problems(JSON.stringify(missing))).toEqual(["$.customColumns: missing"]);
    const bad = exported();
    bad.customColumns = [
      { cluster: null, group: "", kind: "Secret", source: "field", path: ".data.password", title: "" },
      { cluster: null, group: "", kind: "Pod", source: "field", path: ".spec.containers[*]", title: "" },
      { cluster: null, group: "", kind: "Pod", source: "jsonpath", path: "x", title: "" },
      { cluster: null, group: "", kind: "Pod", source: "label", path: "app", title: "", extra: 1 },
    ];
    bad.views[0].customColumns = [{ source: "field", path: "{.spec}", title: "" }];
    expect(problems(JSON.stringify(bad))).toEqual(
      expect.arrayContaining([
        "$.customColumns[0].path: a Secret's data or stringData is never a column",
        "$.customColumns[1]: not a valid column (pathInvalid)",
        '$.customColumns[2].source: not "label", "annotation" or "field"',
        "$.customColumns[3].extra: unknown field",
        "$.views[0].customColumns[0]: not a valid column (pathInvalid)",
      ]),
    );
  });
});
