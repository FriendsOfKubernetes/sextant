// The model and the manifest's declarative parts. The manifest's problem rules, the kinds' "Only problems" and the
// columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run
// time so the type check stays inside the extension) and compared with the model they replace — the reading of
// Sextant's former built-in Kyverno view (ADR-0101), ported unchanged — on its fixtures and variants of them.
import type { KindRef, KubeObject } from "@sextant/extension-sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import clusterPolicyJson from "../fixtures/clusterpolicy.json";
import podJson from "../fixtures/pod.json";
import reportJson from "../fixtures/policyreport.json";
import en from "./locales/en.json";
import {
  backgroundScan,
  CLUSTER_EPHEMERAL_REPORT,
  CLUSTER_POLICY,
  CLUSTER_POLICY_REPORT,
  EPHEMERAL_REPORT,
  isPolicyProblem,
  isReportProblem,
  KYVERNO_KINDS,
  modeTone,
  POLICY,
  POLICY_REPORT,
  policyMessage,
  policyMode,
  policyProblems,
  policyReady,
  policyReportLabel,
  policyRules,
  readyTone,
  reportResults,
  reportScope,
  reportSummary,
  resultPolicyName,
  RESULT_VALUES,
  type BuiltInProblem,
} from "./model";

const policy = clusterPolicyJson as unknown as KubeObject;
const report = reportJson as unknown as KubeObject;
const pod = podJson as unknown as KubeObject;
const copy = <T>(value: T): T => structuredClone(value);
type Result = { result: string; policy: string; rule?: string; timestamp?: { seconds: number } };

describe("the model", () => {
  it("a policy's readiness, mode per rule and the label of its reports", () => {
    expect(policyReady(policy)).toBe("True");
    expect(policyRules(policy).map((r) => [r.name, r.type, r.mode, r.kinds])).toEqual([
      ["check-team", "validate", "Enforce", ["Pod"]],
      ["add-default-owner", "mutate", undefined, ["Deployment", "StatefulSet"]],
    ]);
    expect(policyMode(policy)).toBe("Enforce");
    expect(policyReportLabel(policy, CLUSTER_POLICY)).toBe("cpol.kyverno.io/require-labels");

    // The policy-wide action of older policies, lowercase too; rules that differ are Mixed.
    const older = copy(policy);
    const spec = older.spec as { validationFailureAction?: string; rules: { validate?: { failureAction?: string } }[] };
    spec.validationFailureAction = "audit";
    delete spec.rules[0]!.validate!.failureAction;
    expect(policyMode(older)).toBe("Audit");
    spec.rules.push({ validate: { failureAction: "Enforce" } });
    expect(policyMode(older)).toBe("Mixed");

    const namespaced = copy(policy);
    namespaced.metadata.namespace = "team-a";
    expect(resultPolicyName(namespaced, POLICY)).toBe("team-a/require-labels");
    expect(policyReportLabel(namespaced, POLICY)).toBe("pol.kyverno.io/require-labels");
  });

  it("a report's object, results and summary", () => {
    expect(reportScope(POLICY_REPORT, report)).toEqual({ kind: { group: "", version: "v1", kind: "Pod" }, namespace: "default", name: "nginx" });
    expect(reportResults(POLICY_REPORT, report).map((r) => [r.policy, r.result])).toEqual([
      ["require-labels", "fail"],
      ["disallow-latest-tag", "pass"],
    ]);
    expect(reportSummary(POLICY_REPORT, report)).toEqual({ pass: 1, fail: 1, warn: 0, error: 0, skip: 0 });
    expect(isReportProblem(POLICY_REPORT)(report)).toBe(true);
    expect(report.metadata.name).toBe(pod.metadata.uid);
  });

  it("the built-in problems: opt-in, from the wgpolicyk8s.io reports, about the object the report names", () => {
    expect(policyProblems(POLICY_REPORT, report)).toMatchObject([
      { reason: "PolicyViolation", count: 1, policies: ["require-labels"], notify: true, object: { name: "nginx" } },
    ]);
    expect(policyProblems(EPHEMERAL_REPORT, report)).toEqual([]);
  });
});

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  notify: boolean;
  object?: unknown;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
  filter?: { type: string; value(obj: KubeObject, ctx: { now: number }): unknown };
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
/** The window's `formatList`, which the built-in message and `|list` both join with. */
let formatList: (items: readonly string[]) => string;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  ({ formatList } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/format.ts"))) as { formatList: typeof formatList });
});

