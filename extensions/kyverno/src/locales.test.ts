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
import { READY_VALUES, RESULT_VALUES, RULE_TYPES } from "./model";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);
const MODES = ["Enforce", "Audit", "Mixed"];

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
        ...[...text.matchAll(/^\s*\["([a-zA-Z]+)", (?!")/gm)].map((m) => `fields.${m[1]!}`),
        // Table headers: `["name", "type"].map((h) => t(`rules.${h}`))`.
        ...[...text.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z.]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
          [...m[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((h) => `${m[2]!}.${h[1]!}`),
        ),
      ];
    });
    const built = [
      ...READY_VALUES.map((v) => `ready.${v}`),
      ...MODES.flatMap((m) => [`mode.${m}`, `modeHint.${m}`]),
      ...RULE_TYPES.map((r) => `ruleType.${r}`),
      ...RESULT_VALUES.flatMap((v) => [`result.${v}`, `summary.${v}`]),
      "results.object",
    ];
    expect(keys.length).toBeGreaterThan(25);
    const missing = [...new Set([...keys, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string; tooltip?: string };
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  const english = new Map<string, string>([
    ["name", manifest.name],
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as const),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as const),
    ...c.problemCategories.map((p) => [`problemCategories.${p.id}.title`, p.title] as const),
    ...c.detailsSections.map((s) => [`detailsSections.${s.id}.title`, s.title] as const),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as const,
      ...(((col as { cases?: Case[] }).cases ?? []).map((cs, i) => [`columns.${col.id}.cases.${i}.text`, cs.text] as const)),
    ]),
    ...c.problems.flatMap((r) => [[`problems.${r.id}.title`, r.title] as const, [`problems.${r.id}.message`, r.message] as const]),
  ]);
  /** Texts every language writes as English does: names, kinds, numbers and field values, counts too (left out of `translations`). */
  const sameEverywhere = (text: string) => /^([A-Z][A-Za-z]+|[0-9]+|\{\{[^}]+\}\}(\/\{\{[^}]+\}\})?)$/.test(text);

  it("translate every text of the manifest into every language Sextant has", () => {
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    const badge = (key: string) => key.startsWith("sectionBadges.");
    // A rule's message by plural form: exactly the language's forms besides `other` (#404).
    const form = (key: string) => /^problems\.[^.]+\.messageForms\./.test(key);
    for (const [language, texts] of Object.entries(translations)) {
      for (const key of Object.keys(texts).filter((k) => !badge(k) && !form(k))) expect(english.has(key), `${language} ${key}`).toBe(true);
      const ruleForms = [...new Intl.PluralRules(language).resolvedOptions().pluralCategories].filter((f) => f !== "other").sort();
      for (const rule of c.problems) {
        const own = Object.keys(texts)
          .filter((k) => k.startsWith(`problems.${rule.id}.messageForms.`))
          .map((k) => k.slice(`problems.${rule.id}.messageForms.`.length))
          .sort();
        expect(own, `${language} ${rule.id}`).toEqual(ruleForms);
      }
      for (const [key, text] of english) {
        if (!Object.hasOwn(texts, key)) expect(sameEverywhere(text), `${language} leaves out ${key}: ${text}`).toBe(true);
      }
      // The counter's label in exactly the language's plural forms (ADR-0167).
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.kyverno.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
      for (const [k, v] of Object.entries(texts)) expect(v.trim(), `${language} ${k}`).not.toBe("");
    }
  });

  it("keep the English placeholders, and translate the problem rules' titles, each its own", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    for (const [language, texts] of Object.entries(translations)) {
      for (const rule of c.problems) {
        expect(placeholders(texts[`problems.${rule.id}.message`]!), `${language} ${rule.id}`).toEqual(placeholders(rule.message));
        for (const [k, v] of Object.entries(texts).filter(([k]) => k.startsWith(`problems.${rule.id}.messageForms.`))) {
          expect(placeholders(v), `${language} ${k}`).toEqual(placeholders(rule.message));
        }
        expect(texts[`problems.${rule.id}.title`], language).not.toBe(rule.title);
        expect(Array.from(texts[`problems.${rule.id}.title`]!).length, language).toBeLessThanOrEqual(80);
      }
      const titles = c.problems.map((r) => texts[`problems.${r.id}.title`]);
      expect(new Set(titles).size, language).toBe(titles.length);
    }
  });

  it("say readiness, mode, yes and no in the table as the details do", () => {
    const wordsOf = (catalog: Record<string, string>) => new Set([...READY_VALUES.map((v) => catalog[`ready.${v}`]), ...MODES.map((m) => catalog[`mode.${m}`]), catalog.yes, catalog.no]);
    const caseTexts = (texts: Record<string, string>) =>
      c.columns
        .filter((col) => /-(ready|mode|background)$/.test(col.id))
        .flatMap((col) => ((col as { cases?: Case[] }).cases ?? []).map((cs, i) => texts[`columns.${col.id}.cases.${i}.text`] ?? cs.text));
    for (const text of caseTexts({})) expect(wordsOf(en).has(text), text).toBe(true);
    for (const [language, texts] of Object.entries(translations)) {
      const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
      for (const text of caseTexts(texts)) expect(wordsOf(catalog).has(text), `${language} ${text}`).toBe(true);
    }
  });
});
