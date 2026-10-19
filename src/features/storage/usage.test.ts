import { describe, expect, it } from "vitest";
import type { VolumeUsage } from "../../api";
import { bytesPercent, claimLevel, clampPercent, diskProblems, inodesPercent, levelOf, thresholdsOf } from "./usage";

const vol = (claim: string, used: number, capacity = 100, extra: Partial<VolumeUsage> = {}): VolumeUsage => ({
  namespace: "db",
  claim,
  capacityBytes: capacity,
  usedBytes: used,
  availableBytes: capacity - used,
  inodes: null,
  inodesUsed: null,
  inodesFree: null,
  ...extra,
});

const FORMAT = { percent: (v: number) => `${v}%`, bytes: (v: number) => `${v}B`, count: (v: number) => String(v) };
const DEFAULTS = thresholdsOf(undefined);

describe("thresholds", () => {
  it("are 85 % and 95 % by default, clamped to 50–99, the critical one never below the warning", () => {
    expect(DEFAULTS).toEqual({ warn: 85, critical: 95 });
    expect(thresholdsOf({ volumeWarnPercent: 10, volumeCriticalPercent: 120 })).toEqual({ warn: 50, critical: 99 });
    expect(thresholdsOf({ volumeWarnPercent: 90, volumeCriticalPercent: 80 })).toEqual({ warn: 90, critical: 90 });
    expect(clampPercent("x", 85)).toBe(85);
    expect(clampPercent(87.6, 85)).toBe(88);
  });

  it("a level counts from its threshold on", () => {
    expect(levelOf(84.9, DEFAULTS)).toBe("ok");
    expect(levelOf(85, DEFAULTS)).toBe("warn");
    expect(levelOf(94.9, DEFAULTS)).toBe("warn");
    expect(levelOf(95, DEFAULTS)).toBe("critical");
    expect(levelOf(undefined, DEFAULTS)).toBe("ok");
  });

  it("space and inodes count the same: the worse decides", () => {
    const inodesFull = vol("a", 10, 100, { inodes: 1000, inodesUsed: 960, inodesFree: 40 });
    expect(bytesPercent(inodesFull)).toBe(10);
    expect(inodesPercent(inodesFull)).toBe(96);
    expect(claimLevel(inodesFull, DEFAULTS)).toBe("critical");
    // Without a capacity, used + available; without inodesUsed, total − free.
    expect(bytesPercent(vol("b", 90, 100, { capacityBytes: null }))).toBe(90);
    expect(inodesPercent(vol("c", 1, 100, { inodes: 100, inodesFree: 12 }))).toBe(88);
  });
});

describe("what counts as used", () => {
  it("is capacity − available when both are known: reserved blocks count, a volume with nothing available is full", () => {
    // ext4 keeps 5 % for root: the kubelet's used is 95 while nothing is available.
    const reserved = vol("ext4", 95, 100, { availableBytes: 0 });
    expect(bytesPercent(reserved)).toBe(100);
    const strict = thresholdsOf({ volumeWarnPercent: 98, volumeCriticalPercent: 99 });
    expect(claimLevel(reserved, strict)).toBe("critical");
    expect(diskProblems([reserved], strict, new Map(), 0, FORMAT)[0]!.messageParams).toEqual({ percent: "100%", used: "100B", capacity: "100B" });
    // Without available, the kubelet's used.
    expect(bytesPercent(vol("x", 40, 100, { availableBytes: null }))).toBe(40);
  });

  it("inodes: total − free when both are known, else the kubelet's used", () => {
    expect(inodesPercent(vol("a", 1, 100, { inodes: 100, inodesUsed: 50, inodesFree: 0 }))).toBe(100);
    expect(inodesPercent(vol("b", 1, 100, { inodes: 100, inodesUsed: 70, inodesFree: null }))).toBe(70);
  });
});

describe("diskProblems", () => {
  it("makes one problem per level crossed, of the claim, notifying, with the numbers in the message", () => {
    const seen = new Map<string, number>();
    const problems = diskProblems(
      [vol("ok", 50), vol("warn", 86), vol("crit", 99, 100, { inodes: 100, inodesUsed: 90, inodesFree: 10 })],
      DEFAULTS,
      seen,
      1000,
      FORMAT,
    );
    expect(problems.map((p) => [p.object.name, p.reason, p.group])).toEqual([
      ["warn", "AlmostFull", "disk-warn"],
      ["crit", "CriticallyFull", "disk-critical"],
      ["crit", "InodesAlmostFull", "inodes-warn"],
    ]);
    const [warn] = problems;
    expect(warn).toMatchObject({
      category: "disk",
      notify: true,
      uid: "claim:db/warn",
      key: "claim:db/warn|AlmostFull",
      notifyKey: "claim:db/warn|disk-warn",
      object: { kind: { group: "", version: "v1", kind: "PersistentVolumeClaim" }, namespace: "db", name: "warn" },
      messageKey: "messages.diskUsage",
      messageParams: { percent: "86%", used: "86B", capacity: "100B" },
      firstSeen: 1000,
      activeAt: 1000,
    });
    expect(problems[2]!.messageParams).toEqual({ percent: "90%", used: "90", total: "100" });
  });

  it("keeps when each was first seen across polls and forgets what went away", () => {
    const seen = new Map<string, number>();
    diskProblems([vol("a", 90)], DEFAULTS, seen, 1000, FORMAT);
    const again = diskProblems([vol("a", 91)], DEFAULTS, seen, 5000, FORMAT);
    expect(again[0]!.firstSeen).toBe(1000);
    // Crossing into critical is a new state, seen now.
    const worse = diskProblems([vol("a", 97)], DEFAULTS, seen, 9000, FORMAT);
    expect(worse.map((p) => [p.reason, p.firstSeen])).toEqual([["CriticallyFull", 9000]]);
    expect([...seen.keys()]).toEqual(["claim:db/a|CriticallyFull"]);
    expect(diskProblems([vol("a", 10)], DEFAULTS, seen, 9500, FORMAT)).toEqual([]);
    expect(seen.size).toBe(0);
  });

  it("follows the thresholds it is given", () => {
    const strict = thresholdsOf({ volumeWarnPercent: 60, volumeCriticalPercent: 70 });
    expect(diskProblems([vol("a", 65)], strict, new Map(), 0, FORMAT).map((p) => p.reason)).toEqual(["AlmostFull"]);
    expect(diskProblems([vol("a", 65)], DEFAULTS, new Map(), 0, FORMAT)).toEqual([]);
  });
});
