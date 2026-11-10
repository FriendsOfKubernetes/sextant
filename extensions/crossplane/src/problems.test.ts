// The manifest's problem rules against the built-in category `crossplane` they replace (its `toProblems`, ported as
// `builtInProblems`). The rules run in Sextant's own window: registered as an extension's category
// (`src/features/problems/extensionCategories.ts`, which compiles the `kindsFrom` rules into the detector of the kinds
// the XRDs define) and judged by the problems store's `resolve` (`src/features/problems/model.ts`) with `defined: true`,
// as the store judges a source of a kind Rust found defined. Both are loaded at run time so the type check stays inside
// the extension. Every combination of Synced, Ready, another condition, the pause and a claim reference is compared:
// the problem's key, reason, message, start, when it counts, and what it notifies as.
import type { KubeObject, ObjectRef } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import claimJson from "../fixtures/claim.json";
import compositeJson from "../fixtures/composite.json";
import { builtInProblems, kindFromApiVersion, toRow, type KindRef, type Role } from "./model";

interface WindowProblem {
  key: string;
  notifyKey: string;
  uid: string;
  object: ObjectRef;
  reason: string;
  message?: string;
  since?: string;
  firstSeen: number;
  activeAt: number;
  category: string;
  notify: boolean;
}
interface ProblemsModel {
  resolve(kind: KindRef, obj: KubeObject, now: number, before: readonly WindowProblem[], category: string, ctx: { defined?: boolean }): WindowProblem[];
  isActive(problem: WindowProblem, now: number): boolean;
}
interface Categories {
  registerExtensionProblems(extensionId: string, title: string, rules: readonly unknown[]): () => void;
}
let model: ProblemsModel;
const CATEGORY = "ext:sextant.crossplane";
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  const categories = (await import(/* @vite-ignore */ join(here, "../../../src/features/problems/extensionCategories.ts"))) as Categories;
  model = (await import(/* @vite-ignore */ join(here, "../../../src/features/problems/model.ts"))) as ProblemsModel;
  // As Rust hands the rules to the window: `notify` defaults to true, `toldThroughOwner` to false.
  categories.registerExtensionProblems(
    manifest.id,
    manifest.name,
    manifest.contributes.problems.map((rule) => ({ notify: true, toldThroughOwner: false, kind: { group: "", kind: "" }, ...rule })),
  );
  // The window's problems are compiled on first import: slow on a busy machine.
}, 120_000);

type Cond = { type: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string };
const copy = <T>(value: T): T => structuredClone(value);
const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
const NOW = Date.parse("2026-11-10T12:00:00Z");
const T1 = "2026-11-10T11:59:00Z";
const T2 = "2026-11-10T11:00:00Z";
const T3 = "2026-11-10T10:00:00Z";

/** The window's problems as the built-in shape (a message that is not there is no message). */
function windowProblems(kind: KindRef, obj: KubeObject, now: number, before: readonly WindowProblem[] = []) {
  return model.resolve(kind, obj, now, before, CATEGORY, { defined: true });
}
const shape = (p: { key: string; uid: string; object: ObjectRef; reason: string; message?: string; since?: string; firstSeen: number; activeAt: number }) => ({
  key: p.key,
  uid: p.uid,
  object: p.object,
  reason: p.reason,
  message: p.message || undefined,
  since: p.since,
  firstSeen: p.firstSeen,
  activeAt: p.activeAt,
});

const SYNCED: (Cond | null)[] = [
  null,
  { type: "Synced", status: "True", reason: "ReconcileSuccess", lastTransitionTime: T3 },
  { type: "Synced", status: "False", reason: "ReconcileError", message: "cannot compose resources", lastTransitionTime: T1 },
  { type: "Synced", status: "False", message: "no reason", lastTransitionTime: T2 },
  { type: "Synced", status: "False", reason: "ReconcilePaused", lastTransitionTime: T2 },
  { type: "Synced", status: "Unknown", reason: "Pending" },
  { type: "Synced", status: "False", reason: "ReconcileError" },
];
const READY: (Cond | null)[] = [
  null,
  { type: "Ready", status: "True", reason: "Available", lastTransitionTime: T3 },
  { type: "Ready", status: "False", reason: "Creating", message: "creating the database", lastTransitionTime: T2 },
  { type: "Ready", status: "False", reason: "Deleting", lastTransitionTime: T1 },
  { type: "Ready", status: "False", reason: "Unavailable", message: "the instance is down", lastTransitionTime: T1 },
  { type: "Ready", status: "False" },
  { type: "Ready", status: "Unknown", reason: "Deleting", lastTransitionTime: T1 },
  { type: "Ready", status: "Unknown", lastTransitionTime: T3 },
  { type: "Ready", status: "Odd" },
];
const OTHER: (Cond | null)[] = [
  null,
  { type: "Responsive", status: "False", reason: "WatchCircuitOpen", message: "too many events", lastTransitionTime: T2 },
  { type: "Responsive", status: "False", lastTransitionTime: T3 },
  { type: "LastAsyncOperation", status: "False", reason: "Deleting" },
  { type: "Healthy", status: "True" },
];

