import { describe, expect, it } from "vitest";
import { appendLines, LOG_BUFFER_LIMIT } from "./buffer";
import { findMatches, splitLine } from "./search";
import { labelSelectorOf } from "./selector";

describe("log buffer", () => {
  it("keeps everything below the limit", () => {
    const b = appendLines(appendLines({ lines: [], dropped: 0 }, ["a", "b"]), ["c"]);
    expect(b).toEqual({ lines: ["a", "b", "c"], dropped: 0 });
  });

  it("keeps the newest lines above the limit and counts the discarded ones", () => {
    const b = appendLines({ lines: ["1", "2", "3"], dropped: 0 }, ["4", "5"], 4);
    expect(b).toEqual({ lines: ["2", "3", "4", "5"], dropped: 1 });
    const c = appendLines(b, ["6"], 4);
    expect(c).toEqual({ lines: ["3", "4", "5", "6"], dropped: 2 });
  });

  it("a single batch larger than the limit keeps its tail", () => {
    const batch = Array.from({ length: 10 }, (_, i) => `l${i}`);
    expect(appendLines({ lines: ["old"], dropped: 0 }, batch, 3)).toEqual({ lines: ["l7", "l8", "l9"], dropped: 8 });
  });

  it("the default limit is 100 000 lines", () => {
    expect(LOG_BUFFER_LIMIT).toBe(100_000);
  });
});

describe("search", () => {
  it("finds every occurrence, ignoring case, in order", () => {
    expect(findMatches(["Error: a", "fine", "error error"], "ERROR")).toEqual([
      { line: 0, start: 0 },
      { line: 2, start: 0 },
      { line: 2, start: 6 },
    ]);
  });

  it("an empty query matches nothing", () => {
    expect(findMatches(["a"], "")).toEqual([]);
  });

  it("splits a line into plain and matching parts", () => {
    expect(splitLine("an Error and error", "error")).toEqual([
      { text: "an ", match: false },
      { text: "Error", match: true },
      { text: " and ", match: false },
      { text: "error", match: true },
    ]);
    expect(splitLine("nothing", "x")).toEqual([{ text: "nothing", match: false }]);
  });
});

describe("workload pod selector", () => {
  it("builds a label selector from matchLabels and matchExpressions", () => {
    expect(
      labelSelectorOf({
        spec: {
          selector: {
            matchLabels: { app: "web", tier: "fe" },
            matchExpressions: [
              { key: "env", operator: "In", values: ["a", "b"] },
              { key: "x", operator: "NotIn", values: ["y"] },
              { key: "has", operator: "Exists" },
              { key: "lacks", operator: "DoesNotExist" },
            ],
          },
        },
      }),
    ).toBe("app=web,tier=fe,env in (a,b),x notin (y),has,!lacks");
  });

  it("is null without a selector", () => {
    expect(labelSelectorOf({ spec: {} })).toBeNull();
    expect(labelSelectorOf({ spec: { selector: {} } })).toBeNull();
  });
});
