// What a rule's `related` found (ADR-0169): one object of those a `relatedBy` finds (`newest`, `prefer`), lookups that
// decide nothing (`optional`), the found object's window and time (`givesSince`) and fields (`{{related:…}}`) on the
// problem, whether the cluster serves a kind (`served`), texts read by a pattern (`fits`) and texts cut without an
// ellipsis (`|cut:<n>`) — and whatever the rows cannot tell is no problem (ADR-0144).
import { describe, expect, it } from "vitest";
import type { KubeObject, ProblemCondition, ProblemContribution } from "../api";
import { isActive, type Problem } from "../features/problems/model";
import type { JudgedRows, SourceDef } from "../features/problems/sources";
import { lookupRefs } from "../features/mcp-diagnostics/problems";
import { comparedPaths, factsOf, judgeAcross, judgedAcross, lookedUp, rowOf, type AcrossTarget } from "./problemsAcross";
import { detectRule, evaluate, fitsPattern, placeholderText, renderMessage } from "./problemRules";

const CHART = { group: "helm.cattle.io", kind: "HelmChart" };
const JOB = { group: "batch", kind: "Job" };
const ADDON = { group: "k3s.cattle.io", kind: "Addon" };
const LABEL = "helmcharts.helm.cattle.io/chart";
const keyOf = (k: { group: string; kind: string }) => `${k.group}/${k.kind}`.toLowerCase();
const def = (kind: { group: string; kind: string }): SourceDef => ({ category: "ext:demo", kind: { ...kind, version: "v1" }, fieldSelector: null, discovered: true });
const JOBS = def(JOB);
const TARGETS: AcrossTarget[] = [{ ...JOB, namespaced: true, def: JOBS }];

const FAILED: ProblemCondition = { type: "condition", conditionType: "Failed", status: "True" };
const FAILED_AT = '.status.conditions[type="Failed",status="True"].lastTransitionTime';
const WITHIN_A_DAY: ProblemCondition = { type: "all", of: [FAILED, { type: "not", of: { type: "olderThan", path: FAILED_AT, minutes: 1440 } }] };
const theJob = (when: ProblemCondition, more: Partial<Extract<ProblemCondition, { type: "relatedBy" }>> = {}): ProblemCondition => ({
  type: "relatedBy",
  kind: JOB,
  pairs: [{ theirs: `.metadata.labels["${LABEL}"]`, ours: ".metadata.name" }],
  newest: true,
  prefer: [
    { theirs: ".metadata.name", ours: ".status.jobName" },
    { theirs: ".metadata.name", ours: "helm-install-{{.metadata.name}}" },
  ],
  when,
  ...more,
});

const rule = (over: Partial<ProblemContribution>): ProblemContribution => ({
  id: "r",
  title: "R",
  kind: CHART,
  when: { type: "exists", path: ".metadata.name" },
  graceMinutes: 0,
  notify: true,
  message: "m",
  toldThroughOwner: false,
  ...over,
});

// The chart's own condition, the Job's window and time where it failed, its name either way.
const CHART_FAILED = rule({
  id: "chart-failed",
  when: {
    type: "all",
    of: [
      FAILED,
      theJob(WITHIN_A_DAY, { optional: true, givesSince: true }),
      theJob({ type: "exists", path: ".metadata.name" }, { optional: true }),
    ],
  },
  message: "Job {{related:.metadata.name}}: {{.status.conditions[type=\"Failed\"].message}}",
});
// The Job failed while the chart did not say so: required.
const JOB_FAILED = rule({
  id: "job-failed",
  when: { type: "all", of: [{ type: "not", of: FAILED }, theJob(WITHIN_A_DAY, { givesSince: true })] },
  message: '{{related:.status.conditions[type="Failed",status="True"].message ?? .status.conditions[type="Failed",status="True"].reason}}',
});
const RULES = [CHART_FAILED, JOB_FAILED];
const FACTS = factsOf(RULES, keyOf);
const COMPARED = comparedPaths(RULES, keyOf);

type Obj = KubeObject & { metadata: { name: string; namespace: string; uid: string } & Record<string, unknown> };
const chart = (failed: boolean, jobName?: string): Obj =>
  ({
    apiVersion: "helm.cattle.io/v1",
    kind: "HelmChart",
    metadata: { name: "app", namespace: "kube-system", uid: "chart" },
    status: {
      ...(jobName ? { jobName } : {}),
      conditions: [{ type: "Failed", status: failed ? "True" : "False", message: failed ? "chart says no" : "" }],
    },
  }) as Obj;
const job = (name: string, created: string, failedAt?: string, labels: Record<string, string> = { [LABEL]: "app" }): Obj =>
  ({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: "kube-system", uid: name, creationTimestamp: created, labels },
    status: failedAt ? { conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "backoff", lastTransitionTime: failedAt }] } : {},
  }) as Obj;