interface Variant {
  label: string;
  obj: KubeObject;
  role: Role;
}

/** Claims and composites with every combination the built-in category told apart. */
function variants(): Variant[] {
  const out: Variant[] = [];
  let n = 0;
  for (const [role, base] of [
    ["claim", claimJson],
    ["composite", compositeJson],
  ] as const) {
    for (const synced of SYNCED)
      for (const ready of READY)
        for (const other of OTHER)
          for (const otherFirst of other ? [false, true] : [false])
            for (const paused of [false, true])
              for (const claimRef of role === "composite" ? ["none", "v1", "v2", "v2 empty name", "v1 without kind"] : ["none"]) {
                const obj = copy(base) as unknown as KubeObject;
                obj.metadata.uid = `uid-${++n}`;
                const conds = [synced, ready].filter((c): c is Cond => c !== null);
                if (other) {
                  if (otherFirst) conds.unshift(other);
                  else conds.push(other);
                }
                (obj.status as { conditions: Cond[] }).conditions = conds;
                if (paused) obj.metadata.annotations = { ...obj.metadata.annotations, "crossplane.io/paused": "true" };
                const spec = obj.spec as Record<string, unknown>;
                delete spec.claimRef;
                const ref = { apiVersion: "database.example.org/v1alpha1", kind: "PostgreSQLInstance", name: "my-db", namespace: "default" };
                if (claimRef === "v1") spec.claimRef = ref;
                if (claimRef === "v2") spec.crossplane = { claimRef: ref };
                if (claimRef === "v2 empty name") spec.crossplane = { claimRef: { ...ref, name: "" } };
                if (claimRef === "v1 without kind") spec.claimRef = { ...ref, kind: undefined };
                out.push({ label: JSON.stringify({ role, conds, paused, claimRef }), obj, role });
              }
  }
  return out;
}

describe("the problem rules", () => {
  it("name their kinds through the XRDs, notify, and share one notification per object", () => {
    const rules = manifest.contributes.problems;
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.kindsFrom).toEqual({
        kind: { group: "apiextensions.crossplane.io", kind: "CompositeResourceDefinition" },
        groupPath: ".spec.group",
        kindPaths: [".spec.names.kind", ".spec.claimNames.kind"],
        max: 20,
      });
      expect(rule.group).toBe("not-ready");
    }
    expect(manifest.contributes.sectionBadges).toEqual([expect.objectContaining({ section: "crossplane", count: "problems" })]);
  });

  it("tell exactly the built-in category's problems of every claim and composite", () => {
    let problems = 0;
    for (const { label, obj, role } of variants()) {
      const kind = kindOf(obj);
      const expected = builtInProblems([toRow(obj, kind, role)], new Map(), NOW).map(shape);
      const found = windowProblems(kind, obj, NOW);
      expect(found.map(shape), label).toEqual(expected);
      for (const p of found) {
        expect(p.category).toBe(CATEGORY);
        expect(p.notify).toBe(true);
        // One notification per object for every rule, as the built-in `<uid>|notReady`.
        expect(p.notifyKey, label).toBe(`${p.uid}|not-ready`);
        expect([model.isActive(p, NOW), model.isActive(p, p.activeAt)], label).toEqual([p.activeAt <= NOW, true]);
      }
      problems += expected.length;
    }
    // The combinations hold problems of every kind the built-in told.
    expect(problems).toBeGreaterThan(300);
  });

  it("count a grace from when a problem was first seen where the condition gives no time, kept across updates", () => {
    const obj = copy(claimJson) as unknown as KubeObject;
    (obj.status as { conditions: Cond[] }).conditions = [{ type: "Synced", status: "False", reason: "ReconcileError" }];
    const kind = kindOf(obj);
    const firstSeen = new Map<string, number>();
    const builtIn = builtInProblems([toRow(obj, kind, "claim")], firstSeen, NOW);
    const first = windowProblems(kind, obj, NOW);
    expect(first.map(shape)).toEqual(builtIn.map(shape));
    // A later update of the same object: still the first sighting, as the built-in map kept it.
    const later = NOW + 60_000;
    (obj.metadata as { resourceVersion?: string }).resourceVersion = "2";
    expect(windowProblems(kind, obj, later, first).map(shape)).toEqual(builtInProblems([toRow(obj, kind, "claim")], firstSeen, later).map(shape));
    expect(first[0]!.activeAt).toBe(NOW + 2 * 60_000);
    // Being created counts after 30 minutes.
    (obj.status as { conditions: Cond[] }).conditions = [{ type: "Synced", status: "True" }];
    const creating = windowProblems(kind, obj, NOW);
    expect(creating.map((p) => [p.reason, p.activeAt])).toEqual([["Creating", NOW + 30 * 60_000]]);
  });

  it("are judged only on the kinds the XRDs define", () => {
    const obj = copy(claimJson) as unknown as KubeObject;
    (obj.status as { conditions: Cond[] }).conditions = [{ type: "Synced", status: "False", reason: "ReconcileError" }];
    expect(model.resolve(kindOf(obj), obj, NOW, [], CATEGORY, {})).toEqual([]);
  });
});
