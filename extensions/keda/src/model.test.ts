// The model and the manifest's declarative parts. The kinds' "Only problems" and the columns are judged here by
// Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run time so the type check
// stays inside the extension) and compared with the model they replace — the reading of Sextant's former built-in
// view (ADR-0080), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import objectsJson from "../fixtures/objects.json";
import { analyzeHpa } from "./hpa";
import {
  authSources,
  CLUSTER_TRIGGER_AUTHENTICATION,
  isProblem,
  kedaState,
  managedHpaName,
  PROVIDERS,
  readyOf,
  readyTone,
  SCALED_JOB,
  SCALED_OBJECT,
  scaleTargetOf,
  sourcesText,
  stateTone,
  stateWord,
  TRIGGER_AUTHENTICATION,
  triggersOf,
  triggerTypes,
  type KindRef,
} from "./model";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const byName = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const ofKind = (kind: string) => objects.filter((o) => o.kind === kind).map(copy);
type Cond = { type: string; status?: string; reason?: string; message?: string };
const conditions = (o: KubeObject) => ((o.status ??= {}) as { conditions?: Cond[] });

describe("the model", () => {
  it("reads targets, triggers, the managed HPA and the state as the built-in view did", () => {
    const so = byName("ScaledObject", "orders");
    expect(scaleTargetOf(so)).toEqual({ apiVersion: "apps/v1", kind: "Deployment", name: "orders" });
    expect(scaleTargetOf(byName("ScaledObject", "held"))).toEqual({ apiVersion: "apps/v1", kind: "Deployment", name: "web" });
    expect(managedHpaName(so)).toBe("keda-hpa-orders");
    expect(managedHpaName(byName("ScaledObject", "paused"))).toBe("keda-hpa-paused");
    const triggers = triggersOf(so);
    expect(triggers[0]).toMatchObject({ type: "rabbitmq", name: "orders-queue", failures: 4, health: "Failure", auth: { kind: "TriggerAuthentication", name: "rabbit" } });
    expect(triggers[0]!.metadata).toEqual(["queueName=orders", "mode=QueueLength", "value=20"]);
    expect(triggers[1]).toMatchObject({ auth: { kind: "ClusterTriggerAuthentication", name: "cluster-aws" }, failures: 0, health: "Happy" });
    expect(triggerTypes(so)).toEqual(["rabbitmq", "cron"]);
    expect(kedaState(so).phrases.map((p) => p.key)).toEqual(["keda.triggerFailing", "keda.active"]);
    expect(kedaState(byName("ScaledObject", "paused")).phrases.map((p) => p.key)).toEqual(["keda.paused"]);
    expect(kedaState(byName("ScaledObject", "held")).phrases.map((p) => p.key)).toEqual(["keda.pausedAt"]);
    expect(kedaState(byName("ScaledObject", "fallback")).phrases.map((p) => p.key)).toEqual(["keda.fallback", "keda.triggerFailing", "keda.active"]);
    expect(kedaState(byName("ScaledObject", "broken")).phrases.map((p) => p.key)).toEqual(["keda.notReady", "keda.inactive"]);
    expect(kedaState(byName("ScaledObject", "idle")).phrases).toEqual([{ key: "keda.inactiveIdle", params: { replicas: 0 }, tone: "neutral" }]);
    expect(kedaState(byName("ScaledJob", "importer"), true).phrases).toEqual([{ key: "keda.jobActive", params: { max: 5 }, tone: "success" }]);
    expect(stateWord(byName("ScaledObject", "broken"))).toBe("ScaledObjectCheckFailed");
    expect(stateWord(byName("ScaledObject", "unknown"))).toBe("NotReady");
    expect(stateWord(byName("ScaledObject", "fresh"))).toBeUndefined();
  });

  it("tells where the parameters come from, names only", () => {
    expect(authSources(byName("TriggerAuthentication", "vault"))).toEqual({ sources: [{ parameter: "password", from: "hashiCorpVault", name: "secret/data/rabbit" }] });
    expect(authSources(byName("TriggerAuthentication", "azure"))).toEqual({ sources: [{ parameter: "", from: "azureKeyVault" }], podIdentity: "azure-workload" });
    expect(sourcesText(byName("TriggerAuthentication", "mixed"))).toBe("Secret, ConfigMap, env");
    expect(sourcesText(byName("ClusterTriggerAuthentication", "cluster-aws"))).toBe("Secret, aws");
    expect(sourcesText(byName("TriggerAuthentication", "empty"))).toBe("");
  });

  it("explains the managed HPA as the built-in summary did", () => {
    const a = analyzeHpa(byName("HorizontalPodAutoscaler", "keda-hpa-orders"));
    expect(a.verdict.key).toBe("verdict.noMetrics");
    expect(a.causes.map((c) => c.key)).toEqual(["cause.noExternalMetrics"]);
    expect(a.metrics.map((m) => [m.currentText, m.targetText, m.proposes, m.withinTolerance])).toEqual([
      ["18", "20", 3, true],
      [undefined, "1", undefined, undefined],
    ]);
    expect(a.metrics[0]!.selector).toBe("scaledobject.keda.sh/name=orders");
  });
});

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
}
interface WindowColumn {
  value(obj: KubeObject): unknown;
  filter?: { type: string; value(obj: KubeObject, ctx: { now: number }): unknown };
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
});

