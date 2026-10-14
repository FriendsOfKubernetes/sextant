// The manifest: the SDK's validator against the cases Sextant's own check agrees on (test/fixtures/manifest-cases.json),
// and the SDK's manifest types against the JSON schema Sextant reads (the types themselves are compared with the
// generated ones in test/protocol.test.ts, by the compiler).
import { describe, expect, it } from "vitest";
import {
  checkManifestBytes,
  formatManifestError,
  manifestSchema,
  readJson,
  validateManifest,
} from "../scripts/manifest.mjs";
import { EXTENSION_ACTIONS, normalizeManifest, type ManifestFile } from "../src/manifest";
import { applyCase, CASES } from "./cases";
import { MANIFEST_SHAPES, PLACEMENTS } from "./shapes";

describe("manifest validator", () => {
  it.each(CASES.valid.map((c) => [c.name, c] as const))("accepts %s", (_name, testCase) => {
    expect(validateManifest(applyCase(testCase))).toBeNull();
  });

  it.each(CASES.invalid.map((c) => [c.name, c] as const))("refuses %s", (_name, testCase) => {
    const error = validateManifest(applyCase(testCase));
    expect(error, "accepted").not.toBeNull();
    expect(error!.path).toBe(testCase.path);
    expect(error!.message).toContain(testCase.message);
  });

  it("reads numbers as Sextant does: 1.0 is not a whole number", () => {
    const text = JSON.stringify(applyCase({ name: "x", base: "minimal" })).replace('"sextantApi":1', '"sextantApi":1.0');
    expect(validateManifest(readJson(text))).toEqual({ path: "sextantApi", message: "must be a whole number" });
  });

  it("checks the bytes of the file: size, JSON, then the manifest", () => {
    const good = new TextEncoder().encode(JSON.stringify(applyCase({ name: "x", base: "minimal" })));
    expect(checkManifestBytes(good)).toEqual({ manifest: applyCase({ name: "x", base: "minimal" }) });
    expect(checkManifestBytes(new TextEncoder().encode("{"))).toEqual({ error: { path: "", message: "not valid JSON" } });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...good]);
    expect(checkManifestBytes(bom).error?.message).toBe("not valid JSON");
    const huge = new Uint8Array(256 * 1024 + 1).fill(0x20);
    expect(checkManifestBytes(huge).error?.message).toContain("too large");
    expect(formatManifestError({ path: "id", message: "must be a string" })).toBe(
      "sextant-extension.json: id: must be a string",
    );
  });
});

/** The object schema at `pointer` (`/$defs/rule`), following `items`. */
function schemaAt(pointer: string): { properties: Record<string, unknown>; required?: string[] } {
  let node: unknown = manifestSchema();
  for (const part of pointer.split("/").slice(1)) node = (node as Record<string, unknown>)[part];
  return node as { properties: Record<string, unknown>; required?: string[] };
}

describe("manifest types and the schema", () => {
  it.each(Object.entries(MANIFEST_SHAPES))("%s has the fields of the schema, required as there", (_name, shape) => {
    const node = schemaAt(shape.schema);
    expect(Object.keys(shape.fields).sort()).toEqual(Object.keys(node.properties).sort());
    const required = Object.entries(shape.fields)
      .filter(([, need]) => need === "required")
      .map(([field]) => field)
      .sort();
    expect(required).toEqual([...(node.required ?? [])].sort());
  });

  it("names the same actions and placements", () => {
    const schema = manifestSchema() as {
      $defs: Record<string, { properties: Record<string, { items?: { enum: string[] }; enum?: string[] }> }>;
    };
    expect([...EXTENSION_ACTIONS]).toEqual(schema.$defs.rule!.properties.actions!.items!.enum);
    const details = schemaAt("/$defs/contributes/properties/detailsSections/items") as unknown as {
      properties: { placement: { enum: string[] } };
    };
    expect([...PLACEMENTS]).toEqual(details.properties.placement.enum);
  });

  it("normalizes a manifest as Sextant reads it", () => {
    const file = applyCase({ name: "x", base: "full" }) as unknown as ManifestFile;
    const manifest = normalizeManifest(file);
    expect(manifest.permissions.rules.map((r) => r.confirm)).toEqual([true, true, false, true]);
    expect(manifest.contributes.actions.map((a) => [a.danger, a.multiple])).toEqual([
      [false, false],
      [true, true],
    ]);
    const minimal = normalizeManifest(applyCase({ name: "x", base: "minimal" }) as unknown as ManifestFile);
    expect(minimal.contributes).toEqual({ pages: [], detailsSections: [], actions: [], columns: [], dockActions: [] });
    expect("icon" in minimal).toBe(false);
  });
});

it("the shared cases cover both verdicts", () => {
  expect(CASES.valid.length).toBeGreaterThan(10);
  expect(CASES.invalid.length).toBeGreaterThan(50);
});