const NOW = Date.parse("2026-11-01T12:00:00Z");
const holdsNow = (condition: unknown, obj: KubeObject) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && (v.activeFrom === undefined || v.activeFrom <= NOW) && (v.until === undefined || v.until > NOW);
};

// ---------- Variants ----------

/** Reports of every shape the rules tell apart: results of each value, with and without summary and scope. */
function reportVariants(base: KubeObject): [string, KubeObject][] {
  const out: [string, KubeObject][] = [["fixture", copy(base)]];
  const results: Result[][] = [
    [],
    [{ result: "pass", policy: "a" }],
    [{ result: "fail", policy: "b", rule: "r1" }],
    [{ result: "fail", policy: "b" }, { result: "fail", policy: "a" }, { result: "pass", policy: "c" }],
    [{ result: "error", policy: "e" }],
    [{ result: "error", policy: "e" }, { result: "fail", policy: "f", timestamp: { seconds: 1791712800 } }, { result: "warn", policy: "w" }],
    [{ result: "skip", policy: "s" }, { result: "warn", policy: "w" }],
  ];
  results.forEach((list, i) => {
    for (const summary of [true, false]) {
      for (const scope of ["full", "none", "empty"] as const) {
        const r = copy(base);
        r.results = list;
        if (summary) r.summary = Object.fromEntries(["pass", "fail", "warn", "error", "skip"].map((v) => [v, list.filter((x) => x.result === v).length]));
        else delete r.summary;
        if (scope === "none") delete r.scope;
        if (scope === "empty") (r.scope as Record<string, unknown>).name = "";
        out.push([`results ${i}, summary ${summary}, scope ${scope}`, r]);
      }
    }
  });
  const none = copy(base);
  delete none.results;
  delete none.summary;
  out.push(["no results", none]);
  return out;
}

/** The same report as a ClusterPolicyReport about a Namespace, and as Kyverno's ephemeral reports. */
function asKind(r: KubeObject, kind: KindRef): KubeObject {
  const out = copy(r);
  out.apiVersion = `${kind.group}/${kind.version}`;
  out.kind = kind.kind;
  if (!kind.kind.startsWith("Cluster")) return out;
  delete out.metadata.namespace;
  if (out.scope) out.scope = { apiVersion: "v1", kind: "Namespace", name: "team-a" };
  return out;
}
function asEphemeral(r: KubeObject, kind: KindRef): KubeObject {
  const out = asKind(r, kind);
  out.spec = { owner: out.scope, results: out.results, summary: out.summary };
  delete out.scope;
  delete out.results;
  delete out.summary;
  for (const key of Object.keys(out.spec as object)) if ((out.spec as Record<string, unknown>)[key] === undefined) delete (out.spec as Record<string, unknown>)[key];
  return out;
}

type Rule = (typeof manifest.contributes.problems)[number];
const rules = manifest.contributes.problems as Rule[];
const rulesOf = (kind: { group: string; kind: string }) => rules.filter((r) => r.kind.group === kind.group && r.kind.kind === kind.kind);

