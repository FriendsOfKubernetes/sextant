import { describe, expect, it } from "vitest";
import type { KubeObject } from "./commands";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import { applyWatchUpdate, isCapped, type WatchState } from "./watchState";

const obj = (uid: string, rv = "1"): JsonValue => ({ metadata: { uid, name: uid, resourceVersion: rv } }) as JsonValue;
const EMPTY: WatchState = { items: new Map(), status: "loading" };

describe("a list sent in parts", () => {
  it("adds up while it loads and is complete with its end", () => {
    let state = applyWatchUpdate(EMPTY, { type: "snapshotPart", items: [obj("a"), obj("b")] });
    expect(state.status).toBe("loading");
    expect([...state.items.keys()]).toEqual(["a", "b"]);
    const before = state.items;
    state = applyWatchUpdate(state, { type: "snapshotPart", items: [obj("c")] });
    expect(before.size).toBe(2);
    state = applyWatchUpdate(state, { type: "snapshotEnd", items: [obj("b", "2"), obj("d")], deleted: ["a"] });
    expect(state.status).toBe("ready");
    expect([...state.items.keys()].sort()).toEqual(["b", "c", "d"]);
    expect((state.items.get("b") as KubeObject).metadata?.resourceVersion).toBe("2");
  });

  it("knows how many match when the watch keeps only the first ones", () => {
    let state = applyWatchUpdate(EMPTY, { type: "snapshot", items: [obj("a")] });
    expect(isCapped(state)).toBe(false);
    state = applyWatchUpdate(state, { type: "capped", total: 3 });
    expect(isCapped(state)).toBe(true);
    expect(applyWatchUpdate(state, { type: "capped", total: 3 })).toBe(state);
    // A delta and a later snapshot keep the total until the backend says otherwise.
    state = applyWatchUpdate(state, { type: "delta", upserted: [obj("b")], deleted: [] });
    expect(state.total).toBe(3);
    state = applyWatchUpdate(state, { type: "capped", total: 2 });
    expect(isCapped(state)).toBe(false);
  });
});
