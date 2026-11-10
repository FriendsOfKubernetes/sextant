// The model and the manifest's declarative parts. The packages' "Only problems" and every column are judged here by
// Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run time so the type check
// stays inside the extension) and compared with the model they replace — the reading of Sextant's former built-in view
// (ADR-0101), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import claimJson from "../fixtures/claim.json";
import compositeJson from "../fixtures/composite.json";
import managedJson from "../fixtures/managed.json";
import providerJson from "../fixtures/provider.json";
import xrdJson from "../fixtures/xrd.json";
import en from "./locales/en.json";
import {
  byState,
  compositionFields,
  conditionStatus,
  conditionTone,
  CREATING_GRACE_MS,
  FAILURE_GRACE_MS,
  explainPackage,
  explainResource,
  explainXrd,
  firstFailing,
  HEALTH_TONE,
  isProblemRow,
  kindFromApiVersion,
  mayBeCrossplaneResource,
  packageFields,
  packageHealth,
  parseXrd,
  resourceHealth,
  resourceRefsOf,
  roleOf,
  toRow,
  type KindRef,
} from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const xrd = () => copy(xrdJson) as unknown as KubeObject;
const claim = () => copy(claimJson) as unknown as KubeObject;
const composite = () => copy(compositeJson) as unknown as KubeObject;
const managed = () => copy(managedJson) as unknown as KubeObject;
const provider = () => copy(providerJson) as unknown as KubeObject;
const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
type Cond = { type: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string };
const conditions = (o: KubeObject) => (o.status as { conditions: Cond[] }).conditions;
const spec = (o: KubeObject) => o.spec as Record<string, unknown>;

describe("the model", () => {
  it("reads the kinds an XRD defines and tells claims from composites", () => {
    const info = parseXrd(xrd())!;
    expect(info.composite).toEqual(kindOf(composite()));
    expect(info.claim).toEqual(kindOf(claim()));
    expect(roleOf(kindOf(claim()), [info])).toBe("claim");
    expect(roleOf(kindOf(composite()), [info])).toBe("composite");
    expect(roleOf(kindOf(managed()), [info])).toBeUndefined();
    expect(explainXrd(info)).toEqual({ key: "xrdEstablishedWithClaim", params: { kind: "XPostgreSQLInstance", claim: "PostgreSQLInstance" } });
  });

  it("Synced and Ready: creating is progress, a reconcile error is a failure named first", () => {
    expect(resourceHealth(claim())).toBe("progressing");
    expect(explainResource(claim())).toEqual({ key: "creating" });
    expect(resourceHealth(managed())).toBe("failed");
    expect(firstFailing(managed())?.reason).toBe("ReconcileError");
    expect(explainResource(managed())).toEqual({ key: "notSynced", params: { reason: "ReconcileError" } });
    expect(packageHealth(provider())).toBe("failed");
    expect(explainPackage(provider())).toEqual({ key: "packageUnhealthy", params: { reason: "UnhealthyPackageRevision" } });
  });

  it("a paused resource (ReconcilePaused) is neutral: paused, never failed, never a problem", () => {
    const paused = claim();
    paused.metadata.annotations = { "crossplane.io/paused": "true" };
    (paused.status as { conditions: unknown[] }).conditions = [
      { type: "Synced", status: "False", reason: "ReconcilePaused", lastTransitionTime: "2026-10-10T10:00:00Z" },
      { type: "Ready", status: "True", reason: "Available" },
    ];
    expect(resourceHealth(paused)).toBe("paused");
    expect(firstFailing(paused)).toBeUndefined();
    expect(explainResource(paused)).toEqual({ key: "paused" });
    expect(isProblemRow(toRow(paused, kindOf(paused), "claim"))).toBe(false);
    paused.metadata.annotations = {};
    expect(resourceHealth(paused)).toBe("paused");
    conditions(paused)[0]!.reason = "ReconcileError";
    expect(resourceHealth(paused)).toBe("failed");
  });

  it("reads Crossplane v2's fields under spec.crossplane", () => {
    const v2 = composite();
    spec(v2).crossplane = { resourceRefs: spec(v2).resourceRefs };
    delete spec(v2).resourceRefs;
    expect(resourceRefsOf(v2).map((r) => r.kind)).toEqual(["Instance", "SecurityGroup"]);
  });

  it("makes rows of claims and composites, problems first, a claimed composite told through its claim", () => {
    const failing = claim();
    conditions(failing)[0] = { type: "Synced", status: "False", reason: "ReconcileError" };
    const rows = [toRow(composite(), kindOf(composite()), "composite"), toRow(failing, kindOf(failing), "claim")].sort(byState);
    expect(rows.map((r) => [r.ref.name, r.health, r.failing?.reason, r.composition])).toEqual([
      ["my-db", "failed", "ReconcileError", "xpostgresqlinstances.aws.database.example.org"],
      ["my-db-x7k2p", "progressing", "Creating", "xpostgresqlinstances.aws.database.example.org"],
    ]);
    expect(rows.map(isProblemRow)).toEqual([true, false]);
    expect(CREATING_GRACE_MS).toBe(30 * 60_000);
  });

  it("looks for claims, composites and managed resources only on kinds of installed APIs", () => {
    expect(mayBeCrossplaneResource({ group: "rds.aws.upbound.io", kind: "Instance" })).toBe(true);
    expect(mayBeCrossplaneResource({ group: "database.example.org", kind: "PostgreSQLInstance" })).toBe(true);
    for (const kind of [
      { group: "", kind: "Pod" },
      { group: "apps", kind: "Deployment" },
      { group: "networking.k8s.io", kind: "Ingress" },
      { group: "apiextensions.crossplane.io", kind: "Composition" },
      { group: "pkg.crossplane.io", kind: "ProviderRevision" },
    ])
      expect(mayBeCrossplaneResource(kind), kind.kind).toBe(false);
  });
});

