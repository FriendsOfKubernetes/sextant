// The model and the manifest's declarative parts. The manifest's problem rule, the kind's "Only problems" and the
// columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run
// time so the type check stays inside the extension) and compared with the model they replace — the reading of
// Sextant's former built-in Sealed Secrets view (ADR-0109), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import fixtures from "../fixtures/objects.json";
import { CATALOGS } from "./i18n";
import en from "./locales/en.json";
import {
  base64Bytes,
  builtInProblems,
  failureHint,
  isProblem,
  scopeOf,
  sealedKeys,
  SYNC_GRACE_MS,
  TARGET_GRACE_MS,
  SYNC_TONE,
  syncOf,
  targetRelation,
  templateOf,
} from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const synced = fixtures.synced as unknown as KubeObject;
const failed = fixtures.failed as unknown as KubeObject;
const clusterWide = fixtures.clusterWide as unknown as KubeObject;
const target = fixtures.target as unknown as KubeObject;

describe("the model", () => {
  it("reads the Synced condition as the controller writes it, and a status of an older generation as pending", () => {
    expect(syncOf(synced)).toMatchObject({ state: "ready", noStatus: false, stale: false });
    expect(syncOf(failed)).toMatchObject({ state: "failed", message: "no key could decrypt secret (password, username)" });
    // observedGeneration 2 of generation 3: the status is of the old spec.
    expect(syncOf(clusterWide)).toMatchObject({ state: "progressing", stale: true });
    const none = copy(synced);
    delete none.status;
    expect(syncOf(none)).toMatchObject({ state: "progressing", noStatus: true });
    expect(isProblem(failed)).toBe(true);
    expect(isProblem(synced)).toBe(false);
  });

  it("reads the scope from the SealedSecret's own annotations, cluster-wide first", () => {
    expect(scopeOf(synced)).toBe("strict");
    expect(scopeOf(clusterWide)).toBe("clusterWide");
    const ns = copy(synced);
    ns.metadata = { ...ns.metadata, annotations: { "sealedsecrets.bitnami.com/namespace-wide": "true" } };
    expect(scopeOf(ns)).toBe("namespaceWide");
    ns.metadata.annotations = { "sealedsecrets.bitnami.com/namespace-wide": "yes" };
    expect(scopeOf(ns)).toBe("strict");
  });

  it("names the keys with their sealed sizes and the template's keys, never a value", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AA==")).toBe(1);
    expect(sealedKeys(failed)).toEqual([
      { name: "password", sealedBytes: base64Bytes("AgA1b2c3d4e5f6g7h8i9j0kLmNoPqRsTuVwXyZ0123456789+/==") },
      { name: "username", sealedBytes: 19 },
    ]);
    expect(templateOf(clusterWide)).toEqual({
      type: "kubernetes.io/dockerconfigjson",
      immutable: true,
      skipOwnerReferences: true,
      dataKeys: [
        { name: "config.yaml", omitted: false },
        { name: "legacy", omitted: true },
      ],
    });
  });

  it("tells how the Secret stands by the controller's own test", () => {
    expect(targetRelation(synced, target)).toBe("owned");
    const other = copy(target);
    (other.metadata.ownerReferences as { uid: string }[])[0]!.uid = "someone-else";
    expect(targetRelation(synced, other)).toBe("ownedByOther");
    const plain = copy(target);
    delete plain.metadata.ownerReferences;
    expect(targetRelation(synced, plain)).toBe("unmanaged");
    plain.metadata.annotations = { "sealedsecrets.bitnami.com/managed": "true" };
    expect(targetRelation(synced, plain)).toBe("managed");
    plain.metadata.annotations = { "sealedsecrets.bitnami.com/patch": "true" };
    expect(targetRelation(synced, plain)).toBe("patched");
  });

  it("explains the controller's errors by their texts", () => {
    expect(failureHint("no key could decrypt secret (password)")).toBe("noKey");
    expect(failureHint('failed update: Resource "x" already exists and is not managed by SealedSecret')).toBe("unmanaged");
    expect(failureHint("Secret \"x\" is invalid: data: Forbidden: field is immutable when `immutable` is set")).toBe("immutable");
    expect(failureHint("using deprecated 'data' field, use 'encryptedData' or flip the feature flag")).toBe("legacyData");
    expect(failureHint("something else")).toBeUndefined();
  });

  it("the built-in problems: a failed unseal after its grace from the transition, a missing Secret only where known", () => {
    expect(builtInProblems(failed, () => true, 0)).toEqual([
      {
        reason: "SyncFailed",
        message: "no key could decrypt secret (password, username)",
        since: "2025-10-15T08:00:00Z",
        activeAt: Date.parse("2025-10-15T08:00:00Z") + SYNC_GRACE_MS,
      },
    ]);
    expect(builtInProblems(synced, () => false, 0).map((p) => p.reason)).toEqual(["TargetMissing"]);
    expect(builtInProblems(synced, () => undefined, 0)).toEqual([]);
    expect(builtInProblems(clusterWide, () => false, 0)).toEqual([]);
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
  lookups?: unknown;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  width?: string;
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
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
});

const NOW = Date.parse("2026-11-01T12:00:00Z");
const holdsNow = (condition: unknown, obj: KubeObject) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && (v.activeFrom === undefined || v.activeFrom <= NOW) && (v.until === undefined || v.until > NOW);
};

