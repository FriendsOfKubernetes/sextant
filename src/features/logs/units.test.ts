import { describe, expect, it } from "vitest";
import { appendLines, bufferOf, EMPTY_BUFFER, LOG_BUFFER_LIMIT, LOG_BUFFER_TEXT_LIMIT, markCutLines, type LogBuffer } from "./buffer";
import { findMatches, splitLine } from "./search";
import { labelSelectorOf } from "./selector";

describe("log buffer", () => {
  const texts = (b: LogBuffer) => ({ lines: b.lines.toArray(), dropped: b.dropped });

  it("keeps everything below the limit", () => {
    const b = appendLines(appendLines(EMPTY_BUFFER, ["a", "b"]), ["c"]);
    expect(texts(b)).toEqual({ lines: ["a", "b", "c"], dropped: 0 });
  });

  it("keeps the newest lines above the limit and counts the discarded ones", () => {
    const b = appendLines(bufferOf(["1", "2", "3"]), ["4", "5"], 4);
    expect(texts(b)).toEqual({ lines: ["2", "3", "4", "5"], dropped: 1 });
    const c = appendLines(b, ["6"], 4);
    expect(texts(c)).toEqual({ lines: ["3", "4", "5", "6"], dropped: 2 });
  });

  it("a single batch larger than the limit keeps its tail", () => {
    const batch = Array.from({ length: 10 }, (_, i) => `l${i}`);
    expect(texts(appendLines(bufferOf(["old"]), batch, 3))).toEqual({ lines: ["l7", "l8", "l9"], dropped: 8 });
  });

  it("the default limits are 100 000 lines and 32 MiB of text", () => {
    expect(LOG_BUFFER_LIMIT).toBe(100_000);
    expect(LOG_BUFFER_TEXT_LIMIT).toBe(32 * 1024 * 1024);
  });

  it("drops the oldest lines once the text is over its size limit, keeping at least the newest line", () => {
    const b = appendLines(bufferOf(["aaaa", "bbbb"]), ["cccc", "dd"], 100, 9);
    expect(texts(b)).toEqual({ lines: ["cccc", "dd"], dropped: 2 });
    expect(b.lines.size).toBe(6);
    expect(texts(appendLines(b, ["x".repeat(50)], 100, 9))).toEqual({ lines: ["x".repeat(50)], dropped: 4 });
  });

  it("the default size limit holds against long lines well below the line limit", () => {
    const line = "y".repeat(64 * 1024);
    let b = EMPTY_BUFFER;
    for (let i = 0; i < 1_000; i++) b = appendLines(b, [line, line]);
    expect(b.lines.size).toBeLessThanOrEqual(LOG_BUFFER_TEXT_LIMIT);
    expect(b.lines.length).toBe(LOG_BUFFER_TEXT_LIMIT / line.length);
    expect(b.dropped).toBe(2_000 - b.lines.length);
  });

  it("reads lines by index across chunks, after drops, and leaves older buffers unchanged", () => {
    const all = Array.from({ length: 5_000 }, (_, i) => `l${i}`);
    let b = EMPTY_BUFFER;
    const snapshots: LogBuffer[] = [];
    for (let i = 0; i < all.length; i += 7) {
      b = appendLines(b, all.slice(i, i + 7), 3_000);
      snapshots.push(b);
    }
    expect(b.lines.length).toBe(3_000);
    expect(b.lines.at(0)).toBe("l2000");
    expect(b.lines.at(2_999)).toBe("l4999");
    expect(b.lines.at(3_000)).toBeUndefined();
    expect(b.lines.at(-1)).toBeUndefined();
    expect(b.lines.toArray()).toEqual(all.slice(2_000));
    // An older buffer still reads what it held.
    expect(snapshots[0]!.lines.toArray()).toEqual(all.slice(0, 7));
    expect(snapshots[300]!.lines.toArray()).toEqual(all.slice(0, 2_107));
  });

  it("appending shares the full chunks instead of copying every line", () => {
    const chunksOf = (b: LogBuffer) => (b.lines as unknown as { chunks: readonly (readonly string[])[] }).chunks;
    const big = bufferOf(Array.from({ length: 50_000 }, (_, i) => `l${i}`));
    const next = appendLines(big, ["one more"]);
    const before = chunksOf(big);
    const after = chunksOf(next);
    expect(after.length).toBe(before.length);
    // Every full chunk is the very same array; only the last, partial one was copied.
    for (let i = 0; i < before.length - 1; i++) expect(after[i]).toBe(before[i]);
    expect(after[after.length - 1]).not.toBe(before[before.length - 1]);
  });

  it("marks the lines the backend cut", () => {
    expect(markCutLines(["a", "b", "c"], [0, 2], "+")).toEqual(["a+", "b", "c+"]);
    const lines = ["a"];
    expect(markCutLines(lines, undefined, "+")).toBe(lines);
    expect(markCutLines(lines, [5], "+")).toEqual(["a"]);
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
