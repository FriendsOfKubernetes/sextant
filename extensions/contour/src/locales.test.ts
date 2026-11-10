// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, and the manifest translated whole —
// but for the texts that read the same in every language (the name, kind names, Contour's own words and counts).
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
const source = (file: string) => readFileSync(join(here, file), "utf8");

/** Keys the code builds from a value: states, health words, phrases. */
const BUILT = [
  ...["valid", "invalid", "orphaned", "pending"].map((s) => `state.${s}`),
  ...["ready", "progressing", "failed", "unknown"].map((s) => `health.${s}`),
  ...[...source("model.ts").matchAll(/key: (?:warnings \? )?"([a-zA-Z]+)"(?: : "([a-zA-Z]+)")?/g)].flatMap((m) => [m[1]!, ...(m[2] ? [m[2]] : [])]).map((k) => `explain.${k}`),
  ...[...(source("model.ts").match(/const OWN_WORDS[^}]+\}/)?.[0] ?? "").matchAll(/: "([a-zA-Z]+)",/g)].map((m) => `explain.${m[1]!}`),
  "explain.invalidInPart",
];

describe("catalogs", () => {
  it("exist for every language Sextant has", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(SEXTANT_LANGUAGES);
  });

  it("have English's keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems(CATALOGS)).toEqual([]);
  });

  it("have every key the code asks for", () => {
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const keys = sources.flatMap((f) => [...source(f).matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!));
    const details = source("details.ts");
    // Field rows `["key", value]`, labelled `fields.<key>`.
    const rows = [...details.matchAll(/\["([a-zA-Z]+)",(?!\s*")/g)].map((m) => m[1]!);
    const headers = [...details.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
      [...m[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((h) => `${m[2]!}.${h[1]!}`),
    );
    expect(keys.length).toBeGreaterThan(30);
    expect(rows.length).toBeGreaterThan(15);
    expect(headers.length).toBeGreaterThan(10);
    expect(BUILT.length).toBeGreaterThan(20);
    const missing = [...new Set([...keys, ...headers, ...BUILT, ...rows.map((r) => `fields.${r}`)])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string };
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  /** Contour's own words, shown as the built-in table showed them in every language: "passthrough", "Orphaned". */
  const CONTOUR_WORDS = new Set(["columns.proxy-tls.cases.0.text", "columns.proxy-reason.cases.0.text"]);
  /** A text that reads the same in every language: counts, nothing at all. */
  const neutral = (text: string) => !/[A-Za-z]/.test(text);

  const english = new Map<string, string>([
    ["name", manifest.name],
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as const),
    ...c.detailsSections.map((s) => [`detailsSections.${s.id}.title`, s.title] as const),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as const),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as const,
      ...((col as { cases?: Case[] }).cases ?? []).map((cs, i) => [`columns.${col.id}.cases.${i}.text`, cs.text] as const),
      ...((col as { items?: { cases: Case[] } }).items?.cases ?? []).map((cs, i) => [`columns.${col.id}.items.${i}.text`, cs.text] as const),
    ]),
    ...c.problems.flatMap((r) => [[`problems.${r.id}.title`, r.title] as const, [`problems.${r.id}.message`, r.message] as const]),
  ]);
  /** What every language leaves to English: the name, kind and section names, and texts without words. */
  const same = (key: string, text: string) =>
    key === "name" || key.startsWith("detailsSections.") || key.startsWith("sections.") || key.startsWith("kinds.") || CONTOUR_WORDS.has(key) || neutral(text.replace(/\{\{[\s\S]*?\}\}/g, ""));

  it("translate every text of the manifest into every language Sextant has, but those that read the same", () => {
    const keys = [...english].filter(([key, text]) => !same(key, text)).map(([key]) => key).sort();
    expect(keys.length).toBeGreaterThan(15);
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    const prefix = "sectionBadges.contour.label.";
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).filter((k) => !k.startsWith(prefix)).sort(), language).toEqual(keys);
      // The counter's label in exactly the language's plural forms (ADR-0167).
      const forms = Object.keys(texts)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const form of forms) expect(texts[`${prefix}${form}`], `${language} ${form}`).toContain("{{count}}");
    }
  });

  it("keep the English placeholders, and translate the problem rules' titles, each its own", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    expect(new Set(c.problems.map((r) => r.title)).size).toBe(c.problems.length);
    for (const [language, texts] of Object.entries(translations)) {
      for (const [key, text] of english) if (texts[key] !== undefined) expect(placeholders(texts[key]), `${language} ${key}`).toEqual(placeholders(text));
      for (const rule of c.problems) expect(texts[`problems.${rule.id}.title`], language).not.toBe(rule.title);
      expect(new Set(c.problems.map((r) => texts[`problems.${r.id}.title`])).size, language).toBe(c.problems.length);
    }
  });

  it("say the states as the details do", () => {
    const catalogs = CATALOGS as Record<string, Record<string, string>>;
    const STATUS: Record<string, string> = { "proxy-status": "state", "extension-status": "health" };
    for (const language of SEXTANT_LANGUAGES) {
      for (const [id, group] of Object.entries(STATUS)) {
        const col = c.columns.find((x) => x.id === id)! as { cases: (Case & { value: string })[] };
        for (const [i, cs] of col.cases.entries()) {
          const shown = language === "en" ? cs.text : translations[language]![`columns.${id}.cases.${i}.text`];
          expect(shown, `${language} ${id} ${i}`).toBe(catalogs[language]![`${group}.${cs.value}`]);
        }
      }
    }
  });
});