// ---------- The window's engine ----------

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
  width?: string;
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
  // The window's engine is compiled on first import: slow on a busy machine.
}, 120_000);

const holdsNow = (condition: unknown, obj: KubeObject) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && v.activeFrom === undefined && v.until === undefined;
};

// ---------- Variants of the fixtures ----------

function xrds(): [string, KubeObject][] {
  const list: [string, KubeObject][] = [["the fixture", xrd()]];
  const add = (label: string, change: (o: KubeObject) => void) => {
    const o = xrd();
    change(o);
    list.push([label, o]);
  };
  add("no claim", (o) => delete spec(o).claimNames);
  add("an empty claim kind", (o) => (spec(o).claimNames = { kind: "" }));
  add("no group", (o) => delete spec(o).group);
  add("an empty group", (o) => (spec(o).group = ""));
  add("no kind", (o) => (spec(o).names = { plural: "x" }));
  add("not established", (o) => (conditions(o)[0]!.status = "False"));
  add("established unknown", (o) => (conditions(o)[0]!.status = "Unknown"));
  add("an odd status", (o) => (conditions(o)[1]!.status = "Maybe"));
  add("no offered", (o) => conditions(o).splice(1, 1));
  add("no status", (o) => delete (o as { status?: unknown }).status);
  return list;
}

