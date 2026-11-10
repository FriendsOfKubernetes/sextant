// Problem judges (ADR-0168): when the window asks the extension's backend, and what it cannot tell.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JudgedObject, ProblemJudgeContribution } from "../api";
import { mockBackend, type MockBackend } from "../api/mockBackend";
import type { JudgedRows } from "../features/problems/sources";
import {
  entryKey,
  forgetJudges,
  judgedFact,
  judgedFacts,
  judgeReads,
  JUDGE_INTERVAL_MS,
  NOT_SERVED_ROWS,
  observeJudge,
  onJudgeAnswer,
  setJudgesClock,
  type JudgeInput,
} from "./problemJudges";

const JUDGE: ProblemJudgeContribution = {
  id: "routing",
  reads: [{ kind: { group: "networking.istio.io", kind: "VirtualService" }, paths: [".spec.hosts"] }],
  facts: [{ id: "unknown-host", values: ["host"] }],
};

const row = (name: string, hosts: string[]) => ({
  name,
  namespace: "shop",
  judged: { apiVersion: "networking.istio.io/v1", values: { ".spec.hosts": hosts, ".spec.other": "not declared here" } },
});

const rows = (entries: [string, ReturnType<typeof row>][], over: Partial<JudgedRows> = {}): JudgedRows => ({
  status: "ready",
  rows: new Map(entries),
  truncated: false,
  namespaces: null,
  ...over,
});

const input = (r: JudgedRows | undefined): JudgeInput[] => [{ read: JUDGE.reads[0]!, kind: "VirtualService", rows: r }];

let backend: MockBackend;
let now = 0;
let sent: JudgedObject[][];
let told: number;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  setJudgesClock(() => now);
  sent = [];
  told = 0;
  backend = mockBackend();
  backend.on("extension_problem_judge", (args) => {
    const objects = (args as { objects: JudgedObject[] }).objects;
    sent.push(objects);
    return objects.map((o) => ({ uid: o.metadata.uid, fact: "unknown-host", values: { host: String((o.values[".spec.hosts"] as string[])[0]) } }));
  });
  stop = onJudgeAnswer(() => {
    told += 1;
  });
});

afterEach(() => {
  stop();
  forgetJudges();
  setJudgesClock(null);
  backend.restore();
  vi.useRealTimers();
});

