import { beforeEach, describe, expect, it } from "vitest";
import type { AppSettings, DesktopNotification, KubeObject } from "../../api";
import { defaultAppSettings } from "../../api";
import { JOB, NODE, POD, resolve, type Problem } from "../problems/model";
import { clip, COOLDOWN_MS, GROUP_LIMIT, MAX_PER_MINUTE, NotificationEngine } from "./engine";
import { muteForHour, prefsOf, setCategory, setClusterMuted, setEnabled } from "./prefs";

const T0 = Date.parse("2026-10-18T10:00:00Z");

function crashing(name: string, reason = "CrashLoopBackOff"): KubeObject {
  return {
    metadata: { name, uid: `uid-${name}`, namespace: "demo" },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "app",
          restartCount: 3,
          state: reason === "running" ? { running: {} } : { waiting: { reason } },
          lastState: { terminated: { reason: "Error", finishedAt: new Date(T0).toISOString() } },
        },
      ],
    },
  };
}

function notReadyNode(name: string): KubeObject {
  return { metadata: { name, uid: `uid-${name}` }, status: { conditions: [{ type: "Ready", status: "False" }] } };
}

const problems = (objs: KubeObject[], kind = POD): Problem[] => objs.flatMap((o) => resolve(kind, o, T0));

let now: number;
let shown: DesktopNotification[];
let scheduled: (() => void)[];
let engine: NotificationEngine;

function settings(...changes: ((s: AppSettings) => AppSettings)[]): void {
  engine.setPrefs(prefsOf(changes.reduce((s, change) => change(s), defaultAppSettings())));
}

function source(list: Problem[], key = "c1|/v1/Pod|", clusterId = "c1") {
  return { key, clusterId, status: "ready" as const, problems: list };
}

/** Runs the flush timers due. */
function flush(): void {
  const due = scheduled;
  scheduled = [];
  for (const fn of due) fn();
}

beforeEach(() => {
  now = T0 + 1000;
  shown = [];
  scheduled = [];
  engine = new NotificationEngine({
    now: () => now,
    show: (n) => shown.push(n),
    schedule: (fn) => {
      scheduled.push(fn);
      return () => {
        scheduled = scheduled.filter((f) => f !== fn);
      };
    },
    clusterName: (id) => `name-${id}`,
  });
  settings();
});