function compositions(): [string, KubeObject][] {
  const base = (s: Record<string, unknown>): KubeObject => ({ apiVersion: "apiextensions.crossplane.io/v1", kind: "Composition", metadata: { name: "c", uid: "u" }, spec: s });
  const ref = { apiVersion: "database.example.org/v1alpha1", kind: "XPostgreSQLInstance" };
  return [
    ["a pipeline", base({ compositeTypeRef: ref, mode: "Pipeline", pipeline: [{ step: "patch", functionRef: { name: "function-patch-and-transform" } }] })],
    ["a pipeline without a mode", base({ compositeTypeRef: ref, pipeline: [{ step: "patch" }] })],
    ["resources without a mode", base({ compositeTypeRef: ref, resources: [{ name: "rds" }] })],
    ["an empty pipeline without a mode", base({ compositeTypeRef: ref, pipeline: [] })],
    ["a pipeline that is no list", base({ compositeTypeRef: ref, pipeline: { step: "x" } })],
    ["a mode Resources", base({ compositeTypeRef: ref, mode: "Resources", pipeline: [{ step: "x" }] })],
    ["no composite type", base({ mode: "Pipeline" })],
    ["a composite type without a kind", base({ compositeTypeRef: { apiVersion: "a/v1" } })],
    ["a composite type with an empty version", base({ compositeTypeRef: { apiVersion: "", kind: "X" } })],
    ["no spec", { apiVersion: "apiextensions.crossplane.io/v1", kind: "Composition", metadata: { name: "c" } }],
  ];
}

function packages(): [string, KubeObject][] {
  const list: [string, KubeObject][] = [["the fixture", provider()]];
  const add = (label: string, conds: Cond[] | undefined, change?: (o: KubeObject) => void) => {
    const o = provider();
    if (conds === undefined) delete (o as { status?: unknown }).status;
    else (o.status as Record<string, unknown>).conditions = conds;
    change?.(o);
    list.push([label, o]);
  };
  const c = (type: string, status: string): Cond => ({ type, status });
  add("healthy", [c("Installed", "True"), c("Healthy", "True")]);
  add("not installed", [c("Installed", "False"), c("Healthy", "True")]);
  add("not installed nor healthy", [c("Installed", "False"), c("Healthy", "False")]);
  add("installing", [c("Installed", "True"), c("Healthy", "Unknown")]);
  add("installed only", [c("Installed", "True")]);
  add("healthy only", [c("Healthy", "True")]);
  add("unknown both", [c("Installed", "Unknown"), c("Healthy", "Unknown")]);
  add("empty statuses", [c("Installed", ""), c("Healthy", "")]);
  add("other conditions only", [c("Active", "True")]);
  add("no conditions", []);
  add("no status", undefined);
  add("no package", [c("Installed", "True"), c("Healthy", "True")], (o) => delete spec(o).package);
  return list;
}

// ---------- "Only problems" ----------

