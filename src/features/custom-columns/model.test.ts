// Custom columns (#214) in the settings: which columns a table shows, and adding and removing them within the caps.
import { describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings } from "../../api";
import { MAX_COLUMNS_PER_KIND, shownColumns, withColumn, withoutColumn, type CustomColumn } from "./model";

const POD = { group: "", kind: "Pod" };

function col(cluster: string | null, path: string, title = "", kind = "Pod"): CustomColumn {
  return { cluster, group: "", kind, source: "label", path, title };
}

function settingsWith(customColumns: CustomColumn[]): AppSettings {
  return { ...defaultAppSettings(), customColumns };
}

describe("shown columns", () => {
  it("are this cluster's and every cluster's of the kind, a cluster's winning, then the view's", () => {
    const settings = settingsWith([
      col(null, "app", "App (all)"),
      col("c1", "tier"),
      col("c2", "other"),
      col("c1", "app", "App (c1)"),
      col(null, "x", "", "Service"),
    ]);
    const shown = shownColumns(settings, "c1", POD, [
      { source: "label", path: "tier", title: "dup" },
      { source: "field", path: ".spec.nodeName", title: "Node" },
    ]);
    expect(shown.map((c) => [c.id, c.scope, c.spec.title])).toEqual([
      ["custom:label:app", "cluster", "App (c1)"],
      ["custom:label:tier", "cluster", ""],
      ["custom:field:.spec.nodeName", "view", "Node"],
    ]);
  });

  it("leave out what the rules do not allow on the kind (a hand-edited file)", () => {
    const settings = settingsWith([
      { cluster: null, group: "", kind: "Secret", source: "field", path: ".data.password", title: "" },
      { cluster: null, group: "", kind: "Secret", source: "field", path: ".type", title: "" },
    ]);
    expect(shownColumns(settings, "c1", { group: "", kind: "Secret" }).map((c) => c.spec.path)).toEqual([".type"]);
    expect(
      shownColumns(defaultAppSettings(), "c1", { group: "", kind: "Secret" }, [
        { source: "field", path: ".stringData.x", title: "" },
      ]),
    ).toEqual([]);
  });
});

describe("changes", () => {
  it("add a column per kind and scope, refuse a repeated one and stop at the cap", () => {
    let settings = defaultAppSettings();
    const added = withColumn(settings, "c1", POD, { source: "label", path: "app", title: "" });
    expect("problem" in added).toBe(false);
    settings = added as AppSettings;
    expect(settings.customColumns).toEqual([col("c1", "app")]);
    expect(withColumn(settings, "c1", POD, { source: "label", path: "app", title: "Other" })).toEqual({ problem: "duplicate" });
    // The same column for every cluster is another entry.
    expect("problem" in withColumn(settings, null, POD, { source: "label", path: "app", title: "" })).toBe(false);

    for (let i = 1; i < MAX_COLUMNS_PER_KIND; i++)
      settings = withColumn(settings, "c1", POD, { source: "label", path: `k${i}`, title: "" }) as AppSettings;
    expect(settings.customColumns).toHaveLength(MAX_COLUMNS_PER_KIND);
    expect(withColumn(settings, "c1", POD, { source: "label", path: "more", title: "" })).toEqual({ problem: "full" });
    expect("problem" in withColumn(settings, "c2", POD, { source: "label", path: "more", title: "" })).toBe(false);
  });

  it("remove only the column of that scope", () => {
    const settings = settingsWith([col("c1", "app"), col(null, "app"), col("c1", "tier")]);
    expect(withoutColumn(settings, "c1", POD, "custom:label:app").customColumns).toEqual([col(null, "app"), col("c1", "tier")]);
    expect(withoutColumn(settings, null, POD, "custom:label:app").customColumns).toEqual([col("c1", "app"), col("c1", "tier")]);
    expect(withoutColumn(settings, "c2", POD, "custom:label:app")).toBe(settings);
  });
});
