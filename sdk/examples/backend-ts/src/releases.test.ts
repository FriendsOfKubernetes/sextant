import { describe, expect, it } from "vitest";
import { summaryLines } from "./releases";

describe("summaryLines", () => {
  it("tells the clusters and the release, or why there is none", () => {
    expect(summaryLines({ clusters: 2, latest: { tag: "v0.26.0", published: "2026-11-01T10:00:00Z" } })).toEqual([
      "Clusters this extension may see: 2",
      "Latest Sextant release: v0.26.0 (2026-11-01)",
    ]);
    expect(summaryLines({ clusters: 0, latest: null, error: "GitHub answered 403" })[1]).toBe(
      "The latest release could not be read: GitHub answered 403",
    );
  });
});
