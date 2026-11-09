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
import type { SubscriptionState } from "./model";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);
const STATES: SubscriptionState[] = ["resolutionFailed", "installPlanFailed", "upgradeFailed", "waitingApproval", "upgradePending", "upgradeAvailable", "atLatest", "pending"];

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
        // Table headers: `["name", "kind"].map((h) => t(`crds.${h}`))`.
        ...[...text.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
          [...m[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((h) => `${m[2]!}.${h[1]!}`),
        ),
      ];
    });
    const built = STATES.map((s) => `subscriptionState.${s}`);
    expect(keys.length).toBeGreaterThan(100);
    const missing = [...new Set([...keys, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string; tooltip?: string };
  const c = manifest.contributes;

  it("translate every text of the manifest into every language Sextant has", () => {
    const keys = [
      "name",
      "description",
      ...c.kinds.map((_, i) => `kinds.${i}.title`),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
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
        .map((k) => k.slice("sectionBadges.olm.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
    }
  });

  it("keep the English placeholders, and translate the problem rules' titles", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    const english = new Map<string, string>();
    for (const col of c.columns) {
      for (const [i, cs] of ((col as { cases?: Case[] }).cases ?? []).entries()) {
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

  it("say the Subscription states, yes and no as the details do", () => {
    const state = c.columns.find((col) => col.id === "subscription-state")! as { cases: Case[] };
    expect(state.cases.map((cs) => cs.text)).toEqual(STATES.map((s) => en[`subscriptionState.${s}` as keyof typeof en]));
    for (const [language, texts] of Object.entries(manifest.translations as Record<string, Record<string, string>>)) {
      const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
      STATES.forEach((s, i) => expect(texts[`columns.subscription-state.cases.${i}.text`], language).toBe(catalog[`subscriptionState.${s}`]));
      expect(texts["columns.install-plan-approved.cases.0.text"], language).toBe(catalog.yes);
      expect(texts["columns.install-plan-approved.cases.1.text"], language).toBe(catalog.no);
      expect(texts["columns.operator-group-targets.cases.0.text"], language).toBe(catalog.allNamespaces);
    }
  });
});
