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
const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
/** A text without words: placeholders, punctuation and digits only (a tooltip, a trace, a list of names). */
const wordless = (text: string) => !/\p{L}/u.test(text.replace(/\{\{[\s\S]*?\}\}/g, ""));

describe("catalogs", () => {
  it("exist for every language Sextant has", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(SEXTANT_LANGUAGES);
  });

  it("have English's keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems(CATALOGS)).toEqual([]);
  });

  it("have every key the code asks for", () => {
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const code = sources.map((f) => readFileSync(join(here, f), "utf8")).join("\n");
    const literal = [...code.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!);
    // The fields' labels (`fields.<key>` of each row) and the readiness words (`state.<state>`).
    const rows = [...readFileSync(join(here, "details.ts"), "utf8").matchAll(/\["([a-zA-Z]+)", /g)].map((m) => `fields.${m[1]}`);
    const built = [...rows, ...["ready", "notReady", "pending"].map((s) => `state.${s}`)];
    const missing = [...new Set([...literal, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });

});

describe("the manifest's translations", () => {
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  type Case = { text: string; tooltip?: string };
  const english = new Map<string, string>([
    ["name", manifest.name],
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as [string, string]),
    ...c.detailsSections.map((s) => [`detailsSections.${s.id}.title`, s.title] as [string, string]),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as [string, string]),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as [string, string],
      ...((col as { cases?: Case[] }).cases ?? []).flatMap((cs, i) => [
        [`columns.${col.id}.cases.${i}.text`, cs.text] as [string, string],
        ...(cs.tooltip === undefined ? [] : [[`columns.${col.id}.cases.${i}.tooltip`, cs.tooltip] as [string, string]]),
      ]),
    ]),
    ...c.problems.flatMap((r) => [
      [`problems.${r.id}.title`, r.title] as [string, string],
      [`problems.${r.id}.message`, r.message] as [string, string],
    ]),
  ]);

  it("translate every text of the manifest with words into every language Sextant has", () => {
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    // Wordless texts (placeholders and punctuation) reading as in English are left to English, which the window
    // shows for a missing key: the manifest stays within the size Sextant reads.
    const needed = [...english].filter(([, text]) => !wordless(text)).map(([key]) => key).sort();
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      const keys = Object.keys(texts).filter((k) => !badge(k));
      expect(keys.filter((k) => !english.has(k)), language).toEqual([]);
      expect(needed.filter((k) => !keys.includes(k)), language).toEqual([]);
      for (const k of keys.filter((key) => !needed.includes(key))) expect(texts[k], `${language} ${k}`).not.toBe(english.get(k));
      // The counter's label in exactly the language's plural forms (ADR-0167).
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.strimzi.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
    }
  });

  it("keep the English placeholders, and translate the problem rules' titles", () => {
    for (const [language, texts] of Object.entries(translations)) {
      for (const [key, text] of Object.entries(texts)) {
        if (key.startsWith("sectionBadges.")) continue;
        expect(placeholders(text), `${language} ${key}`).toEqual(placeholders(english.get(key)!));
      }
      for (const rule of c.problems) expect(texts[`problems.${rule.id}.title`], language).not.toBe(rule.title);
    }
  });

});