describe("the problem rules, against the built-in category `policies`", () => {
  it("are all in the extension's own opt-in category, with no rule in the main one", () => {
    expect(manifest.contributes.problemCategories).toEqual([{ id: "policies", title: "Kyverno policy failures", optIn: true }]);
    for (const rule of rules) expect(rule.category, rule.id).toBe("policies");
    expect(new Set(rules.map((r) => r.kind.kind))).toEqual(new Set(["PolicyReport", "ClusterPolicyReport"]));
  });

  it("are counted on the section by problem, as the built-in counter counted (a failure and an error of one report: two)", () => {
    // Every rule's problems, so a failure and an error of one report count twice, as there.
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "kyverno", count: "problems", label: expect.anything() }]);
  });

  for (const kind of [POLICY_REPORT, CLUSTER_POLICY_REPORT]) {
    it(`find a problem where the built-in did on a ${kind.kind}: reason, notification, group, object, time and words`, () => {
      let compared = 0;
      for (const [label, base] of [...reportVariants(report), ...countVariants(report)]) {
        const r = asKind(base, kind);
        const builtIn: BuiltInProblem[] = policyProblems(kind, r);
        const found = rulesOf(kind).flatMap((rule) => engine.detectRule(rule, r).map((d) => ({ ...d, rule: rule.id })));
        expect(
          found.map((d) => [d.reason, d.notify, d.group]),
          label,
        ).toEqual(builtIn.map((p) => [p.reason, p.notify, p.group]));
        // One rule per problem: none of a report's rules overlap.
        for (const [p, d] of builtIn.map((p, i) => [p, found[i]!] as const)) {
          // About the object the report names (#405), else about the report.
          expect(d.object, label).toEqual(p.object);
          // The built-in words in their plural form, each policy once, sorted.
          expect(d.message, label).toBe(builtInMessage("en", p));
          // Since the earliest such result's time (#404).
          expect(d.since, label).toBe(p.since);
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(40);
    });
  }

  it("say the built-in words in every language, in each plural form", () => {
    const translations = manifest.translations as Record<string, Record<string, string>>;
    for (const language of Object.keys(translations)) {
      const texts = translations[language]!;
      for (const [label, r] of countVariants(report)) {
        const builtIn = policyProblems(POLICY_REPORT, r);
        const found = rulesOf(POLICY_REPORT).flatMap((rule) => {
          // As the window localizes a rule (the language's forms, else the English ones) and picks the form.
          const prefix = `problems.${rule.id}.messageForms.`;
          const own = Object.fromEntries(Object.entries(texts).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
          const forms: Record<string, string> = Object.keys(own).length > 0 ? own : rule.messageForms;
          const n = Number(engine.detectRule({ ...rule, message: `{{${rule.pluralBy}}}`, messageForms: undefined, pluralBy: undefined }, r)[0]?.message);
          const form = new Intl.PluralRules(language).select(n);
          const message = forms[form] ?? texts[`problems.${rule.id}.message`]!;
          return engine.detectRule({ ...rule, message, messageForms: undefined, pluralBy: undefined }, r);
        });
        expect(found.length, `${language} ${label}`).toBe(builtIn.length);
        builtIn.forEach((p, i) => expect(found[i]!.message, `${language} ${label}`).toBe(builtInMessage(language, p)));
      }
    }
  });

  it("go by the count's plural form in English", () => {
    const [one] = rulesOf(POLICY_REPORT).flatMap((rule) => engine.detectRule(rule, countVariants(report).find(([l]) => l === "1 × fail")![1]));
    expect(one!.message).toBe("1 policy rule fails: p0");
    const [many] = rulesOf(POLICY_REPORT).flatMap((rule) => engine.detectRule(rule, countVariants(report).find(([l]) => l === "21 × fail")![1]));
    expect(many!.message).toBe(`21 policy rules fail: ${formatList(["p0", "p1", "p2"])}`);
  });

  it("never judge Kyverno's ephemeral reports", () => {
    for (const kind of [EPHEMERAL_REPORT, CLUSTER_EPHEMERAL_REPORT]) {
      expect(rulesOf(kind)).toEqual([]);
      expect(policyProblems(kind, asEphemeral(report, kind))).toEqual([]);
    }
  });

  it("say the fixture's problem as the built-in did, about the Pod, since the failure's time", () => {
    const [d] = rulesOf(POLICY_REPORT).flatMap((rule) => engine.detectRule(rule, report));
    expect(d).toMatchObject({ reason: "PolicyViolation", notify: true, group: "policies" });
    expect(d!.message).toBe("1 policy rule fails: require-labels");
    expect(d!.object).toEqual({ kind: { group: "", version: "v1", kind: "Pod" }, namespace: "default", name: "nginx" });
    expect(d!.since).toBe(policyProblems(POLICY_REPORT, report)[0]!.since);
    expect(d!.since).toBeDefined();
  });

  it("count from the earliest failed result's time, and name each policy once, sorted", () => {
    const r = copy(report);
    r.results = [
      { result: "fail", policy: "b", timestamp: { seconds: 1791712900 } },
      { result: "fail", policy: "a" },
      { result: "fail", policy: "b", timestamp: { seconds: 1791712800 } },
    ];
    const [d] = rulesOf(POLICY_REPORT).flatMap((rule) => engine.detectRule(rule, r));
    const [p] = policyProblems(POLICY_REPORT, r);
    expect(d!.since).toBe(new Date(1791712800 * 1000).toISOString());
    expect(d!.since).toBe(p!.since);
    expect(d!.message).toBe(`3 policy rules fail: ${formatList(["a", "b"])}`);
    expect(p!.policies).toEqual(["a", "b"]);
  });
});

/** The built-in message (`messages.policyFailures`/`policyErrors` of Sextant's `problems` texts). */
function builtInMessage(language: string, p: BuiltInProblem): string {
  // The built-in view's messages, as they were before it moved (copied, so the test never reads the core's texts).
  const texts = (JSON.parse(readFileSync(join(here, "../fixtures/builtin-messages.json"), "utf8")) as Record<string, Record<string, string>>)[language]!;
  const key = p.messageKey.replace("messages.", "");
  const form = new Intl.PluralRules(language).select(p.count);
  const template = texts[`${key}_${form}`] ?? texts[`${key}_other`]!;
  return template.replace("{{count}}", String(p.count)).replace("{{policies}}", formatList(p.policies));
}

/** Reports with 1 to 1000 failed or errored results: each plural form of every language. */
function countVariants(base: KubeObject): [string, KubeObject][] {
  return [1, 2, 3, 4, 5, 7, 11, 12, 14, 20, 21, 22, 25, 40, 101, 111, 1000].flatMap((n) =>
    (["fail", "error"] as const).map((value): [string, KubeObject] => {
      const r = copy(base);
      r.results = Array.from({ length: n }, (_, i) => ({ result: value, policy: `p${i % 3}`, rule: `r${i}`, timestamp: { seconds: 1791712800 } }));
      r.summary = { pass: 0, fail: value === "fail" ? n : 0, warn: 0, error: value === "error" ? n : 0, skip: 0 };
      return [`${n} × ${value}`, r];
    }),
  );
}

describe("\"Only problems\", against the built-in tables", () => {
  const problemWhen = (kind: { kind: string }) => manifest.contributes.kinds.find((k) => k.kind === kind.kind)!.problemWhen;

  it("of the reports", () => {
    for (const def of KYVERNO_KINDS.filter((d) => d.kind.group !== "kyverno.io")) {
      const ephemeral = def.kind.group === "reports.kyverno.io";
      for (const [label, base] of reportVariants(report)) {
        const r = ephemeral ? asEphemeral(base, def.kind) : asKind(base, def.kind);
        expect(holdsNow(problemWhen(def.kind), r), `${def.kind.kind} ${label}`).toBe(isReportProblem(def.kind)(r));
      }
    }
  });

  it("of the policies: not ready by the Ready condition, else the older status.ready", () => {
    for (const def of [CLUSTER_POLICY, POLICY]) {
      for (const [label, p] of readyVariants()) expect(holdsNow(problemWhen(def), p), `${def.kind} ${label}`).toBe(isPolicyProblem(p));
    }
  });
});

function readyVariants(): [string, KubeObject][] {
  const out: [string, KubeObject][] = [];
  for (const condition of ["True", "False", "Unknown", "Odd", null]) {
    for (const legacy of [true, false, undefined]) {
      const p = copy(policy);
      const status: Record<string, unknown> = {};
      if (condition) status.conditions = [{ type: "Ready", status: condition, message: `message ${condition}` }];
      if (legacy !== undefined) status.ready = legacy;
      p.status = status;
      out.push([`condition ${condition}, ready ${legacy}`, p]);
    }
  }
  const none = copy(policy);
  delete none.status;
  out.push(["no status", none]);
  return out;
}

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.kyverno:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
function toneOf(id: string, obj: KubeObject): string | undefined {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  if (node?.props?.title !== undefined) node = node.props.children as typeof node;
  return node?.props?.tone;
}
const titleOf = (id: string, obj: KubeObject) => (windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string } } | null)?.props?.title;
/** The window's tones by the built-in tone names. */
const WINDOW_TONE: Record<string, string> = { success: "success", danger: "danger", warning: "warning", neutral: "neutral", muted: "muted" };

