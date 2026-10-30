// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, and the manifest translated whole.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogProblems } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import { RANGES } from "./charts";
import { KNOWN_CHECKS } from "./checks";
import { COMPONENTS } from "./components";
import { CATALOGS } from "./i18n";
import en from "./locales/en.json";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);

describe("catalogs", () => {
  it("exist for every language Sextant has", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(SEXTANT_LANGUAGES);
  });

  it("have English's keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems(CATALOGS)).toEqual([]);
  });

  it("have every key the code asks for", () => {
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const literal = sources.flatMap((f) =>
      [...readFileSync(join(here, f), "utf8").matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
    );
    const built = [
      ...Object.keys(KNOWN_CHECKS).map((code) => `checks.${code}.meaning`),
      ...Object.entries(KNOWN_CHECKS)
        .filter(([, next]) => next === "own")
        .map(([code]) => `checks.${code}.next`),
      ...COMPONENTS.map((c) => `components.${c.id}`),
      ...RANGES.map((r) => `chart.range.${r.id}`),
      ...["rbd", "cephfs", "bucket"].map((d) => `page.drivers.${d}`),
      ...["health", "total", "used", "inCluster", "in", "up", "active", "clean", "degraded", "undersized", "down"].map(
        (id) => `chart.series.${id}`,
      ),
      ...["stale", "peering", "incomplete", "inconsistent", "recovering", "backfilling", "remapped"].map(
        (id) => `chart.series.${id}`,
      ),
      "status.severity.error",
      "status.severity.warning",
      "status.severity.info",
    ];
    const missing = [...new Set([...literal, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  it("translate every text of the manifest into every language Sextant has", () => {
    const c = manifest.contributes;
    const keys = [
      "name",
      "description",
      ...c.pages.map((p) => `pages.${p.id}.title`),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
      ...c.columns.map((col) => `columns.${col.id}.title`),
      ...c.problems.flatMap((r) => [`problems.${r.id}.title`, `problems.${r.id}.message`]),
      ...c.metricQueries.map((q) => `metricQueries.${q.id}.title`),
    ].sort();
    const translations = manifest.translations as Record<string, Record<string, string>>;
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).sort(), language).toEqual(keys);
    }
  });
});
