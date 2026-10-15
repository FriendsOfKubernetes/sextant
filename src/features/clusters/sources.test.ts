import { describe, expect, it } from "vitest";
import type { SourceKind } from "../../api";
import en from "../../locales/en/clusters.json";
import { isRemovableSource, removeConfirmKey } from "./sources";

const ALL: SourceKind[] = ["default", "env", "addedFile", "pasted", "cloud"];

describe("kubeconfig source policy", () => {
  it("lets only added, pasted and cloud sources be removed", () => {
    expect(ALL.filter(isRemovableSource)).toEqual(["addedFile", "pasted", "cloud"]);
  });

  it("names what removing does to the file", () => {
    expect(removeConfirmKey("addedFile")).toBe("clusters:sources.confirmFile");
    expect(removeConfirmKey("pasted")).toBe("clusters:sources.confirmPasted");
    expect(removeConfirmKey("cloud")).toBe("clusters:sources.confirmCloud");
    expect(removeConfirmKey(undefined)).toBe("clusters:sources.confirmFile");
  });

  it("uses keys that exist in the English strings", () => {
    const sources = (en as { sources: Record<string, unknown> }).sources;
    for (const kind of ALL.filter(isRemovableSource)) {
      const key = removeConfirmKey(kind).replace("clusters:sources.", "");
      expect(typeof sources[key]).toBe("string");
    }
  });
});
