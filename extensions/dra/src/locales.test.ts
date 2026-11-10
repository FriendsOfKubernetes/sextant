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
import type { ClaimState, DraReason } from "./model";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);
const STATES: ClaimState[] = ["inUse", "allocated", "pending", "bindingFailed", "deleting"];
const REASONS: DraReason[] = ["notCreated", "notFound", "deleting", "inUse", "noClass", "cannotAllocate", "notOnNode", "allocating", "notOwner"];
const SCOPES = ["node", "allNodes", "selector", "perDevice", "unknown"];
const BUILT = [...STATES.flatMap((s) => [`state.${s}`, `hint.${s}`]), ...REASONS.map((r) => `reason.${r}`), ...SCOPES.map((s) => `scope.${s}`)];

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
        ...[...text.matchAll(/^\s*\["([a-zA-Z]+)",/gm)].map((m) => `fields.${m[1]!}`),
        // Table headers: `["name", "type"].map((h) => t(`pods.${h}`))`.
        ...[...text.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
          [...m[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((h) => `${m[2]!}.${h[1]!}`),
        ),
      ];
    });
    expect(keys.length).toBeGreaterThan(60);
    const missing = [...new Set([...keys, ...BUILT])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string; tooltip?: string; tooltipOr?: string[] };
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  /** The English texts of the columns' cases and the problems' messages, by translation key. */
  const englishTexts = new Map<string, string>();
  for (const col of c.columns) {
    for (const [i, cs] of ((col as { cases?: Case[] }).cases ?? []).entries()) {
      englishTexts.set(`columns.${col.id}.cases.${i}.text`, cs.text);
      if (cs.tooltip !== undefined) englishTexts.set(`columns.${col.id}.cases.${i}.tooltip`, cs.tooltip);
      for (const [k, or] of (cs.tooltipOr ?? []).entries()) englishTexts.set(`columns.${col.id}.cases.${i}.tooltipOr.${k}`, or);
    }
  }
  for (const rule of c.problems) englishTexts.set(`problems.${rule.id}.message`, rule.message);
  /**
   * A text with no words — placeholders, numbers, punctuation — reads the same in every language: it is left to the
   * English fallback (`localizeManifest` takes the manifest's text for a key a language lacks), which keeps the manifest
   * under Sextant's 256 KiB.
   */
  const wordless = (key: string) => {
    const text = englishTexts.get(key);
    return text !== undefined && text.replace(/\{\{[\s\S]*?\}\}/g, "").replace(/[\s,/…0-9]/g, "") === "";
  };

  it("translate every text of the manifest into every language Sextant has", () => {
    const keys = [
      "name",
      "description",
      ...c.kinds.map((_, i) => `kinds.${i}.title`),
      ...c.pages.map((p) => `pages.${p.id}.title`),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
      ...c.sections.map((s) => `sections.${s.section}.title`),
      ...c.columns.map((col) => `columns.${col.id}.title`),
      ...englishTexts.keys(),
      ...c.problems.map((r) => `problems.${r.id}.title`),
    ]
      .filter((key) => !wordless(key))
      .sort();
    expect(keys.length).toBeGreaterThan(40);
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).filter((k) => !badge(k)).sort(), language).toEqual(keys);
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.dra.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
    }
  });

  it("keep the English placeholders, and translate the problem rules' titles, each its own", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    expect(new Set(c.problems.map((r) => r.title)).size).toBe(c.problems.length);
    for (const [language, texts] of Object.entries(translations)) {
      for (const [key, text] of englishTexts) expect(placeholders(texts[key] ?? text), `${language} ${key}`).toEqual(placeholders(text));
      for (const rule of c.problems) expect(texts[`problems.${rule.id}.title`], language).not.toBe(rule.title);
      expect(new Set(c.problems.map((r) => texts[`problems.${r.id}.title`])).size, language).toBe(c.problems.length);
    }
  });

  it("say the states, the kinds, the columns and the counter as the details do", () => {
    const catalogs = CATALOGS as Record<string, Record<string, string>>;
    const words = Object.entries(en).filter(([k]) => k.startsWith("state.") || k.startsWith("scope."));
    for (const language of SEXTANT_LANGUAGES.filter((l) => l !== "en")) {
      const catalog = catalogs[language]!;
      const texts = translations[language]!;
      for (const col of c.columns) {
        for (const [i, cs] of ((col as { cases?: Case[] }).cases ?? []).entries()) {
          const key = words.find(([, v]) => v === cs.text)?.[0];
          if (key) expect(texts[`columns.${col.id}.cases.${i}.text`], `${language} ${col.id} ${i}`).toBe(catalog[key]);
        }
      }
      expect(texts["kinds.0.title"]).toBe(catalog["sidebar.claims"]);
      expect(texts["pages.devices.title"]).toBe(catalog["page.sidebar"]);
      expect(texts["detailsSections.pod-devices.title"]).toBe(catalog["pod.title"]);
      expect(texts["detailsSections.node-devices.title"]).toBe(catalog["node.title"]);
      for (const form of new Intl.PluralRules(language).resolvedOptions().pluralCategories) {
        expect(texts[`sectionBadges.dra.label.${form}`]).toBe(catalog[`badge_${form}`]);
      }
    }
  });
});