describe("the packages' Only problems, against the built-in filter", () => {
  it("shows the failed packages, and XRDs and Compositions have none", () => {
    for (const kind of manifest.contributes.kinds) {
      const when = (kind as { problemWhen?: unknown }).problemWhen;
      if (kind.group !== "pkg.crossplane.io") {
        expect(when, kind.kind).toBeUndefined();
        continue;
      }
      for (const [label, o] of packages()) expect(holdsNow(when, o), `${kind.kind} ${label}`).toBe(packageHealth(o) === "failed");
    }
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.crossplane:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = Date.parse("2026-10-22T14:00:00Z");
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject): { title?: string; tone?: string } {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title: title || undefined, tone: node?.props?.tone };
}
const sortOf = (id: string, obj: KubeObject) => windowColumn(id).value(obj);
const filterOf = (id: string, obj: KubeObject) => {
  const filter = windowColumn(id).filter!;
  return { type: filter.type, value: filter.value(obj, { now: NOW }) };
};

/** A condition column as the built-in drew it: the status, coloured by it, sorted by it. */
function expectConditionColumn(id: string, type: string, obj: KubeObject, label: string): void {
  const value = conditionStatus(obj, type);
  expect(cell(id, obj), `${id} ${label}`).toBe(value);
  expect(sortOf(id, obj), `${id} ${label}`).toBe(value);
  if (value) expect(drawn(id, obj).tone, `${id} ${label}`).toBe(conditionTone(value));
}

describe("the columns, against the built-in ones", () => {
  it("are placed after the name, in the built-in order and widths, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const ids = (k: string) => manifest.contributes.columns.filter((c) => c.kind.kind === k).map((c) => [c.afterColumn, c.id, c.width]);
    expect(ids("CompositeResourceDefinition")).toEqual([
      ["name", "xrd-composite", "minmax(120px, 1fr)"],
      ["xrd-composite", "xrd-claim", "minmax(120px, 1fr)"],
      ["xrd-claim", "xrd-established", "100px"],
      ["xrd-established", "xrd-offered", "100px"],
    ]);
    expect(ids("Composition")).toEqual([
      ["name", "composition-type", "minmax(180px, 2fr)"],
      ["composition-type", "composition-mode", "100px"],
    ]);
    for (const [kind, p] of [
      ["Provider", "provider"],
      ["Configuration", "configuration"],
      ["Function", "function"],
    ] as const)
      expect(ids(kind)).toEqual([
        ["name", `${p}-status`, "110px"],
        [`${p}-status`, `${p}-package`, "minmax(200px, 3fr)"],
        [`${p}-package`, `${p}-installed`, "100px"],
        [`${p}-installed`, `${p}-healthy`, "100px"],
      ]);
    expect(columnOf("xrd-composite").title).toBe("Composite kind");
  });

  it("of XRDs: the composite and claim kinds, Established and Offered", () => {
    for (const [label, o] of xrds()) {
      const info = parseXrd(o);
      expect(cell("xrd-composite", o), label).toBe(info?.composite.kind);
      expect(sortOf("xrd-composite", o), label).toBe(info?.composite.kind);
      expect(cell("xrd-claim", o), label).toBe(info?.claim?.kind);
      expect(sortOf("xrd-claim", o), label).toBe(info?.claim?.kind);
      expectConditionColumn("xrd-established", "Established", o, label);
      expectConditionColumn("xrd-offered", "Offered", o, label);
    }
  });

  it("of Compositions: the composite type and the mode", () => {
    for (const [label, o] of compositions()) {
      const f = compositionFields(o);
      expect(cell("composition-type", o), label).toBe(f.compositeType);
      expect(sortOf("composition-type", o), label).toBe(f.compositeType);
      expect(cell("composition-mode", o), label).toBe(f.mode);
      expect(sortOf("composition-mode", o), label).toBe(f.mode);
    }
  });

  it("of packages: the state in words, coloured and sorted by it, the package with its hover, Installed and Healthy", () => {
    for (const p of ["provider", "configuration", "function"]) {
      for (const [label, o] of packages()) {
        const health = packageHealth(o);
        expect(cell(`${p}-status`, o), label).toBe(en[`health.${health}` as keyof typeof en]);
        expect(drawn(`${p}-status`, o).tone, label).toBe(HEALTH_TONE[health]);
        expect(sortOf(`${p}-status`, o), label).toBe(health);
        expect(filterOf(`${p}-status`, o), label).toEqual({ type: "string", value: health });
        const pkg = packageFields(o).package;
        expect(cell(`${p}-package`, o), label).toBe(pkg);
        expect(drawn(`${p}-package`, o).title, label).toBe(pkg);
        expectConditionColumn(`${p}-installed`, "Installed", o, label);
        expectConditionColumn(`${p}-healthy`, "Healthy", o, label);
      }
    }
  });
});

describe("the manifest", () => {
  it("judges claims and composites only by rules of the kinds the XRDs define (problems.test.ts compares them)", () => {
    const rules = manifest.contributes.problems;
    expect(rules.map((r) => r.id)).toEqual(["not-synced", "not-ready-condition", "not-ready-condition-unnamed", "not-ready", "creating-condition", "creating"]);
    expect(rules.every((r) => "kindsFrom" in r && !("kind" in r))).toBe(true);
    expect(rules.map((r) => r.graceMinutes)).toEqual([2, 2, 2, 2, 30, 30]);
    expect(CREATING_GRACE_MS).toBe(30 * 60_000);
    expect(FAILURE_GRACE_MS).toBe(2 * 60_000);
  });

  it("reads every kind, and changes nothing", () => {
    expect(manifest.permissions.rules).toEqual([{ namespaces: { type: "all" }, kinds: { type: "all" }, actions: ["read"] }]);
  });
});