const holdsNow = (condition: unknown, obj: KubeObject) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && v.activeFrom === undefined && v.until === undefined;
};
const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.keda:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = Date.parse("2026-10-22T14:00:00Z");
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
interface Drawn {
  title?: string;
  tone?: string;
}
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject): Drawn {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title: title || undefined, tone: node?.props?.tone };
}
const sortOf = (id: string, obj: KubeObject) => windowColumn(id).value(obj);

/** Every ScaledObject and ScaledJob of the fixtures, and variants of their conditions and annotations. */
function scaled(kind: "ScaledObject" | "ScaledJob"): [string, KubeObject][] {
  const out: [string, KubeObject][] = ofKind(kind).map((o) => [o.metadata.name, o]);
  const base = ofKind(kind)[0]!;
  const reasons = ["Failed", "Unknown", "Ready", "Completed", "Init:Error", "Init:CrashLoopBackOff", "Waiting", "", undefined];
  for (const reason of reasons) {
    for (const status of ["False", "Unknown", "", undefined]) {
      const o = copy(base);
      conditions(o).conditions = [{ type: "Ready", ...(status === undefined ? {} : { status }), ...(reason === undefined ? {} : { reason }) }];
      out.push([`ready ${status} ${reason}`, o]);
    }
  }
  const annotationVariants: [string, Record<string, string>][] = [
    ["paused false", { "autoscaling.keda.sh/paused": "false" }],
    ["paused true", { "autoscaling.keda.sh/paused": "true" }],
    ["paused-replicas empty", { "autoscaling.keda.sh/paused-replicas": "" }],
    ["paused-replicas", { "autoscaling.keda.sh/paused-replicas": "0" }],
  ];
  for (const [label, annotations] of annotationVariants) {
    for (const active of ["True", "False", undefined]) {
      for (const fallback of ["True", "False", undefined]) {
        const o = copy(base);
        o.metadata.annotations = annotations;
        conditions(o).conditions = [
          { type: "Ready", status: "True" },
          ...(active ? [{ type: "Active", status: active }] : []),
          ...(fallback ? [{ type: "Fallback", status: fallback }] : []),
        ];
        out.push([`${label} active ${active} fallback ${fallback}`, o]);
      }
    }
  }
  const pausedCondition = copy(base);
  conditions(pausedCondition).conditions = [{ type: "Ready", status: "True" }, { type: "Paused", status: "True" }, { type: "Active", status: "True" }];
  out.push(["Paused condition", pausedCondition]);
  const noTypes = copy(base);
  (noTypes.spec as Record<string, unknown>).triggers = [{ type: "" }, { metadata: {} }, { type: "cpu" }, { type: "cpu" }, { type: "memory" }];
  out.push(["types missing or repeated", noTypes]);
  const noTriggers = copy(base);
  delete (noTriggers.spec as Record<string, unknown>).triggers;
  out.push(["no triggers", noTriggers]);
  return out;
}

const PREFIX: Record<string, string> = { ScaledObject: "so", ScaledJob: "sj" };