/** Lets the scheduled call run and its answer arrive. */
async function settle(ms = 0): Promise<void> {
  now += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

describe("problem judges", () => {
  it("send only the declared paths, once per change, and keep the answer", async () => {
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["reviews"])]])));
    await settle();
    expect(sent).toEqual([
      [{ apiVersion: "networking.istio.io/v1", kind: "VirtualService", metadata: { name: "web", namespace: "shop", uid: "u1" }, values: { ".spec.hosts": ["reviews"] } }],
    ]);
    expect(judgedFact("c1", "mesh", "routing", "unknown-host", "u1")).toEqual({ host: "reviews" });
    expect(judgeReads("c1", "mesh", "routing")).toEqual([{ group: "networking.istio.io", kind: "VirtualService", namespaces: null }]);
    expect(told).toBe(1);
    // The same objects in a new map: nothing is sent again.
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["reviews"])]])));
    await settle(JUDGE_INTERVAL_MS);
    expect(sent).toHaveLength(1);
  });

  it("ask at most once per interval and never twice at once", async () => {
    let release: (() => void) | undefined;
    backend.on("extension_problem_judge", (args) => {
      sent.push((args as { objects: JudgedObject[] }).objects);
      return new Promise((resolve) => {
        release = () => resolve([]);
      });
    });
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["a"])]])));
    await settle();
    expect(sent).toHaveLength(1);
    // Two changes while the call runs: one more call, after it ends and the interval allows, with the latest objects.
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["b"])]])));
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["c"])]])));
    await settle(JUDGE_INTERVAL_MS * 2);
    expect(sent).toHaveLength(1);
    release!();
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]![0]!.values).toEqual({ ".spec.hosts": ["c"] });
  });

  it("cannot tell while a list is not read in full, or holds too much, and forgets the answer at once", async () => {
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["reviews"])]])));
    await settle();
    expect(judgedFact("c1", "mesh", "routing", "unknown-host", "u1")).not.toBeNull();
    for (const r of [undefined, rows([], { status: "loading" }), rows([], { truncated: true }), rows([], { status: "error" })]) {
      observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["reviews"])]])));
      observeJudge("c1", "mesh", JUDGE, input(r));
      expect(judgedFact("c1", "mesh", "routing", "unknown-host", "u1")).toBeNull();
    }
    const many = Array.from({ length: 5001 }, (_, i): [string, ReturnType<typeof row>] => [`u${i}`, row(`w${i}`, ["x"])]);
    observeJudge("c1", "mesh", JUDGE, input(rows(many)));
    await settle(JUDGE_INTERVAL_MS);
    expect(sent.every((objects) => objects.length <= 5000)).toBe(true);
  });

  it("keep no answer past a failed call, and try the same objects again later", async () => {
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["reviews"])]])));
    await settle();
    let fail = true;
    backend.on("extension_problem_judge", (args) => {
      sent.push((args as { objects: JudgedObject[] }).objects);
      if (fail) throw { code: "timeout", message: "out of time" };
      return [];
    });
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["other"])]])));
    await settle(JUDGE_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    expect(judgedFact("c1", "mesh", "routing", "unknown-host", "u1")).toBeNull();
    expect(told).toBe(2);
    fail = false;
    await settle(JUDGE_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    await settle(60_000);
    expect(sent).toHaveLength(3);
  });

  it("keep every entry of a fact with its own texts, each with the time it first came", async () => {
    backend.on("extension_problem_judge", (args) => {
      const objects = (args as { objects: JudgedObject[] }).objects;
      sent.push(objects);
      const hosts = objects[0]!.values[".spec.hosts"] as string[];
      return hosts.map((host) => ({ uid: "u1", fact: "unknown-host", values: { host } }));
    });
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["a", "b"])]])));
    await settle();
    const first = judgedFacts("c1", "mesh", "routing", "unknown-host", "u1");
    expect(first?.map((e) => e.values)).toEqual([{ host: "a" }, { host: "b" }]);
    expect(first?.map((e) => e.since)).toEqual([now, now]);
    expect(first?.[0]?.key).toBe(entryKey({ host: "a" }));
    // The first entry is what a rule without `each` shows.
    expect(judgedFact("c1", "mesh", "routing", "unknown-host", "u1")).toEqual({ host: "a" });
    const began = now;
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["b", "c"])]])));
    await settle(JUDGE_INTERVAL_MS);
    const second = judgedFacts("c1", "mesh", "routing", "unknown-host", "u1");
    // `b` keeps its time; `c` is new; `a` is gone.
    expect(second?.map((e) => [e.values.host, e.since])).toEqual([
      ["b", began],
      ["c", now],
    ]);
  });

  it("send an optional read the cluster does not serve as no objects, and leave it out of what an agent must read", async () => {
    const judge: ProblemJudgeContribution = {
      ...JUDGE,
      reads: [JUDGE.reads[0]!, { kind: { group: "networking.istio.io", kind: "ServiceEntry" }, paths: [".spec.hosts"], optional: true }],
    };
    observeJudge("c1", "mesh", judge, [
      ...input(rows([["u1", row("web", ["reviews"])]])),
      { read: judge.reads[1]!, kind: "ServiceEntry", rows: NOT_SERVED_ROWS, notServed: true },
    ]);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((o) => o.kind)).toEqual(["VirtualService"]);
    expect(judgedFact("c1", "mesh", "routing", "unknown-host", "u1")).toEqual({ host: "reviews" });
    expect(judgeReads("c1", "mesh", "routing")).toEqual([{ group: "networking.istio.io", kind: "VirtualService", namespaces: null }]);
  });

  it("cannot tell from a kind read in some namespaces only, unless its read is partial, then say where it was not read", async () => {
    let partials: unknown[] = [];
    backend.on("extension_problem_judge", (args) => {
      const { objects, partial } = args as { objects: JudgedObject[]; partial?: unknown };
      sent.push(objects);
      partials.push(partial);
      return objects.map((o) => ({ uid: o.metadata.uid, fact: "unknown-host" }));
    });
    // Narrowed to the extension's or the user's namespaces, or refused by the API server in some: not read in full.
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["reviews"])]], { namespaces: ["shop"] })));
    await settle();
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["reviews"])]], { forbidden: ["team-b"] })));
    await settle(JUDGE_INTERVAL_MS);
    expect(sent).toEqual([]);
    expect(judgedFact("c1", "mesh", "routing", "unknown-host", "u1")).toBeNull();

    // A partial read: sent with where it was not read, the refused namespaces taken out of those read.
    const partly: ProblemJudgeContribution = { ...JUDGE, reads: [{ ...JUDGE.reads[0]!, partial: true }] };
    const inputOf = (r: JudgedRows): JudgeInput[] => [{ read: partly.reads[0]!, kind: "VirtualService", rows: r }];
    observeJudge("c1", "mesh", partly, inputOf(rows([["u1", row("web", ["reviews"])]], { namespaces: ["shop", "team-b"], forbidden: ["team-b"] })));
    await settle(JUDGE_INTERVAL_MS);
    expect(partials).toEqual([
      [{ kind: { group: "networking.istio.io", kind: "VirtualService" }, readNamespaces: ["shop"], unreadNamespaces: ["team-b"] }],
    ]);
    expect(judgedFact("c1", "mesh", "routing", "unknown-host", "u1")).toEqual({});
    // An agent must be able to read it where it was read.
    expect(judgeReads("c1", "mesh", "routing")).toEqual([{ group: "networking.istio.io", kind: "VirtualService", namespaces: ["shop"] }]);
    // Refused in some of every namespace: no `readNamespaces`.
    partials = [];
    observeJudge("c1", "mesh", partly, inputOf(rows([["u1", row("web", ["reviews"])]], { forbidden: ["team-b"] })));
    await settle(JUDGE_INTERVAL_MS);
    expect(partials).toEqual([[{ kind: { group: "networking.istio.io", kind: "VirtualService" }, unreadNamespaces: ["team-b"] }]]);
    // Read everywhere: nothing said, as a judge written before expects.
    partials = [];
    observeJudge("c1", "mesh", partly, inputOf(rows([["u1", row("web", ["other"])]])));
    await settle(JUDGE_INTERVAL_MS);
    expect(partials).toEqual([undefined]);
    // A kind without namespaces is never read in part.
    partials = [];
    observeJudge("c1", "mesh", JUDGE, [{ read: JUDGE.reads[0]!, kind: "VirtualService", rows: rows([["u2", row("web", ["x"])]], { namespaces: ["shop"] }), namespaced: false }]);
    await settle(JUDGE_INTERVAL_MS);
    expect(partials).toEqual([undefined]);
  });

  it("keep what each fact says it rests on", async () => {
    const needs = [{ kind: { group: "", kind: "Service" }, namespace: "shop" }];
    backend.on("extension_problem_judge", (args) => {
      const objects = (args as { objects: JudgedObject[] }).objects;
      return objects.flatMap((o) => [
        { uid: o.metadata.uid, fact: "unknown-host", values: { host: "a" }, needs },
        { uid: o.metadata.uid, fact: "unknown-host", values: { host: "b" } },
      ]);
    });
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["reviews"])]])));
    await settle();
    const entries = judgedFacts("c1", "mesh", "routing", "unknown-host", "u1");
    expect(entries?.map((e) => e.needs)).toEqual([needs, undefined]);
  });

  it("forget a cluster's answers when its connection goes", async () => {
    observeJudge("c1", "mesh", JUDGE, input(rows([["u1", row("web", ["reviews"])]])));
    await settle();
    forgetJudges("c1");
    expect(judgedFact("c1", "mesh", "routing", "unknown-host", "u1")).toBeNull();
  });
});
