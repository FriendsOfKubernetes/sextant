import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { explainSnapshot, snapshotState } from "./model";

describe("snapshots", () => {
  it("ready, failed with the driver's message, or waiting", () => {
    const snap = (status: Record<string, unknown>): KubeObject => ({ metadata: { name: "s" }, status });
    expect(snapshotState(snap({ readyToUse: true })).word).toBe("Ready");
    expect(snapshotState(snap({ readyToUse: false, error: { message: "quota" } }))).toEqual({ word: "Failed", tone: "danger" });
    expect(explainSnapshot(snap({ error: { message: "quota" } }))?.params).toEqual({ message: "quota" });
    expect(explainSnapshot(snap({}))?.key).toBe("snapshot.explain.unbound");
    expect(explainSnapshot(snap({ boundVolumeSnapshotContentName: "c" }))?.key).toBe("snapshot.explain.pending");
  });
});