// ---------- Variants ----------

type Condition = Record<string, unknown>;

/** SealedSecrets of every shape the readings tell apart: Synced and its message, generations, scopes, keys, deletion. */
function variants(): [string, KubeObject][] {
  const out: [string, KubeObject][] = [
    ["synced", copy(synced)],
    ["failed", copy(failed)],
    ["clusterWide", copy(clusterWide)],
  ];
  const statuses: (string | null | undefined)[] = ["True", "False", "Unknown", "", null, undefined];
  const messages: (string | undefined)[] = ["boom: no key could decrypt secret (a)", "", undefined];
  const generations: [number | undefined, number | undefined][] = [
    [undefined, undefined],
    [3, undefined],
    [undefined, 3],
    [3, 3],
    [3, 2],
    [2, 3],
  ];
  for (const status of statuses) {
    for (const message of messages) {
      for (const [generation, observed] of generations) {
        const o = copy(synced);
        const c: Condition = { type: "Synced", lastTransitionTime: "2026-10-01T10:00:02Z", lastUpdateTime: "2026-10-20T08:00:00Z" };
        if (status !== undefined) c.status = status;
        if (message !== undefined) c.message = message;
        o.status = { conditions: [{ type: "Other", status: "False", message: "not this one" }, c] };
        if (observed !== undefined) (o.status as Record<string, unknown>).observedGeneration = observed;
        if (generation !== undefined) o.metadata.generation = generation;
        else delete o.metadata.generation;
        out.push([`status ${String(status)}, message ${String(message)}, generation ${generation}/${observed}`, o]);
      }
    }
  }
  const noStatus = copy(synced);
  delete noStatus.status;
  out.push(["no status", noStatus]);
  const noConditions = copy(failed);
  noConditions.status = { observedGeneration: 2, conditions: "not a list" };
  out.push(["conditions not a list", noConditions]);
  const twoSynced = copy(failed);
  (twoSynced.status as { conditions: Condition[] }).conditions.push({ type: "Synced", status: "True" });
  out.push(["two Synced, the first counts", twoSynced]);
  const deleting = copy(failed);
  deleting.metadata.deletionTimestamp = "2026-11-01T11:00:00Z";
  out.push(["failed, being deleted", deleting]);
  const noTime = copy(failed);
  delete (noTime.status as { conditions: Condition[] }).conditions[0]!.lastTransitionTime;
  out.push(["failed, no transition time", noTime]);
  for (const cw of ["true", "yes", "True", undefined]) {
    for (const nw of ["true", "TRUE", undefined]) {
      const o = copy(synced);
      const annotations: Record<string, string> = {};
      if (cw !== undefined) annotations["sealedsecrets.bitnami.com/cluster-wide"] = cw;
      if (nw !== undefined) annotations["sealedsecrets.bitnami.com/namespace-wide"] = nw;
      o.metadata.annotations = annotations;
      out.push([`cluster-wide ${cw}, namespace-wide ${nw}`, o]);
    }
  }
  for (const [label, data] of [
    ["no keys", {}],
    ["one key", { a: "AAAA" }],
    ["no encryptedData", undefined],
    ["encryptedData a text", "AAAA"],
    ["encryptedData null", null],
  ] as const) {
    const o = copy(synced);
    const spec = o.spec as Record<string, unknown>;
    if (data === undefined) delete spec.encryptedData;
    else spec.encryptedData = data;
    out.push([label, o]);
  }
  return out;
}