/** Policies of every mode shape the column tells apart: up to three rules of each type and action, each policy-wide action. */
function modeVariants(): [string, KubeObject][] {
  const RULES: [string, Record<string, unknown>][] = [
    ["validate Enforce", { validate: { failureAction: "Enforce" } }],
    ["validate enforce", { validate: { failureAction: "enforce" } }],
    ["validate Audit", { validate: { failureAction: "Audit" } }],
    ["validate", { validate: { pattern: {} } }],
    ["images Enforce", { verifyImages: [{ failureAction: "Enforce" }] }],
    ["images Audit", { verifyImages: [{ imageReferences: ["*"] }, { failureAction: "Audit" }] }],
    ["images", { verifyImages: [{ imageReferences: ["*"] }] }],
    ["mutate", { mutate: {} }],
  ];
  const out: [string, KubeObject][] = [];
  const lists: [string, Record<string, unknown>][][] = [[]];
  for (let n = 1; n <= 3; n++) {
    for (const list of lists.filter((l) => l.length === n - 1)) for (const r of RULES) lists.push([...list, r]);
  }
  for (const action of [undefined, "Enforce", "enforce", "Audit", "audit"]) {
    for (const list of lists) {
      const p = copy(policy);
      const spec = p.spec as Record<string, unknown>;
      spec.rules = list.map(([, r], i) => ({ name: `r${i}`, ...copy(r) }));
      if (action) spec.validationFailureAction = action;
      out.push([`${action ?? "-"}: ${list.map(([l]) => l).join(", ")}`, p]);
    }
  }
  return out;
}