const rowsOf = (objects: Obj[], over: Partial<JudgedRows> = {}): JudgedRows => ({
  status: "ready",
  rows: new Map(objects.map((o) => [o.metadata.uid, rowOf([], FACTS.get(keyOf(JOB)) ?? [], false, COMPARED.get(keyOf(JOB)) ?? [])(o)])),
  truncated: false,
  namespaces: null,
  ...over,
});

const NOW = Date.parse("2026-10-01T12:00:00Z");
function judge(r: ProblemContribution, o: Obj, jobs: Obj[] | JudgedRows | undefined, served?: (k: { group: string; kind: string }) => boolean): Problem[] {
  const [found] = detectRule(r, o);
  if (!found) return [];
  const p: Problem = {
    ...found,
    key: `${o.metadata.uid}|${found.reason}`,
    notifyKey: `${o.metadata.uid}|${r.id}`,
    category: "ext:demo",
    uid: o.metadata.uid,
    object: { kind: { ...r.kind, version: "v1" }, namespace: o.metadata.namespace, name: o.metadata.name },
    firstSeen: NOW,
    activeAt: found.activeFrom ?? NOW,
  };
  const rows = Array.isArray(jobs) ? rowsOf(jobs) : jobs;
  return judgeAcross(
    [p],
    { rows: undefined, target: (d) => (d === JOBS ? rows : undefined), problemUids: () => new Set() },
    { rules: new Map(RULES.map((x) => [x.id, x])), targets: TARGETS, api: 5, ...(served ? { served } : {}) },
  );
}

describe("relatedBy newest and prefer (ADR-0169)", () => {
  it("takes the Job the chart names before the newest, else the newest by creation time", () => {
    const named = job("helm-install-app", "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z");
    const newer = job("helm-install-app-2", "2026-10-01T11:00:00Z");
    // The named one failed, the newer did not: the named one counts.
    expect(judge(JOB_FAILED, chart(false, "helm-install-app"), [named, newer])).toHaveLength(1);
    // Nothing named: the one helm-controller would name (`helm-install-<name>`).
    expect(judge(JOB_FAILED, chart(false), [named, newer])).toHaveLength(1);
    // Nothing named, none of that name: the newest counts, which did not fail.
    const other = job("other-install", "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z");
    expect(judge(JOB_FAILED, chart(false), [other, newer])).toEqual([]);
    // Named but not there: the newest, whatever the other alternatives say.
    expect(judge(JOB_FAILED, chart(false, "helm-install-gone"), [newer, named])).toEqual([]);
    // Only Jobs of the chart's label count.
    expect(judge(JOB_FAILED, chart(false), [job("other", "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z", { [LABEL]: "other" })])).toEqual([]);
  });

  it("dates the problem from the Job's failure and ends it a day later", () => {
    const [p] = judge(JOB_FAILED, chart(false, "helm-install-app"), [job("helm-install-app", "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z")]);
    expect(p?.since).toBe("2026-10-01T10:00:00Z");
    expect(p?.until).toBe(Date.parse("2026-10-02T10:00:00Z"));
    expect(p?.activeAt).toBe(Date.parse("2026-10-01T10:00:00Z"));
    expect(p?.message).toBe("backoff");
    expect(isActive(p!, NOW)).toBe(true);
    expect(isActive(p!, Date.parse("2026-10-02T10:00:01Z"))).toBe(false);
  });

  it("cannot tell, so no problem, while the Jobs are not read in full", () => {
    const failed = job("helm-install-app", "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z");
    expect(judge(JOB_FAILED, chart(false, "helm-install-app"), rowsOf([failed], { truncated: true }))).toEqual([]);
    expect(judge(JOB_FAILED, chart(false, "helm-install-app"), undefined)).toEqual([]);
  });
});

describe("optional related (ADR-0169)", () => {
  const failed = job("helm-install-app", "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z");
  const running = job("helm-install-app", "2026-10-01T09:00:00Z");

  it("decides nothing: the chart's own condition stands without the Jobs, with no Job, and with a Job that did not fail", () => {
    for (const jobs of [undefined, rowsOf([failed], { status: "loading" }), [], [running]]) {
      const [p] = judge(CHART_FAILED, chart(true, "helm-install-app"), jobs as Obj[] | JudgedRows | undefined);
      expect(p).toBeDefined();
      expect(p?.until).toBeUndefined();
      expect(p?.since).toBeUndefined();
    }
  });

  it("names the Job it found whatever its state, nothing when none", () => {
    expect(judge(CHART_FAILED, chart(true, "helm-install-app"), [running])[0]?.message).toBe("Job helm-install-app: chart says no");
    expect(judge(CHART_FAILED, chart(true, "helm-install-app"), [])[0]?.message).toBe("Job : chart says no");
    expect(judge(CHART_FAILED, chart(true, "helm-install-app"), undefined)[0]?.message).toBe("Job : chart says no");
  });

  it("gives the window and time of a Job that failed", () => {
    const [p] = judge(CHART_FAILED, chart(true, "helm-install-app"), [failed]);
    expect(p?.since).toBe("2026-10-01T10:00:00Z");
    expect(p?.until).toBe(Date.parse("2026-10-02T10:00:00Z"));
    // A day later the row keeps the window, so the problem has ended — as the built-in view counted it.
    expect(isActive(p!, Date.parse("2026-10-03T00:00:00Z"))).toBe(false);
  });

  it("is a lookup an agent must be able to read", () => {
    const [p] = judge(CHART_FAILED, chart(true, "helm-install-app"), [failed]);
    expect(lookupRefs(p!, null)).toContainEqual({ group: "batch", kind: "Job", namespace: "kube-system" });
  });
});

