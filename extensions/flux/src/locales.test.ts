// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, and the manifest translated whole.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogProblems } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
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
    // The fields' labels are `fields.<key>` of the rows in fields.ts.
    const fields = [...readFileSync(join(here, "fields.ts"), "utf8").matchAll(/^\s*\[\s*"([a-zA-Z]+)",/gm)].map((m) => `fields.${m[1]!}`);
    expect(fields.length).toBeGreaterThan(20);
    const missing = [...new Set([...literal, ...fields])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  it("translate every text of the manifest into every language Sextant has", () => {
    const c = manifest.contributes;
    const keys = [
      "name",
      "description",
      ...c.kinds.flatMap((k, i) => [`kinds.${i}.title`, ...(k.sectionTitle ? [`kinds.${i}.sectionTitle`] : [])]),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
      ...c.actions.flatMap((a) => [`actions.${a.id}.title`, ...("whyNot" in a ? [`actions.${a.id}.whyNot`] : [])]),
      ...c.columns.map((col) => `columns.${col.id}.title`),
      // The Suspended column's Yes and No. The Ready column's cases are Kubernetes' condition statuses (True, False,
      // Unknown), kept as Sextant's own Flux table kept them, and its tones are keyed by them.
      ...c.columns.filter((col) => col.id.startsWith("suspended-")).flatMap((col) => [`columns.${col.id}.cases.0.text`, `columns.${col.id}.cases.1.text`]),
      ...c.problems.flatMap((r) => [`problems.${r.id}.title`, `problems.${r.id}.message`]),
    ].sort();
    const translations = manifest.translations as Record<string, Record<string, string>>;
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).sort(), language).toEqual(keys);
    }
  });

  it("keep a problem message's placeholders", () => {
    const translations = manifest.translations as Record<string, Record<string, string>>;
    const placeholders = (text: string) => [...text.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]).sort();
    for (const rule of manifest.contributes.problems) {
      for (const texts of Object.values(translations)) {
        expect(placeholders(texts[`problems.${rule.id}.message`]!)).toEqual(placeholders(rule.message));
      }
    }
  });
});