describe("the columns, against the built-in ones", () => {
  it("are placed after the name (and namespace) in the built-in order and widths, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const byKind = (kind: string) => manifest.contributes.columns.filter((c) => c.kind.kind === kind).map((c) => [c.title, c.width]);
    const policyWidths = [["Ready", "90px"], ["Mode", "90px"], ["Background", "100px"], ["Rules", "70px"], ["Message", "minmax(160px, 3fr)"]];
    const reportWidths = [["Object", "minmax(160px, 2fr)"], ...["Pass", "Fail", "Warn", "Error", "Skip"].map((t) => [t, "70px"])];
    expect(byKind("ClusterPolicy")).toEqual(policyWidths);
    expect(byKind("Policy")).toEqual(policyWidths);
    for (const kind of ["PolicyReport", "ClusterPolicyReport", "EphemeralReport", "ClusterEphemeralReport"]) expect(byKind(kind), kind).toEqual(reportWidths);
    expect(columnOf("policy-ready").afterColumn).toBe("namespace");
    expect(columnOf("cluster-policy-ready").afterColumn).toBe("name");
    expect(columnOf("ephemeral-report-object").afterColumn).toBe("namespace");
  });

  for (const id of ["cluster-policy", "policy"]) {
    it(`Ready, Background, Rules and Message of a ${id}, sorted and filtered by the built-in values`, () => {
      for (const [label, p] of readyVariants()) {
        const ready = policyReady(p);
        expect(cell(`${id}-ready`, p), label).toBe(ready ? en[`ready.${ready}` as keyof typeof en] : undefined);
        if (ready) expect(toneOf(`${id}-ready`, p), label).toBe(WINDOW_TONE[readyTone(ready)]);
        // The built-in column's value was the state: True, False, Unknown.
        expect(windowColumn(`${id}-ready`).value(p), label).toBe(ready);
        expect(windowColumn(`${id}-ready`).filter?.value(p, { now: NOW }), label).toBe(ready);
        expect(cell(`${id}-message`, p), label).toBe(policyMessage(p));
        expect(titleOf(`${id}-message`, p), label).toBe(policyMessage(p));
      }
      for (const background of [true, false, undefined, "x"]) {
        const p = copy(policy);
        (p.spec as Record<string, unknown>).background = background;
        expect(cell(`${id}-background`, p), String(background)).toBe(backgroundScan(p) ? en.yes : en.no);
        // The built-in sorted the boolean: No before Yes.
        expect(windowColumn(`${id}-background`).value(p), String(background)).toBe(Number(backgroundScan(p)));
      }
      for (const [label, p] of modeVariants().slice(0, 40)) {
        expect(windowColumn(`${id}-rules`).value(p), label).toBe(policyRules(p).length);
        expect(windowColumn(`${id}-rules`).filter?.value(p, { now: NOW }), label).toBe(policyRules(p).length);
      }
      const bare = copy(policy);
      delete (bare.spec as Record<string, unknown>).rules;
      expect(windowColumn(`${id}-rules`).value(bare)).toBe(0);
    });

    it(`Mode of a ${id}: Enforce, Audit or Mixed over every rule as the built-in column read it`, () => {
      const variants = [...modeVariants(), ...longModeVariants()];
      expect(variants.length).toBeGreaterThan(3000);
      for (const [label, p] of variants) {
        const mode = policyMode(p);
        expect(cell(`${id}-mode`, p), label).toBe(mode ? en[`mode.${mode}` as keyof typeof en] : undefined);
        if (mode) expect(toneOf(`${id}-mode`, p), label).toBe(WINDOW_TONE[modeTone(mode)]);
        expect(windowColumn(`${id}-mode`).value(p), label).toBe(mode);
        expect(windowColumn(`${id}-mode`).filter?.value(p, { now: NOW }), label).toBe(mode);
      }
    });
  }

  it("Mode reads every rule and a verifyImages entry's lowercase action", () => {
    const p = copy(policy);
    const spec = p.spec as Record<string, unknown>;
    spec.rules = [{ mutate: {} }, { mutate: {} }, { mutate: {} }, { mutate: {} }, { mutate: {} }, { validate: { failureAction: "Enforce" } }];
    expect(policyMode(p)).toBe("Enforce");
    expect(cell("cluster-policy-mode", p)).toBe("Enforce");
    spec.rules = [{ verifyImages: [{ failureAction: "enforce" }] }];
    expect(policyMode(p)).toBe("Enforce");
    expect(cell("cluster-policy-mode", p)).toBe("Enforce");
  });

  it("Mode counts every action of a verifyImages rule's entries (the built-in took the first entry with one)", () => {
    const p = copy(policy);
    (p.spec as Record<string, unknown>).rules = [{ verifyImages: [{ failureAction: "Audit" }, { failureAction: "Enforce" }] }];
    expect(policyMode(p)).toBe("Audit");
    expect(cell("cluster-policy-mode", p)).toBe("Mixed");
  });

  for (const def of KYVERNO_KINDS.filter((d) => d.kind.group !== "kyverno.io")) {
    it(`the object and counts of a ${def.kind.kind}`, () => {
      const ephemeral = def.kind.group === "reports.kyverno.io";
      for (const [label, base] of [...reportVariants(report), ...countVariants(report)]) {
        const r = ephemeral ? asEphemeral(base, def.kind) : asKind(base, def.kind);
        const scope = reportScope(def.kind, r);
        expect(cell(`${def.section}-object`, r), label).toBe(scope ? `${scope.kind.kind}/${scope.name}` : undefined);
        const summary = reportSummary(def.kind, r);
        for (const value of RESULT_VALUES) {
          const id = `${def.section}-${value}`;
          const n = summary[value];
          expect(windowColumn(id).value(r), `${id} ${label}`).toBe(n);
          expect(windowColumn(id).filter?.value(r, { now: NOW }), `${id} ${label}`).toBe(n);
          expect(cell(id, r), `${id} ${label}`).toBe(String(n));
          // Failures and errors red, as the built-in column drew them, from the summary or counted.
          const red = (value === "fail" || value === "error") && n > 0;
          expect(toneOf(id, r), `${id} ${label}`).toBe(red ? "danger" : undefined);
        }
      }
    });
  }

  it("draw any count of failures red, sorted and filtered as the number", () => {
    const r = copy(report);
    (r.summary as Record<string, number>).fail = 1234;
    expect(windowColumn("policy-report-fail").value(r)).toBe(1234);
    expect(windowColumn("policy-report-fail").filter?.value(r, { now: NOW })).toBe(1234);
    expect(toneOf("policy-report-fail", r)).toBe("danger");
  });
});

/** Policies of five to seven rules: two validating ones of every shape pair among mutating ones, first and last. */
function longModeVariants(): [string, KubeObject][] {
  const shapes = modeVariants()
    .filter(([label]) => label.startsWith("-: ") && label !== "-: " && !label.includes(","))
    .map(([, p]) => (p.spec as { rules: Record<string, unknown>[] }).rules[0]!);
  const out: [string, KubeObject][] = [];
  for (const action of [undefined, "Enforce", "Audit"]) {
    shapes.forEach((a, i) =>
      shapes.forEach((b, j) => {
        for (const layout of [0, 1]) {
          const p = copy(policy);
          const spec = p.spec as Record<string, unknown>;
          const filler = Array.from({ length: 4 + layout }, () => ({ mutate: {} }));
          spec.rules = layout === 0 ? [...filler, copy(a), copy(b)] : [copy(a), ...filler, copy(b)];
          if (action) spec.validationFailureAction = action;
          out.push([`${action ?? "-"}: long ${i}/${j}/${layout}`, p]);
        }
      }),
    );
  }
  return out;
}
