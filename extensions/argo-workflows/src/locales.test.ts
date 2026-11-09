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
import { ACTION_IDS, type WorkflowAction } from "./patches";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);
const ACTIONS = Object.keys(ACTION_IDS) as WorkflowAction[];

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
      ...["seconds", "minutes", "hours", "days", "years"].map((u) => `age.${u}`),
      ...["expand", "collapse", "offloaded", "compressed"].map((k) => `tree.${k}`),
      ...["completed", "finished", "nodesElsewhere", "noDefault"].map((r) => `dialog.refusal.${r}`),
      ...ACTIONS.flatMap((a) => [`actions.${a}`, `dialog.${a}Title`, `dialog.${a}Text`, `dialog.nothing.${a}`, `whyNot.${a}`]),
    ];
    const missing = [...new Set([...literal, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });

  it("say an action's title and whyNot as the manifest does", () => {
    for (const action of ACTIONS) {
      const entry = manifest.contributes.actions.find((a) => a.id === ACTION_IDS[action])!;
      expect(entry.title).toBe(en[`actions.${action}` as keyof typeof en]);
      expect(entry.whyNot).toBe(en[`whyNot.${action}` as keyof typeof en]);
      for (const [language, texts] of Object.entries(manifest.translations as Record<string, Record<string, string>>)) {
        const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
        expect(texts[`actions.${entry.id}.whyNot`], language).toBe(catalog[`whyNot.${action}`]);
        expect(texts[`actions.${entry.id}.title`], language).toBe(catalog[`actions.${action}`]);
      }
    }
  });
});

describe("the manifest's translations", () => {
  it("translate every text of the manifest into every language Sextant has", () => {
    const c = manifest.contributes;
    type Case = { text: string; tooltip?: string };
    const keys = [
      "name",
      "description",
      ...c.kinds.map((_, i) => `kinds.${i}.title`),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
      ...c.actions.flatMap((a) => [`actions.${a.id}.title`, `actions.${a.id}.whyNot`]),
      ...c.sections.map((s) => `sections.${s.section}.title`),
      ...c.columns.flatMap((col) => [
        `columns.${col.id}.title`,
        ...(((col as { cases?: Case[] }).cases ?? []).flatMap((cs, i) => [
          `columns.${col.id}.cases.${i}.text`,
          ...(cs.tooltip === undefined ? [] : [`columns.${col.id}.cases.${i}.tooltip`]),
        ])),
      ]),
      ...c.problems.flatMap((r) => [`problems.${r.id}.title`, `problems.${r.id}.message`]),
    ].sort();
    const translations = manifest.translations as Record<string, Record<string, string>>;
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    // The counter's label in exactly the language's plural forms (ADR-0167).
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).filter((k) => !badge(k)).sort(), language).toEqual(keys);
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.argoWorkflows.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
    }
  });

  it("keep the English placeholders, and translate the problem rules' texts", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    const english = new Map<string, string>();
    const c = manifest.contributes;
    for (const col of c.columns) {
      for (const [i, cs] of ((col as { cases?: { text: string; tooltip?: string }[] }).cases ?? []).entries()) {
        english.set(`columns.${col.id}.cases.${i}.text`, cs.text);
        if (cs.tooltip !== undefined) english.set(`columns.${col.id}.cases.${i}.tooltip`, cs.tooltip);
      }
    }
    for (const rule of c.problems) english.set(`problems.${rule.id}.message`, rule.message);
    for (const [language, texts] of Object.entries(manifest.translations as Record<string, Record<string, string>>)) {
      for (const [key, text] of english) expect(placeholders(texts[key]!), `${language} ${key}`).toEqual(placeholders(text));
      for (const rule of c.problems) expect(texts[`problems.${rule.id}.title`], language).not.toBe(rule.title);
    }
  });
});
