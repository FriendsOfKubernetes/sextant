// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, and the manifest translated whole.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogProblems } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import { COMPONENTS } from "./components";
import { CATALOGS } from "./i18n";
import en from "./locales/en.json";
import { UPDATE_MODES, VPA_REASONS } from "./model";

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
    const keys = sources.flatMap((f) => {
      const text = readFileSync(join(here, f), "utf8");
      return [
        ...[...text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
        // The rows of `fieldsOf`, labelled `fields.<key>`.
        ...(f === "details.ts" ? [...text.matchAll(/^\s*\["([a-zA-Z]+)",/gm)].map((m) => `fields.${m[1]!}`) : []),
        // Table headers: `["container", "resource"].map((h) => t(`table.${h}`))`.
        ...[...text.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
          [...m[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((h) => `${m[2]!}.${h[1]!}`),
        ),
      ];
    });
    const built = [
      ...VPA_REASONS.map((r) => `reason.${r}`),
      ...VPA_REASONS.filter((r) => r !== "provided").map((r) => `hint.${r}`),
      ...[...UPDATE_MODES, "unknown"].map((m) => `modeExplain.${m}`),
      ...["minAllowed", "maxAllowed", "limit"].map((c) => `table.capped.${c}`),
      ...COMPONENTS.map((c) => `components.name.${c}`),
      ...["recommender", "admission", "admissionInitial", "updater"].map((m) => `components.missing.${m}`),
    ];
    expect(keys.length).toBeGreaterThan(40);
    const missing = [...new Set([...keys, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string; tooltip?: string };
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
  /** A text without words: placeholders, punctuation and digits only (a hover, a target). */
  const wordless = (text: string) => !/\p{L}/u.test(text.replace(/\{\{[\s\S]*?\}\}/g, ""));
  const english = new Map<string, string>([
    ["name", manifest.name],
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as [string, string]),
    ...c.detailsSections.map((s) => [`detailsSections.${s.id}.title`, s.title] as [string, string]),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as [string, string]),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as [string, string],
      ...((col as { cases?: Case[] }).cases ?? [])
        .flatMap((cs, i) => [
          ...(cs.text === "" ? [] : [[`columns.${col.id}.cases.${i}.text`, cs.text] as [string, string]]),
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
    // shows for a missing key.
    const needed = [...english].filter(([, text]) => !wordless(text)).map(([key]) => key).sort();
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      const keys = Object.keys(texts).filter((k) => !badge(k));
      expect(keys.filter((k) => !english.has(k)), language).toEqual([]);
      expect(keys.sort(), language).toEqual(needed);
      // The counter's label in exactly the language's plural forms (ADR-0167).
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.vpa.label.".length))
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

  it("say the states as the details do", () => {
    const status = (c.columns.find((col) => col.id === "vpa-status") as { cases: (Case & { value: string })[] }).cases;
    for (const cs of status) expect(cs.text).toBe(en[`reason.${cs.value}` as keyof typeof en]);
    for (const [language, texts] of Object.entries(translations)) {
      const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
      status.forEach((cs, i) => expect(texts[`columns.vpa-status.cases.${i}.text`], language).toBe(catalog[`reason.${cs.value}`]));
    }
  });
});