describe("notifications", () => {
  it("say nothing about problems that were there when the cluster was first looked at", () => {
    engine.observe(source(problems([crashing("a"), crashing("b")])));
    engine.observe(source(problems([crashing("a"), crashing("b")])));
    flush();
    expect(shown).toEqual([]);
    expect(engine.history()).toEqual([]);
  });

  it("wait for the first list: a source still loading is not the baseline", () => {
    engine.observe({ ...source([]), status: "loading" });
    engine.observe(source(problems([crashing("a")])));
    flush();
    expect(shown).toEqual([]);
  });

  it("tell a problem that starts afterwards, once, with what to open", () => {
    engine.observe(source([]));
    engine.observe(source(problems([crashing("a")])));
    engine.observe(source(problems([crashing("a")])));
    flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("name-c1: CrashLoopBackOff");
    expect(shown[0]!.body).toContain("Pod demo/a");
    expect(shown[0]!.extra).toEqual({ clusterId: "c1", object: { kind: POD, namespace: "demo", name: "a" } });
    expect(shown[0]!.actionTypeId).toBe("sextant-problem");
    expect(engine.history().map((h) => [h.reason, h.delivery])).toEqual([["CrashLoopBackOff", "shown"]]);
  });

  it("tell a crash loop once: it flapping between back-off and running is one state", () => {
    engine.observe(source([]));
    for (const state of ["CrashLoopBackOff", "running", "CrashLoopBackOff", "running", "CrashLoopBackOff"]) {
      engine.observe(source(problems([crashing("a", state)])));
      flush();
    }
    expect(shown).toHaveLength(1);
  });

  it("drop a notification whose problem went away before it was due", () => {
    engine.observe(source([]));
    engine.observe(source(problems([crashing("a")])));
    engine.observe(source([]));
    flush();
    expect(shown).toEqual([]);
    // Nor one whose source stopped being watched (the cluster disconnected).
    engine.observe(source(problems([crashing("b")])));
    engine.forget("c1|/v1/Pod|");
    flush();
    expect(shown).toEqual([]);
  });

  it("make cluster text inert and short: no markup reaches the notification service", () => {
    engine.observe(source([]));
    const evil = crashing("a");
    const cs = (evil.status as { containerStatuses: { state: { waiting: Record<string, string> } }[] }).containerStatuses[0]!;
    cs.state.waiting.message = `<a href="https://evil.example">click</a> & ${"x".repeat(500)}`;
    engine.observe(source(problems([evil])));
    flush();
    const { title, body } = shown[0]!;
    expect(body).not.toMatch(/[<>&]/);
    expect(body).toContain("\u2039a href=");
    expect(Array.from(body).length).toBeLessThanOrEqual(200);
    expect(title).not.toMatch(/[<>&]/);
  });

  it("clip a long reason in the title, never splitting a surrogate pair", () => {
    expect(clip("😀".repeat(10), 5)).toBe("😀😀😀😀…");
    expect(clip("short", 5)).toBe("short");
    engine.observe(source([], "c1|batch/v1/Job|"));
    const job: KubeObject = {
      metadata: { name: "j", uid: "uid-j", namespace: "demo" },
      status: { conditions: [{ type: "Failed", status: "True", reason: "R".repeat(1000) }] },
    };
    engine.observe(source(problems([job], JOB), "c1|batch/v1/Job|"));
    flush();
    expect(Array.from(shown[0]!.title).length).toBeLessThanOrEqual(100);
  });

  it("open the cluster with the most problems from a summary across clusters", () => {
    engine.observe(source([], "c1|/v1/Pod|", "c1"));
    engine.observe(source([], "c2|/v1/Pod|", "c2"));
    engine.observe(source(problems([crashing("a")]), "c1|/v1/Pod|", "c1"));
    engine.observe(source(problems([crashing("b"), crashing("c"), crashing("d")]), "c2|/v1/Pod|", "c2"));
    flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("New problems in 2 clusters (4 in total)");
    expect(shown[0]!.extra).toEqual({ clusterId: "c2", object: null });
  });

  it("tell a state again only when it comes back after the cooldown, never while it lasts", () => {
    engine.observe(source([]));
    engine.observe(source(problems([crashing("a")])));
    flush();
    // Still there an hour later: nothing new.
    now += 2 * COOLDOWN_MS;
    engine.observe(source(problems([crashing("a")])));
    flush();
    expect(shown).toHaveLength(1);
    // Gone, and back before the cooldown is over.
    engine.observe(source([]));
    now += COOLDOWN_MS - 1000;
    engine.observe(source(problems([crashing("a")])));
    flush();
    expect(shown).toHaveLength(1);
    // Gone for longer than the cooldown, then back.
    engine.observe(source([]));
    now += COOLDOWN_MS + 1;
    engine.observe(source(problems([crashing("a")])));
    flush();
    expect(shown).toHaveLength(2);
  });

  it("show a problem that was there at the start once it goes and comes back", () => {
    engine.observe(source(problems([crashing("a")])));
    engine.observe(source([]));
    engine.observe(source(problems([crashing("a")])));
    flush();
    expect(shown).toHaveLength(1);
  });

  it("group a storm into one summary, and keep the rest of the minute for later", () => {
    engine.observe(source([]));
    const many = Array.from({ length: 12 }, (_, i) => crashing(`p${i}`));
    engine.observe(source(problems(many)));
    flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe("12 new problems in name-c1");
    expect(shown[0]!.body).toBe("CrashLoopBackOff ×12");
    expect(shown[0]!.extra).toEqual({ clusterId: "c1", object: null });
    expect(engine.history()).toHaveLength(12);
    expect(engine.history().every((h) => h.delivery === "summary")).toBe(true);
  });

  it(`show up to ${GROUP_LIMIT} at once one by one, and at most ${MAX_PER_MINUTE} a minute`, () => {
    engine.observe(source([]));
    const nodes: KubeObject[] = [];
    let n = 0;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 2; i++) nodes.push(notReadyNode(`n${n++}`));
      engine.observe(source(problems(nodes, NODE)));
      now += 5000;
      flush();
    }
    // Three rounds of two (6 a minute), then the fourth waits for the next minute.
    expect(shown).toHaveLength(MAX_PER_MINUTE);
    expect(scheduled).toHaveLength(1);
    now += 60_000;
    flush();
    expect(shown).toHaveLength(MAX_PER_MINUTE + 2);
    expect(shown.at(-1)!.title).toBe("name-c1: NotReady");
  });

  it("fold what waited past the minute's limit into one summary", () => {
    engine.observe(source([]));
    const nodes: KubeObject[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 2; i++) nodes.push(notReadyNode(`n${round}-${i}`));
      engine.observe(source(problems(nodes, NODE)));
      flush();
    }
    for (let i = 0; i < 5; i++) {
      nodes.push(notReadyNode(`late-${i}`));
      engine.observe(source(problems(nodes, NODE)));
      flush();
    }
    expect(shown).toHaveLength(MAX_PER_MINUTE);
    now += 60_000;
    flush();
    expect(shown).toHaveLength(MAX_PER_MINUTE + 1);
    expect(shown.at(-1)!.title).toBe("5 new problems in name-c1");
  });

  it("go only to the history while muted for an hour", () => {
    settings(muteForHour(now));
    engine.observe(source([]));
    engine.observe(source(problems([crashing("a")])));
    flush();
    expect(shown).toEqual([]);
    expect(engine.history().map((h) => h.delivery)).toEqual(["muted"]);

    // An hour later the next new problem is shown.
    now += 3600_000 + 1;
    engine.observe(source(problems([crashing("a"), crashing("b")])));
    flush();
    expect(shown).toHaveLength(1);
  });

  it("respect the global switch, the category and the cluster at the time they are due", () => {
    for (const change of [setEnabled(false), setCategory("pods", false), setClusterMuted("c1", true)]) {
      engine.reset();
      settings(change);
      engine.observe(source([]));
      engine.observe(source(problems([crashing("a")])));
      flush();
      expect(shown).toEqual([]);
      expect(engine.history().map((h) => h.delivery)).toEqual(["muted"]);
    }
    // Another category of the same cluster still notifies.
    engine.reset();
    settings(setCategory("pods", false));
    engine.observe(source([], "c1|/v1/Node|"));
    engine.observe(source(problems([notReadyNode("n1")], NODE), "c1|/v1/Node|"));
    flush();
    expect(shown).toHaveLength(1);
  });

  it("start quiet again after a source is forgotten (the cluster disconnected)", () => {
    engine.observe(source([]));
    engine.forget("c1|/v1/Pod|");
    engine.observe(source(problems([crashing("a")])));
    flush();
    expect(shown).toEqual([]);
  });

  it("keep the last 100 in the history, newest first", () => {
    settings(muteForHour(now));
    engine.observe(source([]));
    for (let i = 0; i < 120; i++) {
      engine.observe(source(problems([crashing(`p${i}`)])));
      flush();
    }
    expect(engine.history()).toHaveLength(100);
    expect(engine.history()[0]!.object.name).toBe("p119");
  });

  it("clear the history of one cluster and keep the others'", () => {
    engine.observe(source([]));
    engine.observe(source([], "c2|/v1/Pod|", "c2"));
    engine.observe(source(problems([crashing("a")])));
    engine.observe(source(problems([crashing("b")]), "c2|/v1/Pod|", "c2"));
    flush();
    expect(engine.history().map((h) => h.clusterId).sort()).toEqual(["c1", "c2"]);
    engine.clearHistory("c1");
    expect(engine.history().map((h) => h.clusterId)).toEqual(["c2"]);
    engine.clearHistory();
    expect(engine.history()).toEqual([]);
  });
});