// ---------- The kind, the rule and "Only problems" ----------

const kind = manifest.contributes.kinds[0]!;
type Rule = (typeof manifest.contributes.problems)[number];
const rules = manifest.contributes.problems as Rule[];

describe("the kind and its problem rule, against the built-in category `sealedSecrets`", () => {
  it("list SealedSecrets in the section `sealedSecrets` without the CRD's printer columns", () => {
    expect(kind).toMatchObject({ group: "bitnami.com", kind: "SealedSecret", section: "sealedSecrets", icon: "sealedSecret", order: 10, printerColumns: false });
    expect(manifest.contributes.sections).toEqual([{ section: "sealedSecrets", title: "Sealed Secrets", icon: "sealedSecrets", after: "crossplane" }]);
  });

  it("\"Only problems\" shows the failed ones, as the built-in `isProblem`", () => {
    let failing = 0;
    for (const [label, o] of variants()) {
      expect(holdsNow(kind.problemWhen, o), label).toBe(isProblem(o));
      if (isProblem(o)) failing++;
    }
    expect(failing).toBeGreaterThan(5);
  });

  it("are in the extension's own opt-in category, as the built-in category was opt-in", () => {
    expect(manifest.contributes.problemCategories).toEqual([{ id: "sealed-secrets", title: "Sealed Secrets", optIn: true }]);
    for (const rule of rules) expect(rule.category).toBe("sealed-secrets");
    expect(manifest.contributes.sectionBadges).toEqual([
      { section: "sealedSecrets", label: { one: "{{count}} object needs attention", other: "{{count}} objects need attention" } },
    ]);
  });

  const ruleOf = (id: string) => rules.find((r) => r.id === id)!;

  it("find a failed unseal where the built-in did: reason, notification, message, since and grace", () => {
    let compared = 0;
    for (const [label, o] of variants()) {
      const builtIn = builtInProblems(o, () => true, NOW).filter((p) => p.reason === "SyncFailed");
      const found = engine.detectRule(ruleOf("sync-failed"), o);
      expect(
        found.map((d) => d.reason),
        label,
      ).toEqual(builtIn.map((p) => p.reason));
      builtIn.forEach((p, i) => {
        const d = found[i]!;
        expect(d.notify, label).toBe(true);
        expect(d.message, label).toBe(p.message ?? "");
        expect(d.since, label).toBe(p.since);
        expect(d.graceMs, label).toBe(SYNC_GRACE_MS);
        // The store counts it from `since` (else from when it was first seen) plus the grace, as the built-in did.
        expect((d.since ? Date.parse(d.since) : NOW) + d.graceMs!, label).toBe(p.activeAt);
        expect(d.lookups, label).toBeUndefined();
        compared++;
      });
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("find a synced one whose Secret is missing where the built-in did: the Secret of its own name, 2 minutes after first seen", () => {
    let compared = 0;
    for (const [label, o] of variants()) {
      // The built-in judged against a list read in full: missing (false) gives the problem; the rule names the Secret
      // it looks up, and the window's judge keeps the problem only where that Secret is not listed.
      const builtIn = builtInProblems(o, () => false, NOW).filter((p) => p.reason === "TargetMissing");
      const found = engine.detectRule(ruleOf("target-missing"), o);
      expect(
        found.map((d) => d.reason),
        label,
      ).toEqual(builtIn.map((p) => p.reason));
      builtIn.forEach((p, i) => {
        const d = found[i]!;
        expect(d.lookups, label).toEqual([{ group: "", kind: "Secret", name: o.metadata.name }]);
        expect(d.notify, label).toBe(true);
        expect(d.since, label).toBeUndefined();
        expect(NOW + d.graceMs!, label).toBe(p.activeAt);
        expect(d.message, label).toBe(`Says it is synced, but its Secret ${o.metadata.name} does not exist.`);
        compared++;
      });
      // Where the Secret is there, the built-in had no problem; one not synced is never looked up.
      expect(builtInProblems(o, () => true, NOW).filter((p) => p.reason === "TargetMissing"), label).toEqual([]);
      if (syncOf(o).state !== "ready") expect(found, label).toEqual([]);
    }
    expect(compared).toBeGreaterThan(10);
    expect(TARGET_GRACE_MS).toBe(2 * 60_000);
  });

  it("the two rules never hold together, and the counter counts both, as the built-in counted every problem", () => {
    for (const [label, o] of variants()) {
      const reasons = rules.flatMap((rule) => engine.detectRule(rule, o).map((d) => d.reason));
      expect(reasons.length, label).toBeLessThanOrEqual(1);
    }
    expect(manifest.contributes.sectionBadges[0]).not.toHaveProperty("rules");
    expect(rules.map((r) => r.id)).toEqual(["sync-failed", "target-missing"]);
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.sealed-secrets:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
function toneOf(id: string, obj: KubeObject): string | undefined {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  if (node?.props?.title !== undefined) node = node.props.children as typeof node;
  return node?.props?.tone;
}
const titleOf = (id: string, obj: KubeObject) => (windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string } } | null)?.props?.title;
const catalog = en as Record<string, string>;
const localeOf = (language: string) => CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;

describe("the columns, against the built-in ones", () => {
  it("are Status, Scope, Keys and Message after the namespace, in the built-in widths", () => {
    expect(manifest.contributes.columns.map((c) => [c.id, c.title, c.afterColumn, c.width])).toEqual([
      ["status", "Status", "namespace", "100px"],
      ["scope", "Scope", "status", "130px"],
      ["keys", "Keys", "scope", "70px"],
      ["message", "Message", "keys", "minmax(160px, 2fr)"],
    ]);
  });

  it("Status: the state in words and its tone, the controller's message on hover, sorted and filtered by the state", () => {
    for (const [label, o] of variants()) {
      const s = syncOf(o);
      expect(cell("status", o), label).toBe(catalog[`state.${s.state}`]);
      expect(toneOf("status", o), label).toBe(SYNC_TONE[s.state]);
      // The built-in column's value was the state: ready, progressing, failed.
      expect(windowColumn("status").value(o), label).toBe(s.state);
      expect(windowColumn("status").filter?.value(o, { now: NOW }), label).toBe(s.state);
      expect(titleOf("status", o) || undefined, label).toBe(s.message);
    }
  });

  it("Scope: the scope in words, sorted and filtered by its name", () => {
    for (const [label, o] of variants()) {
      const scope = scopeOf(o);
      expect(cell("scope", o), label).toBe(catalog[`scope.${scope}`]);
      expect(toneOf("scope", o), label).toBeUndefined();
      expect(windowColumn("scope").value(o), label).toBe(scope);
      expect(windowColumn("scope").filter?.value(o, { now: NOW }), label).toBe(scope);
    }
  });

  it("Keys: how many keys it seals, a number (0 without any)", () => {
    for (const [label, o] of variants()) {
      const n = sealedKeys(o).length;
      expect(cell("keys", o), label).toBe(String(n));
      expect(windowColumn("keys").value(o), label).toBe(n);
      expect(windowColumn("keys").filter?.value(o, { now: NOW }), label).toBe(n);
    }
  });

  it("Message: the Synced condition's message", () => {
    for (const [label, o] of variants()) {
      const message = syncOf(o).message;
      expect(cell("message", o) || undefined, label).toBe(message);
      expect(windowColumn("message").value(o) || undefined, label).toBe(message);
    }
  });

  it("say the states and scopes in the words the details use, in every language", () => {
    const translations = manifest.translations as Record<string, Record<string, string>>;
    const status = columnOf("status").cases!;
    const scope = columnOf("scope").cases!;
    expect(status.map((c) => c.value)).toEqual(["ready", "progressing", "failed"]);
    expect(scope.map((c) => c.value)).toEqual(["clusterWide", "namespaceWide", "strict"]);
    expect(status.map((c) => c.text)).toEqual(status.map((c) => catalog[`state.${c.value}`]));
    expect(scope.map((c) => c.text)).toEqual(scope.map((c) => catalog[`scope.${c.value}`]));
    for (const [language, texts] of Object.entries(translations)) {
      const own = localeOf(language);
      status.forEach((c, i) => expect(texts[`columns.status.cases.${i}.text`], language).toBe(own[`state.${c.value}`]));
      scope.forEach((c, i) => expect(texts[`columns.scope.cases.${i}.text`], language).toBe(own[`scope.${c.value}`]));
    }
  });
});