describe("the columns, against the built-in ones", () => {
  it("are placed after the name or namespace, in the built-in order and widths, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const ids = (k: string) => manifest.contributes.columns.filter((c) => c.kind.kind === k).map((c) => [c.afterColumn, c.id, c.width]);
    expect(ids("ScaledObject")).toEqual([
      ["namespace", "so-target", "minmax(140px, 1.5fr)"],
      ["so-target", "so-min", "60px"],
      ["so-min", "so-max", "60px"],
      ["so-max", "so-triggers", "minmax(120px, 1.5fr)"],
      ["so-triggers", "so-ready", "80px"],
      ["so-ready", "so-state", "100px"],
    ]);
    expect(ids("ScaledJob")).toEqual([
      ["namespace", "sj-max", "60px"],
      ["sj-max", "sj-triggers", "minmax(120px, 1.5fr)"],
      ["sj-triggers", "sj-ready", "80px"],
      ["sj-ready", "sj-state", "100px"],
    ]);
    expect(ids("TriggerAuthentication")).toEqual([["namespace", "ta-sources", "minmax(160px, 2fr)"]]);
    expect(ids("ClusterTriggerAuthentication")).toEqual([["name", "cta-sources", "minmax(160px, 2fr)"]]);
  });

  it("show a ScaledObject's target, replica range and triggers", () => {
    for (const [label, o] of scaled("ScaledObject")) {
      const t = scaleTargetOf(o);
      expect(cell("so-target", o), label).toBe(t ? `${t.kind}/${t.name}` : undefined);
      const min = (o.spec as { minReplicaCount?: number }).minReplicaCount ?? 0;
      const max = (o.spec as { maxReplicaCount?: number }).maxReplicaCount ?? 100;
      expect([cell("so-min", o), sortOf("so-min", o)], label).toEqual([String(min), min]);
      expect([cell("so-max", o), sortOf("so-max", o)], label).toEqual([String(max), max]);
      const types = triggerTypes(o).join(", ");
      expect(cell("so-triggers", o), label).toBe(types === "" ? undefined : types);
    }
    for (const [label, o] of scaled("ScaledJob")) {
      const max = (o.spec as { maxReplicaCount?: number }).maxReplicaCount ?? 100;
      expect(cell("sj-max", o), label).toBe(String(max));
    }
  });

  it("say Ready and the state in the built-in words and tones", () => {
    for (const kind of ["ScaledObject", "ScaledJob"] as const) {
      const p = PREFIX[kind]!;
      for (const [label, o] of scaled(kind)) {
        const ready = readyOf(o);
        // An empty status is a blank cell in both.
        expect(cell(`${p}-ready`, o) || undefined, label).toBe(ready || undefined);
        if (ready) expect(drawn(`${p}-ready`, o).tone, label).toBe(readyTone(ready));
        const word = stateWord(o);
        expect(cell(`${p}-state`, o), label).toBe(word);
        if (word) expect(drawn(`${p}-state`, o).tone, `${label}: ${word}`).toBe(stateTone(word));
      }
    }
  });

  it("tell a TriggerAuthentication's sources: the 19 usual sets exactly, any other by its fields", () => {
    const sources: [string, unknown][] = [
      ["secretTargetRef", [{ parameter: "p", name: "s", key: "k" }]],
      ["configMapTargetRef", [{ parameter: "p", name: "c", key: "k" }]],
      ["env", [{ parameter: "p", name: "E" }]],
      ...PROVIDERS.map((p) => [p, { secrets: [{ parameter: "p", path: "x" }] }] as [string, unknown]),
      ["podIdentity", { provider: "azure-workload" }],
    ];
    let exact = 0;
    for (let mask = 0; mask < 1 << sources.length; mask++) {
      const spec: Record<string, unknown> = {};
      sources.forEach(([field, value], i) => {
        if (mask & (1 << i)) spec[field] = copy(value);
      });
      for (const kind of [TRIGGER_AUTHENTICATION, CLUSTER_TRIGGER_AUTHENTICATION]) {
        const o = { apiVersion: "keda.sh/v1alpha1", kind: kind.kind, metadata: { name: "x", ...(kind === TRIGGER_AUTHENTICATION ? { namespace: "shop" } : {}) }, spec } as KubeObject;
        const id = kind === TRIGGER_AUTHENTICATION ? "ta-sources" : "cta-sources";
        const text = sourcesText(o);
        const shown = cell(id, o);
        if (shown === (text === "" ? undefined : text)) {
          exact++;
          continue;
        }
        // Another set: its fields, in key order, joined in the UI language (the README's known difference).
        expect(shown?.split(/,\s*/), JSON.stringify(spec)).toEqual(Object.keys(spec));
      }
    }
    expect(exact).toBe(2 * 20);
    for (const o of [...ofKind("TriggerAuthentication"), ...ofKind("ClusterTriggerAuthentication")]) {
      const id = o.kind === "TriggerAuthentication" ? "ta-sources" : "cta-sources";
      const text = sourcesText(o);
      if (o.metadata.name !== "clouds") expect(cell(id, o), o.metadata.name).toBe(text === "" ? undefined : text);
    }
  });
});

describe("Only problems, against the built-in filter", () => {
  it("shows the same objects", () => {
    const kinds: [KindRef, KubeObject[]][] = [
      [SCALED_OBJECT, scaled("ScaledObject").map(([, o]) => o)],
      [SCALED_JOB, scaled("ScaledJob").map(([, o]) => o)],
      [TRIGGER_AUTHENTICATION, ofKind("TriggerAuthentication")],
      [CLUSTER_TRIGGER_AUTHENTICATION, ofKind("ClusterTriggerAuthentication")],
    ];
    for (const [kind, list] of kinds) {
      const when = manifest.contributes.kinds.find((k) => sameKind(k, kind))!.problemWhen;
      for (const o of list) expect(holdsNow(when, o), `${kind.kind} ${JSON.stringify(o.status)}`).toBe(isProblem(o));
    }
    expect(scaled("ScaledObject").some(([, o]) => isProblem(o))).toBe(true);
  });
});