describe("{{related:…}} (ADR-0169)", () => {
  it("is kept as a mark the cleaning of URIs leaves alone, filled last from the found row", () => {
    const text = renderMessage("a {{related:.metadata.name}} b", { metadata: { name: "x" } } as KubeObject);
    expect(text).toMatch(/^a [0-9a-f]+ b$/);
    // Cluster text in the found object is not read as a placeholder.
    const odd = job("{{missing}} https://user:pw@example.com/x", "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z");
    const [p] = judge(rule({ ...JOB_FAILED, message: "{{related:.metadata.name}}" }), chart(false, odd.metadata.name), [odd]);
    expect(p?.message).toBe("{{missing}} https://example.com/x");
  });

  it("is read on the found kind's rows only for the paths the messages name", () => {
    expect(COMPARED.get(keyOf(JOB))).toEqual(
      expect.arrayContaining([`.metadata.labels["${LABEL}"]`, ".metadata.name", '.status.conditions[type="Failed",status="True"].message']),
    );
  });
});

describe("served (ADR-0169)", () => {
  const COMPONENT = rule({ id: "component", kind: { group: "apps", kind: "Deployment" }, when: { type: "served", kind: ADDON } });
  const deployment = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "coredns", namespace: "kube-system", uid: "d" } } as Obj;
  const judgeServed = (served?: (k: { group: string; kind: string }) => boolean) => {
    const [found] = detectRule(COMPONENT, deployment);
    const p = { ...found!, key: "k", notifyKey: "n", category: "ext:demo", uid: "d", object: { kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "kube-system", name: "coredns" }, firstSeen: 0, activeAt: 0 } as Problem;
    return judgeAcross([p], { rows: undefined, target: () => undefined, problemUids: () => new Set() }, { rules: new Map([[COMPONENT.id, COMPONENT]]), targets: [], api: 5, ...(served ? { served } : {}) });
  };

  it("holds only where discovery says the cluster serves the kind, and cannot tell before it does", () => {
    expect(judgeServed(() => true)).toHaveLength(1);
    expect(judgeServed(() => false)).toEqual([]);
    expect(judgeServed()).toEqual([]);
  });

  it("is judged across objects, but needs no source and nothing an agent reads", () => {
    expect(judgedAcross(COMPONENT)).toBe(true);
    expect(lookedUp(COMPONENT.when)).toEqual([]);
    const [p] = judgeServed(() => true);
    expect(lookupRefs(p!, null)).toEqual([]);
  });
});

describe("fits (ADR-0169)", () => {
  it("reads `*` as any text and `#` as one or more digits", () => {
    expect(fitsPattern("v1.33.4+k3s1", "*+k3s#")).toBe(true);
    expect(fitsPattern("v1.33.4+k3s12", "*+k3s#")).toBe(true);
    expect(fitsPattern("v1.33.4+k3sx", "*+k3s#")).toBe(false);
    expect(fitsPattern("v1.33.4+k3s", "*+k3s#")).toBe(false);
    expect(fitsPattern("v1.33.4+rke2r1", "*+rke2r#")).toBe(true);
    expect(fitsPattern("", "*")).toBe(true);
    expect(fitsPattern("a", "")).toBe(false);
    expect(fitsPattern("ab12cd", "a*#*d")).toBe(true);
  });

  it("holds for a text only", () => {
    const node = { metadata: { name: "n" }, status: { nodeInfo: { kubeletVersion: "v1.33.4+k3s1" } } } as KubeObject;
    expect(evaluate({ type: "fits", path: ".status.nodeInfo.kubeletVersion", patterns: ["*+rke2r#", "*+k3s#"] }, node).holds).toBe(true);
    expect(evaluate({ type: "fits", path: ".status.nodeInfo", patterns: ["*"] }, node).holds).toBe(false);
  });
});

describe("|cut (ADR-0169)", () => {
  it("cuts without an ellipsis, and the shorter of `clip` and `cut` decides", () => {
    const obj = { spec: { checksum: "6b3a1d8f0e9c7b5a4d3c" } };
    expect(placeholderText(obj, ".spec.checksum|cut:12")).toBe("6b3a1d8f0e9c");
    expect(placeholderText(obj, ".spec.checksum|cut:40")).toBe("6b3a1d8f0e9c7b5a4d3c");
    expect(placeholderText(obj, ".spec.checksum|clip:4|cut:12")).toBe("6b3a…");
    expect(placeholderText(obj, ".spec.checksum|clip:12|cut:4")).toBe("6b3a");
  });
});
